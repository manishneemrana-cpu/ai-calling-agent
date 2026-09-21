-- 003_agents_leads_calls.sql
-- Core tenant-scoped domain tables: agents, agent_prompts (Prompt-to-Agent
-- Builder output), leads (vertical-agnostic CRM stub), calls (schema only).

CREATE TABLE agents (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name          text NOT NULL,
  status        text NOT NULL DEFAULT 'draft', -- draft | active | paused
  -- Which provider adapters this agent uses at each layer — a config key,
  -- resolved against provider_accounts/provider_rate_cards, never a
  -- hardcoded provider name in application code.
  telephony_provider_key text,
  stt_provider_key        text,
  tts_provider_key        text,
  llm_provider_key        text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agents_org_id_idx ON agents (org_id);

-- agent_prompts: the Agent Builder config, one row per agent (current
-- version) — this is the single place vertical-specific behavior lives
-- (see docs/ARCHITECTURE.md). `config` stores the full structured-output
-- shape from docs/PROMPT_TO_AGENT_BUILDER.md §3 (persona, greeting,
-- qualification questions, objection handling, tools_needed, knowledge
-- base scaffold, pipeline stages, dispositions, lead scoring criteria).
CREATE TABLE agent_prompts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  agent_id          uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  version           integer NOT NULL DEFAULT 1,
  inferred_vertical text,
  source            text NOT NULL DEFAULT 'manual', -- manual | prompt_to_agent_builder
  source_description text, -- the free-text business description, if generated
  config            jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_active         boolean NOT NULL DEFAULT true,
  created_by        uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agent_prompts_org_id_idx ON agent_prompts (org_id);
CREATE INDEX agent_prompts_agent_id_idx ON agent_prompts (agent_id);

-- leads: vertical-agnostic CRM stub. Pipeline stage/disposition are
-- tenant-defined free text (from suggested_pipeline_stages /
-- suggested_dispositions in the agent config), never a fixed enum tied to
-- one vertical.
CREATE TABLE leads (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  agent_id        uuid REFERENCES agents(id) ON DELETE SET NULL,
  full_name       text,
  phone_number    text,
  email           text,
  pipeline_stage  text NOT NULL DEFAULT 'new',
  disposition     text,
  custom_fields   jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX leads_org_id_idx ON leads (org_id);

-- calls: schema only for Phase 1 — no real telephony/voice logic yet
-- (that's Phase 2/3, services/voice-gateway). Shaped to receive events
-- from the future voice gateway.
CREATE TABLE calls (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  agent_id          uuid REFERENCES agents(id) ON DELETE SET NULL,
  lead_id           uuid REFERENCES leads(id) ON DELETE SET NULL,
  direction         text NOT NULL DEFAULT 'outbound', -- outbound | inbound
  status            text NOT NULL DEFAULT 'queued',   -- queued|ringing|in_progress|completed|failed|no_answer
  from_number       text,
  to_number         text,
  provider_call_id  text, -- id from the telephony provider (Plivo/Exotel/...)
  started_at        timestamptz,
  ended_at          timestamptz,
  duration_seconds  integer,
  transcript        jsonb, -- populated by voice gateway in Phase 2/3
  recording_url     text,
  disposition       text,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX calls_org_id_idx ON calls (org_id);
CREATE INDEX calls_lead_id_idx ON calls (lead_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON agents, agent_prompts, leads, calls TO app_user;

ALTER TABLE agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE agents FORCE ROW LEVEL SECURITY;
CREATE POLICY agents_isolation ON agents
  USING (org_id = current_org_id()) WITH CHECK (org_id = current_org_id());

ALTER TABLE agent_prompts ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_prompts FORCE ROW LEVEL SECURITY;
CREATE POLICY agent_prompts_isolation ON agent_prompts
  USING (org_id = current_org_id()) WITH CHECK (org_id = current_org_id());

ALTER TABLE leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE leads FORCE ROW LEVEL SECURITY;
CREATE POLICY leads_isolation ON leads
  USING (org_id = current_org_id()) WITH CHECK (org_id = current_org_id());

ALTER TABLE calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE calls FORCE ROW LEVEL SECURITY;
CREATE POLICY calls_isolation ON calls
  USING (org_id = current_org_id()) WITH CHECK (org_id = current_org_id());
