-- 010_crm_pipeline.sql
-- Phase 5: CRM — lead pipeline, dispositions, lead scoring, call summaries,
-- human handoff.
--
-- Multi-industry principle (see docs/PROMPT_TO_AGENT_BUILDER.md and the
-- founder's real-estate -> multi-vertical pivot): the ORIGINAL master
-- spec's pipeline (NEW -> AI_CALLED -> ... -> SITE_VISIT -> ... -> BOOKING
-- -> CLOSED|LOST) and disposition list (CONNECTED, NO_ANSWER, ...,
-- SITE_VISIT, ...) are real-estate-flavored. Per that pivot, neither is
-- hardcoded anywhere in this schema or in application code — both are
-- tenant-owned, ordered rows in `pipeline_stages` / `dispositions`,
-- generated from one of the *template* catalogs below (or from a given
-- agent's own Prompt-to-Agent-Builder output — see
-- docs/PROMPT_TO_AGENT_BUILDER.md §3's `suggested_pipeline_stages` /
-- `suggested_dispositions` / `suggested_lead_scoring_criteria`, which this
-- phase's tables consume directly, not a re-invented shape). Real estate
-- is seeded as ONE template among others (`real_estate`), sitting next to
-- a vertical-neutral `generic_default` template — exactly the "pre-built
-- template, not a special case" rule ARCHITECTURE.md sets for the whole
-- platform.
--
-- `transcripts`: Phase 1's `calls.transcript jsonb` column (see
-- 003_agents_leads_calls.sql) already IS this platform's transcript store
-- — there is no separate `transcripts` table from an earlier phase to
-- verify against. Rather than add a second, redundant transcript table,
-- this migration keeps `calls.transcript` as the single source of raw
-- transcript text and has `call_summaries` reference `call_id` only (never
-- copying transcript text into the summary row) — see docs/CRM_LOGIC.md
-- "Where the transcript lives" for the reasoning.

-- ===========================================================================
-- Platform-wide template catalogs (RLS disabled — same rationale as
-- `providers`/`provider_rate_cards`: shared, platform-managed reference
-- data, not tenant data; every tenant/agent can read every template and
-- copy from it, but never write to it).
-- ===========================================================================

CREATE TABLE pipeline_stage_templates (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_key  text NOT NULL UNIQUE, -- e.g. 'generic_default', 'real_estate'
  display_name  text NOT NULL,
  vertical      text, -- e.g. 'generic', 'real_estate' — informational only, never branched on in code
  -- Ordered array of
  -- {"stage_key", "display_name", "sort_order", "is_terminal", "terminal_outcome"}
  stages        jsonb NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE disposition_templates (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_key  text NOT NULL UNIQUE, -- e.g. 'default'
  display_name  text NOT NULL,
  -- Ordered array of {"disposition_key", "display_name", "category"}
  dispositions  jsonb NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON pipeline_stage_templates, disposition_templates TO app_user;

-- ===========================================================================
-- Tenant-owned pipeline / disposition / scoring config. `agent_id IS NULL`
-- means an org-level default (used when a lead/call isn't tied to one
-- agent, or before any agent-level override exists); a non-null agent_id
-- lets each agent (vertical) run its own stage/disposition set within one
-- org — e.g. a reseller's diagnostics-lab agent and real-estate agent in
-- the same org each keep their own pipeline.
-- ===========================================================================

CREATE TABLE pipeline_stages (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  agent_id            uuid REFERENCES agents(id) ON DELETE CASCADE,
  stage_key           text NOT NULL,
  display_name        text NOT NULL,
  sort_order          integer NOT NULL,
  is_terminal         boolean NOT NULL DEFAULT false,
  terminal_outcome    text CHECK (terminal_outcome IN ('won', 'lost') OR terminal_outcome IS NULL),
  source_template_key text, -- which template this stage was instantiated from, if any (audit trail only)
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, agent_id, stage_key)
);
CREATE INDEX pipeline_stages_org_id_idx ON pipeline_stages (org_id);
CREATE INDEX pipeline_stages_org_agent_idx ON pipeline_stages (org_id, agent_id, sort_order);

CREATE TABLE dispositions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  agent_id            uuid REFERENCES agents(id) ON DELETE CASCADE,
  disposition_key     text NOT NULL,
  display_name        text NOT NULL,
  category            text, -- e.g. 'connected' | 'no_contact' | 'interest' | 'qualification' | 'transfer' | 'compliance' | 'failed'
  source_template_key text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, agent_id, disposition_key)
);
CREATE INDEX dispositions_org_id_idx ON dispositions (org_id);

-- lead_scoring_criteria: kept as its own small table rather than folded
-- into agent_prompts.config jsonb, even though the latter would also work
-- (agent_prompts.config already carries the Prompt-to-Agent Builder's
-- `suggested_lead_scoring_criteria`). Reasoning (see docs/CRM_LOGIC.md
-- "Why a dedicated table"): the scoring engine and the dashboard both need
-- to query/update individual criteria (enable/disable one, tweak a weight)
-- without reading/writing/versioning the entire agent config blob, and a
-- real table gets this phase's RLS + tenant-isolation tests "for free" in
-- the same pattern as every other new table here — a nested jsonb array
-- would need bespoke isolation tests of its own for no benefit.
CREATE TABLE lead_scoring_criteria (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  agent_id      uuid REFERENCES agents(id) ON DELETE CASCADE,
  criterion_key text NOT NULL,
  display_name  text NOT NULL,
  -- Numeric weight this criterion contributes toward the HOT/WARM/COLD
  -- score when satisfied — see voice_gateway/crm/scoring.py for the exact
  -- ruleset and docs/CRM_LOGIC.md for the documented reasoning. Mirrors
  -- the builder's high/medium/low `weight_hint` as 3/2/1 by default.
  weight        integer NOT NULL DEFAULT 1,
  weight_hint   text CHECK (weight_hint IN ('high', 'medium', 'low') OR weight_hint IS NULL),
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, agent_id, criterion_key)
);
CREATE INDEX lead_scoring_criteria_org_id_idx ON lead_scoring_criteria (org_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON pipeline_stages, dispositions, lead_scoring_criteria TO app_user;

ALTER TABLE pipeline_stages ENABLE ROW LEVEL SECURITY;
ALTER TABLE pipeline_stages FORCE ROW LEVEL SECURITY;
CREATE POLICY pipeline_stages_isolation ON pipeline_stages
  USING (org_id = current_org_id()) WITH CHECK (org_id = current_org_id());

ALTER TABLE dispositions ENABLE ROW LEVEL SECURITY;
ALTER TABLE dispositions FORCE ROW LEVEL SECURITY;
CREATE POLICY dispositions_isolation ON dispositions
  USING (org_id = current_org_id()) WITH CHECK (org_id = current_org_id());

ALTER TABLE lead_scoring_criteria ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_scoring_criteria FORCE ROW LEVEL SECURITY;
CREATE POLICY lead_scoring_criteria_isolation ON lead_scoring_criteria
  USING (org_id = current_org_id()) WITH CHECK (org_id = current_org_id());

-- ===========================================================================
-- lead_stage_history: append-only proof that every pipeline transition is
-- timestamped (per the master spec's explicit requirement). Stages here
-- are NOT strictly ordered/enforced server-side — see docs/CRM_LOGIC.md
-- "Ordered vs. freely-jumpable stages" for why this phase chose to allow a
-- lead to jump straight to a terminal stage (e.g. LOST) from anywhere,
-- rather than rejecting an "out of order" move, since real conversations
-- (a caller says "not interested" on the very first call) don't obey a
-- strict linear order even when the tenant's template is drawn as one.
-- ===========================================================================

CREATE TABLE lead_stage_history (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  lead_id             uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  from_stage_id       uuid REFERENCES pipeline_stages(id) ON DELETE SET NULL,
  to_stage_id         uuid REFERENCES pipeline_stages(id) ON DELETE SET NULL,
  changed_by_user_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  note                text,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX lead_stage_history_org_id_idx ON lead_stage_history (org_id);
CREATE INDEX lead_stage_history_lead_id_idx ON lead_stage_history (lead_id, created_at);

GRANT SELECT, INSERT ON lead_stage_history TO app_user;

ALTER TABLE lead_stage_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_stage_history FORCE ROW LEVEL SECURITY;
CREATE POLICY lead_stage_history_isolation ON lead_stage_history
  USING (org_id = current_org_id()) WITH CHECK (org_id = current_org_id());

-- ===========================================================================
-- call_summaries: one structured summary per call, generated post-call by
-- the LLM Provider Registry (see voice_gateway/crm/summary.py) from
-- `calls.transcript` — never a copy of the raw transcript itself.
-- ===========================================================================

CREATE TABLE call_summaries (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  call_id               uuid NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  lead_id               uuid REFERENCES leads(id) ON DELETE SET NULL,
  requirement_text      text,   -- what the caller needs/wants
  budget_value          text,   -- kept as text: not every vertical's "budget" is an INR amount (e.g. "under 2 packs/month")
  location              text,   -- only meaningful for location-sensitive verticals; null otherwise
  product_type          text,
  intent                text,
  objections            jsonb NOT NULL DEFAULT '[]'::jsonb, -- array of strings
  next_action           text,
  follow_up_date        date,
  lead_score_at_call    integer,
  recommended_action    text,
  -- True when the LLM's structured output was malformed/incomplete and the
  -- parser had to fall back rather than silently drop fields — see
  -- voice_gateway/crm/summary.py's parser and docs/CRM_LOGIC.md.
  needs_review          boolean NOT NULL DEFAULT false,
  raw_llm_output        jsonb,  -- kept only for the needs_review debugging path
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (call_id)
);
CREATE INDEX call_summaries_org_id_idx ON call_summaries (org_id);
CREATE INDEX call_summaries_lead_id_idx ON call_summaries (lead_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON call_summaries TO app_user;

ALTER TABLE call_summaries ENABLE ROW LEVEL SECURITY;
ALTER TABLE call_summaries FORCE ROW LEVEL SECURITY;
CREATE POLICY call_summaries_isolation ON call_summaries
  USING (org_id = current_org_id()) WITH CHECK (org_id = current_org_id());

-- ===========================================================================
-- handoff_requests: the testable deliverable for human handoff this phase.
-- Actually notifying/ringing a human salesperson (SMS/app push/live call
-- transfer) is explicitly OUT of scope here — see docs/CRM_LOGIC.md
-- "Deferred to Phase 6+" — this table only proves the trigger-detection ->
-- payload-snapshot -> row-creation path works end-to-end.
-- ===========================================================================

CREATE TABLE handoff_requests (
  id                            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  call_id                       uuid REFERENCES calls(id) ON DELETE SET NULL,
  lead_id                       uuid REFERENCES leads(id) ON DELETE SET NULL,
  trigger_reason                text NOT NULL CHECK (trigger_reason IN ('explicit_request', 'high_score', 'objection_escalation', 'other')),
  transfer_type                 text NOT NULL CHECK (transfer_type IN ('warm', 'cold', 'callback_request')),
  assigned_salesperson_user_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  status                        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'connected', 'missed', 'callback_scheduled')),
  -- Snapshot handed to the human at transfer time: name, requirement,
  -- budget, location, conversation summary, lead score, product/property
  -- discussed, objections — see voice_gateway/crm/handoff.py for the exact
  -- shape this is built with.
  handoff_payload               jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at                    timestamptz NOT NULL DEFAULT now(),
  updated_at                    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX handoff_requests_org_id_idx ON handoff_requests (org_id);
CREATE INDEX handoff_requests_lead_id_idx ON handoff_requests (lead_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON handoff_requests TO app_user;

ALTER TABLE handoff_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE handoff_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY handoff_requests_isolation ON handoff_requests
  USING (org_id = current_org_id()) WITH CHECK (org_id = current_org_id());

-- ===========================================================================
-- Extend `leads` (Phase 1) with the CRM fields this phase's spec calls
-- for. `pipeline_stage` (free text, Phase 1) is left in place unmodified
-- for backward compatibility with any existing row/reader; the new
-- `pipeline_stage_id` FK is the one pipeline_stages-aware transitions use
-- from here on (see docs/CRM_LOGIC.md).
-- ===========================================================================

ALTER TABLE leads
  ADD COLUMN pipeline_stage_id             uuid REFERENCES pipeline_stages(id) ON DELETE SET NULL,
  ADD COLUMN score                         integer NOT NULL DEFAULT 0,
  ADD COLUMN score_band                    text CHECK (score_band IN ('hot', 'warm', 'cold') OR score_band IS NULL),
  ADD COLUMN assigned_salesperson_user_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN last_disposition_id           uuid REFERENCES dispositions(id) ON DELETE SET NULL,
  ADD COLUMN next_follow_up_at             timestamptz,
  ADD COLUMN latest_call_summary_id        uuid REFERENCES call_summaries(id) ON DELETE SET NULL;

CREATE INDEX leads_pipeline_stage_id_idx ON leads (pipeline_stage_id);
CREATE INDEX leads_assigned_salesperson_idx ON leads (assigned_salesperson_user_id);

-- ===========================================================================
-- Seed the two platform-wide template catalogs. Order within each
-- `stages`/`dispositions` array IS the intended sort_order (0-based).
-- ===========================================================================

INSERT INTO pipeline_stage_templates (template_key, display_name, vertical, stages) VALUES
(
  'generic_default', 'Generic default', 'generic',
  '[
    {"stage_key": "new",            "display_name": "New",             "sort_order": 0, "is_terminal": false, "terminal_outcome": null},
    {"stage_key": "contacted",      "display_name": "Contacted",       "sort_order": 1, "is_terminal": false, "terminal_outcome": null},
    {"stage_key": "qualified",      "display_name": "Qualified",       "sort_order": 2, "is_terminal": false, "terminal_outcome": null},
    {"stage_key": "hot",            "display_name": "Hot",             "sort_order": 3, "is_terminal": false, "terminal_outcome": null},
    {"stage_key": "warm",           "display_name": "Warm",            "sort_order": 4, "is_terminal": false, "terminal_outcome": null},
    {"stage_key": "cold",           "display_name": "Cold",            "sort_order": 5, "is_terminal": false, "terminal_outcome": null},
    {"stage_key": "proposal_sent",  "display_name": "Proposal Sent",   "sort_order": 6, "is_terminal": false, "terminal_outcome": null},
    {"stage_key": "follow_up",      "display_name": "Follow Up",       "sort_order": 7, "is_terminal": false, "terminal_outcome": null},
    {"stage_key": "closed_won",     "display_name": "Closed Won",      "sort_order": 8, "is_terminal": true,  "terminal_outcome": "won"},
    {"stage_key": "closed_lost",    "display_name": "Closed Lost",     "sort_order": 9, "is_terminal": true,  "terminal_outcome": "lost"}
  ]'::jsonb
),
(
  'real_estate', 'Real estate', 'real_estate',
  '[
    {"stage_key": "new",              "display_name": "New",                "sort_order": 0,  "is_terminal": false, "terminal_outcome": null},
    {"stage_key": "ai_called",        "display_name": "AI Called",          "sort_order": 1,  "is_terminal": false, "terminal_outcome": null},
    {"stage_key": "connected",        "display_name": "Connected",          "sort_order": 2,  "is_terminal": false, "terminal_outcome": null},
    {"stage_key": "qualified",        "display_name": "Qualified",          "sort_order": 3,  "is_terminal": false, "terminal_outcome": null},
    {"stage_key": "hot",              "display_name": "Hot",                "sort_order": 4,  "is_terminal": false, "terminal_outcome": null},
    {"stage_key": "warm",             "display_name": "Warm",               "sort_order": 5,  "is_terminal": false, "terminal_outcome": null},
    {"stage_key": "cold",             "display_name": "Cold",               "sort_order": 6,  "is_terminal": false, "terminal_outcome": null},
    {"stage_key": "property_shared",  "display_name": "Property Shared",    "sort_order": 7,  "is_terminal": false, "terminal_outcome": null},
    {"stage_key": "site_visit",       "display_name": "Site Visit",         "sort_order": 8,  "is_terminal": false, "terminal_outcome": null},
    {"stage_key": "visit_completed",  "display_name": "Visit Completed",    "sort_order": 9,  "is_terminal": false, "terminal_outcome": null},
    {"stage_key": "negotiation",      "display_name": "Negotiation",        "sort_order": 10, "is_terminal": false, "terminal_outcome": null},
    {"stage_key": "booking",          "display_name": "Booking",            "sort_order": 11, "is_terminal": false, "terminal_outcome": null},
    {"stage_key": "closed",           "display_name": "Closed",             "sort_order": 12, "is_terminal": true,  "terminal_outcome": "won"},
    {"stage_key": "lost",             "display_name": "Lost",               "sort_order": 13, "is_terminal": true,  "terminal_outcome": "lost"}
  ]'::jsonb
);

INSERT INTO disposition_templates (template_key, display_name, dispositions) VALUES
(
  'default', 'Default call dispositions',
  '[
    {"disposition_key": "connected",         "display_name": "Connected",          "category": "connected"},
    {"disposition_key": "no_answer",         "display_name": "No Answer",          "category": "no_contact"},
    {"disposition_key": "busy",              "display_name": "Busy",               "category": "no_contact"},
    {"disposition_key": "wrong_number",      "display_name": "Wrong Number",       "category": "no_contact"},
    {"disposition_key": "callback",          "display_name": "Callback Requested", "category": "follow_up"},
    {"disposition_key": "interested",        "display_name": "Interested",         "category": "interest"},
    {"disposition_key": "not_interested",    "display_name": "Not Interested",     "category": "interest"},
    {"disposition_key": "qualified",         "display_name": "Qualified",          "category": "qualification"},
    {"disposition_key": "site_visit",        "display_name": "Site Visit Booked",  "category": "qualification"},
    {"disposition_key": "transferred",       "display_name": "Transferred",        "category": "transfer"},
    {"disposition_key": "dnd_request",       "display_name": "DND Requested",      "category": "compliance"},
    {"disposition_key": "failed",            "display_name": "Failed",             "category": "failed"}
  ]'::jsonb
);
