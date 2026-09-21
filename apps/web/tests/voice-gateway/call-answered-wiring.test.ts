import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { Client } from "pg";
import { randomUUID } from "crypto";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/calls/webhook/[providerKey]/route";

/**
 * Proves the "call answered" webhook -> voice-gateway pipeline-instantiation
 * trigger fires correctly using MockTelephony's webhook payload shape — no
 * live telephony account, and no live voice-gateway process, needed (global
 * `fetch` is stubbed and asserted against). This is the apps/web half of
 * the audio-bridge wiring proof; the Python half (the voice-gateway
 * endpoint this POST targets actually resolving providers and building an
 * orchestrator) is proven independently by
 * services/voice-gateway/tests/media_stream/test_internal_api.py.
 */

const ADMIN_URL =
  process.env.DATABASE_URL_MIGRATE ?? "postgresql://postgres:postgres@localhost:5432/ai_calling_agent";

let admin: Client;
let orgId: string;

async function insertCall(providerCallId: string, status: string): Promise<string> {
  const { rows } = await admin.query(
    `INSERT INTO calls (org_id, direction, status, provider_call_id) VALUES ($1, 'outbound', $2, $3) RETURNING id`,
    [orgId, status, providerCallId]
  );
  return rows[0].id;
}

beforeAll(async () => {
  admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  const suffix = randomUUID().slice(0, 8);
  const { rows } = await admin.query(
    "INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id",
    [`Call Answered Wiring Test Org ${suffix}`, `call-answered-wiring-${suffix}`]
  );
  orgId = rows[0].id;
});

afterAll(async () => {
  await admin.query("DELETE FROM organizations WHERE id = $1", [orgId]);
  await admin.end();
});

beforeEach(() => {
  vi.restoreAllMocks();
});

function makeRequest(providerCallId: string, status: string): NextRequest {
  const body = JSON.stringify({ provider_call_id: providerCallId, event_type: "status_callback", status });
  return new NextRequest(`http://localhost/api/calls/webhook/mock`, { method: "POST", body });
}

describe("call-answered webhook -> voice-gateway trigger", () => {
  it("notifies the voice-gateway exactly when a call first becomes in_progress", async () => {
    const providerCallId = `mock_${randomUUID()}`;
    const callId = await insertCall(providerCallId, "ringing");

    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ started: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await POST(makeRequest(providerCallId, "in_progress"), {
      params: Promise.resolve({ providerKey: "mock" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.processed).toBe(true);
    expect(body.callId).toBe(callId);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [unknown, RequestInit];
    expect(String(url)).toBe(`http://localhost:8100/internal/pipelines/${callId}/start`);
    const sentBody = JSON.parse(init.body as string);
    expect(sentBody).toEqual({ orgId, userId: null, providerKey: "mock" });

    vi.unstubAllGlobals();
  });

  it("does not re-notify on a retried webhook delivery of the same event (idempotency)", async () => {
    const providerCallId = `mock_${randomUUID()}`;
    await insertCall(providerCallId, "ringing");

    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    // Same idempotency key (derived from the identical raw body) both
    // times — process_telephony_webhook_event's UNIQUE constraint makes the
    // second delivery `was_new = false`.
    const req1 = makeRequest(providerCallId, "in_progress");
    const rawBody = await req1.clone().text();
    const req2 = new NextRequest(`http://localhost/api/calls/webhook/mock`, { method: "POST", body: rawBody });

    await POST(req1, { params: Promise.resolve({ providerKey: "mock" }) });
    await POST(req2, { params: Promise.resolve({ providerKey: "mock" }) });

    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.unstubAllGlobals();
  });

  it("does not notify for a non-answered status transition (e.g. ringing)", async () => {
    const providerCallId = `mock_${randomUUID()}`;
    await insertCall(providerCallId, "queued");

    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await POST(makeRequest(providerCallId, "ringing"), {
      params: Promise.resolve({ providerKey: "mock" }),
    });

    expect(fetchMock).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });

  it("a voice-gateway outage does not fail the webhook response", async () => {
    const providerCallId = `mock_${randomUUID()}`;
    await insertCall(providerCallId, "ringing");

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      })
    );

    const res = await POST(makeRequest(providerCallId, "in_progress"), {
      params: Promise.resolve({ providerKey: "mock" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.processed).toBe(true);

    vi.unstubAllGlobals();
  });
});
