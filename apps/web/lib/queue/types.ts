/**
 * Job queue abstraction — see docs/ARCHITECTURE.md's Redis-backed
 * outbound-dialing queue and the Phase 6 decision recorded in
 * db/migrations/011_phase6_whatsapp_appointments_campaigns_compliance.sql.
 *
 * Two implementations satisfy this same contract:
 *  - lib/queue/pg-queue.ts — Postgres-backed (`job_queue` table,
 *    `FOR UPDATE SKIP LOCKED`), the documented interim substitute used by
 *    default in this dev environment (no managed Redis provisioned yet).
 *  - lib/queue/bullmq-queue.ts — BullMQ + Redis, the production-target
 *    mechanism (Redis IS available/startable in this sandbox — verified —
 *    so the real adapter is implemented, not just planned).
 *
 * Callers (the campaign dialer, appointment reminder scheduler, WhatsApp
 * sender) depend only on this interface, obtained from
 * lib/queue/index.ts's `getJobQueue()`, so which backend is active is a
 * config choice (QUEUE_BACKEND env var), never a code branch at the call
 * site.
 */

export type QueueJobMeta = {
  id: string;
  queueName: string;
  attempts: number;
  maxAttempts: number;
};

export type EnqueueOptions = {
  /** When the job becomes eligible to run; defaults to "now". */
  runAt?: Date;
  maxAttempts?: number;
  orgId?: string | null;
};

export type JobHandler<T = unknown> = (payload: T, meta: QueueJobMeta) => Promise<void>;

export interface JobQueue {
  /** Enqueues a job. Returns immediately — never blocks on the job running.
   * This is the ONLY thing any API route path may call; running the job
   * itself always happens out-of-process (a worker), never inline in the
   * request. */
  enqueue<T = unknown>(queueName: string, payload: T, opts?: EnqueueOptions): Promise<string>;

  /** Starts a long-running worker that polls/subscribes for `queueName`
   * jobs and invokes `handler` for each. Returns a stop() function. Never
   * called from an API route — only from a dedicated worker process/script. */
  startWorker<T = unknown>(queueName: string, handler: JobHandler<T>, opts?: { pollIntervalMs?: number }): { stop: () => Promise<void> };

  close(): Promise<void>;
}
