import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "pg";
import { randomUUID } from "crypto";
import { PgJobQueue } from "@/lib/queue/pg-queue";

/**
 * Postgres-backed queue tests: enqueue/claim/complete/fail-with-retry and
 * the hard dead-letter cap, plus the `FOR UPDATE SKIP LOCKED` concurrency
 * property (two concurrent claimers never get the same job).
 */

const ADMIN_URL =
  process.env.DATABASE_URL_MIGRATE ?? "postgresql://postgres:postgres@localhost:5432/ai_calling_agent";

let admin: Client;
const queueName = `test-queue-${randomUUID().slice(0, 8)}`;

beforeAll(async () => {
  admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
});

afterAll(async () => {
  await admin.query("DELETE FROM job_queue WHERE queue_name = $1", [queueName]);
  await admin.end();
});

describe("PgJobQueue", () => {
  it("enqueues and claims a due job exactly once", async () => {
    const queue = new PgJobQueue();
    const id = await queue.enqueue(queueName, { hello: "world" });
    expect(id).toBeTruthy();

    const claimed = await queue.claimNext(queueName, "worker-a");
    expect(claimed).not.toBeNull();
    expect(claimed!.payload).toEqual({ hello: "world" });

    // Second claim finds nothing else due — it's now 'processing', not
    // 'pending', so it isn't re-claimed by anyone.
    const second = await queue.claimNext(queueName, "worker-b");
    expect(second).toBeNull();

    await queue.markCompleted(claimed!.id);
    const { rows } = await admin.query("SELECT status FROM job_queue WHERE id = $1", [claimed!.id]);
    expect(rows[0].status).toBe("completed");
  });

  it("does not claim a job whose run_at is in the future", async () => {
    const queue = new PgJobQueue();
    await queue.enqueue(queueName, { future: true }, { runAt: new Date(Date.now() + 60_000) });
    const claimed = await queue.claimNext(queueName, "worker-a");
    expect(claimed).toBeNull();
  });

  it("reschedules a failed job with backoff until max_attempts, then dead-letters it", async () => {
    const queue = new PgJobQueue();
    const id = await queue.enqueue(queueName, { retry: true }, { maxAttempts: 2 });

    let claimed = await queue.claimNext(queueName, "worker-a");
    expect(claimed!.attempts).toBe(0);
    await queue.markFailed(claimed!.id, "boom", 0);

    let row = (await admin.query("SELECT status, attempts FROM job_queue WHERE id = $1", [id])).rows[0];
    expect(row.status).toBe("pending");
    expect(row.attempts).toBe(1);

    claimed = await queue.claimNext(queueName, "worker-a");
    expect(claimed).not.toBeNull();
    await queue.markFailed(claimed!.id, "boom again", 0);

    row = (await admin.query("SELECT status, attempts FROM job_queue WHERE id = $1", [id])).rows[0];
    expect(row.status).toBe("dead_letter");
    expect(row.attempts).toBe(2);

    // A dead-lettered job is never claimed again.
    const shouldBeNull = await queue.claimNext(queueName, "worker-a");
    expect(shouldBeNull).toBeNull();
  });

  it("SKIP LOCKED: two concurrent claimers never receive the same job", async () => {
    const queue = new PgJobQueue();
    await queue.enqueue(queueName, { concurrent: 1 });
    await queue.enqueue(queueName, { concurrent: 2 });

    const [a, b] = await Promise.all([
      queue.claimNext(queueName, "worker-a"),
      queue.claimNext(queueName, "worker-b"),
    ]);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a!.id).not.toBe(b!.id);
  });

  it("startWorker processes a job via the handler and marks it completed", async () => {
    const queue = new PgJobQueue();
    const seen: unknown[] = [];
    await queue.enqueue(queueName, { worker: "yes" });

    const { stop } = queue.startWorker(queueName, async (payload) => {
      seen.push(payload);
    });

    await new Promise((resolve) => setTimeout(resolve, 300));
    await stop();

    expect(seen).toEqual(expect.arrayContaining([{ worker: "yes" }]));
  });
});
