import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "pg";
import { randomUUID } from "crypto";
import { rotateN8nWebhookToken, hasN8nWebhookToken } from "@/lib/webhooks/n8nToken";
import { assertValidN8nRequest } from "@/lib/webhooks/n8n-auth";
import { NextRequest } from "next/server";

const ADMIN_URL =
  process.env.DATABASE_URL_MIGRATE ?? "postgresql://postgres:postgres@localhost:5432/ai_calling_agent";

let admin: Client;
let orgId: string;
let userId: string;

beforeAll(async () => {
  admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  const suffix = randomUUID().slice(0, 8);
  const orgRow = await admin.query("INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id", [
    `n8n Token Test Org ${suffix}`,
    `n8n-token-test-org-${suffix}`,
  ]);
  orgId = orgRow.rows[0].id;
  const userRow = await admin.query(
    "INSERT INTO users (org_id, email, password_hash, role) VALUES ($1, $2, 'x', 'owner') RETURNING id",
    [orgId, `n8n-token-${suffix}@test.local`]
  );
  userId = userRow.rows[0].id;
});

afterAll(async () => {
  await admin.query("DELETE FROM organizations WHERE id = $1", [orgId]);
  await admin.end();
});

function tokenReq(token: string): NextRequest {
  return new NextRequest("http://localhost/api/webhooks/n8n/daily-summary", {
    headers: { "x-n8n-webhook-token": token },
  });
}

describe("rotateN8nWebhookToken", () => {
  it("has no token before the first rotate", async () => {
    expect(await hasN8nWebhookToken(orgId, userId)).toBe(false);
  });

  it("generates a working token that resolves back to this org", async () => {
    const token = await rotateN8nWebhookToken(orgId, userId);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(await hasN8nWebhookToken(orgId, userId)).toBe(true);

    const resolvedOrgId = await assertValidN8nRequest(tokenReq(token));
    expect(resolvedOrgId).toBe(orgId);
  });

  it("rotating again invalidates the previous token immediately", async () => {
    const first = await rotateN8nWebhookToken(orgId, userId);
    const second = await rotateN8nWebhookToken(orgId, userId);
    expect(second).not.toBe(first);

    await expect(assertValidN8nRequest(tokenReq(first))).rejects.toThrow();
    await expect(assertValidN8nRequest(tokenReq(second))).resolves.toBe(orgId);
  });
});
