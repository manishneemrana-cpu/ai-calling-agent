import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { Client } from "pg";
import { randomUUID, createHmac } from "crypto";
import {
  enqueueOutboundWebhook,
  processDueOutboundWebhooks,
  _BACKOFF_SCHEDULE_MS_FOR_TESTS,
} from "@/lib/webhooks/outboundWebhookSender";
import { encryptSitesnsignSecret } from "@/lib/webhooks/sitesnsignAuth";

/**
 * Proves the generic outbound webhook sender: delivers to a mock target
 * with a verifiable HMAC signature, and retries on failure per its
 * backoff policy (docs/SITESNSIGN_INTEGRATION.md's return-callback
 * direction — this module is generic, not sitesnsign-specific, so these
 * tests exercise it directly against `webhook_subscriptions`/
 * `webhook_deliveries` rather than through any particular call path).
 */

const ADMIN_URL =
  process.env.DATABASE_URL_MIGRATE ?? "postgresql://postgres:postgres@localhost:5432/ai_calling_agent";
const SECRET = "test-outbound-webhook-secret";

let admin: Client;
let orgId: string;

async function makeSubscription(targetUrl: string, eventType = "call.completed"): Promise<string> {
  const enc = encryptSitesnsignSecret(SECRET);
  const { rows } = await admin.query(
    `INSERT INTO webhook_subscriptions (org_id, event_type, target_url, secret_enc) VALUES ($1, $2, $3, $4) RETURNING id`,
    [orgId, eventType, targetUrl, JSON.stringify(enc)]
  );
  return rows[0].id;
}

beforeAll(async () => {
  process.env.PROVIDER_CONFIG_ENCRYPTION_KEY ??= "test-only-encryption-key-do-not-use-in-prod";
  admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  const suffix = randomUUID().slice(0, 8);
  const orgRow = await admin.query("INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id", [
    `Outbound Webhook Test Org ${suffix}`,
    `outbound-webhook-test-org-${suffix}`,
  ]);
  orgId = orgRow.rows[0].id;
});

afterAll(async () => {
  await admin.query("DELETE FROM organizations WHERE id = $1", [orgId]);
  await admin.end();
});

describe("enqueueOutboundWebhook + processDueOutboundWebhooks", () => {
  it("is a no-op when the org has no matching subscription", async () => {
    const ids = await enqueueOutboundWebhook({
      orgId,
      eventType: "call.completed",
      payload: { callId: randomUUID() },
    });
    expect(ids).toEqual([]);
  });

  it("delivers to the target with a correct, verifiable HMAC signature", async () => {
    const subId = await makeSubscription("https://example.test/sitesnsign-callback");
    const callId = randomUUID();
    const ids = await enqueueOutboundWebhook({ orgId, eventType: "call.completed", payload: { callId } });
    expect(ids).toHaveLength(1);

    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = init.body as string;
      const sig = (init.headers as Record<string, string>)["x-ai-calling-agent-signature"];
      const expected = `sha256=${createHmac("sha256", SECRET).update(body, "utf8").digest("hex")}`;
      expect(sig).toBe(expected);
      return new Response("ok", { status: 200 });
    });

    const results = await processDueOutboundWebhooks(10, fetchMock as unknown as typeof fetch);
    const mine = results.find((r) => r.id === ids[0]);
    expect(mine?.outcome).toBe("delivered");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const { rows } = await admin.query("SELECT status, attempts FROM webhook_deliveries WHERE id = $1", [ids[0]]);
    expect(rows[0].status).toBe("delivered");
    expect(rows[0].attempts).toBe(1);

    await admin.query("DELETE FROM webhook_subscriptions WHERE id = $1", [subId]);
  });

  it("retries on failure per the backoff schedule, then exhausts after max_attempts", async () => {
    const subId = await makeSubscription("https://example.test/always-down");
    const ids = await enqueueOutboundWebhook({ orgId, eventType: "call.completed", payload: { callId: randomUUID() } });
    const deliveryId = ids[0];
    const maxAttempts = _BACKOFF_SCHEDULE_MS_FOR_TESTS.length;

    const failingFetch = vi.fn(async () => new Response("nope", { status: 500 }));

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      // Force this delivery to be immediately due regardless of the
      // backoff delay just written, so the test doesn't need real timers.
      await admin.query(`UPDATE webhook_deliveries SET next_attempt_at = now() WHERE id = $1`, [deliveryId]);
      const results = await processDueOutboundWebhooks(10, failingFetch as unknown as typeof fetch);
      const mine = results.find((r) => r.id === deliveryId);
      expect(mine).toBeTruthy();
      if (attempt < maxAttempts) {
        expect(mine?.outcome).toBe("retrying");
      } else {
        expect(mine?.outcome).toBe("exhausted");
      }
    }

    const { rows } = await admin.query("SELECT status, attempts FROM webhook_deliveries WHERE id = $1", [deliveryId]);
    expect(rows[0].status).toBe("exhausted");
    expect(rows[0].attempts).toBe(maxAttempts);
    expect(failingFetch).toHaveBeenCalledTimes(maxAttempts);

    await admin.query("DELETE FROM webhook_subscriptions WHERE id = $1", [subId]);
  });
});
