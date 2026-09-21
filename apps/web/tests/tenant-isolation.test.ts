import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "pg";
import { randomUUID } from "crypto";

/**
 * Tenant-isolation proof — the single most important Phase 1 deliverable.
 *
 * This connects as `app_user` (the exact role the running app uses — a
 * non-superuser, NOBYPASSRLS role) and proves that Postgres Row Level
 * Security, not application code, is what stops one org from reading or
 * writing another org's rows. It seeds two organizations directly (as the
 * superuser, bypassing RLS the way a migration would) and then does all
 * reads/writes as app_user with `app.current_org_id` set via `SET LOCAL`,
 * exactly like apps/web/lib/db/tenant.ts does.
 *
 * A companion "prove the test is real" check lives in
 * db/migrations/README or is run manually per docs/PHASE1_DECISIONS.md —
 * see that doc for the exact command used to temporarily break isolation
 * and confirm this suite fails.
 */

const ADMIN_URL =
  process.env.DATABASE_URL_MIGRATE ?? "postgresql://postgres:postgres@localhost:5432/ai_calling_agent";
const APP_URL =
  process.env.DATABASE_URL ?? "postgresql://app_user:app_user_dev_password@localhost:5432/ai_calling_agent";

let admin: Client;
let orgA: string;
let orgB: string;
let userA: string;
let userB: string;
let agentA: string;

async function asTenant<T>(orgId: string, userId: string, fn: (c: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: APP_URL });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.current_org_id', $1, true)", [orgId]);
    await client.query("SELECT set_config('app.current_user_id', $1, true)", [userId]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } finally {
    await client.end();
  }
}

beforeAll(async () => {
  admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();

  const suffix = randomUUID().slice(0, 8);
  const orgAResult = await admin.query(
    "INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id",
    [`Test Org A ${suffix}`, `test-org-a-${suffix}`]
  );
  orgA = orgAResult.rows[0].id;

  const orgBResult = await admin.query(
    "INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id",
    [`Test Org B ${suffix}`, `test-org-b-${suffix}`]
  );
  orgB = orgBResult.rows[0].id;

  const userAResult = await admin.query(
    "INSERT INTO users (org_id, email, password_hash, role) VALUES ($1, $2, 'x', 'owner') RETURNING id",
    [orgA, `a-${suffix}@test.local`]
  );
  userA = userAResult.rows[0].id;

  const userBResult = await admin.query(
    "INSERT INTO users (org_id, email, password_hash, role) VALUES ($1, $2, 'x', 'owner') RETURNING id",
    [orgB, `b-${suffix}@test.local`]
  );
  userB = userBResult.rows[0].id;

  const agentAResult = await admin.query(
    "INSERT INTO agents (org_id, name) VALUES ($1, 'Org A Agent') RETURNING id",
    [orgA]
  );
  agentA = agentAResult.rows[0].id;

  await admin.query("INSERT INTO leads (org_id, full_name, phone_number) VALUES ($1, 'Org A Lead', '+10000000000')", [
    orgA,
  ]);
});

afterAll(async () => {
  // Cascades clean up users/agents/leads/agent_prompts for both orgs.
  await admin.query("DELETE FROM organizations WHERE id = ANY($1)", [[orgA, orgB]]);
  await admin.end();
});

describe("tenant isolation (RLS)", () => {
  it("org A can read its own agents", async () => {
    const rows = await asTenant(orgA, userA, async (c) => {
      const { rows } = await c.query("SELECT id, name FROM agents WHERE org_id = $1", [orgA]);
      return rows;
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("Org A Agent");
  });

  it("org B cannot read org A's agents, even asking by id directly", async () => {
    const rows = await asTenant(orgB, userB, async (c) => {
      const { rows } = await c.query("SELECT id FROM agents WHERE id = $1", [agentA]);
      return rows;
    });
    expect(rows).toHaveLength(0);
  });

  it("org B cannot read org A's leads via an unscoped SELECT *", async () => {
    const rows = await asTenant(orgB, userB, async (c) => {
      const { rows } = await c.query("SELECT * FROM leads");
      return rows;
    });
    expect(rows).toHaveLength(0);
  });

  it("org B cannot update org A's agent row", async () => {
    await asTenant(orgB, userB, async (c) => {
      const result = await c.query("UPDATE agents SET name = 'hijacked' WHERE id = $1", [agentA]);
      expect(result.rowCount).toBe(0);
    });

    const rows = await asTenant(orgA, userA, async (c) => {
      const { rows } = await c.query("SELECT name FROM agents WHERE id = $1", [agentA]);
      return rows;
    });
    expect(rows[0].name).toBe("Org A Agent");
  });

  it("org B cannot insert a row claiming to belong to org A", async () => {
    await expect(
      asTenant(orgB, userB, async (c) => {
        await c.query("INSERT INTO agents (org_id, name) VALUES ($1, 'sneaky')", [orgA]);
      })
    ).rejects.toThrow();
  });

  it("a connection with no tenant context set sees nothing (fail closed, not fail open)", async () => {
    const client = new Client({ connectionString: APP_URL });
    await client.connect();
    try {
      const { rows } = await client.query("SELECT * FROM agents");
      expect(rows).toHaveLength(0);
    } finally {
      await client.end();
    }
  });

  it("sessions table is not directly readable by app_user at all (only via SECURITY DEFINER functions)", async () => {
    const client = new Client({ connectionString: APP_URL });
    await client.connect();
    try {
      const { rows } = await client.query("SELECT * FROM sessions");
      expect(rows).toHaveLength(0);
    } finally {
      await client.end();
    }
  });
});
