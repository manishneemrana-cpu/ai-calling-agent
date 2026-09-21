import { Pool } from "pg";

// The app ALWAYS connects as app_user (see db/migrations/001_extensions_and_core.sql)
// — a non-superuser, NOBYPASSRLS role. Every tenant-scoped table has
// FORCE ROW LEVEL SECURITY, so this connection cannot see cross-tenant rows
// no matter what application code does, as long as `app.current_org_id` is
// set correctly for the transaction (see tenant.ts).
let pool: Pool | undefined;

export function getPool(): Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error("DATABASE_URL is not set");
    }
    pool = new Pool({ connectionString });
  }
  return pool;
}
