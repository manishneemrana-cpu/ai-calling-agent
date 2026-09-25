import { createHmac } from "crypto";
import { getPool } from "@/lib/db/pool";
import { withTenant } from "@/lib/db/tenant";
import { decryptProviderConfig, isEncryptedConfig } from "@/lib/providers/crypto";

/**
 * The OUTBOUND webhook delivery module: ai-calling-agent -> a
 * tenant-configured target URL (e.g. sitesnsign.com's own call-summary
 * receiving endpoint — see docs/SITESNSIGN_INTEGRATION.md — but this is
 * generic infra, keyed only by `webhook_subscriptions.event_type`, not
 * sitesnsign-specific in any way).
 *
 * Deliberately its OWN small delivery-log + backoff schedule
 * (`webhook_deliveries`, 017_sitesnsign_integration.sql) rather than
 * routed through the generic lib/queue/ JobQueue: that queue's
 * `startWorker()` retry path (pg-queue.ts's `markFailed`) always reschedules
 * with `retryDelayMs = 0` on a handler throw (there is no per-call-site way
 * to plug in a custom backoff curve through the shared `JobQueue`
 * interface) — fine for the campaign dialer's own smart-retry schedule
 * (which manages its OWN delay via `campaigns.retry_schedule` and never
 * throws to get queue-level retries), wrong for a webhook to a third
 * party's server, which specifically needs exponential backoff so a
 * flaky/down receiver doesn't get hammered. This still reuses the SAME
 * shape of pattern (a durable row per delivery attempt with
 * attempts/max_attempts/next_attempt_at/last_error, claimed by a poll
 * loop) established by `lib/queue/pg-queue.ts`'s `job_queue` table —
 * deliberately not a third, different pattern.
 */

const BACKOFF_SCHEDULE_MS = [0, 30_000, 2 * 60_000, 10 * 60_000, 60 * 60_000, 6 * 60 * 60_000];

export type WebhookEventType = "call.completed" | "lead.disposition_changed";

export type FetchImpl = typeof fetch;

export type EnqueueWebhookParams = {
  orgId: string;
  eventType: WebhookEventType;
  payload: Record<string, unknown>;
};

/**
 * Looks up this org's ENABLED subscription(s) for `eventType` and inserts
 * one `webhook_deliveries` row per subscription, due immediately. Returns
 * immediately — never sends the HTTP request inline (same
 * enqueue-then-worker-drains-it discipline as `JobQueue.enqueue()`). A safe
 * no-op if the org has no subscription for this event (most tenants won't
 * — this is opt-in per-tenant infra, not something every org pays the cost
 * of).
 */
export async function enqueueOutboundWebhook(params: EnqueueWebhookParams): Promise<string[]> {
  return withTenant(params.orgId, null, async (client) => {
    const { rows: subs } = await client.query<{ id: string; target_url: string; secret_enc: unknown }>(
      `SELECT id, target_url, secret_enc FROM webhook_subscriptions
        WHERE org_id = $1 AND event_type = $2 AND enabled = true`,
      [params.orgId, params.eventType]
    );
    const ids: string[] = [];
    for (const sub of subs) {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO webhook_deliveries (org_id, subscription_id, event_type, payload, target_url, secret_enc, max_attempts)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id`,
        [
          params.orgId,
          sub.id,
          params.eventType,
          JSON.stringify(params.payload),
          sub.target_url,
          JSON.stringify(sub.secret_enc),
          BACKOFF_SCHEDULE_MS.length,
        ]
      );
      if (rows[0]) ids.push(rows[0].id);
    }
    return ids;
  });
}

export type DeliveryAttemptResult = {
  id: string;
  outcome: "delivered" | "retrying" | "exhausted";
  statusCode?: number;
  error?: string;
};

/**
 * Claims and attempts delivery of at most `limit` due `webhook_deliveries`
 * rows. Meant to be called on an interval by a worker process/script (same
 * "no route ever calls this inline" discipline as `JobQueue.startWorker()`
 * — see docs/DEPLOYMENT.md / deploy/RUNBOOK.md for how this runs in
 * production). `fetchImpl` is injectable (same DI pattern as every
 * provider adapter and `lib/voice-gateway/client.ts` in this codebase) so
 * this is unit-testable against a mock target with no real network call.
 */
export async function processDueOutboundWebhooks(
  limit = 20,
  fetchImpl: FetchImpl = fetch
): Promise<DeliveryAttemptResult[]> {
  const pool = getPool();

  // Claim due rows inside their own short transaction (mark 'processing'
  // immediately) so concurrent worker instances can't double-send the same
  // delivery — same `FOR UPDATE SKIP LOCKED` + explicit
  // BEGIN/claim/COMMIT-before-the-slow-part shape as
  // `lib/queue/pg-queue.ts`'s `claimNext()`, rather than holding a
  // transaction open across the outbound HTTP call itself.
  const client = await pool.connect();
  let due: Array<{
    id: string;
    org_id: string;
    subscription_id: string;
    event_type: string;
    payload: Record<string, unknown>;
    target_url: string;
    secret_enc: unknown;
    attempts: number;
    max_attempts: number;
  }>;
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `SELECT id, org_id, subscription_id, event_type, payload, target_url, secret_enc, attempts, max_attempts
         FROM webhook_deliveries
        WHERE status = 'pending' AND next_attempt_at <= now()
        ORDER BY next_attempt_at ASC
        LIMIT $1
        FOR UPDATE SKIP LOCKED`,
      [limit]
    );
    due = rows;
    if (due.length > 0) {
      await client.query(`UPDATE webhook_deliveries SET status = 'processing', updated_at = now() WHERE id = ANY($1)`, [
        due.map((d) => d.id),
      ]);
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  const results: DeliveryAttemptResult[] = [];
  for (const delivery of due) {
    results.push(await attemptDelivery(delivery, fetchImpl));
  }
  return results;
}

async function attemptDelivery(
  delivery: {
    id: string;
    org_id: string;
    subscription_id: string;
    event_type: string;
    payload: Record<string, unknown>;
    target_url: string;
    secret_enc: unknown;
    attempts: number;
    max_attempts: number;
  },
  fetchImpl: FetchImpl
): Promise<DeliveryAttemptResult> {
  const pool = getPool();
  const secret =
    delivery.secret_enc && isEncryptedConfig(delivery.secret_enc)
      ? (decryptProviderConfig(delivery.secret_enc).secret as string)
      : "";

  const body = JSON.stringify({ eventType: delivery.event_type, data: delivery.payload });
  const signature = createHmac("sha256", secret).update(body, "utf8").digest("hex");
  const attemptNumber = delivery.attempts + 1;

  let statusCode: number | undefined;
  let error: string | undefined;
  try {
    const res = await fetchImpl(delivery.target_url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-ai-calling-agent-signature": `sha256=${signature}`,
        "x-ai-calling-agent-event": delivery.event_type,
        "x-ai-calling-agent-delivery-id": delivery.id,
      },
      body,
    });
    statusCode = res.status;
    if (res.ok) {
      await pool.query(
        `UPDATE webhook_deliveries
            SET status = 'delivered', attempts = $2, last_status_code = $3, delivered_at = now(), updated_at = now()
          WHERE id = $1`,
        [delivery.id, attemptNumber, statusCode]
      );
      return { id: delivery.id, outcome: "delivered", statusCode };
    }
    error = `Target responded ${res.status}`;
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  if (attemptNumber >= delivery.max_attempts) {
    await pool.query(
      `UPDATE webhook_deliveries
          SET status = 'exhausted', attempts = $2, last_status_code = $3, last_error = $4, updated_at = now()
        WHERE id = $1`,
      [delivery.id, attemptNumber, statusCode ?? null, error ?? null]
    );
    return { id: delivery.id, outcome: "exhausted", statusCode, error };
  }

  const delayMs = BACKOFF_SCHEDULE_MS[Math.min(attemptNumber, BACKOFF_SCHEDULE_MS.length - 1)];
  await pool.query(
    `UPDATE webhook_deliveries
        SET status = 'pending', attempts = $2, last_status_code = $3, last_error = $4,
            next_attempt_at = now() + ($5 || ' milliseconds')::interval, updated_at = now()
      WHERE id = $1`,
    [delivery.id, attemptNumber, statusCode ?? null, error ?? null, String(delayMs)]
  );
  return { id: delivery.id, outcome: "retrying", statusCode, error };
}

export const _BACKOFF_SCHEDULE_MS_FOR_TESTS = BACKOFF_SCHEDULE_MS;
