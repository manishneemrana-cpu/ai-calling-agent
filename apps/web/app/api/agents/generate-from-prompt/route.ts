import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSession } from "@/lib/auth";
import { generateAgentConfig, VoiceGatewayGenerateError } from "@/lib/voice-gateway/client";

/**
 * POST /api/agents/generate-from-prompt — the Prompt-to-Agent Builder's
 * generation endpoint (docs/PROMPT_TO_AGENT_BUILDER.md §2 Step 1/2). A
 * tenant submits a free-text business description; this either returns
 * `clarification_needed: true` with 1-3 targeted questions (send the same
 * description back with `clarificationAnswers` filled in to complete
 * generation — still one LLM call per request, per the doc's design), or
 * a full generated config for the tenant to review before calling
 * `POST /api/agents/generate-from-prompt/commit`.
 *
 * This route NEVER writes to the database — generation and commit are
 * deliberately separate steps so a tenant always reviews before anything
 * goes live (docs/PROMPT_TO_AGENT_BUILDER.md §2's "always presented for
 * tenant review" rule).
 *
 * Input bounding: the free-text description is the most injection-adjacent
 * input this platform sends to an LLM (docs/PROMPT_TO_AGENT_BUILDER.md's
 * "Implementation" addendum) — length-capped here AND independently
 * re-validated on the voice-gateway side
 * (`voice_gateway/agent_builder/generator.py`), so a caller bypassing this
 * route entirely still can't send an unbounded payload into the LLM call.
 */
const MAX_DESCRIPTION_LENGTH = 4000;
const MAX_CLARIFICATION_ANSWER_LENGTH = 2000;

const schema = z.object({
  description: z.string().trim().min(1, "description must not be empty").max(MAX_DESCRIPTION_LENGTH),
  clarificationAnswers: z.string().trim().max(MAX_CLARIFICATION_ANSWER_LENGTH).optional(),
});

export async function POST(req: NextRequest): Promise<NextResponse> {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const json = await req.json().catch(() => null);
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid input" }, { status: 400 });
  }

  try {
    const config = await generateAgentConfig({
      orgId: session.orgId,
      userId: session.userId,
      description: parsed.data.description,
      clarificationAnswers: parsed.data.clarificationAnswers ?? null,
    });
    return NextResponse.json({ config }, { status: 200 });
  } catch (err) {
    if (err instanceof VoiceGatewayGenerateError) {
      return NextResponse.json({ error: err.message }, { status: 502 });
    }
    throw err;
  }
}
