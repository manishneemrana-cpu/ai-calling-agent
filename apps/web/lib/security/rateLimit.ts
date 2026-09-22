import { withoutTenant } from "@/lib/db/tenant";

/**
 * Phase 10 security hardening: a Postgres-backed fixed-window rate limiter
 * for public-facing, pre-auth endpoints (login, signup, and the n8n webhook
 * receivers) — none of which had ANY rate limiting through Phase 9.
 *
 * Why Postgres-backed, not in-memory: this app is designed to run as
 * multiple Node instances in production (no shared process memory), so an
 * in-memory counter would silently under-count — a bug that is invisible in
 * a single-process dev/test run but a real hole in production. This is the
 * same "Postgres-backed default now, Redis-backed the documented production
 * upgrade" pattern Phase 6 already established for the job queue
 * (`QUEUE_BACKEND=pg` default, `bullmq`+Redis as the documented production
 * target — see `.env.example` and `lib/queue/index.ts`). A real production
 * deployment should point this at Redis (`INCR` + `EXPIRE`, one round trip,
 * no table growth) instead — not built here, since it would require
 * provisioning Redis, which this platform does not yet require for every
 * deployment (see docs/DEPLOYMENT.md "Redis"). The interface below
 * (`checkRateLimit(bucketKey, limit, windowSeconds)`) is deliberately
 * storage-agnostic so swapping the implementation is a one-file change.
 *
 * Table: `auth_rate_limit_events` (db/migrations/015_phase10_audit_and_rate_limits.sql).
 * Fixed-window (not sliding/token-bucket) — simple, sufficient to stop
 * unthrottled brute-force/credential-stuffing loops, and cheap: one INSERT
 * + one COUNT per check, with old rows pruned opportunistically on the
 * same call so the table doesn't grow unbounded in a long-running dev/demo
 * deployment without a cron job.
 */
export class RateLimitExceededError extends Error {
  constructor(public readonly retryAfterSeconds: number) {
    super("Too many requests — please try again later.");
    this.name = "RateLimitExceededError";
  }
}

/**
 * Throws RateLimitExceededError if `bucketKey` has been hit `limit` or more
 * times in the last `windowSeconds`. Otherwise records this hit and
 * returns normally. `bucketKey` should combine the action with an
 * identifying value the caller controls the granularity of, e.g.
 * `login:${email}` and/or `login:ip:${ip}` (call both — see auth actions).
 */
export async function checkRateLimit(
  bucketKey: string,
  limit: number,
  windowSeconds: number
): Promise<void> {
  await withoutTenant(async (client) => {
    // Opportunistic cleanup: bounded, cheap, avoids unbounded table growth
    // without needing a separate cron/scheduled job for this dev-scale
    // limiter. A real Redis-backed limiter would use TTL/EXPIRE instead.
    await client.query(
      `DELETE FROM auth_rate_limit_events WHERE occurred_at < now() - ($1 || ' seconds')::interval`,
      [String(windowSeconds * 4)]
    );

    const { rows } = await client.query(
      `SELECT count(*)::int AS n FROM auth_rate_limit_events
       WHERE bucket_key = $1 AND occurred_at > now() - ($2 || ' seconds')::interval`,
      [bucketKey, String(windowSeconds)]
    );
    const count = rows[0]?.n ?? 0;
    if (count >= limit) {
      throw new RateLimitExceededError(windowSeconds);
    }
    await client.query(`INSERT INTO auth_rate_limit_events (bucket_key) VALUES ($1)`, [bucketKey]);
  });
}

/** Non-throwing convenience for route handlers that want a boolean instead
 * of a try/catch (e.g. webhook receivers, where the response shape differs
 * from the auth actions' inline-error-string convention). */
export async function isRateLimited(
  bucketKey: string,
  limit: number,
  windowSeconds: number
): Promise<boolean> {
  try {
    await checkRateLimit(bucketKey, limit, windowSeconds);
    return false;
  } catch (err) {
    if (err instanceof RateLimitExceededError) return true;
    throw err;
  }
}

/** Best-effort client IP extraction behind a typical reverse proxy/CDN
 * (Vercel, most load balancers) — `x-forwarded-for`'s first entry is the
 * original client. Falls back to a constant so a missing header degrades
 * to "rate-limit by email/bucket-key only" rather than throwing. */
export function clientIpFromHeaders(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return headers.get("x-real-ip") ?? "unknown";
}
