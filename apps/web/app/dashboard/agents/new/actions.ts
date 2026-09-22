"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getSession, requireRole, InsufficientRoleError } from "@/lib/auth";
import { generateAgentConfig, VoiceGatewayGenerateError, type GeneratedAgentConfig } from "@/lib/voice-gateway/client";
import { commitGeneratedConfig, CommitValidationError } from "@/lib/agent-builder/commit";

/**
 * Server actions backing /dashboard/agents/new — the Prompt-to-Agent
 * Builder's plumbing-proof UI (docs/PROMPT_TO_AGENT_BUILDER.md §2). Same
 * austerity level as every other Phase 1-10 dashboard page: plain
 * `<form action={...}>` server actions, no client-side JS framework state.
 *
 * In-progress builder state (the description, any clarification questions,
 * or a generated-but-not-yet-committed config) is held in a short-lived,
 * httpOnly cookie scoped to this one page — NOT the database (nothing is
 * written until the tenant explicitly confirms via `commitAction`, per
 * docs/PROMPT_TO_AGENT_BUILDER.md §2's "always presented for tenant review
 * before going live" rule) and NOT server memory (would not survive a
 * redirect in a real multi-instance deployment).
 */

const DRAFT_COOKIE = "agent_builder_draft";
const DRAFT_TTL_SECONDS = 60 * 30;

type Draft = {
  description: string;
  clarificationQuestions?: string[];
  config?: GeneratedAgentConfig;
  error?: string;
};

export async function readDraft(): Promise<Draft | null> {
  const store = await cookies();
  const raw = store.get(DRAFT_COOKIE)?.value;
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Draft;
  } catch {
    return null;
  }
}

async function writeDraft(draft: Draft | null): Promise<void> {
  const store = await cookies();
  if (draft === null) {
    store.delete(DRAFT_COOKIE);
    return;
  }
  store.set(DRAFT_COOKIE, JSON.stringify(draft), {
    httpOnly: true,
    sameSite: "lax",
    maxAge: DRAFT_TTL_SECONDS,
    path: "/dashboard/agents/new",
  });
}

export async function generateAction(formData: FormData): Promise<void> {
  const session = await getSession();
  if (!session) redirect("/login");

  const description = String(formData.get("description") ?? "").trim();
  if (!description) {
    await writeDraft({ description: "", error: "Please describe your business first." });
    redirect("/dashboard/agents/new");
  }

  try {
    const config = await generateAgentConfig({ orgId: session.orgId, userId: session.userId, description });
    if (config.clarification_needed) {
      await writeDraft({ description, clarificationQuestions: config.clarification_questions });
    } else {
      await writeDraft({ description, config });
    }
  } catch (err) {
    const message = err instanceof VoiceGatewayGenerateError ? err.message : "Generation failed — please try again.";
    await writeDraft({ description, error: message });
  }
  redirect("/dashboard/agents/new");
}

export async function clarifyAction(formData: FormData): Promise<void> {
  const session = await getSession();
  if (!session) redirect("/login");

  const description = String(formData.get("description") ?? "").trim();
  const answers = String(formData.get("answers") ?? "").trim();
  if (!description || !answers) {
    await writeDraft({ description, error: "Please answer the question(s) before continuing." });
    redirect("/dashboard/agents/new");
  }

  try {
    const config = await generateAgentConfig({
      orgId: session.orgId,
      userId: session.userId,
      description,
      clarificationAnswers: answers,
    });
    if (config.clarification_needed) {
      // Still ambiguous after one round of clarification — surface the
      // (possibly new) questions again rather than looping silently.
      await writeDraft({ description, clarificationQuestions: config.clarification_questions });
    } else {
      await writeDraft({ description, config });
    }
  } catch (err) {
    const message = err instanceof VoiceGatewayGenerateError ? err.message : "Generation failed — please try again.";
    await writeDraft({ description, error: message });
  }
  redirect("/dashboard/agents/new");
}

export async function commitAction(formData: FormData): Promise<void> {
  const session = await getSession();
  if (!session) redirect("/login");

  const description = String(formData.get("description") ?? "");
  const agentName = String(formData.get("agentName") ?? "").trim();
  const configRaw = String(formData.get("config") ?? "");

  let config: GeneratedAgentConfig;
  try {
    config = JSON.parse(configRaw) as GeneratedAgentConfig;
  } catch {
    await writeDraft({ description, error: "Lost the generated config — please regenerate." });
    redirect("/dashboard/agents/new");
  }

  try {
    requireRole(session, "admin");
    await commitGeneratedConfig({
      orgId: session.orgId,
      userId: session.userId,
      agentName,
      sourceDescription: description,
      config,
    });
  } catch (err) {
    const message =
      err instanceof CommitValidationError
        ? err.message
        : err instanceof InsufficientRoleError
          ? "Only an org admin can confirm and create an agent."
          : "Could not save the agent — please try again.";
    await writeDraft({ description, config, error: message });
    redirect("/dashboard/agents/new");
  }

  await writeDraft(null);
  redirect("/dashboard/agents");
}

export async function resetAction(): Promise<void> {
  await writeDraft(null);
  redirect("/dashboard/agents/new");
}
