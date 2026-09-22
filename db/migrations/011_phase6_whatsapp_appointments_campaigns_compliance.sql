-- 011_phase6_whatsapp_appointments_campaigns_compliance.sql
-- Phase 6: WhatsApp provider registry layer, appointments (generalized
-- "site visits"), campaigns + smart retry, a job queue, and the
-- pre-dial compliance gate's data model (consent/DND/opt-out).
--
-- Multi-industry principle (continuing Phase 5's pattern): "site visit" ->
-- generic `appointments.type` (tenant-configurable text, e.g. site_visit |
-- demo | consultation | pickup); WhatsApp template keys are tenant-owned
-- config, never hardcoded real-estate copy; campaign lead filters are a
-- generic jsonb field-matcher, not real-estate-specific columns.

-- ===========================================================================
-- 1. WhatsApp provider registry layer — same DB-driven pattern as
--    telephony (Phase 2) / stt|tts|llm (Phase 3) / embedding (Phase 3.5).
--    Per docs/PROVIDER_REGISTRY.md, adding a layer is a one-line CHECK
--    edit, never a schema rewrite or an ALTER TYPE.
-- ===========================================================================

ALTER TABLE providers DROP CONSTRAINT providers_layer_check;
ALTER TABLE providers ADD CONSTRAINT providers_layer_check
  CHECK (layer IN ('telephony', 'stt', 'tts', 'llm', 'embedding', 'whatsapp'));

ALTER TABLE tenant_provider_config DROP CONSTRAINT tenant_provider_config_layer_check;
ALTER TABLE tenant_provider_config ADD CONSTRAINT tenant_provider_config_layer_check
  CHECK (layer IN ('telephony', 'stt', 'tts', 'llm', 'embedding', 'whatsapp'));

INSERT INTO providers (layer, provider_key, display_name, adapter_class_identifier, config_schema, status, default_priority, cost_notes, capabilities) VALUES
(
  'whatsapp', 'mock', 'Mock WhatsApp (demo/test)', 'whatsapp.mock',
  '{"required": [], "properties": {}}'::jsonb,
  'active', 1,
  'No cost — in-memory simulated adapter for demo mode and automated tests. Never sends a real message.',
  '{"templates": true, "media": true, "location": true}'::jsonb
),
(
  'whatsapp', 'interakt', 'Interakt (BSP)', 'whatsapp.interakt',
  '{"required": ["api_key", "waba_id"], "properties": {"api_key": {"type": "string"}, "waba_id": {"type": "string"}, "base_url": {"type": "string"}}}'::jsonb,
  'active', 10,
  'Recommended primary per docs/VERIFICATION.md (2026-09-22): official Meta BSP, transparent per-conversation pricing (~₹0.95-0.97/marketing conversation), fast (days, not weeks) small-business onboarding, published template API. Cheapest transparent-pricing BSP suitable for a small Indian startup at Phase 6 volume.',
  '{"templates": true, "media": true, "location": true}'::jsonb
),
(
  'whatsapp', 'gupshup', 'Gupshup (BSP)', 'whatsapp.gupshup',
  '{"required": ["api_key", "app_name", "source_number"], "properties": {"api_key": {"type": "string"}, "app_name": {"type": "string"}, "source_number": {"type": "string"}, "base_url": {"type": "string"}}}'::jsonb,
  'beta', 20,
  'Recommended alternate per docs/VERIFICATION.md (2026-09-22): enterprise-grade Meta Tech Partner BSP, larger-scale/BFSI-proven, but pricing is quote-only (not published) and richer than Interakt for a Phase 6 volume — kept as the fallback/scale-up option, not the Phase 6 default.',
  '{"templates": true, "media": true, "location": true}'::jsonb
);

-- Log of every WhatsApp send attempted through the registry, for
-- delivery-status tracking and for the reminder/follow-up jobs below to
-- avoid double-sending. Vertical-neutral: `template_key` and `payload` are
-- tenant/config-owned, never a fixed real-estate template name.
CREATE TABLE whatsapp_messages (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  lead_id             uuid REFERENCES leads(id) ON DELETE SET NULL,
  call_id             uuid REFERENCES calls(id) ON DELETE SET NULL,
  appointment_id      uuid, -- FK added after appointments is created below
  provider_key        text NOT NULL,
  message_type        text NOT NULL, -- document | media | location | appointment_confirmation | reminder | follow_up | template
  template_key        text,
  to_number           text NOT NULL,
  status              text NOT NULL DEFAULT 'queued', -- queued|sent|delivered|read|failed
  provider_message_id text,
  payload             jsonb NOT NULL DEFAULT '{}'::jsonb,
  error               text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX whatsapp_messages_org_id_idx ON whatsapp_messages (org_id);
CREATE INDEX whatsapp_messages_lead_id_idx ON whatsapp_messages (lead_id);

-- ===========================================================================
-- 2. Appointments — generalized "site visits" per the multi-industry
--    pivot. `type` is free text (tenant-configurable, e.g. site_visit,
--    demo, consultation, pickup), never a fixed enum.
-- ===========================================================================

CREATE TABLE appointments (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  lead_id           uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  call_id           uuid REFERENCES calls(id) ON DELETE SET NULL,
  type              text NOT NULL DEFAULT 'appointment', -- tenant-configurable: site_visit|demo|consultation|pickup|...
  scheduled_at      timestamptz NOT NULL,
  status            text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'confirmed', 'completed', 'cancelled', 'no_show')),
  location_or_link  text, -- physical address OR a video-call link, vertical-agnostic
  notes             text,
  reminder_sent_at  timestamptz, -- set once the reminder job has fired, to avoid double-sends
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX appointments_org_id_idx ON appointments (org_id);
CREATE INDEX appointments_lead_id_idx ON appointments (lead_id);
CREATE INDEX appointments_scheduled_at_idx ON appointments (scheduled_at);

ALTER TABLE whatsapp_messages ADD CONSTRAINT whatsapp_messages_appointment_id_fkey
  FOREIGN KEY (appointment_id) REFERENCES appointments(id) ON DELETE SET NULL;

-- ===========================================================================
-- 3. Compliance gate data model — consent / DND / opt-out per lead, checked
--    by the mandatory pre-dial gate (apps/web/lib/compliance/gate.ts).
--    See docs/COMPLIANCE.md for the TRAI/DLT/DND/TCCCPR findings this
--    schema is built to satisfy (7-day explicit-consent expiry, DND
--    exclusion unless valid consent, spam/opt-out honoring).
-- ===========================================================================

CREATE TABLE lead_compliance (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  lead_id           uuid NOT NULL UNIQUE REFERENCES leads(id) ON DELETE CASCADE,
  consent_status    text NOT NULL DEFAULT 'unknown' CHECK (consent_status IN ('granted', 'revoked', 'unknown')),
  consent_source    text, -- e.g. 'web_form', 'inbound_call', 'manual'
  consent_captured_at timestamptz,
  -- Per docs/COMPLIANCE.md (Feb 2025 TRAI amendment): explicit consent for
  -- a specific commercial purpose is valid for only 7 days from capture
  -- unless renewed; inferred consent (existing customer) may set this
  -- further out or NULL (relationship-duration based) — always tenant/ops
  -- set, never assumed by this schema.
  consent_expires_at  timestamptz,
  is_dnd            boolean NOT NULL DEFAULT false, -- number is on NDNC / tenant-flagged DND
  opted_out         boolean NOT NULL DEFAULT false, -- explicit do-not-call request from this lead
  opted_out_at      timestamptz,
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX lead_compliance_org_id_idx ON lead_compliance (org_id);

-- ===========================================================================
-- 4. Campaigns — tenant-owned outbound calling campaigns with smart retry
--    and calling-hour/limit configuration, all enforced by the compliance
--    gate at dial time (never trusted as self-enforcing here).
-- ===========================================================================

CREATE TABLE campaigns (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  agent_id            uuid REFERENCES agents(id) ON DELETE SET NULL,
  agent_prompt_id     uuid REFERENCES agent_prompts(id) ON DELETE SET NULL,
  name                text NOT NULL,
  status              text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'paused', 'completed', 'archived')),
  lead_source         text, -- free text / import batch id, informational
  -- Generic field-matcher, never real-estate-specific columns, e.g.
  -- {"pipeline_stage": "new", "custom_fields.city": "Patna"}.
  lead_filter         jsonb NOT NULL DEFAULT '{}'::jsonb,
  start_at            timestamptz,
  end_at              timestamptz,
  calling_days        integer[] NOT NULL DEFAULT '{1,2,3,4,5,6}', -- ISO day-of-week, 1=Mon..7=Sun
  calling_hour_start  integer NOT NULL DEFAULT 9,  -- local hour, 0-23; enforced by the compliance gate
  calling_hour_end    integer NOT NULL DEFAULT 20,
  timezone            text NOT NULL DEFAULT 'Asia/Kolkata',
  max_calls_per_hour  integer NOT NULL DEFAULT 60,
  -- Smart-retry schedule: ordered array of {"attempt": n, "delay_minutes": m}
  -- applied per the disposition returned by the previous attempt. Default
  -- matches the spec's example: attempt 1 immediate, 2 after 30min, 3 after
  -- 4h, 4 next day (1440min) — tenant-overridable, never hardcoded in code.
  retry_schedule      jsonb NOT NULL DEFAULT
    '[{"attempt":1,"delay_minutes":0},{"attempt":2,"delay_minutes":30},{"attempt":3,"delay_minutes":240},{"attempt":4,"delay_minutes":1440}]'::jsonb,
  max_attempts        integer NOT NULL DEFAULT 4, -- hard cap, never exceeded regardless of retry_schedule length
  language            text,
  voice_provider_key  text,
  pipeline_template_key text,
  webhook_url         text,
  follow_up_rule      jsonb NOT NULL DEFAULT '{}'::jsonb, -- e.g. {"on_disposition":"no_answer","action":"whatsapp_follow_up"}
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX campaigns_org_id_idx ON campaigns (org_id);

-- Per-lead campaign membership + attempt/retry state. One row per
-- (campaign, lead) so the dialer job can pick "who's due right now" with a
-- single indexed query and the smart-retry counter is authoritative.
CREATE TABLE campaign_leads (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  campaign_id       uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  lead_id           uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  status            text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'completed', 'exhausted', 'blocked')),
  attempts          integer NOT NULL DEFAULT 0,
  last_disposition  text,
  last_call_id      uuid REFERENCES calls(id) ON DELETE SET NULL,
  next_attempt_at   timestamptz NOT NULL DEFAULT now(),
  blocked_reason    text, -- set by the compliance gate when it refuses to schedule further attempts
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, lead_id)
);
CREATE INDEX campaign_leads_org_id_idx ON campaign_leads (org_id);
CREATE INDEX campaign_leads_due_idx ON campaign_leads (campaign_id, status, next_attempt_at);

-- ===========================================================================
-- 5. Job queue — Postgres-backed, row-locked queue table.
--
-- DECISION (documented per the founder's brief): docs/ARCHITECTURE.md
-- planned Redis for the outbound-dialing queue, and Redis IS available and
-- startable in this dev sandbox (`redis-server` binary verified working,
-- see the Phase 6 commit message / VERIFICATION-style note in
-- docs/ARCHITECTURE.md). `bullmq` + `ioredis` are added as dependencies
-- and apps/web/lib/queue/bullmq.ts implements the BullMQ-backed queues
-- (campaign-dial, retry, reminders, whatsapp-send) as the primary,
-- production-target mechanism.
--
-- This table is kept as a SEPARATE, documented interim/fallback substitute
-- (apps/web/lib/queue/pg-queue.ts) for two reasons: (1) there is no managed
-- Redis instance provisioned for any deployed environment yet — only a
-- local binary confirmed in this sandbox — so a Postgres-backed queue lets
-- Phase 6 ship a working, persistent, crash-safe queue today without a new
-- unmanaged infra dependency; (2) it gives the test suite a
-- zero-extra-service way to exercise queue semantics (enqueue, due-time,
-- `FOR UPDATE SKIP LOCKED` claiming, retry/backoff, dead-lettering) using
-- only the Postgres the rest of the test suite already requires. Both
-- implementations satisfy the same `Queue`-shaped contract in
-- apps/web/lib/queue/types.ts, so callers (the campaign dialer, reminder
-- scheduler, WhatsApp sender) are queue-backend-agnostic — swapping which
-- one is active is a config choice, not a rewrite. Ops should move fully
-- to the BullMQ/Redis path once a managed Redis instance is provisioned.
-- ===========================================================================

CREATE TABLE job_queue (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid REFERENCES organizations(id) ON DELETE CASCADE, -- nullable: some jobs (e.g. platform cron) are not tenant-scoped
  queue_name    text NOT NULL, -- 'campaign-dial' | 'retry' | 'reminder' | 'whatsapp-send' | ...
  payload       jsonb NOT NULL DEFAULT '{}'::jsonb,
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'dead_letter')),
  run_at        timestamptz NOT NULL DEFAULT now(),
  attempts      integer NOT NULL DEFAULT 0,
  max_attempts  integer NOT NULL DEFAULT 5,
  locked_at     timestamptz,
  locked_by     text,
  last_error    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX job_queue_due_idx ON job_queue (queue_name, status, run_at);

GRANT SELECT, INSERT, UPDATE, DELETE ON whatsapp_messages, appointments, lead_compliance, campaigns, campaign_leads, job_queue TO app_user;

ALTER TABLE whatsapp_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_messages FORCE ROW LEVEL SECURITY;
CREATE POLICY whatsapp_messages_tenant_isolation ON whatsapp_messages
  USING (org_id = current_org_id()) WITH CHECK (org_id = current_org_id());

ALTER TABLE appointments ENABLE ROW LEVEL SECURITY;
ALTER TABLE appointments FORCE ROW LEVEL SECURITY;
CREATE POLICY appointments_tenant_isolation ON appointments
  USING (org_id = current_org_id()) WITH CHECK (org_id = current_org_id());

ALTER TABLE lead_compliance ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_compliance FORCE ROW LEVEL SECURITY;
CREATE POLICY lead_compliance_tenant_isolation ON lead_compliance
  USING (org_id = current_org_id()) WITH CHECK (org_id = current_org_id());

ALTER TABLE campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaigns FORCE ROW LEVEL SECURITY;
CREATE POLICY campaigns_tenant_isolation ON campaigns
  USING (org_id = current_org_id()) WITH CHECK (org_id = current_org_id());

ALTER TABLE campaign_leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_leads FORCE ROW LEVEL SECURITY;
CREATE POLICY campaign_leads_tenant_isolation ON campaign_leads
  USING (org_id = current_org_id()) WITH CHECK (org_id = current_org_id());

-- job_queue: RLS intentionally left OFF its per-row org scoping for the
-- *worker* process (it must be able to see and claim jobs across all
-- tenants in one poll), but application code enqueuing/reading a specific
-- tenant's jobs still always goes through withTenant() + an org_id filter
-- in the query for defense in depth. This mirrors the `providers` /
-- `provider_rate_cards` precedent of RLS-off platform-managed tables,
-- except job_queue *does* carry org_id per-row (for filtering), it just
-- isn't RLS-enforced since the one reader that must see all orgs (the
-- worker) is not a per-tenant HTTP request context.
