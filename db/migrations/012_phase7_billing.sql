-- 012_phase7_billing.sql
-- Phase 7: customer billing (plans/wallet/invoices), the payment-gateway
-- provider-registry layer, and a latency-metrics sink for the Provider
-- Scoreboard. Builds ON Phase 1/3.5/4's usage_records/cost_records/
-- provider_rate_cards pipeline (db/migrations/004_billing_providers.sql) —
-- that remains the PLATFORM COST side; everything new here is the
-- CUSTOMER PRICE side, kept in clearly separate tables per the spec's
-- "never expose platform cost to customer" rule.

-- ===========================================================================
-- 1. billing_plans — platform catalog (org_id NULL, curated by the
--    platform owner) OR a tenant's own custom plan (org_id set). Either
--    way, a plan is just a row of fully DB-driven price config — never a
--    hardcoded number in application code. Documented choice: catalog +
--    tenant-selection (via billing_accounts.plan_id below) rather than
--    "always tenant-owned", so the platform owner can offer standard
--    tiers a tenant simply subscribes to, while still allowing a
--    bespoke/negotiated tenant-specific plan row when needed.
-- ===========================================================================
CREATE TABLE billing_plans (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- NULL = platform catalog plan, visible to every tenant. Set = a
  -- tenant-specific/custom plan, visible only to that org.
  org_id          uuid REFERENCES organizations(id) ON DELETE CASCADE,
  name            text NOT NULL,
  plan_type       text NOT NULL CHECK (plan_type IN ('subscription', 'pay_as_you_go', 'prepaid_wallet', 'postpaid_enterprise', 'hybrid')),
  currency        text NOT NULL DEFAULT 'INR',
  -- Fully config-driven rate config — e.g.
  -- {"per_minute_rate": 2.99, "monthly_fee": 999, "included_minutes": 500,
  --  "overage_per_minute_rate": 3.49}
  -- No numeric price point is ever hardcoded in application code; every
  -- example in this migration's own comments (and the spec's) is
  -- illustrative only and lives here, in data.
  rate_config     jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX billing_plans_org_id_idx ON billing_plans (org_id);

-- ===========================================================================
-- 2. billing_accounts — the extension point for Phase 8's reseller
--    hierarchy. For Phase 7, an account always attaches directly to an
--    org. `reseller_id` is added now, nullable and unused by any Phase 7
--    code path, so Phase 8 can route a tenant's billing through a
--    reseller markup without a schema rewrite — see the column comment.
-- ===========================================================================
CREATE TABLE billing_accounts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL UNIQUE REFERENCES organizations(id) ON DELETE CASCADE,
  plan_id         uuid REFERENCES billing_plans(id) ON DELETE SET NULL,
  -- Phase 8 extension point (documented, NOT implemented here): once
  -- reseller/white-label exists, a tenant billed *through* a reseller
  -- would set this to that reseller's org id, and Phase 8's pricing-
  -- visibility rules (reseller never sees platform cost, customer never
  -- sees reseller cost) would key off it. Left NULL and unread by every
  -- Phase 7 code path.
  reseller_id     uuid REFERENCES organizations(id) ON DELETE SET NULL,
  billing_mode    text NOT NULL DEFAULT 'direct' CHECK (billing_mode IN ('direct', 'reseller_managed')),
  issuing_entity_name text NOT NULL DEFAULT 'Your Company',
  gstin           text,
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'closed')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- ===========================================================================
-- 3. wallets + wallet_transactions — prepaid balance + append-only ledger.
--    A wallet balance is NEVER written directly; every change happens via
--    apps/web/lib/billing/wallet.ts's `applyWalletTransaction()`, which
--    inserts the ledger row and updates the balance in the SAME db
--    transaction (see that file's docstring), same discipline as
--    Phase 2's telephony-webhook idempotency.
-- ===========================================================================
CREATE TABLE wallets (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                uuid NOT NULL UNIQUE REFERENCES organizations(id) ON DELETE CASCADE,
  balance               numeric(14,4) NOT NULL DEFAULT 0,
  currency              text NOT NULL DEFAULT 'INR',
  low_balance_threshold numeric(14,4) NOT NULL DEFAULT 0,
  -- Optional config, e.g. {"enabled": true, "topup_amount": 500, "trigger_threshold": 100}
  auto_recharge_config  jsonb,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE wallet_transactions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  wallet_id       uuid NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
  type            text NOT NULL CHECK (type IN ('credit', 'debit')),
  reason          text NOT NULL CHECK (reason IN ('call_charge', 'manual_topup', 'gateway_topup', 'refund', 'adjustment')),
  amount          numeric(14,4) NOT NULL CHECK (amount > 0),
  balance_after   numeric(14,4) NOT NULL,
  -- Loose references (no FK — the referenced row may live in a table this
  -- ledger doesn't need a hard dependency on) to whatever this
  -- transaction relates to: a cost_records.id, an invoices.id, or a
  -- payment_orders.id.
  cost_record_id  uuid,
  invoice_id      uuid,
  payment_order_id uuid,
  idempotency_key text,
  notes           text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX wallet_transactions_org_id_idx ON wallet_transactions (org_id);
CREATE INDEX wallet_transactions_wallet_id_idx ON wallet_transactions (wallet_id);
-- Idempotency: a retried gateway webhook (or any retried credit) must not
-- double-apply. NULL idempotency_key rows (manual/internal debits that
-- have no natural external key) are unconstrained.
CREATE UNIQUE INDEX wallet_transactions_idempotency_idx ON wallet_transactions (wallet_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

-- ===========================================================================
-- 4. billing_alerts — low-balance / other billing events. Live delivery
--    (WhatsApp/email) is a follow-up per the spec's own scoping note;
--    this table is the durable record + the hook a notifier can poll.
-- ===========================================================================
CREATE TABLE billing_alerts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  alert_type      text NOT NULL CHECK (alert_type IN ('low_balance', 'zero_balance', 'call_blocked')),
  details         jsonb,
  delivered       boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX billing_alerts_org_id_idx ON billing_alerts (org_id);

-- ===========================================================================
-- 5. invoices + invoice_line_items — GST-aware, tenant-configurable
--    issuing entity name (read from billing_accounts.issuing_entity_name
--    at generation time — NEVER a hardcoded company name).
-- ===========================================================================
CREATE TABLE invoices (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  invoice_number        text NOT NULL,
  issuing_entity_name   text NOT NULL, -- copied from billing_accounts at generation time, tenant-configurable
  issuing_entity_gstin  text,
  billed_to_name        text NOT NULL,
  billed_to_gstin       text,
  period_start          date NOT NULL,
  period_end            date NOT NULL,
  subtotal              numeric(14,4) NOT NULL DEFAULT 0,
  gst_rate_percent      numeric(5,2) NOT NULL DEFAULT 18.00, -- tenant/plan-configurable, not hardcoded to one number of legal significance beyond a default
  gst_amount            numeric(14,4) NOT NULL DEFAULT 0,
  total_amount          numeric(14,4) NOT NULL DEFAULT 0,
  currency              text NOT NULL DEFAULT 'INR',
  status                text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'issued', 'paid', 'overdue', 'void')),
  issued_at             timestamptz,
  paid_at               timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX invoices_org_id_idx ON invoices (org_id);
CREATE UNIQUE INDEX invoices_org_invoice_number_idx ON invoices (org_id, invoice_number);

CREATE TABLE invoice_line_items (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  invoice_id      uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  description     text NOT NULL,
  quantity        numeric(14,4) NOT NULL,
  unit            text NOT NULL,
  unit_price      numeric(14,6) NOT NULL,
  line_total      numeric(14,4) NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX invoice_line_items_invoice_id_idx ON invoice_line_items (invoice_id);

-- ===========================================================================
-- 6. Payment gateway provider-registry layer — same DB-driven pattern as
--    telephony/stt/tts/llm/embedding/whatsapp (docs/PROVIDER_REGISTRY.md).
-- ===========================================================================
ALTER TABLE providers DROP CONSTRAINT providers_layer_check;
ALTER TABLE providers ADD CONSTRAINT providers_layer_check
  CHECK (layer IN ('telephony', 'stt', 'tts', 'llm', 'embedding', 'whatsapp', 'payment_gateway'));

ALTER TABLE tenant_provider_config DROP CONSTRAINT tenant_provider_config_layer_check;
ALTER TABLE tenant_provider_config ADD CONSTRAINT tenant_provider_config_layer_check
  CHECK (layer IN ('telephony', 'stt', 'tts', 'llm', 'embedding', 'whatsapp', 'payment_gateway'));

INSERT INTO providers (layer, provider_key, display_name, adapter_class_identifier, config_schema, status, default_priority, cost_notes, capabilities) VALUES
(
  'payment_gateway', 'mock', 'Mock Payment Gateway (demo/test)', 'payment_gateway.mock',
  '{"required": [], "properties": {}}'::jsonb,
  'active', 1,
  'No cost — deterministic in-memory fake for demo mode and automated tests. Never contacts a real gateway.',
  '{"payment_links": true, "webhooks": true}'::jsonb
),
(
  'payment_gateway', 'razorpay', 'Razorpay', 'payment_gateway.razorpay',
  '{"required": ["key_id", "key_secret"], "properties": {"key_id": {"type": "string"}, "key_secret": {"type": "string"}, "webhook_secret": {"type": "string"}}}'::jsonb,
  'active', 10,
  'Recommended primary per docs/VERIFICATION.md (2026-09-22): developer-friendly APIs, mature Payment Links/Subscriptions/webhook-signature-verification products, the most common recommendation for an India SaaS selling recurring/subscription billing. ~2%+GST TDR — re-verify current pricing before go-live, same caveat as every other adapter in this catalog.',
  '{"payment_links": true, "subscriptions": true, "webhooks": true}'::jsonb
),
(
  'payment_gateway', 'cashfree', 'Cashfree Payments', 'payment_gateway.cashfree',
  '{"required": ["client_id", "client_secret"], "properties": {"client_id": {"type": "string"}, "client_secret": {"type": "string"}, "webhook_secret": {"type": "string"}}}'::jsonb,
  'beta', 20,
  'Alternate per docs/VERIFICATION.md (2026-09-22): slightly lower published TDR (~1.75-1.95%) and strong instant-payouts product, kept as the fallback/cost-optimization option — not the Phase 7 default, since Razorpay''s subscription/wallet tooling is the better fit for this platform''s recurring-billing needs.',
  '{"payment_links": true, "subscriptions": true, "webhooks": true}'::jsonb
)
ON CONFLICT (layer, provider_key) DO NOTHING;

-- payment_orders: one row per wallet top-up (or future subscription
-- charge) attempt through a payment_gateway adapter.
CREATE TABLE payment_orders (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  gateway_provider_key text NOT NULL,
  provider_order_id   text NOT NULL,
  purpose             text NOT NULL DEFAULT 'wallet_topup' CHECK (purpose IN ('wallet_topup', 'subscription_charge')),
  amount              numeric(14,4) NOT NULL,
  currency            text NOT NULL DEFAULT 'INR',
  status              text NOT NULL DEFAULT 'created' CHECK (status IN ('created', 'paid', 'failed', 'cancelled')),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX payment_orders_org_id_idx ON payment_orders (org_id);
CREATE UNIQUE INDEX payment_orders_gateway_order_idx ON payment_orders (gateway_provider_key, provider_order_id);

-- payment_webhook_events: idempotency ledger for gateway webhooks — exact
-- same shape/purpose as telephony_webhook_events (007_provider_registry.sql).
-- A retried webhook delivery (same gateway_provider_key + idempotency_key)
-- is a no-op, so a wallet is never double-credited.
CREATE TABLE payment_webhook_events (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              uuid REFERENCES organizations(id) ON DELETE CASCADE,
  gateway_provider_key text NOT NULL,
  idempotency_key     text NOT NULL,
  payment_order_id    uuid REFERENCES payment_orders(id) ON DELETE SET NULL,
  event_type          text,
  payload             jsonb,
  processed_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (gateway_provider_key, idempotency_key)
);
CREATE INDEX payment_webhook_events_org_id_idx ON payment_webhook_events (org_id);

-- Telephony + TTS rate-card rows were missing real (non-mock) entries —
-- needed so the Cost Simulator (lib/billing/costSimulator.ts) has a real
-- telephony/TTS line to compute, not just STT/LLM. Same sourcing as
-- 009_embedding_layer_and_rate_cards.sql: docs/COST_MODEL_V1.md's
-- Economy-tier figures (re-verify before billing real usage, same
-- standing caveat as every price in this codebase).
INSERT INTO provider_rate_cards (provider_type, provider_key, unit, unit_price_usd, notes) VALUES
('telephony', 'mock', 'per_minute', 0.000000, 'Mock provider — always free, used only so cost-simulator tests/demo runs have a real rate-card row to join against.'),
('tts', 'mock', 'per_1k_chars', 0.000000, 'Mock provider — always free.'),
('telephony', 'frejun_teler', 'per_minute', 0.003200, 'docs/COST_MODEL_V1.md Economy tier: ~Rs 0.28/min blended (base + streaming add-on) ~= $0.0032/min at ~Rs 88/$1 — re-verify before billing real usage.'),
('tts', 'sarvam', 'per_1k_chars', 0.034000, 'docs/COST_MODEL_V1.md Economy tier: Sarvam Bulbul ~Rs 0.003/char = Rs 3/1k chars ~= $0.034/1k chars at ~Rs 88/$1 — re-verify before billing real usage.')
ON CONFLICT DO NOTHING;

-- ===========================================================================
-- 7. call_latency_metrics — durable sink for Phase 3's per-call latency
--    measurements (voice_gateway/latency.py), so the Provider Scoreboard
--    can aggregate real per-provider latency instead of re-inventing
--    measurement. Phase 3's TurnLatencyTracker/log_stage log
--    structured JSON today but do not persist to Postgres; this table is
--    that sink, written via voice_gateway/billing/latency_writer.py.
--    NOTE (honest scope note, see Phase 7 report): wiring every real
--    pipeline call site to call that writer end-to-end is left as a
--    small follow-up — the table, writer function, and scoreboard
--    aggregation query are all in place and tested against fixture rows.
-- ===========================================================================
CREATE TABLE call_latency_metrics (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid REFERENCES organizations(id) ON DELETE CASCADE,
  call_id         uuid REFERENCES calls(id) ON DELETE SET NULL,
  layer           text NOT NULL CHECK (layer IN ('stt', 'tts', 'llm', 'telephony')),
  provider_key    text NOT NULL,
  stage           text NOT NULL, -- e.g. 'end_of_speech_to_transcript', 'transcript_to_llm_first_token', 'llm_first_token_to_first_tts_byte'
  duration_s      numeric(10,4) NOT NULL,
  recorded_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX call_latency_metrics_org_id_idx ON call_latency_metrics (org_id);
CREATE INDEX call_latency_metrics_layer_provider_idx ON call_latency_metrics (layer, provider_key);

-- ===========================================================================
-- 8. provider_quality_ratings — manual/admin-entered "Hinglish quality"
--    (and any other subjective quality) rating per provider. Platform-
--    level (no org_id), NOT an automatic score — the spec is explicit
--    that quality cannot be measured automatically from usage data alone,
--    and this codebase does not fabricate one.
-- ===========================================================================
CREATE TABLE provider_quality_ratings (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  layer           text NOT NULL,
  provider_key    text NOT NULL,
  metric          text NOT NULL DEFAULT 'hinglish_quality',
  score           numeric(4,2) NOT NULL CHECK (score >= 0 AND score <= 10),
  rated_by        text, -- free-text admin identifier/email, not a users FK (platform-level, may be rated by someone without a tenant login)
  notes           text,
  rated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX provider_quality_ratings_unique_idx ON provider_quality_ratings (layer, provider_key, metric);

-- ===========================================================================
-- Grants + RLS — same established pattern as every prior phase.
-- ===========================================================================
GRANT SELECT, INSERT, UPDATE, DELETE ON
  billing_plans, billing_accounts, wallets, wallet_transactions, billing_alerts,
  invoices, invoice_line_items, payment_orders, payment_webhook_events, call_latency_metrics
  TO app_user;
-- Platform-level, not tenant data (no org_id column) — same rationale as
-- provider_rate_cards / providers: admin-managed only.
GRANT SELECT ON provider_quality_ratings TO app_user;

ALTER TABLE billing_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_plans FORCE ROW LEVEL SECURITY;
CREATE POLICY billing_plans_isolation ON billing_plans
  USING (org_id IS NULL OR org_id = current_org_id())
  WITH CHECK (org_id IS NULL OR org_id = current_org_id());

ALTER TABLE billing_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_accounts FORCE ROW LEVEL SECURITY;
CREATE POLICY billing_accounts_isolation ON billing_accounts
  USING (org_id = current_org_id()) WITH CHECK (org_id = current_org_id());

ALTER TABLE wallets ENABLE ROW LEVEL SECURITY;
ALTER TABLE wallets FORCE ROW LEVEL SECURITY;
CREATE POLICY wallets_isolation ON wallets
  USING (org_id = current_org_id()) WITH CHECK (org_id = current_org_id());

ALTER TABLE wallet_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE wallet_transactions FORCE ROW LEVEL SECURITY;
CREATE POLICY wallet_transactions_isolation ON wallet_transactions
  USING (org_id = current_org_id()) WITH CHECK (org_id = current_org_id());

ALTER TABLE billing_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_alerts FORCE ROW LEVEL SECURITY;
CREATE POLICY billing_alerts_isolation ON billing_alerts
  USING (org_id = current_org_id()) WITH CHECK (org_id = current_org_id());

ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoices FORCE ROW LEVEL SECURITY;
CREATE POLICY invoices_isolation ON invoices
  USING (org_id = current_org_id()) WITH CHECK (org_id = current_org_id());

ALTER TABLE invoice_line_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_line_items FORCE ROW LEVEL SECURITY;
CREATE POLICY invoice_line_items_isolation ON invoice_line_items
  USING (org_id = current_org_id()) WITH CHECK (org_id = current_org_id());

ALTER TABLE payment_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_orders FORCE ROW LEVEL SECURITY;
CREATE POLICY payment_orders_isolation ON payment_orders
  USING (org_id = current_org_id()) WITH CHECK (org_id = current_org_id());

ALTER TABLE payment_webhook_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_webhook_events FORCE ROW LEVEL SECURITY;
CREATE POLICY payment_webhook_events_isolation ON payment_webhook_events
  USING (org_id IS NULL OR org_id = current_org_id())
  WITH CHECK (org_id IS NULL OR org_id = current_org_id());

ALTER TABLE call_latency_metrics ENABLE ROW LEVEL SECURITY;
ALTER TABLE call_latency_metrics FORCE ROW LEVEL SECURITY;
CREATE POLICY call_latency_metrics_isolation ON call_latency_metrics
  USING (org_id IS NULL OR org_id = current_org_id())
  WITH CHECK (org_id IS NULL OR org_id = current_org_id());

-- ===========================================================================
-- 9. credit_wallet_transaction — SECURITY DEFINER helper mirroring
--    process_telephony_webhook_event's idempotent-apply pattern, so the
--    payment-gateway webhook handler can atomically (a) mark a
--    payment_orders row paid, (b) record the idempotency ledger row, and
--    (c) credit the wallet + insert its ledger row — all in one
--    transaction, with a retried delivery being a safe no-op.
-- ===========================================================================
-- Takes NO org_id from the caller: a webhook request has no trustworthy
-- tenant context (exactly like process_telephony_webhook_event), so this
-- function looks up which org the referenced payment_orders row belongs
-- to itself, as the function owner (bypassing RLS the same way
-- process_telephony_webhook_event's `calls` lookup does), rather than
-- trusting a caller-supplied org id for a request nothing has
-- authenticated as belonging to that org.
-- The credited amount is read from the platform's OWN payment_orders row
-- (set when the order was created, before any webhook existed), never
-- from the webhook payload itself — a webhook's `amount` field is
-- attacker-observable/replayable and must never be trusted as the
-- authoritative charge amount.
CREATE OR REPLACE FUNCTION credit_wallet_from_payment(
  p_gateway_provider_key text,
  p_idempotency_key     text,
  p_provider_order_id   text,
  p_event_type          text,
  p_payload             jsonb
) RETURNS TABLE(was_new boolean, wallet_id uuid, balance_after numeric) AS $$
DECLARE
  v_order_id uuid;
  v_org_id uuid;
  v_amount numeric;
  v_wallet_id uuid;
  v_row_count int;
  v_new_balance numeric;
BEGIN
  SELECT id, org_id, amount INTO v_order_id, v_org_id, v_amount FROM payment_orders
   WHERE gateway_provider_key = p_gateway_provider_key AND provider_order_id = p_provider_order_id
   LIMIT 1;

  IF v_order_id IS NULL THEN
    RETURN QUERY SELECT false, NULL::uuid, 0::numeric;
    RETURN;
  END IF;

  INSERT INTO payment_webhook_events (org_id, gateway_provider_key, idempotency_key, payment_order_id, event_type, payload)
    VALUES (v_org_id, p_gateway_provider_key, p_idempotency_key, v_order_id, p_event_type, p_payload)
    ON CONFLICT (gateway_provider_key, idempotency_key) DO NOTHING;
  GET DIAGNOSTICS v_row_count = ROW_COUNT;

  IF v_row_count = 0 THEN
    -- Duplicate delivery: report the wallet's CURRENT state, but do not
    -- credit again.
    SELECT w.id, w.balance INTO v_wallet_id, v_new_balance FROM wallets w WHERE w.org_id = v_org_id;
    RETURN QUERY SELECT false, v_wallet_id, v_new_balance;
    RETURN;
  END IF;

  UPDATE payment_orders SET status = 'paid', updated_at = now()
   WHERE id = v_order_id;

  INSERT INTO wallets (org_id, balance) VALUES (v_org_id, 0)
    ON CONFLICT (org_id) DO NOTHING;

  UPDATE wallets SET balance = balance + v_amount, updated_at = now()
   WHERE org_id = v_org_id
   RETURNING id, balance INTO v_wallet_id, v_new_balance;

  INSERT INTO wallet_transactions (org_id, wallet_id, type, reason, amount, balance_after, payment_order_id, idempotency_key)
    VALUES (v_org_id, v_wallet_id, 'credit', 'gateway_topup', v_amount, v_new_balance, v_order_id, p_idempotency_key);

  RETURN QUERY SELECT true, v_wallet_id, v_new_balance;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION credit_wallet_from_payment(text, text, text, text, jsonb) TO app_user;

-- ===========================================================================
-- 10. Platform-wide provider-scoreboard aggregate functions. `cost_records`
--    /`usage_records`/`call_latency_metrics` are correctly tenant-isolated
--    by RLS, but the Provider Scoreboard is INTENTIONALLY a platform-level
--    view spanning every tenant's usage (same "not tenant data" category
--    as `providers`/`provider_rate_cards` themselves) — a plain app_user
--    connection with no/any single org context cannot aggregate across
--    orgs by design, so these SECURITY DEFINER functions do it once,
--    read-only, the same bypass-RLS-deliberately pattern as
--    `process_telephony_webhook_event` / `credit_wallet_from_payment`
--    above (which bypass it to resolve which org a request belongs to;
--    this bypasses it to aggregate ACROSS orgs for a platform-owner view).
-- ===========================================================================
CREATE OR REPLACE FUNCTION platform_provider_cost_stats()
RETURNS TABLE(provider_type text, provider_key text, total_cost_usd numeric, total_usage_quantity numeric, usage_unit text, call_count bigint)
AS $$
  SELECT ur.provider_type, ur.provider_key,
         SUM(cr.amount_usd), SUM(ur.quantity), MAX(ur.unit), COUNT(DISTINCT ur.call_id)
    FROM cost_records cr
    JOIN usage_records ur ON ur.id = cr.usage_record_id
   GROUP BY ur.provider_type, ur.provider_key
   ORDER BY ur.provider_type, ur.provider_key;
$$ LANGUAGE sql SECURITY DEFINER SET search_path = public STABLE;

CREATE OR REPLACE FUNCTION platform_provider_latency_stats()
RETURNS TABLE(layer text, provider_key text, stage text, avg_duration_s numeric, sample_count bigint)
AS $$
  SELECT layer, provider_key, stage, AVG(duration_s), COUNT(*)
    FROM call_latency_metrics
   GROUP BY layer, provider_key, stage
   ORDER BY layer, provider_key, stage;
$$ LANGUAGE sql SECURITY DEFINER SET search_path = public STABLE;

GRANT EXECUTE ON FUNCTION platform_provider_cost_stats() TO app_user;
GRANT EXECUTE ON FUNCTION platform_provider_latency_stats() TO app_user;
