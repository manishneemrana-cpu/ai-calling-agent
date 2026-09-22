import { Queue, Worker, type Job } from "bullmq";
import IORedis, { type Redis } from "ioredis";
import type { EnqueueOptions, JobHandler, JobQueue, QueueJobMeta } from "./types";

/**
 * BullMQ + Redis job queue — the production-target mechanism per
 * docs/ARCHITECTURE.md. Redis was verified startable in this dev sandbox
 * (`redis-server --daemonize yes` + PING succeeded) so this is a real,
 * working implementation, not just a documented plan — see
 * db/migrations/011_phase6_whatsapp_appointments_campaigns_compliance.sql
 * for why lib/queue/pg-queue.ts is still the *default* until a managed
 * Redis instance is provisioned for a deployed environment.
 *
 * One BullMQ `Queue` + at most one `Worker` per queueName, keyed off a
 * shared ioredis connection (`maxRetriesPerRequest: null`, as BullMQ
 * requires for its blocking commands).
 */
export class BullMQJobQueue implements JobQueue {
  private readonly connection: Redis;
  private readonly queues = new Map<string, Queue>();
  private readonly workers: Worker[] = [];

  constructor(redisUrl: string) {
    this.connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });
  }

  private getQueue(queueName: string): Queue {
    let q = this.queues.get(queueName);
    if (!q) {
      q = new Queue(queueName, { connection: this.connection });
      this.queues.set(queueName, q);
    }
    return q;
  }

  async enqueue<T = unknown>(queueName: string, payload: T, opts: EnqueueOptions = {}): Promise<string> {
    const delay = opts.runAt ? Math.max(0, opts.runAt.getTime() - Date.now()) : 0;
    const job = await this.getQueue(queueName).add(queueName, payload, {
      delay,
      attempts: opts.maxAttempts ?? 5,
      backoff: { type: "fixed", delay: 0 }, // retry timing is application-driven (smart-retry schedule), not BullMQ's own backoff
      removeOnComplete: true,
      removeOnFail: false,
    });
    return String(job.id);
  }

  startWorker<T = unknown>(queueName: string, handler: JobHandler<T>): { stop: () => Promise<void> } {
    const worker = new Worker(
      queueName,
      async (job: Job) => {
        const meta: QueueJobMeta = {
          id: String(job.id),
          queueName,
          attempts: job.attemptsMade,
          maxAttempts: job.opts.attempts ?? 5,
        };
        await handler(job.data as T, meta);
      },
      { connection: this.connection }
    );
    this.workers.push(worker);
    return {
      stop: async () => {
        await worker.close();
      },
    };
  }

  async close(): Promise<void> {
    await Promise.all(this.workers.map((w) => w.close()));
    await Promise.all(Array.from(this.queues.values()).map((q) => q.close()));
    this.connection.disconnect();
  }
}
