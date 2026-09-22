import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "child_process";
import { randomUUID } from "crypto";
import { BullMQJobQueue } from "@/lib/queue/bullmq-queue";

/**
 * BullMQ + Redis integration test. Spins up an ephemeral, throwaway
 * redis-server on a random high port for the duration of this file only
 * (verified available in this sandbox — `redis-server` binary present and
 * PING succeeds — see the Phase 6 report / docs/ARCHITECTURE.md note).
 * Skips itself gracefully if no redis-server binary is on PATH, so the
 * rest of the suite isn't hostage to this one optional dependency.
 */

const port = 6400 + (Math.floor(Math.random() * 500));
let redisProc: ChildProcess | undefined;
let redisAvailable = false;

async function waitForRedis(url: string, timeoutMs = 5000): Promise<boolean> {
  const IORedis = (await import("ioredis")).default;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const client = new IORedis(url, { lazyConnect: true, retryStrategy: () => null });
      await client.connect();
      await client.ping();
      client.disconnect();
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  return false;
}

beforeAll(async () => {
  try {
    redisProc = spawn("redis-server", ["--port", String(port), "--daemonize", "no", "--save", ""], {
      stdio: "ignore",
    });
    redisAvailable = await waitForRedis(`redis://127.0.0.1:${port}`);
  } catch {
    redisAvailable = false;
  }
}, 10_000);

afterAll(async () => {
  redisProc?.kill();
});

describe("BullMQJobQueue (real Redis)", () => {
  it("enqueues a job and a worker processes it", async () => {
    if (!redisAvailable) {
      console.warn("Skipping BullMQ/Redis test: no redis-server available in this environment");
      return;
    }
    const queue = new BullMQJobQueue(`redis://127.0.0.1:${port}`);
    const queueName = `test-bullmq-${randomUUID().slice(0, 8)}`;
    const seen: unknown[] = [];

    const { stop } = queue.startWorker(queueName, async (payload) => {
      seen.push(payload);
    });

    await queue.enqueue(queueName, { hello: "bullmq" });

    // Poll briefly for the worker to pick it up rather than a fixed sleep.
    const start = Date.now();
    while (seen.length === 0 && Date.now() - start < 5000) {
      await new Promise((r) => setTimeout(r, 100));
    }

    expect(seen).toEqual([{ hello: "bullmq" }]);
    await stop();
    await queue.close();
  }, 15_000);
});
