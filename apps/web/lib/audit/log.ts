import type { PoolClient } from "pg";
import { withoutTenant } from "@/lib/db/tenant";

/**
 * Phase 10 security hardening: `audit_logs` (db/migrations/005_knowledge_audit.sql)
 * has existed since Phase 1 — RLS-isolated, indexed on `org_id` — but no
 * application code in Phases 1-9 ever wrote to it. It sat completely
 * unused. This module is the single writer path, wired into the
 * highest-value sensitive-action call sites per the Phase 10 brief:
 *
 * - auth events (login, signup, logout) — `apps/web/app/(auth)/actions.ts`
 * - wallet/billing mutations — `apps/web/lib/billing/wallet.ts`
 * - reseller pricing/branding changes — `apps/web/app/dashboard/reseller/actions.ts`
 * - role/org-hierarchy changes — `apps/web/lib/reseller/adminActions.ts`
 *
 * NOT instrumented (documented, not silently skipped): every read-only
 * dashboard page, CRM lead/pipeline mutations, and campaign/appointment
 * scheduling — these are lower-value for a first audit-log pass and can be
 * added incrementally without a schema change (same `logAuditEvent` call).
 *
 * Both write paths below go through `record_audit_event()`, a SECURITY
 * DEFINER SQL function (db/migrations/015_phase10_audit_and_rate_limits.sql)
 * — the same escape-hatch pattern as `signup_organization`/`create_session`
 * in 006_auth_functions.sql. This is required, not a convenience: outside a
 * `withTenant()` transaction (auth events, which run via `withoutTenant()`
 * before any org context exists) `current_org_id()` is NULL, so a plain
 * `INSERT` would be rejected by `audit_logs`' own RLS policy
 * (`org_id = current_org_id()`). The function still takes an explicit
 * `org_id` and writes exactly one row scoped to it — never a generic
 * RLS-bypass hole — and the `org_id` passed in is always a value this
 * server process itself just resolved (a fresh login/signup or an existing
 * session's own org), never taken from client-suppliable input.
 */
export type AuditAction =
  | "auth.login_succeeded"
  | "auth.login_failed"
  | "auth.signup"
  | "auth.logout"
  | "billing.wallet_credited"
  | "billing.wallet_debited"
  | "billing.wallet_debit_rejected_insufficient_balance"
  | "reseller.sell_rate_updated"
  | "reseller.branding_updated"
  | "reseller.buy_rate_set"
  | "reseller.customer_org_created"
  | "org.role_promoted";

export interface AuditEvent {
  orgId: string;
  actorUserId?: string | null;
  action: AuditAction;
  targetType?: string;
  targetId?: string;
  metadata?: Record<string, unknown>;
}

/** Write an audit row using an already-open tenant-scoped transaction
 * (preferred — the audit row is then atomic with the action it records). */
export async function logAuditEventTx(client: PoolClient, event: AuditEvent): Promise<void> {
  await client.query("SELECT record_audit_event($1, $2, $3, $4, $5, $6::jsonb)", [
    event.orgId,
    event.actorUserId ?? null,
    event.action,
    event.targetType ?? null,
    event.targetId ?? null,
    JSON.stringify(event.metadata ?? {}),
  ]);
}

/** Write an audit row with its own connection, for call sites that happen
 * outside any `withTenant()` transaction (auth events specifically — see
 * module docstring). Never throws: an audit-log write failure must never
 * break the user-facing action it's describing (e.g. a failed login should
 * still return "invalid credentials" to the caller even if the audit
 * insert itself errors) — errors are swallowed and reported to stderr only. */
export async function logAuditEvent(event: AuditEvent): Promise<void> {
  try {
    await withoutTenant(async (client) => {
      await logAuditEventTx(client, event);
    });
  } catch (err) {
    console.error("audit log write failed (non-fatal):", err);
  }
}
