import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { Client } from "pg";
import { randomUUID } from "crypto";
import { NextRequest } from "next/server";
import { requireRole, hasRole, InsufficientRoleError, type SessionInfo } from "@/lib/auth";
import { applyWalletTransaction } from "@/lib/billing/wallet";
import { checkRateLimit, RateLimitExceededError } from "@/lib/security/rateLimit";

// getSession() reads the real request's cookies via next/headers, which
// has no meaningful value when a route handler is invoked directly (not
// through an actual Next.js request) — the same reason no other test file
// in this suite calls a getSession()-gated route directly (webhook tests
// use their own shared-secret header instead). Mocked here specifically to
// prove the wallet-topup route's Phase 10 RBAC gate, which sits in front
// of any DB/payment-gateway call the route would otherwise need mocked too.
vi.mock("@/lib/auth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth")>("@/lib/auth");
  return { ...actual, getSession: vi.fn() };
});
const { getSession } = await import("@/lib/auth");
const { POST: walletTopupPost } = await import("@/app/api/billing/wallet/topup/route");

/**
 * Phase 10 security hardening tests, covering the three real gaps this
 * phase closed (see docs/SECURITY_AUDIT.md):
 * 1. Within-org RBAC (`users.role`) was never enforced anywhere before
 *    this phase — only `orgRole` (cross-org: platform/reseller/customer)
 *    was checked. A `viewer` could hit money-moving routes.
 * 2. `audit_logs` existed since Phase 1 but nothing ever wrote to it.
 * 3. No rate limiting existed on any public-facing endpoint.
 */

const ADMIN_URL =
  process.env.DATABASE_URL_MIGRATE ?? "postgresql://postgres:postgres@localhost:5432/ai_calling_agent";

let admin: Client;
let orgId: string;

function fakeSession(role: SessionInfo["role"]): SessionInfo {
  return { userId: randomUUID(), orgId, role, orgRole: "customer" };
}

beforeAll(async () => {
  process.env.PROVIDER_CONFIG_ENCRYPTION_KEY ??= "test-only-encryption-key-do-not-use-in-prod";
  admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  const suffix = randomUUID().slice(0, 8);
  const orgRow = await admin.query("INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id", [
    `Security Test Org ${suffix}`,
    `security-test-org-${suffix}`,
  ]);
  orgId = orgRow.rows[0].id;
});

afterAll(async () => {
  await admin.query("DELETE FROM organizations WHERE id = $1", [orgId]);
  await admin.end();
});

describe("requireRole / hasRole — within-org RBAC", () => {
  it("ranks roles viewer < agent_manager < admin < owner", () => {
    expect(hasRole(fakeSession("owner"), "admin")).toBe(true);
    expect(hasRole(fakeSession("admin"), "owner")).toBe(false);
    expect(hasRole(fakeSession("agent_manager"), "agent_manager")).toBe(true);
    expect(hasRole(fakeSession("viewer"), "agent_manager")).toBe(false);
  });

  it("requireRole throws InsufficientRoleError for a role below the bar, passes at/above it", () => {
    expect(() => requireRole(fakeSession("viewer"), "admin")).toThrow(InsufficientRoleError);
    expect(() => requireRole(fakeSession("admin"), "admin")).not.toThrow();
    expect(() => requireRole(fakeSession("owner"), "admin")).not.toThrow();
  });
});

describe("wallet topup route — RBAC enforcement (Phase 10 fix)", () => {
  function topupReq(): NextRequest {
    return new NextRequest("http://localhost/api/billing/wallet/topup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ amount: 100 }),
    });
  }

  it("a viewer cannot initiate a wallet top-up order (403) — before this phase, any session could", async () => {
    vi.mocked(getSession).mockResolvedValueOnce(fakeSession("viewer"));
    const res = await walletTopupPost(topupReq());
    expect(res.status).toBe(403);
  });

  it("agent_manager also cannot (billing is admin+, matching the reseller pricing/branding bar)", async () => {
    vi.mocked(getSession).mockResolvedValueOnce(fakeSession("agent_manager"));
    const res = await walletTopupPost(topupReq());
    expect(res.status).toBe(403);
  });

  it("no session at all is still 401, not 403 (unauthenticated vs. under-privileged stay distinct)", async () => {
    vi.mocked(getSession).mockResolvedValueOnce(null);
    const res = await walletTopupPost(topupReq());
    expect(res.status).toBe(401);
  });
});

describe("audit_logs — Phase 10 wiring (previously unused table)", () => {
  it("a manual wallet top-up writes a billing.wallet_credited audit row", async () => {
    await applyWalletTransaction({ orgId, type: "credit", reason: "manual_topup", amount: 500 });
    const { rows } = await admin.query(
      `SELECT action, target_type, metadata FROM audit_logs WHERE org_id = $1 AND action = 'billing.wallet_credited' ORDER BY created_at DESC LIMIT 1`,
      [orgId]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].target_type).toBe("wallet");
    expect(Number(rows[0].metadata.amount)).toBe(500);
  });

  it("a rejected overdraft debit writes a billing.wallet_debit_rejected_insufficient_balance audit row", async () => {
    await expect(
      applyWalletTransaction({ orgId, type: "debit", reason: "adjustment", amount: 999999 })
    ).rejects.toThrow();
    const { rows } = await admin.query(
      `SELECT action FROM audit_logs WHERE org_id = $1 AND action = 'billing.wallet_debit_rejected_insufficient_balance'`,
      [orgId]
    );
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });

  it("a per-call charge does NOT flood audit_logs (documented scope decision)", async () => {
    const before = await admin.query(`SELECT count(*)::int AS c FROM audit_logs WHERE org_id = $1`, [orgId]);
    await applyWalletTransaction({ orgId, type: "credit", reason: "manual_topup", amount: 10 });
    await applyWalletTransaction({ orgId, type: "debit", reason: "call_charge", amount: 1 });
    const after = await admin.query(`SELECT count(*)::int AS c FROM audit_logs WHERE org_id = $1`, [orgId]);
    // Exactly one new row (the manual_topup credit) — the call_charge debit
    // adds none, per lib/billing/wallet.ts's documented decision.
    expect(after.rows[0].c - before.rows[0].c).toBe(1);
  });
});

describe("checkRateLimit (Phase 10, Postgres-backed) — previously nonexistent", () => {
  it("allows requests under the limit and rejects once the limit is reached within the window", async () => {
    const key = `test:${randomUUID()}`;
    for (let i = 0; i < 3; i++) {
      await expect(checkRateLimit(key, 3, 60)).resolves.toBeUndefined();
    }
    await expect(checkRateLimit(key, 3, 60)).rejects.toThrow(RateLimitExceededError);
  });

  it("different bucket keys are independent", async () => {
    const keyA = `test:${randomUUID()}`;
    const keyB = `test:${randomUUID()}`;
    await checkRateLimit(keyA, 1, 60);
    await expect(checkRateLimit(keyA, 1, 60)).rejects.toThrow(RateLimitExceededError);
    // keyB has made zero requests yet — must not be affected by keyA's state.
    await expect(checkRateLimit(keyB, 1, 60)).resolves.toBeUndefined();
  });
});
