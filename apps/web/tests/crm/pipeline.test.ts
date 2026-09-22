import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "pg";
import { randomUUID } from "crypto";
import {
  instantiatePipelineTemplate,
  instantiateStagesFromSuggestions,
  listPipelineStages,
  listPipelineStageTemplates,
  transitionLeadStage,
  getLeadStageHistory,
} from "@/lib/crm/pipeline";
import { instantiateDispositionTemplate, listDispositions } from "@/lib/crm/dispositions";

/**
 * Proves Phase 5's pipeline mechanism end-to-end against real Postgres,
 * same pattern as tests/tenant-isolation.test.ts and
 * tests/providers/registry.test.ts: seed as the migration/admin role,
 * exercise through the exact app_user/withTenant path production uses.
 */

const ADMIN_URL =
  process.env.DATABASE_URL_MIGRATE ?? "postgresql://postgres:postgres@localhost:5432/ai_calling_agent";

let admin: Client;
let orgId: string;
let userId: string;
let agentId: string;
let leadId: string;

beforeAll(async () => {
  admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();

  const suffix = randomUUID().slice(0, 8);
  const orgRow = await admin.query("INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id", [
    `CRM Test Org ${suffix}`,
    `crm-test-org-${suffix}`,
  ]);
  orgId = orgRow.rows[0].id;

  const userRow = await admin.query(
    "INSERT INTO users (org_id, email, password_hash, role) VALUES ($1, $2, 'x', 'owner') RETURNING id",
    [orgId, `crm-${suffix}@test.local`]
  );
  userId = userRow.rows[0].id;

  const agentRow = await admin.query("INSERT INTO agents (org_id, name) VALUES ($1, 'CRM Test Agent') RETURNING id", [
    orgId,
  ]);
  agentId = agentRow.rows[0].id;

  const leadRow = await admin.query(
    "INSERT INTO leads (org_id, agent_id, full_name, phone_number) VALUES ($1, $2, 'Test Lead', '+911234567890') RETURNING id",
    [orgId, agentId]
  );
  leadId = leadRow.rows[0].id;
});

afterAll(async () => {
  await admin.query("DELETE FROM organizations WHERE id = $1", [orgId]);
  await admin.end();
});

describe("pipeline stage templates (multi-industry catalog)", () => {
  it("lists both the generic_default and real_estate templates", async () => {
    const templates = await listPipelineStageTemplates(orgId, userId);
    const keys = templates.map((t) => t.template_key);
    expect(keys).toEqual(expect.arrayContaining(["generic_default", "real_estate"]));
  });

  it("instantiates the generic_default template into org-level pipeline_stages", async () => {
    const stages = await instantiatePipelineTemplate(orgId, userId, "generic_default");
    expect(stages.length).toBeGreaterThan(0);
    const keys = stages.map((s) => s.stage_key);
    expect(keys).toContain("new");
    expect(keys).toContain("closed_won");
    expect(keys).not.toContain("site_visit"); // real-estate-only stage never leaks into the generic template

    const listed = await listPipelineStages(orgId, userId, null);
    expect(listed.length).toBe(stages.length);
    expect(listed[0].sort_order).toBe(0);
  });

  it("instantiates the real_estate template scoped to one agent, independent of the org-level default", async () => {
    const stages = await instantiatePipelineTemplate(orgId, userId, "real_estate", agentId);
    const keys = stages.map((s) => s.stage_key);
    expect(keys).toContain("site_visit");
    expect(keys).toContain("booking");

    const agentStages = await listPipelineStages(orgId, userId, agentId);
    expect(agentStages.length).toBe(stages.length);

    const orgLevelStages = await listPipelineStages(orgId, userId, null);
    // Org-level default (from the previous test) is untouched by the agent-scoped instantiation.
    expect(orgLevelStages.every((s) => s.agent_id === null)).toBe(true);
  });

  it("builds stages directly from Prompt-to-Agent-Builder suggestions, never a fixed template", async () => {
    const bespokeAgent = await admin.query("INSERT INTO agents (org_id, name) VALUES ($1, 'Bespoke Agent') RETURNING id", [
      orgId,
    ]);
    const bespokeAgentId = bespokeAgent.rows[0].id;

    const stages = await instantiateStagesFromSuggestions(orgId, userId, bespokeAgentId, [
      { stage_key: "report_ready", display_name: "Report Ready" },
      { stage_key: "notified", display_name: "Notified" },
      { stage_key: "booked", display_name: "Booked", is_terminal: true, terminal_outcome: "won" },
      { stage_key: "declined", display_name: "Declined", is_terminal: true, terminal_outcome: "lost" },
    ]);
    expect(stages.map((s) => s.stage_key)).toEqual(["report_ready", "notified", "booked", "declined"]);
    expect(stages[2].is_terminal).toBe(true);
    expect(stages[2].terminal_outcome).toBe("won");
  });

  it("rejects an unknown template key", async () => {
    await expect(instantiatePipelineTemplate(orgId, userId, "not_a_real_template")).rejects.toThrow();
  });
});

describe("disposition templates", () => {
  it("instantiates the default disposition set and it matches the master spec's list", async () => {
    const dispositions = await instantiateDispositionTemplate(orgId, userId, "default");
    const keys = dispositions.map((d) => d.disposition_key);
    expect(keys).toEqual(
      expect.arrayContaining([
        "connected",
        "no_answer",
        "busy",
        "wrong_number",
        "callback",
        "interested",
        "not_interested",
        "qualified",
        "site_visit",
        "transferred",
        "dnd_request",
        "failed",
      ])
    );

    const listed = await listDispositions(orgId, userId, null);
    expect(listed.length).toBe(dispositions.length);
  });
});

describe("lead pipeline transitions + lead_stage_history (every change timestamped)", () => {
  it("records a transition with a timestamp and links from/to stage names", async () => {
    const stages = await listPipelineStages(orgId, userId, null);
    const newStage = stages.find((s) => s.stage_key === "new")!;
    const qualifiedStage = stages.find((s) => s.stage_key === "qualified")!;

    const first = await transitionLeadStage(orgId, userId, leadId, newStage.id, "initial contact");
    expect(first.from_stage_id).toBeNull();
    expect(first.to_stage_name).toBe("New");
    expect(first.created_at).toBeTruthy();

    const second = await transitionLeadStage(orgId, userId, leadId, qualifiedStage.id, "qualified on call");
    expect(second.from_stage_id).toBe(newStage.id);
    expect(second.to_stage_name).toBe("Qualified");

    const history = await getLeadStageHistory(orgId, userId, leadId);
    expect(history.length).toBe(2);
    expect(history[0].to_stage_name).toBe("New");
    expect(history[1].to_stage_name).toBe("Qualified");
    expect(new Date(history[1].created_at).getTime()).toBeGreaterThanOrEqual(
      new Date(history[0].created_at).getTime()
    );
  });

  it("allows jumping straight to a terminal stage (freely-jumpable, not strictly ordered — see docs/CRM_LOGIC.md)", async () => {
    const stages = await listPipelineStages(orgId, userId, null);
    const lostStage = stages.find((s) => s.stage_key === "closed_lost")!;

    const jump = await transitionLeadStage(orgId, userId, leadId, lostStage.id, "not interested on first call");
    expect(jump.to_stage_name).toBe("Closed Lost");
  });

  it("rejects a transition to a stage id from a different org", async () => {
    const otherOrg = await admin.query("INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id", [
      "Other Org For Stage Test",
      `other-org-stage-${randomUUID().slice(0, 8)}`,
    ]);
    const otherOrgId = otherOrg.rows[0].id;
    const otherStages = await instantiatePipelineTemplate(otherOrgId, userId, "generic_default");

    await expect(transitionLeadStage(orgId, userId, leadId, otherStages[0].id)).rejects.toThrow();

    await admin.query("DELETE FROM organizations WHERE id = $1", [otherOrgId]);
  });
});
