-- 004_billing_providers.sql
-- Provider accounts/rate cards (per-tenant provider credentials/config —
-- secrets themselves live in an external secrets manager in later phases;
-- Phase 1 stores only references/labels, never raw API keys) plus
-- usage/cost records (schema only, no real metering pipeline yet).

CREATE TABLE provider_accounts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  provider_type   text NOT NULL, -- telephony | stt | tts | llm
  provider_key    text NOT NULL, -- e.g. 'plivo', 'sarvam', 'gemini' — config value, never hardcoded in app logic
  label           text NOT NULL DEFAULT 'default',
  -- Reference to the secret in the external secrets manager (Phase 2+),
  -- not the secret itself. Never a real credential in this column.
  secret_ref      text,
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX provider_accounts_org_id_idx ON provider_accounts (org_id);

-- provider_rate_cards: NOT tenant-scoped — these are platform-wide vendor
-- prices (what Plivo/Sarvam/Gemini/etc. charge us), used by the cost
-- model (docs/COST_MODEL_V1.md) to compute cost_records. Visible to all
-- tenants read-only would be a Phase 2 concern; Phase 1 keeps it
-- admin-only (no RLS org scoping needed since there is no org_id column).
CREATE TABLE provider_rate_cards (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_type   text NOT NULL,
  provider_key    text NOT NULL,
  unit            text NOT NULL, -- e.g. 'per_minute', 'per_1k_chars', 'per_1m_tokens'
  unit_price_usd  numeric(12,6) NOT NULL,
  effective_from  date NOT NULL DEFAULT current_date,
  notes           text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE usage_records (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  call_id         uuid REFERENCES calls(id) ON DELETE SET NULL,
  provider_type   text NOT NULL,
  provider_key    text NOT NULL,
  quantity        numeric(14,4) NOT NULL, -- minutes, characters, tokens, etc.
  unit            text NOT NULL,
  recorded_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX usage_records_org_id_idx ON usage_records (org_id);

CREATE TABLE cost_records (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  usage_record_id uuid REFERENCES usage_records(id) ON DELETE SET NULL,
  amount_usd      numeric(14,6) NOT NULL,
  billed_amount   numeric(14,6), -- what we charge the tenant (may include markup), Phase 4+ billing concern
  currency        text NOT NULL DEFAULT 'USD',
  recorded_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX cost_records_org_id_idx ON cost_records (org_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON provider_accounts, usage_records, cost_records TO app_user;
GRANT SELECT ON provider_rate_cards TO app_user;

ALTER TABLE provider_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE provider_accounts FORCE ROW LEVEL SECURITY;
CREATE POLICY provider_accounts_isolation ON provider_accounts
  USING (org_id = current_org_id()) WITH CHECK (org_id = current_org_id());

ALTER TABLE usage_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_records FORCE ROW LEVEL SECURITY;
CREATE POLICY usage_records_isolation ON usage_records
  USING (org_id = current_org_id()) WITH CHECK (org_id = current_org_id());

ALTER TABLE cost_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE cost_records FORCE ROW LEVEL SECURITY;
CREATE POLICY cost_records_isolation ON cost_records
  USING (org_id = current_org_id()) WITH CHECK (org_id = current_org_id());

-- provider_rate_cards intentionally has RLS disabled: it carries no org_id,
-- is not tenant data, and is platform-managed (written only via migrations/
-- an internal admin tool in a later phase).
