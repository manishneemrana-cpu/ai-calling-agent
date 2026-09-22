import { randomUUID } from "crypto";
import { getPool } from "../db/pool";
import type { EnqueueOptions, JobHandler, JobQueue, QueueJobMeta } from "./types";

/**
 * Postgres-backed job queue — the documented interim substitute for
 * BullMQ+Redis (see types.ts's top comment and
 * db/migrations/011_phase6_whatsapp_appointments_campaigns_compliance.sql).
 * Uses `job_queue` with `SELECT ... FOR UPDATE SKIP LOCKED` so multiple
 * worker processes can safely claim distinct jobs concurrently without a
 * separate broker.
 *
 * `job_queue` has RLS intentionally off (a worker must see jobs across all
 * tenants in one poll) — every query here still always filters/writes
 * org_id explicitly for defense in depth, never relying on RLS for this
 * table.
 */
export class PgJobQueue implements JobQueue {
  async enqueue<T = unknown>(queueName: string, payload: T, opts: EnqueueOptions = {}): Promise<string> {
    const pool = getPool();
    const { rows } = await pool.query(
      `INSERT INTO job_queue (org_id, queue_name, payload, run_at, max_attempts)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [opts.orgId ?? null, queueName, JSON.stringify(payload), opts.runAt ?? new Date(), opts.maxAttempts ?? 5]
    );
    return rows[0].id as string;
  }

  /** Claims and returns at most one due job for `queueName`, atomically
   * marking it 'processing' so no other worker can also claim it. Returns
   * null if nothing is due. Exposed directly (not just via startWorker) so
   * tests can exercise claim semantics deterministically without a poll
   * loop or timers. */
  async claimNext(
    queueName: string,
    workerId: string
  ): Promise<{ id: string; payload: unknown; attempts: number; maxAttempts: number } | null> {
    const pool = getPool();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query(
        `SELECT id, payload, attempts, max_attempts
           FROM job_queue
          WHERE queue_name = $1 AND status = 'pending' AND run_at <= now()
          ORDER BY run_at ASC
          FOR UPDATE SKIP LOCKED
          LIMIT 1`,
        [queueName]
      );
      if (rows.length === 0) {
        await client.query("COMMIT");
        return null;
      }
      const job = rows[0];
      await client.query(
        `UPDATE job_queue SET status = 'processing', locked_at = now(), locked_by = $2, updated_at = now() WHERE id = $1`,
        [job.id, workerId]
      );
      await client.query("COMMIT");
      return { id: job.id, payload: job.payload, attempts: job.attempts, maxAttempts: job.max_attempts };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async markCompleted(jobId: string): Promise<void> {
    const pool = getPool();
    await pool.query(`UPDATE job_queue SET status = 'completed', updated_at = now() WHERE id = $1`, [jobId]);
  }

  /** Marks a job failed. If under max_attempts, reschedules it (pending)
   * after `retryDelayMs`; otherwise moves it to 'dead_letter' — this is the
   * hard attempt cap referenced by the smart-retry spec, enforced at the
   * queue layer as a second, independent backstop to campaign_leads'
   * own attempts counter. */
  async markFailed(jobId: string, error: string, retryDelayMs = 0): Promise<void> {
    const pool = getPool();
    const { rows } = await pool.query(`SELECT attempts, max_attempts FROM job_queue WHERE id = $1`, [jobId]);
    const row = rows[0];
    if (!row) return;
    const attempts = row.attempts + 1;
    if (attempts >= row.max_attempts) {
      await pool.query(
        `UPDATE job_queue SET status = 'dead_letter', attempts = $2, last_error = $3, updated_at = now() WHERE id = $1`,
        [jobId, attempts, error]
      );
      return;
    }
    await pool.query(
      `UPDATE job_queue
          SET status = 'pending', attempts = $2, last_error = $3, run_at = now() + ($4 || ' milliseconds')::interval,
              locked_at = NULL, locked_by = NULL, updated_at = now()
        WHERE id = $1`,
      [jobId, attempts, error, String(retryDelayMs)]
    );
  }

  startWorker<T = unknown>(
    queueName: string,
    handler: JobHandler<T>,
    opts: { pollIntervalMs?: number } = {}
  ): { stop: () => Promise<void> } {
    const pollIntervalMs = opts.pollIntervalMs ?? 2000;
    const workerId = `pg-worker-${randomUUID()}`;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const tick = async () => {
      if (stopped) return;
      try {
        const job = await this.claimNext(queueName, workerId);
        if (job) {
          const meta: QueueJobMeta = { id: job.id, queueName, attempts: job.attempts, maxAttempts: job.maxAttempts };
          try {
            await handler(job.payload as T, meta);
            await this.markCompleted(job.id);
          } catch (err) {
            await this.markFailed(job.id, err instanceof Error ? err.message : String(err));
          }
          // Immediately check for another due job rather than waiting a
          // full poll interval, so a backlog drains quickly.
          if (!stopped) return tick();
        }
      } catch {
        // Swallow poll-loop errors (e.g. transient DB hiccup) — the loop
        // keeps running; it never lets the queue take down the process.
      }
      if (!stopped) timer = setTimeout(tick, pollIntervalMs);
    };
    timer = setTimeout(tick, 0);

    return {
      stop: async () => {
        stopped = true;
        if (timer) clearTimeout(timer);
      },
    };
  }

  async close(): Promise<void> {
    // getPool() is a shared, process-wide pool owned by lib/db/pool.ts —
    // this queue doesn't own its lifecycle, so close() is a no-op here.
  }
}
