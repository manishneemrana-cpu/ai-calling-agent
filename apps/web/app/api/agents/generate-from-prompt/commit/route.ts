import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSession, requireRole, InsufficientRoleError } from "@/lib/auth";
import { commitGeneratedConfig, CommitValidationError } from "@/lib/agent-builder/commit";
import type { GeneratedAgentConfig } from "@/lib/voice-gateway/client";

/**
 * POST /api/agents/generate-from-prompt/commit — the Prompt-to-Agent
 * Builder's "commit" step (docs/PROMPT_TO_AGENT_BUILDER.md §2 Step 3):
 * takes the config the tenant reviewed (and may have edited) client-side
 * and writes it into `agent_prompts` + `pipeline_stages` / `dispositions`
 * / `lead_scoring_criteria`, via `lib/agent-builder/commit.ts`.
 *
 * Gated at `admin`+ (same bar as the reseller pricing/branding and billing
 * top-up mutations — see docs/SECURITY_AUDIT.md §2): this creates the
 * live configuration a calling agent will actually use, not a read-only
 * preview like the generate step above.
 */
const weightHint = z.enum(["high", "medium", "low"]).nullable().optional();

const configSchema = z.object({
  clarification_needed: z.literal(false),
  inferred_vertical: z.string().nullable(),
  inferred_vertical_confidence: z.enum(["high", "medium", "low"]).nullable(),
  agent_persona: z
    .object({ name: z.string().nullable(), tone: z.string().nullable(), language_style: z.string().nullable() })
    .nullable(),
  greeting_script: z.string().nullable(),
  qualification_questions: z.array(
    z.object({ question: z.string(), purpose: z.string().nullable(), maps_to_field: z.string().nullable() })
  ),
  objection_handling: z.array(z.object({ objection: z.string(), response_stub: z.string().nullable() })),
  tools_needed: z.array(
    z.object({ tool_name: z.string(), description: z.string().nullable(), example_use: z.string().nullable() })
  ),
  knowledge_base_suggested_categories: z.array(z.string()),
  knowledge_base_seed_faqs: z.array(z.object({ question: z.string(), answer_stub: z.string().nullable() })),
  suggested_pipeline_stages: z.array(z.string()),
  suggested_dispositions: z.array(z.string()),
  suggested_lead_scoring_criteria: z.array(z.object({ criterion: z.string(), weight_hint: weightHint })),
  compliance_flags: z.array(z.string()),
  needs_review: z.literal(false),
  raw_llm_output: z.string().nullable(),
});

const schema = z.object({
  agentName: z.string().trim().min(1).max(200).optional(),
  agentId: z.string().uuid().optional(),
  sourceDescription: z.string().trim().min(1).max(4000),
  config: configSchema,
});

export async function POST(req: NextRequest): Promise<NextResponse> {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    requireRole(session, "admin");
  } catch (err) {
    if (err instanceof InsufficientRoleError) {
      return NextResponse.json({ error: err.message }, { status: 403 });
    }
    throw err;
  }

  const json = await req.json().catch(() => null);
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid input" }, { status: 400 });
  }

  try {
    const result = await commitGeneratedConfig({
      orgId: session.orgId,
      userId: session.userId,
      agentName: parsed.data.agentName,
      agentId: parsed.data.agentId,
      sourceDescription: parsed.data.sourceDescription,
      config: parsed.data.config as GeneratedAgentConfig,
    });
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    if (err instanceof CommitValidationError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }
}
