-- 007_provider_registry.sql
-- Phase 2: general, DB-driven Provider Registry. This is the pattern
-- described in docs/PROVIDER_REGISTRY.md — it is deliberately layer-generic
-- (telephony today, stt/tts/llm in Phase 3) so no new tables or migrations
-- are needed when Phase 3 adds those layers, only new rows.
--
-- Relationship to Phase 1's provider_accounts/provider_rate_cards
-- (db/migrations/004_billing_providers.sql): those remain for billing/cost
-- accounting (usage_records, cost_records, vendor rate cards). The tables
-- below are the new, separate concern of "which adapter class implements
-- provider X, and which provider is this tenant configured to use at layer
-- Y" — i.e. adapter *selection*, not cost accounting. A given provider_key
-- (e.g. 'plivo') shows up as a row in both provider_accounts (Phase 1,
-- billing/cred label) and providers (Phase 2, adapter catalog); they are
-- joined only by that shared string key, not a foreign key, since they were
-- designed in different phases for different purposes and may be merged
-- later.

-- providers: the platform-wide adapter catalog. Not tenant-scoped — every
-- tenant sees the same catalog of available providers per layer (like
-- provider_rate_cards, RLS is intentionally not applied here; this is
-- platform-managed data, written by migrations/seeds or a future internal
-- admin tool, never by tenant-facing code).
CREATE TABLE providers (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Extensible on purpose: a plain text column with a CHECK, not a Postgres
  -- ENUM type, so Phase 3 can add 'stt' / 'tts' / 'llm' rows (already
  -- included below) without an ALTER TYPE migration. Any future layer just
  -- needs its value added to this CHECK.
  layer                     text NOT NULL CHECK (layer IN ('telephony', 'stt', 'tts', 'llm')),
  provider_key              text NOT NULL, -- e.g. 'plivo', 'frejun_teler', 'mock' — never hardcoded in business logic
  display_name              text NOT NULL,
  -- The key an adapter class self-registers under (see
  -- apps/web/lib/providers/registry.ts and docs/PROVIDER_REGISTRY.md). Kept
  -- as an opaque identifier string, not a literal JS import path, because
  -- Next.js/webpack cannot dynamically `import()` an arbitrary string built
  -- from DB content at runtime — the registry instead looks this identifier
  -- up in an in-memory map that each adapter module populates when loaded.
  adapter_class_identifier  text NOT NULL,
  -- What config fields this adapter needs, e.g.
  -- {"required": ["auth_id", "auth_token"], "properties": {"auth_id": {"type": "string"}, ...}}
  config_schema             jsonb NOT NULL DEFAULT '{}'::jsonb,
  status                    text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'beta')),
  default_priority          integer NOT NULL DEFAULT 100, -- lower = preferred default, all else equal
  cost_notes                text,
  -- e.g. {"streaming": true, "dtmf": true, "recording": true}
  capabilities              jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  UNIQUE (layer, provider_key)
);
CREATE INDEX providers_layer_idx ON providers (layer);

-- tenant_provider_config: which provider(s) a given org uses at a given
-- layer, in priority order, plus that tenant's own config values for the
-- chosen adapter (API keys/secrets, base URLs, etc).
--
-- Secrets handling (see docs/PROVIDER_REGISTRY.md "Secrets" section):
-- `config` is architected as encrypted-at-rest ciphertext (see
-- lib/providers/crypto.ts), never plaintext, using an application-level
-- AES-256-GCM envelope keyed by PROVIDER_CONFIG_ENCRYPTION_KEY (an env var,
-- never stored in the DB). Postgres itself has no column-level encryption
-- applied here (no pgcrypto pgp_sym_encrypt column) — encryption/decryption
-- happens in the app layer, before/after the encrypted bytes cross the
-- pg wire, so the encryption key never has to be granted to Postgres.
-- TODO(Phase 2 follow-up / infra): today PROVIDER_CONFIG_ENCRYPTION_KEY is a
-- single symmetric key from an env var. Before onboarding real tenant
-- secrets in production, move this to a proper secrets manager / KMS with
-- per-tenant data keys and key rotation. Never seed this table with a real
-- API key/secret in a migration or test fixture — tests use the `mock`
-- provider, which needs no credentials, or a fabricated fake value.
CREATE TABLE tenant_provider_config (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  layer           text NOT NULL CHECK (layer IN ('telephony', 'stt', 'tts', 'llm')),
  provider_key    text NOT NULL,
  priority        integer NOT NULL DEFAULT 100, -- lower = tried first within (org_id, layer)
  is_default      boolean NOT NULL DEFAULT false,
  -- Encrypted-at-rest JSON envelope: {"iv": "...", "tag": "...", "ciphertext": "..."}
  -- decrypted only in-process by lib/providers/crypto.ts. NEVER plaintext.
  config          jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (layer, provider_key) REFERENCES providers (layer, provider_key)
);
CREATE INDEX tenant_provider_config_org_id_idx ON tenant_provider_config (org_id);
CREATE UNIQUE INDEX tenant_provider_config_one_default_idx
  ON tenant_provider_config (org_id, layer)
  WHERE is_default;

GRANT SELECT ON providers TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON tenant_provider_config TO app_user;

ALTER TABLE tenant_provider_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_provider_config FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_provider_config_isolation ON tenant_provider_config
  USING (org_id = current_org_id()) WITH CHECK (org_id = current_org_id());

-- providers intentionally has RLS disabled — same rationale as
-- provider_rate_cards in 004_billing_providers.sql: platform-wide catalog,
-- no org_id column, read-only to tenants.

-- telephony_webhook_events: idempotency ledger for inbound telephony
-- webhooks. A provider (Plivo, FreJun Teler, ...) may retry a webhook
-- delivery on timeout/5xx; the unique constraint on (provider_key,
-- idempotency_key) makes a retried delivery a no-op rather than a
-- duplicate call-state transition. org_id is nullable at insert time
-- because some providers' retried webhook cannot be attributed to a tenant
-- until the payload is parsed, but is always backfilled before being
-- treated as processed; RLS still scopes reads to the owning org once set.
CREATE TABLE telephony_webhook_events (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid REFERENCES organizations(id) ON DELETE CASCADE,
  provider_key      text NOT NULL,
  idempotency_key   text NOT NULL, -- provider's event/delivery id, or a derived hash if the provider has none
  call_id           uuid REFERENCES calls(id) ON DELETE SET NULL,
  event_type        text,
  payload           jsonb,
  processed_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider_key, idempotency_key)
);
CREATE INDEX telephony_webhook_events_org_id_idx ON telephony_webhook_events (org_id);

GRANT SELECT, INSERT ON telephony_webhook_events TO app_user;

ALTER TABLE telephony_webhook_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE telephony_webhook_events FORCE ROW LEVEL SECURITY;
CREATE POLICY telephony_webhook_events_isolation ON telephony_webhook_events
  USING (org_id IS NULL OR org_id = current_org_id())
  WITH CHECK (org_id IS NULL OR org_id = current_org_id());

-- process_telephony_webhook_event: the single, atomic, SECURITY DEFINER
-- entry point inbound telephony webhooks use to (a) find which org a
-- provider_call_id belongs to (impossible to know before any query, since a
-- webhook arrives with no session/tenant context) and (b) idempotently
-- record + apply the event, in one transaction, so a retried delivery can
-- never double-apply a status transition. Returns was_new = false on a
-- duplicate delivery (same provider_key + idempotency_key), in which case
-- the caller must skip all further side effects (e.g. no double dispatch to
-- downstream systems). Mirrors the pattern in 006_auth_functions.sql for
-- "operations that must legitimately cross the tenant boundary".
CREATE OR REPLACE FUNCTION process_telephony_webhook_event(
  p_provider_key      text,
  p_idempotency_key   text,
  p_provider_call_id  text,
  p_event_type        text,
  p_status            text, -- one of calls.status's values, or NULL to leave status untouched
  p_recording_url     text, -- or NULL
  p_payload           jsonb
) RETURNS TABLE(was_new boolean, org_id uuid, call_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_call_id uuid;
  v_org_id  uuid;
  v_row_count int;
BEGIN
  SELECT c.id, c.org_id INTO v_call_id, v_org_id
    FROM calls c WHERE c.provider_call_id = p_provider_call_id
    LIMIT 1;

  INSERT INTO telephony_webhook_events (org_id, provider_key, idempotency_key, call_id, event_type, payload)
    VALUES (v_org_id, p_provider_key, p_idempotency_key, v_call_id, p_event_type, p_payload)
    ON CONFLICT (provider_key, idempotency_key) DO NOTHING;
  GET DIAGNOSTICS v_row_count = ROW_COUNT;

  IF v_row_count > 0 AND v_call_id IS NOT NULL THEN
    UPDATE calls SET
      status = COALESCE(p_status, status),
      recording_url = COALESCE(p_recording_url, recording_url),
      started_at = CASE WHEN p_status = 'in_progress' AND started_at IS NULL THEN now() ELSE started_at END,
      ended_at = CASE WHEN p_status IN ('completed', 'failed', 'no_answer') THEN now() ELSE ended_at END
    WHERE id = v_call_id;
  END IF;

  RETURN QUERY SELECT (v_row_count > 0), v_org_id, v_call_id;
END;
$$;

REVOKE ALL ON FUNCTION process_telephony_webhook_event(text, text, text, text, text, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION process_telephony_webhook_event(text, text, text, text, text, text, jsonb) TO app_user;

-- Seed the platform-wide adapter catalog for Phase 2's telephony layer.
-- No secrets here — config_schema only *describes* what fields a tenant
-- must supply in tenant_provider_config.config, it never contains values.
INSERT INTO providers (layer, provider_key, display_name, adapter_class_identifier, config_schema, status, default_priority, cost_notes, capabilities) VALUES
(
  'telephony', 'mock', 'Mock Telephony (demo/test)', 'telephony.mock',
  '{"required": [], "properties": {}}'::jsonb,
  'active', 1,
  'No cost — in-memory simulated adapter for demo mode and automated tests. Never used for real calls.',
  '{"streaming": true, "dtmf": true, "recording": true, "transfer": true}'::jsonb
),
(
  'telephony', 'frejun_teler', 'FreJun Teler', 'telephony.frejun_teler',
  '{"required": ["api_key", "account_id"], "properties": {"api_key": {"type": "string"}, "account_id": {"type": "string"}, "base_url": {"type": "string"}}}'::jsonb,
  'beta', 10,
  'Cheapest verified streaming-capable option per docs/VERIFICATION.md §7 (~₹0.28-0.30/min blended). Newer/smaller vendor — 10-channel/12-month DID commitment + Aadhaar KYC; needs a paid pilot before being trusted as sole default. Set to default_priority 10 (preferred) but status=beta until a pilot completes.',
  '{"streaming": true, "dtmf": false, "recording": true, "transfer": false}'::jsonb
),
(
  'telephony', 'plivo', 'Plivo', 'telephony.plivo',
  '{"required": ["auth_id", "auth_token"], "properties": {"auth_id": {"type": "string"}, "auth_token": {"type": "string"}, "answer_url": {"type": "string"}}}'::jsonb,
  'active', 20,
  'Most mature/proven fallback per docs/VERIFICATION.md §7 (~₹0.95/min). First-party Pipecat serializer support.',
  '{"streaming": true, "dtmf": true, "recording": true, "transfer": true}'::jsonb
);
