import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "pg";
import { randomUUID } from "crypto";
import { commitGeneratedConfig, CommitValidationError } from "@/lib/agent-builder/commit";
import { listPipelineStages } from "@/lib/crm/pipeline";
import { listDispositions } from "@/lib/crm/dispositions";
import { listScoringCriteria } from "@/lib/crm/scoring";
import { withTenant } from "@/lib/db/tenant";
import {
  CLARIFICATION_CONFIG,
  DIAGNOSTICS_CONFIG,
  ECOMMERCE_D2C_CONFIG,
  NEEDS_REVIEW_CONFIG,
  REAL_ESTATE_CONFIG,
} from "./fixtures";

/**
 * Proves the Prompt-to-Agent Builder's "commit" step end-to-end against
 * real Postgres, using the exact 3 worked examples from
 * docs/PROMPT_TO_AGENT_BUILDER.md §5 — the same fixtures'
 * Python-parser-side proof lives in
 * services/voice-gateway/tests/agent_builder/test_parser.py.
 */

const ADMIN_URL =
  process.env.DATABASE_URL_MIGRATE ?? "postgresql://postgres:postgres@localhost:5432/ai_calling_agent";

let admin: Client;
let orgId: string;
let userId: string;

beforeAll(async () => {
  admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  const suffix = randomUUID().slice(0, 8);
  const orgRow = await admin.query("INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id", [
    `Agent Builder Test Org ${suffix}`,
    `agent-builder-test-org-${suffix}`,
  ]);
  orgId = orgRow.rows[0].id;
  const userRow = await admin.query(
    "INSERT INTO users (org_id, email, password_hash, role) VALUES ($1, $2, 'x', 'owner') RETURNING id",
    [orgId, `agent-builder-${suffix}@test.local`]
  );
  userId = userRow.rows[0].id;
});

afterAll(async () => {
  await admin.query("DELETE FROM organizations WHERE id = $1", [orgId]);
  await admin.end();
});

describe("commitGeneratedConfig — the 3 worked examples", () => {
  it("real estate: creates agent_prompts + pipeline_stages + dispositions + lead_scoring_criteria", async () => {
    const result = await commitGeneratedConfig({
      orgId,
      userId,
      agentName: "Real Estate Agent",
      sourceDescription: "I'm a real estate broker in Patna...",
      config: REAL_ESTATE_CONFIG,
    });

    expect(result.version).toBe(1);
    expect(result.pipelineStagesCreated).toBe(REAL_ESTATE_CONFIG.suggested_pipeline_stages.length);
    expect(result.dispositionsCreated).toBe(REAL_ESTATE_CONFIG.suggested_dispositions.length);
    expect(result.scoringCriteriaCreated).toBe(REAL_ESTATE_CONFIG.suggested_lead_scoring_criteria.length);

    const agentPromptRow = await withTenant(orgId, userId, (client) =>
      client.query("SELECT * FROM agent_prompts WHERE id = $1", [result.agentPromptId])
    );
    expect(agentPromptRow.rows[0].source).toBe("prompt_to_agent_builder");
    expect(agentPromptRow.rows[0].inferred_vertical).toBe("real_estate");
    expect(agentPromptRow.rows[0].is_active).toBe(true);
    expect(agentPromptRow.rows[0].source_description).toBe("I'm a real estate broker in Patna...");

    const stages = await listPipelineStages(orgId, userId, result.agentId);
    expect(stages.map((s) => s.display_name)).toEqual(REAL_ESTATE_CONFIG.suggested_pipeline_stages);
    const wonStage = stages.find((s) => s.display_name === "Won")!;
    expect(wonStage.is_terminal).toBe(true);
    expect(wonStage.terminal_outcome).toBe("won");
    const lostStage = stages.find((s) => s.display_name === "Lost")!;
    expect(lostStage.terminal_outcome).toBe("lost");

    const dispositions = await listDispositions(orgId, userId, result.agentId);
    expect(dispositions.length).toBe(REAL_ESTATE_CONFIG.suggested_dispositions.length);

    const criteria = await listScoringCriteria(orgId, userId, result.agentId);
    const budgetCriterion = criteria.find((c) => c.display_name === "budget confirmed")!;
    expect(budgetCriterion.weight).toBe(3); // high -> 3
    const financingCriterion = criteria.find((c) => c.display_name === "financing pre-approved")!;
    expect(financingCriterion.weight).toBe(2); // medium -> 2
  });

  it("diagnostics lab: creates rows and preserves compliance_flags in the stored config", async () => {
    const result = await commitGeneratedConfig({
      orgId,
      userId,
      agentName: "Diagnostics Agent",
      sourceDescription: "I run a diagnostic lab chain...",
      config: DIAGNOSTICS_CONFIG,
    });

    const agentPromptRow = await withTenant(orgId, userId, (client) =>
      client.query("SELECT config FROM agent_prompts WHERE id = $1", [result.agentPromptId])
    );
    expect(agentPromptRow.rows[0].config.compliance_flags).toEqual(DIAGNOSTICS_CONFIG.compliance_flags);

    const dispositions = await listDispositions(orgId, userId, result.agentId);
    expect(dispositions.map((d) => d.display_name)).toEqual(
      expect.arrayContaining(["Report Collected", "Escalated to Doctor"])
    );
  });

  it("e-commerce D2C: creates rows with the discount/cart-specific suggestions", async () => {
    const result = await commitGeneratedConfig({
      orgId,
      userId,
      agentName: "D2C Agent",
      sourceDescription: "I sell sarees online...",
      config: ECOMMERCE_D2C_CONFIG,
    });

    const stages = await listPipelineStages(orgId, userId, result.agentId);
    expect(stages.map((s) => s.display_name)).toContain("Cart Abandoned");

    const criteria = await listScoringCriteria(orgId, userId, result.agentId);
    expect(criteria.find((c) => c.display_name === "cart value above threshold")?.weight).toBe(3);
  });

  it("a second commit to the SAME agent creates version 2 and deactivates version 1", async () => {
    const first = await commitGeneratedConfig({
      orgId,
      userId,
      agentName: "Versioned Agent",
      sourceDescription: "v1 description",
      config: REAL_ESTATE_CONFIG,
    });
    const second = await commitGeneratedConfig({
      orgId,
      userId,
      agentId: first.agentId,
      sourceDescription: "v2 description — also handle Diwali sale promotions now",
      config: ECOMMERCE_D2C_CONFIG,
    });

    expect(second.agentId).toBe(first.agentId);
    expect(second.version).toBe(2);

    const rows = await withTenant(orgId, userId, (client) =>
      client.query("SELECT version, is_active FROM agent_prompts WHERE agent_id = $1 ORDER BY version", [
        first.agentId,
      ])
    );
    expect(rows.rows).toEqual([
      { version: 1, is_active: false },
      { version: 2, is_active: true },
    ]);
  });
});

describe("commitGeneratedConfig — safety rails", () => {
  it("refuses to commit a clarification_needed result", async () => {
    await expect(
      commitGeneratedConfig({
        orgId,
        userId,
        agentName: "Should Not Be Created",
        sourceDescription: "I run a clinic...",
        config: CLARIFICATION_CONFIG,
      })
    ).rejects.toThrow(CommitValidationError);
  });

  it("refuses to commit a needs_review-flagged (malformed/incomplete) result", async () => {
    await expect(
      commitGeneratedConfig({
        orgId,
        userId,
        agentName: "Should Not Be Created Either",
        sourceDescription: "...",
        config: NEEDS_REVIEW_CONFIG,
      })
    ).rejects.toThrow(CommitValidationError);
  });

  it("another org cannot see the committed agent's pipeline stages (tenant isolation)", async () => {
    const result = await commitGeneratedConfig({
      orgId,
      userId,
      agentName: "Isolation Test Agent",
      sourceDescription: "...",
      config: REAL_ESTATE_CONFIG,
    });

    const otherOrgRow = await admin.query("INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id", [
      "Other Org For Agent Builder Isolation",
      `other-org-agent-builder-${randomUUID().slice(0, 8)}`,
    ]);
    const otherOrgId = otherOrgRow.rows[0].id;

    const stagesFromOtherOrg = await listPipelineStages(otherOrgId, userId, result.agentId);
    expect(stagesFromOtherOrg).toEqual([]);

    await admin.query("DELETE FROM organizations WHERE id = $1", [otherOrgId]);
  });
});
