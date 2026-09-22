import type { PoolClient } from "pg";
import { getPool } from "./pool";

/**
 * withTenant is the ONLY sanctioned way application code touches
 * tenant-scoped tables. It checks out a connection, opens a transaction,
 * sets `app.current_org_id` (and `app.current_user_id`) as *transaction-local*
 * settings via `SET LOCAL` (never a plain SET — SET LOCAL is guaranteed to
 * reset at COMMIT/ROLLBACK, so a pooled connection can never leak one
 * request's tenant context into the next request that reuses it), then runs
 * the callback and commits.
 *
 * Every RLS policy in db/migrations/*.sql keys off current_org_id() /
 * current_app_user_id(), which read these settings. If this function is
 * bypassed, or `orgId` is wrong, queries simply return zero rows for other
 * tenants' data (FORCE ROW LEVEL SECURITY) rather than leaking it — the
 * database is the hard boundary, not this helper. This helper exists for
 * ergonomics and to make "forgot to scope a query" structurally hard, not
 * because it IS the security boundary.
 */
export async function withTenant<T>(
  orgId: string,
  userId: string | null,
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.current_org_id', $1, true)", [orgId]);
    await client.query("SELECT set_config('app.current_user_id', $1, true)", [userId ?? ""]);
    // Phase 8: app.current_org_role gates platform-only data (e.g.
    // provider_rate_cards — see db/migrations/013_phase8_reseller_hierarchy.sql).
    // Re-derived from the organizations row itself on every transaction
    // (never trusted from a caller-supplied argument or a cached session
    // field) so it can never drift from what the org's role actually is in
    // the DB. Reads its OWN org's row, which RLS already allows once
    // app.current_org_id is set (organizations_isolation: id = current_org_id()).
    const { rows } = await client.query(
      "SELECT org_role FROM organizations WHERE id = current_org_id()"
    );
    await client.query("SELECT set_config('app.current_org_role', $1, true)", [
      rows[0]?.org_role ?? "",
    ]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * withoutTenant is for the narrow set of pre-auth operations (signup,
 * login) that must run before any org context exists. These MUST go
 * through the SECURITY DEFINER functions in
 * db/migrations/006_auth_functions.sql (signup_organization,
 * find_user_by_email, create_session, resolve_session, destroy_session) —
 * app_user has no direct table privileges that would let it read/write
 * organizations or sessions any other way, by design.
 */
export async function withoutTenant<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}
