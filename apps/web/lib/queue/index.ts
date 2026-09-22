import type { JobQueue } from "./types";
import { PgJobQueue } from "./pg-queue";
import { BullMQJobQueue } from "./bullmq-queue";

export type { JobQueue, JobHandler, QueueJobMeta, EnqueueOptions } from "./types";
export { PgJobQueue } from "./pg-queue";
export { BullMQJobQueue } from "./bullmq-queue";

let instance: JobQueue | undefined;

/**
 * Returns the process-wide job queue, chosen by QUEUE_BACKEND
 * ('pg' | 'bullmq', default 'pg' — see pg-queue.ts's top comment for why
 * Postgres is the current default). Every enqueue site in this app (the
 * compliance-gated call creator, the campaign dialer, the appointment
 * reminder scheduler, the WhatsApp sender) goes through this function —
 * never `new PgJobQueue()`/`new BullMQJobQueue()` directly — so switching
 * backends is a single env var, not a multi-file change.
 */
export function getJobQueue(): JobQueue {
  if (instance) return instance;
  const backend = process.env.QUEUE_BACKEND ?? "pg";
  if (backend === "bullmq") {
    instance = new BullMQJobQueue(process.env.REDIS_URL ?? "redis://localhost:6379");
  } else {
    instance = new PgJobQueue();
  }
  return instance;
}

/** Test-only: force a fresh instance next call (e.g. after changing env vars). */
export function _resetJobQueueForTests(): void {
  instance = undefined;
}
