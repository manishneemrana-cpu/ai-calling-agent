import { randomBytes, createHash } from "crypto";
import bcrypt from "bcryptjs";
import { cookies } from "next/headers";
import { withoutTenant } from "./db/tenant";

export const SESSION_COOKIE = "session";
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days

export type OrgRole = "platform" | "reseller" | "customer";

export type SessionInfo = {
  userId: string;
  orgId: string;
  role: "owner" | "admin" | "agent_manager" | "viewer";
  /** Phase 8: the org's place in the Platform Owner -> Reseller -> Customer
   * hierarchy (organizations.org_role). Defaults to "customer" for the
   * signup path below, where the org was just created (always org_role
   * 'customer' per db/migrations/013_phase8_reseller_hierarchy.sql's
   * default) — every subsequent request re-derives it fresh from the DB
   * via resolve_session(), never trusting a stale cached value. */
  orgRole: OrgRole;
};

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

/** Creates a brand-new org + owner user. See signup_organization() in
 * db/migrations/006_auth_functions.sql for why this needs a SECURITY
 * DEFINER function rather than a normal tenant-scoped insert (there is no
 * tenant yet). */
export async function signup(params: {
  orgName: string;
  orgSlug: string;
  email: string;
  password: string;
  fullName?: string;
}): Promise<{ orgId: string; userId: string }> {
  const passwordHash = await hashPassword(params.password);
  return withoutTenant(async (client) => {
    const { rows } = await client.query(
      "SELECT * FROM signup_organization($1, $2, $3, $4, $5)",
      [params.orgName, params.orgSlug, params.email, passwordHash, params.fullName ?? null]
    );
    return { orgId: rows[0].org_id, userId: rows[0].user_id };
  });
}

export async function login(email: string, password: string): Promise<SessionInfo | null> {
  return withoutTenant(async (client) => {
    const { rows } = await client.query("SELECT * FROM find_user_by_email($1)", [email]);
    if (rows.length === 0) return null;
    const row = rows[0];
    const ok = await verifyPassword(password, row.password_hash);
    if (!ok) return null;
    return { userId: row.user_id, orgId: row.org_id, role: row.role, orgRole: row.org_role as OrgRole };
  });
}

/** Issues a session token, stores its hash, and sets the httpOnly cookie. */
export async function createSessionCookie(session: SessionInfo): Promise<void> {
  const token = randomBytes(32).toString("hex");
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

  await withoutTenant(async (client) => {
    await client.query("SELECT create_session($1, $2, $3, $4)", [
      tokenHash,
      session.userId,
      session.orgId,
      expiresAt.toISOString(),
    ]);
  });

  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    expires: expiresAt,
  });
}

export async function getSession(): Promise<SessionInfo | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const tokenHash = hashToken(token);
  return withoutTenant(async (client) => {
    const { rows } = await client.query("SELECT * FROM resolve_session($1)", [tokenHash]);
    if (rows.length === 0) return null;
    return {
      userId: rows[0].user_id,
      orgId: rows[0].org_id,
      role: rows[0].role,
      orgRole: rows[0].org_role as OrgRole,
    } as SessionInfo;
  });
}

export async function destroySessionCookie(): Promise<void> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  if (token) {
    const tokenHash = hashToken(token);
    await withoutTenant(async (client) => {
      await client.query("SELECT destroy_session($1)", [tokenHash]);
    });
  }
  cookieStore.delete(SESSION_COOKIE);
}

/**
 * Phase 10 security hardening: within-org RBAC.
 *
 * `users.role` (owner | admin | agent_manager | viewer,
 * db/migrations/002_organizations_users_sessions.sql) has existed since
 * Phase 1 and is carried on every `SessionInfo`, but until this phase it was
 * only ever *displayed* (`app/dashboard/page.tsx`: "Your role: {session.role}")
 * — no sensitive route or server action actually checked it. Every
 * authorization decision in this codebase before Phase 10 was either (a)
 * "any authenticated member of this org" or (b) an `orgRole` check
 * (platform/reseller/customer, the Phase 8 cross-org hierarchy). Those are
 * orthogonal: `orgRole` answers "what kind of org is this", `role` answers
 * "what can this specific member of the org do". A `viewer` in a reseller
 * org could previously change that reseller's sell price or top up the
 * org's wallet — this closes that gap.
 *
 * This is an application-level check, not a new RLS boundary (RLS remains
 * the hard tenant-isolation boundary; role is a same-tenant permission
 * question RLS's `org_id` scoping cannot express) — same "UX convenience,
 * not the security boundary" caveat every `orgRole` check in this codebase
 * already carries (see `app/dashboard/reseller/actions.ts`).
 */
export const ROLE_RANK: Record<SessionInfo["role"], number> = {
  viewer: 0,
  agent_manager: 1,
  admin: 2,
  owner: 3,
};

export class InsufficientRoleError extends Error {
  constructor(required: SessionInfo["role"]) {
    super(`This action requires the '${required}' role or higher`);
    this.name = "InsufficientRoleError";
  }
}

/** Throws InsufficientRoleError if session.role is below `minRole`. Call
 * this at the top of any server action / route handler that mutates
 * something more sensitive than the caller's own org membership (billing,
 * reseller pricing/branding, provider credentials, agent config). */
export function requireRole(session: SessionInfo, minRole: SessionInfo["role"]): void {
  if (ROLE_RANK[session.role] < ROLE_RANK[minRole]) {
    throw new InsufficientRoleError(minRole);
  }
}

export function hasRole(session: SessionInfo, minRole: SessionInfo["role"]): boolean {
  return ROLE_RANK[session.role] >= ROLE_RANK[minRole];
}

export function slugify(input: string): string {
  const base = input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)+/g, "");
  const suffix = randomBytes(3).toString("hex");
  return `${base || "org"}-${suffix}`;
}
