-- 017_sitesnsign_integration.sql
-- VPS deployment prep: sitesnsign.com <-> ai-calling-agent integration
-- (docs/SITESNSIGN_INTEGRATION.md). Two directions, both generic
-- multi-tenant infra — nothing here is sitesnsign-specific in shape, only
-- the founder's own org row is configured to use it once real credentials
-- exist.
--
-- 1. sitesnsign_webhook_tokens — the INBOUND direction (sitesnsign.com's
--    NestJS backend -> POST /api/webhooks/sitesnsign/lead-intake). Same
--    "per-tenant token, hash-only storage, resolve org from token"
--    discipline as 016_gap_closing_pass.sql's n8n_webhook_tokens, PLUS an
--    HMAC signing secret (needed here, unlike the n8n token, because this
--    endpoint additionally verifies a body signature — see
--    docs/SITESNSIGN_INTEGRATION.md's "why two secrets" note). The signing
--    secret is stored application-encrypted (lib/providers/crypto.ts's
--    existing envelope encryption, same as tenant_provider_config.config)
--    since, unlike the token, the raw value must be readable again to
--    compute the expected HMAC.
--
-- 2. webhook_subscriptions / webhook_deliveries — the OUTBOUND direction
--    (ai-calling-agent -> a tenant-configured target URL on call
--    completion / disposition change). Deliberately generic (event_type +
--    target_url + secret per org), not sitesnsign-specific: any tenant
--    could point this at their own CRM.
-- ===========================================================================

CREATE TABLE sitesnsign_webhook_tokens (
  org_id              uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  token_hash          text NOT NULL UNIQUE,
  -- Envelope-encrypted {"iv","tag","ciphertext"} (lib/providers/crypto.ts
  -- shape) wrapping the raw HMAC signing secret handed to sitesnsign.com's
  -- developer to configure on their end.
  hmac_secret_enc     jsonb NOT NULL,
  created_by          uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON sitesnsign_webhook_tokens TO app_user;

ALTER TABLE sitesnsign_webhook_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE sitesnsign_webhook_tokens FORCE ROW LEVEL SECURITY;
CREATE POLICY sitesnsign_webhook_tokens_isolation ON sitesnsign_webhook_tokens
  USING (org_id = current_org_id()) WITH CHECK (org_id = current_org_id());

-- Pre-auth resolver, same pattern/rationale as resolve_org_by_n8n_token():
-- no session/org context exists yet when this inbound webhook arrives.
CREATE OR REPLACE FUNCTION resolve_org_by_sitesnsign_token(p_token_hash text)
RETURNS uuid
LANGUAGE sql SECURITY DEFINER SET search_path = public STABLE AS $$
  SELECT org_id FROM sitesnsign_webhook_tokens WHERE token_hash = p_token_hash;
$$;

REVOKE ALL ON FUNCTION resolve_org_by_sitesnsign_token(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_org_by_sitesnsign_token(text) TO app_user;

-- resolve_sitesnsign_secret(): same pre-auth need, returns the encrypted
-- secret blob so the route can decrypt it and verify the body's HMAC
-- signature. Kept as a separate function (rather than folding into the
-- resolver above) so a future audit of "what can read org ids without a
-- session" and "what can read secret material without a session" stay
-- independently reviewable.
CREATE OR REPLACE FUNCTION resolve_sitesnsign_secret(p_token_hash text)
RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path = public STABLE AS $$
  SELECT hmac_secret_enc FROM sitesnsign_webhook_tokens WHERE token_hash = p_token_hash;
$$;

REVOKE ALL ON FUNCTION resolve_sitesnsign_secret(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_sitesnsign_secret(text) TO app_user;

-- ===========================================================================
-- 2. Outbound webhook delivery — generic per-tenant subscription + a
--    delivery log with its own attempt/backoff bookkeeping (separate from
--    job_queue's generic attempts counter so this module owns its own
--    exponential-backoff schedule rather than depending on job_queue's
--    default immediate-retry behavior — see
--    lib/webhooks/outboundWebhookSender.ts's top comment).
-- ===========================================================================

CREATE TABLE webhook_subscriptions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- e.g. 'call.completed', 'lead.disposition_changed'. Not an enum: new
  -- event types are additive and tenant-configured, never a schema change.
  event_type    text NOT NULL,
  target_url    text NOT NULL,
  -- Envelope-encrypted signing secret (same shape as
  -- sitesnsign_webhook_tokens.hmac_secret_enc) sitesnsign.com's (or any
  -- other target's) receiving endpoint uses to verify this app's
  -- outbound HMAC signature.
  secret_enc    jsonb NOT NULL,
  enabled       boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX webhook_subscriptions_org_event_idx ON webhook_subscriptions (org_id, event_type) WHERE enabled;

CREATE TABLE webhook_deliveries (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  subscription_id   uuid NOT NULL REFERENCES webhook_subscriptions(id) ON DELETE CASCADE,
  event_type        text NOT NULL,
  payload           jsonb NOT NULL,
  target_url        text NOT NULL,
  -- Copied from webhook_subscriptions.secret_enc AT ENQUEUE TIME rather
  -- than re-read cross-tenant later: webhook_subscriptions has RLS FORCED
  -- (org-scoped, like every other tenant table), but the delivery worker
  -- (like job_queue's worker) must process due deliveries across every
  -- tenant in one poll with no org context set — denormalizing the secret
  -- onto the delivery row avoids needing either a SECURITY DEFINER escape
  -- hatch or turning RLS off on webhook_subscriptions itself.
  secret_enc        jsonb NOT NULL,
  status            text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'delivered', 'failed', 'exhausted')),
  attempts          integer NOT NULL DEFAULT 0,
  max_attempts      integer NOT NULL DEFAULT 6,
  last_error        text,
  last_status_code  integer,
  next_attempt_at   timestamptz NOT NULL DEFAULT now(),
  delivered_at      timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX webhook_deliveries_due_idx ON webhook_deliveries (status, next_attempt_at) WHERE status = 'pending';
CREATE INDEX webhook_deliveries_org_id_idx ON webhook_deliveries (org_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON webhook_subscriptions, webhook_deliveries TO app_user;

ALTER TABLE webhook_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_subscriptions FORCE ROW LEVEL SECURITY;
CREATE POLICY webhook_subscriptions_isolation ON webhook_subscriptions
  USING (org_id = current_org_id()) WITH CHECK (org_id = current_org_id());

-- webhook_deliveries: RLS intentionally OFF, same rationale as job_queue
-- (011_phase6_whatsapp_appointments_campaigns_compliance.sql) — the
-- delivery worker must see due deliveries across all tenants in one poll.
-- Every query still filters org_id explicitly for defense in depth.
