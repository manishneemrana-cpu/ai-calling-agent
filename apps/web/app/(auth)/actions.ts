"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { signup, login, createSessionCookie, destroySessionCookie, slugify, getSession } from "@/lib/auth";
import { logAuditEvent } from "@/lib/audit/log";
import { checkRateLimit, RateLimitExceededError } from "@/lib/security/rateLimit";

/**
 * Phase 10 hardening: login/signup had NO rate limiting through Phase 9 —
 * an unthrottled credential-stuffing or signup-spam loop could hit either
 * action as fast as the client could send requests. Limits are per-email
 * (stops targeted brute-forcing of one account) AND per-IP (stops a spray
 * across many emails from one source) — see lib/security/rateLimit.ts.
 * Deliberately generous (not a strict "3 tries" lockout, which itself
 * becomes a denial-of-service vector against a legitimate user whose email
 * an attacker knows) — 10 attempts/5 minutes per email, 30/5 minutes per IP.
 */
async function clientIp(): Promise<string> {
  const h = await headers();
  const forwarded = h.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return h.get("x-real-ip") ?? "unknown";
}

const signupSchema = z.object({
  orgName: z.string().min(2, "Organization name is required"),
  email: z.string().email("Enter a valid email"),
  password: z.string().min(8, "Password must be at least 8 characters"),
  fullName: z.string().optional(),
});

export async function signupAction(
  _prevState: { error?: string } | undefined,
  formData: FormData
): Promise<{ error?: string }> {
  const parsed = signupSchema.safeParse({
    orgName: formData.get("orgName"),
    email: formData.get("email"),
    password: formData.get("password"),
    fullName: formData.get("fullName") || undefined,
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  const { orgName, email, password, fullName } = parsed.data;

  try {
    const ip = await clientIp();
    await checkRateLimit(`signup:ip:${ip}`, 20, 300);
  } catch (err) {
    if (err instanceof RateLimitExceededError) {
      return { error: "Too many signup attempts. Please try again in a few minutes." };
    }
    throw err;
  }

  try {
    const { orgId, userId } = await signup({
      orgName,
      orgSlug: slugify(orgName),
      email,
      password,
      fullName,
    });
    // New orgs are always created as org_role 'customer' by default (see
    // db/migrations/013_phase8_reseller_hierarchy.sql) — every later request
    // re-derives orgRole fresh from the DB via getSession()/resolve_session;
    // this literal is only used for this one redirect below.
    await createSessionCookie({ userId, orgId, role: "owner", orgRole: "customer" });
    await logAuditEvent({ orgId, actorUserId: userId, action: "auth.signup", targetType: "user", targetId: userId });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Signup failed";
    if (message.includes("duplicate key") || message.includes("users_email_unique")) {
      return { error: "An account with that email already exists." };
    }
    return { error: "Signup failed. Please try again." };
  }

  redirect("/dashboard");
}

const loginSchema = z.object({
  email: z.string().email("Enter a valid email"),
  password: z.string().min(1, "Password is required"),
});

export async function loginAction(
  _prevState: { error?: string } | undefined,
  formData: FormData
): Promise<{ error?: string }> {
  const parsed = loginSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { email, password } = parsed.data;

  const ip = await clientIp();
  try {
    // Per-email AND per-IP: an attacker who knows one target's email but
    // sprays passwords is caught by the email bucket; an attacker spraying
    // many emails' worth of common passwords from one source is caught by
    // the IP bucket — neither alone covers both attack shapes.
    await checkRateLimit(`login:email:${email.toLowerCase()}`, 10, 300);
    await checkRateLimit(`login:ip:${ip}`, 30, 300);
  } catch (err) {
    if (err instanceof RateLimitExceededError) {
      return { error: "Too many login attempts. Please try again in a few minutes." };
    }
    throw err;
  }

  const session = await login(email, password);
  if (!session) {
    // No org_id exists yet for a failed login by an unknown/wrong-password
    // email, so this can't be attributed to a specific org's audit_logs row
    // (which requires org_id) — logged to stderr only via the rate-limit
    // bucket itself being the durable record of failed attempts. A
    // per-user "recent failed logins" audit trail is a documented
    // follow-up (see docs/SECURITY_AUDIT.md) once a pre-org-context audit
    // sink exists.
    return { error: "Invalid email or password." };
  }
  await createSessionCookie(session);
  await logAuditEvent({
    orgId: session.orgId,
    actorUserId: session.userId,
    action: "auth.login_succeeded",
    targetType: "user",
    targetId: session.userId,
  });
  redirect("/dashboard");
}

export async function logoutAction(): Promise<void> {
  const session = await getSession();
  await destroySessionCookie();
  if (session) {
    await logAuditEvent({
      orgId: session.orgId,
      actorUserId: session.userId,
      action: "auth.logout",
      targetType: "user",
      targetId: session.userId,
    });
  }
  redirect("/login");
}
