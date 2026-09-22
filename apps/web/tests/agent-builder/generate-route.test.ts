import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { Client } from "pg";
import { randomUUID } from "crypto";
import { NextRequest } from "next/server";
import type { SessionInfo } from "@/lib/auth";
import { REAL_ESTATE_CONFIG, CLARIFICATION_CONFIG } from "./fixtures";

/**
 * Proves the two Prompt-to-Agent Builder API routes end-to-end: the
 * generate route (stubbing `fetch` to the voice-gateway, same pattern as
 * tests/voice-gateway/call-answered-wiring.test.ts — the voice-gateway
 * side's own request-handling is proven independently by
 * services/voice-gateway/tests/agent_builder/test_api.py), and the commit
 * route (real Postgres, no voice-gateway call at all).
 *
 * `getSession()` is mocked rather than driven through a real cookie — same
 * reasoning as tests/security/rbac-audit-ratelimit.test.ts: it reads the
 * request's cookies via `next/headers`, which has no meaningful value when
 * a route handler is invoked directly in a unit test.
 */
vi.mock("@/lib/auth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth")>("@/lib/auth");
  return { ...actual, getSession: vi.fn() };
});
const { getSession } = await import("@/lib/auth");
const { POST: generatePOST } = await import("@/app/api/agents/generate-from-prompt/route");
const { POST: commitPOST } = await import("@/app/api/agents/generate-from-prompt/commit/route");

const ADMIN_URL =
  process.env.DATABASE_URL_MIGRATE ?? "postgresql://postgres:postgres@localhost:5432/ai_calling_agent";

let admin: Client;
let orgId: string;
let userId: string;

function fakeSession(role: SessionInfo["role"]): SessionInfo {
  return { userId, orgId, role, orgRole: "customer" };
}

beforeAll(async () => {
  admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  const suffix = randomUUID().slice(0, 8);
  const orgRow = await admin.query("INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id", [
    `Agent Builder Route Test Org ${suffix}`,
    `agent-builder-route-test-org-${suffix}`,
  ]);
  orgId = orgRow.rows[0].id;
  const userRow = await admin.query(
    "INSERT INTO users (org_id, email, password_hash, role) VALUES ($1, $2, 'x', 'owner') RETURNING id",
    [orgId, `agent-builder-route-${suffix}@test.local`]
  );
  userId = userRow.rows[0].id;
});

afterAll(async () => {
  await admin.query("DELETE FROM organizations WHERE id = $1", [orgId]);
  await admin.end();
});

beforeEach(() => {
  vi.restoreAllMocks();
});

function req(url: string, body: unknown): NextRequest {
  return new NextRequest(url, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

describe("POST /api/agents/generate-from-prompt", () => {
  it("passes the description through to the voice-gateway and returns a full generated config", async () => {
    vi.mocked(getSession).mockResolvedValue(fakeSession("owner"));
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(REAL_ESTATE_CONFIG), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await generatePOST(
      req("http://localhost/api/agents/generate-from-prompt", { description: "I'm a real estate broker in Patna..." })
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.config.inferred_vertical).toBe("real_estate");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [unknown, RequestInit];
    expect(String(url)).toBe("http://localhost:8100/internal/agent-builder/generate");
    const sentBody = JSON.parse(init.body as string);
    expect(sentBody.orgId).toBe(orgId);
    expect(sentBody.description).toBe("I'm a real estate broker in Patna...");

    vi.unstubAllGlobals();
  });

  it("passes through a clarification_needed response unchanged", async () => {
    vi.mocked(getSession).mockResolvedValue(fakeSession("owner"));
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(CLARIFICATION_CONFIG), { status: 200 })));

    const res = await generatePOST(
      req("http://localhost/api/agents/generate-from-prompt", {
        description: "I run a clinic and want to call people about my business.",
      })
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.config.clarification_needed).toBe(true);
    expect(body.config.clarification_questions.length).toBeGreaterThan(0);

    vi.unstubAllGlobals();
  });

  it("rejects an empty description without calling the voice-gateway", async () => {
    vi.mocked(getSession).mockResolvedValue(fakeSession("owner"));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const res = await generatePOST(req("http://localhost/api/agents/generate-from-prompt", { description: "  " }));

    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("rejects an oversized description (input-bounding, per Phase 10 discipline)", async () => {
    vi.mocked(getSession).mockResolvedValue(fakeSession("owner"));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const res = await generatePOST(
      req("http://localhost/api/agents/generate-from-prompt", { description: "x".repeat(5000) })
    );

    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("401s an unauthenticated request", async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    const res = await generatePOST(req("http://localhost/api/agents/generate-from-prompt", { description: "hello" }));
    expect(res.status).toBe(401);
  });

  it("surfaces a voice-gateway outage as a 502, not a crash", async () => {
    vi.mocked(getSession).mockResolvedValue(fakeSession("owner"));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      })
    );

    const res = await generatePOST(
      req("http://localhost/api/agents/generate-from-prompt", { description: "I sell sarees online." })
    );
    expect(res.status).toBe(502);
    vi.unstubAllGlobals();
  });
});

describe("POST /api/agents/generate-from-prompt/commit", () => {
  it("creates the agent for an admin+ role", async () => {
    vi.mocked(getSession).mockResolvedValue(fakeSession("owner"));
    const res = await commitPOST(
      req("http://localhost/api/agents/generate-from-prompt/commit", {
        agentName: "Route Test Agent",
        sourceDescription: "desc",
        config: REAL_ESTATE_CONFIG,
      })
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.pipelineStagesCreated).toBe(REAL_ESTATE_CONFIG.suggested_pipeline_stages.length);
  });

  it("403s a viewer role (below the admin+ bar for this mutation)", async () => {
    vi.mocked(getSession).mockResolvedValue(fakeSession("viewer"));
    const res = await commitPOST(
      req("http://localhost/api/agents/generate-from-prompt/commit", {
        agentName: "Should Be Rejected",
        sourceDescription: "desc",
        config: REAL_ESTATE_CONFIG,
      })
    );
    expect(res.status).toBe(403);
  });

  it("400s a clarification_needed config at the schema level", async () => {
    vi.mocked(getSession).mockResolvedValue(fakeSession("owner"));
    const res = await commitPOST(
      req("http://localhost/api/agents/generate-from-prompt/commit", {
        agentName: "Should Be Rejected",
        sourceDescription: "desc",
        config: CLARIFICATION_CONFIG,
      })
    );
    expect(res.status).toBe(400);
  });
});
