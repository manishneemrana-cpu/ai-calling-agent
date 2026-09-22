"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getSession, requireRole, InsufficientRoleError } from "@/lib/auth";
import { rotateN8nWebhookToken } from "@/lib/webhooks/n8nToken";

/** Shows the freshly rotated raw token exactly once (it's never readable
 * again after this — only its hash is stored) via a short-lived, httpOnly
 * cookie, same "in-progress state, not a DB write" pattern as the
 * Prompt-to-Agent Builder's draft cookie. */
const NEW_TOKEN_COOKIE = "n8n_new_token";

export async function rotateTokenAction(): Promise<void> {
  const session = await getSession();
  if (!session) redirect("/login");
  try {
    requireRole(session, "admin");
  } catch (err) {
    if (err instanceof InsufficientRoleError) redirect("/dashboard/settings/n8n?error=forbidden");
    throw err;
  }

  const rawToken = await rotateN8nWebhookToken(session.orgId, session.userId);
  const store = await cookies();
  store.set(NEW_TOKEN_COOKIE, rawToken, {
    httpOnly: true,
    sameSite: "lax",
    maxAge: 60 * 5,
    path: "/dashboard/settings/n8n",
  });
  redirect("/dashboard/settings/n8n");
}

export async function readAndClearNewToken(): Promise<string | null> {
  const store = await cookies();
  const value = store.get(NEW_TOKEN_COOKIE)?.value ?? null;
  if (value) store.delete(NEW_TOKEN_COOKIE);
  return value;
}
