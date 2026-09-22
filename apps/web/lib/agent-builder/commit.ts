import { withTenant } from "../db/tenant";
import { instantiateStagesFromSuggestions, type SuggestedPipelineStage } from "../crm/pipeline";
import { instantiateDispositionsFromSuggestions, type SuggestedDisposition } from "../crm/dispositions";
import { instantiateScoringCriteriaFromSuggestions } from "../crm/scoring";
import type { GeneratedAgentConfig } from "../voice-gateway/client";

/**
 * The Prompt-to-Agent Builder's "commit" step (docs/PROMPT_TO_AGENT_BUILDER.md
 * §2 Step 3 / §7): writes a fully-generated, tenant-reviewed config into
 * `agent_prompts` and instantiates `pipeline_stages` / `dispositions` /
 * `lead_scoring_criteria` from the SAME `suggested_*` output — reusing
 * Phase 5's existing `instantiate*FromSuggestions` functions verbatim
 * (docs/CRM_LOGIC.md's "Prompt-to-Agent Builder's own output" path), never
 * a re-invented write path. This is the "direct copy suggested_pipeline_stages"
 * mechanism Phase 5 already left open for this exact caller.
 *
 * Nothing here calls the LLM — the config passed in must already be a
 * complete, `needs_review: false`, `clarification_needed: false` result
 * (the API route enforces this before calling `commitGeneratedConfig`).
 * The tenant reviews/edits the generated JSON client-side before this
 * runs, per docs/PROMPT_TO_AGENT_BUILDER.md §2's "always presented for
 * tenant review before going live" rule — this function only performs the
 * actual write once that review is done.
 */

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "stage";
}

// Exact-match only (not substring) — a suggested stage like "Site Visit
// Booked" must NOT be misdetected as terminal just because "booked" also
// happens to be one lab/D2C template's own terminal stage name. This is a
// best-effort heuristic over the builder's plain string suggestions (the
// schema in docs/PROMPT_TO_AGENT_BUILDER.md §3 has no explicit
// is_terminal flag) — the tenant reviews/edits stages in the dashboard
// afterward regardless (§2), so an occasional miss here is not a
// correctness requirement, just a nicer default when it's unambiguous.
const LOST_STAGE_NAMES = new Set(["lost", "closed lost", "closed_lost", "not converted", "declined"]);
const WON_STAGE_NAMES = new Set(["won", "closed won", "closed_won", "converted", "booked"]);

function toStageSuggestion(displayName: string, index: number, total: number): SuggestedPipelineStage {
  const lower = displayName.trim().toLowerCase();
  const isLast = index === total - 1;
  let terminal: SuggestedPipelineStage["terminal_outcome"] = null;
  if (LOST_STAGE_NAMES.has(lower)) {
    terminal = "lost";
  } else if (WON_STAGE_NAMES.has(lower)) {
    terminal = "won";
  }
  return {
    stage_key: slugify(displayName),
    display_name: displayName,
    is_terminal: terminal !== null || (isLast && total > 1),
    terminal_outcome: terminal,
  };
}

function toDispositionSuggestion(displayName: string): SuggestedDisposition {
  return { disposition_key: slugify(displayName), display_name: displayName, category: null };
}

export type CommitGeneratedConfigParams = {
  orgId: string;
  userId: string;
  /** Name for a brand-new agent. Ignored (and required to be absent) when
   * `agentId` is provided — committing a regenerated config to an
   * existing agent per docs/PROMPT_TO_AGENT_BUILDER.md §7's "iteration"
   * note creates a new `agent_prompts` version, never renames the agent. */
  agentName?: string;
  agentId?: string | null;
  sourceDescription: string;
  config: GeneratedAgentConfig;
};

export type CommitGeneratedConfigResult = {
  agentId: string;
  agentPromptId: string;
  version: number;
  pipelineStagesCreated: number;
  dispositionsCreated: number;
  scoringCriteriaCreated: number;
};

export class CommitValidationError extends Error {}

export async function commitGeneratedConfig(params: CommitGeneratedConfigParams): Promise<CommitGeneratedConfigResult> {
  const { orgId, userId, sourceDescription, config } = params;

  if (config.clarification_needed) {
    throw new CommitValidationError("Cannot commit a clarification-needed result — resolve clarification first.");
  }
  if (config.needs_review) {
    throw new CommitValidationError(
      "Cannot commit a config flagged needs_review — the generated output was incomplete/malformed. Regenerate or edit it first."
    );
  }

  const { agentId, agentPromptId, version } = await withTenant(orgId, userId, async (client) => {
    let agentId = params.agentId ?? null;
    if (!agentId) {
      if (!params.agentName || !params.agentName.trim()) {
        throw new CommitValidationError("agentName is required when creating a new agent.");
      }
      const { rows } = await client.query<{ id: string }>(
        "INSERT INTO agents (org_id, name) VALUES ($1, $2) RETURNING id",
        [orgId, params.agentName.trim()]
      );
      agentId = rows[0].id;
    }

    const { rows: verRows } = await client.query<{ next_version: number }>(
      "SELECT COALESCE(MAX(version), 0) + 1 AS next_version FROM agent_prompts WHERE agent_id = $1",
      [agentId]
    );
    const version = verRows[0].next_version;

    // Only one active config per agent at a time — same "current version"
    // convention 003_agents_leads_calls.sql's comment on agent_prompts
    // documents (a real version-history/diff UI is a Phase-1-deferred
    // detail per docs/PROMPT_TO_AGENT_BUILDER.md §7/§8, not built here).
    await client.query("UPDATE agent_prompts SET is_active = false WHERE agent_id = $1 AND is_active = true", [
      agentId,
    ]);

    const { rows: apRows } = await client.query<{ id: string }>(
      `INSERT INTO agent_prompts (org_id, agent_id, version, inferred_vertical, source, source_description, config, is_active, created_by)
       VALUES ($1, $2, $3, $4, 'prompt_to_agent_builder', $5, $6, true, $7)
       RETURNING id`,
      [orgId, agentId, version, config.inferred_vertical, sourceDescription, JSON.stringify(config), userId]
    );

    return { agentId, agentPromptId: apRows[0].id, version };
  });

  const stageSuggestions = config.suggested_pipeline_stages.map((s, i, arr) =>
    toStageSuggestion(s, i, arr.length)
  );
  const dispositionSuggestions = config.suggested_dispositions.map(toDispositionSuggestion);
  const scoringSuggestions = config.suggested_lead_scoring_criteria.map((c) => ({
    criterion: c.criterion,
    weight_hint: c.weight_hint ?? undefined,
  }));

  const [pipelineStages, dispositions, scoringCriteria] = await Promise.all([
    stageSuggestions.length > 0
      ? instantiateStagesFromSuggestions(orgId, userId, agentId, stageSuggestions)
      : Promise.resolve([]),
    dispositionSuggestions.length > 0
      ? instantiateDispositionsFromSuggestions(orgId, userId, agentId, dispositionSuggestions)
      : Promise.resolve([]),
    scoringSuggestions.length > 0
      ? instantiateScoringCriteriaFromSuggestions(orgId, userId, agentId, scoringSuggestions)
      : Promise.resolve([]),
  ]);

  return {
    agentId,
    agentPromptId,
    version,
    pipelineStagesCreated: pipelineStages.length,
    dispositionsCreated: dispositions.length,
    scoringCriteriaCreated: scoringCriteria.length,
  };
}
