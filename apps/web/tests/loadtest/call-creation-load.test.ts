import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "pg";
import { randomUUID } from "crypto";
import { createOutboundCall } from "@/lib/calls/createCall";

/**
 * Phase 9 load test (mock-adapter path, apps/web side) — see
 * docs/LOAD_TESTING.md for the full write-up (tool choice, what this
 * proves vs doesn't, and the numbers this run actually produced).
 *
 * Fires N concurrent `createOutboundCall()` calls (the SAME function every
 * real call-creation path in this codebase goes through — the compliance
 * gate, the wallet gate, and the mock telephony adapter all run for real,
 * nothing stubbed out) across several distinct tenant orgs at once, and
 * reports real throughput/latency/error-rate numbers. Proves:
 *   - concurrency-safety of the shared connection pool + RLS path,
 *   - tenant isolation holds under concurrent load (each call lands only
 *     in its OWN org's `calls` table, verified per-org afterwards),
 *   - idempotency/uniqueness of the generated provider_call_id under
 *     concurrent creation (no collisions).
 *
 * This does NOT prove anything about a REAL telephony/STT/TTS/LLM
 * provider's behavior under load — no live credentials exist in this
 * sandbox. See docs/LOAD_TESTING.md's "what this can't prove" section.
 */

const ADMIN_URL =
  process.env.DATABASE_URL_MIGRATE ?? "postgresql://postgres:postgres@localhost:5432/ai_calling_agent";

const CONCURRENCY = Number(process.env.LOADTEST_CONCURRENCY ?? 100);
const ORG_COUNT = 5;

let admin: Client;
const orgIds: string[] = [];
const leadIdByOrg: Record<string, string> = {};

beforeAll(async () => {
  process.env.PROVIDER_CONFIG_ENCRYPTION_KEY ??= "test-only-encryption-key-do-not-use-in-prod";
  admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();

  for (let i = 0; i < ORG_COUNT; i++) {
    const suffix = randomUUID().slice(0, 8);
    const orgRow = await admin.query("INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id", [
      `Load Test Org ${suffix}`,
      `loadtest-org-${suffix}`,
    ]);
    const orgId = orgRow.rows[0].id;
    await admin.query(
      `INSERT INTO tenant_provider_config (org_id, layer, provider_key, is_default, priority, config)
       VALUES ($1, 'telephony', 'mock', true, 1, '{}'::jsonb)`,
      [orgId]
    );
    // A single consented lead per org — every concurrent call for that org
    // dials this same lead, so the mandatory compliance gate passes for
    // real (this harness never bypasses it) without needing N distinct
    // lead_compliance rows.
    const leadRow = await admin.query(
      `INSERT INTO leads (org_id, full_name, phone_number) VALUES ($1, 'Load Test Lead', '+919990000000') RETURNING id`,
      [orgId]
    );
    const leadId = leadRow.rows[0].id;
    await admin.query(
      `INSERT INTO lead_compliance (org_id, lead_id, consent_status, consent_captured_at, consent_expires_at)
       VALUES ($1, $2, 'granted', now(), now() + interval '7 days')`,
      [orgId, leadId]
    );
    orgIds.push(orgId);
    leadIdByOrg[orgId] = leadId;
  }
}, 30_000);

afterAll(async () => {
  for (const orgId of orgIds) {
    await admin.query("DELETE FROM organizations WHERE id = $1", [orgId]);
  }
  await admin.end();
});

describe("load test: mock-adapter call creation at concurrency", () => {
  it(
    `handles ${CONCURRENCY} concurrent createOutboundCall() calls across ${ORG_COUNT} tenants correctly`,
    async () => {
      const latenciesMs: number[] = [];
      let errors = 0;

      const started = Date.now();
      const results = await Promise.allSettled(
        Array.from({ length: CONCURRENCY }, (_, i) => {
          const orgId = orgIds[i % ORG_COUNT];
          const t0 = performance.now();
          return createOutboundCall({
            orgId,
            userId: null,
            leadId: leadIdByOrg[orgId],
            toNumber: `+9199900${String(i).padStart(5, "0")}`,
            fromNumber: "+911100000000",
          }).finally(() => {
            latenciesMs.push(performance.now() - t0);
          });
        })
      );
      const wallClockMs = Date.now() - started;

      for (const r of results) {
        if (r.status === "rejected") {
          errors++;
          if (errors <= 3) {
             
            console.error("[LOAD TEST] sample failure:", r.reason);
          }
        }
      }

      latenciesMs.sort((a, b) => a - b);
      const p50 = latenciesMs[Math.floor(latenciesMs.length * 0.5)];
      const p95 = latenciesMs[Math.floor(latenciesMs.length * 0.95)];
      const throughputPerSec = (CONCURRENCY / wallClockMs) * 1000;

       
      console.log(
        `[LOAD TEST] concurrency=${CONCURRENCY} wall_clock_ms=${wallClockMs} ` +
          `throughput_req_per_s=${throughputPerSec.toFixed(1)} p50_ms=${p50.toFixed(1)} ` +
          `p95_ms=${p95.toFixed(1)} errors=${errors}/${CONCURRENCY}`
      );

      expect(errors).toBe(0);

      // Tenant isolation under load: each org's call count matches exactly
      // what was routed to it, and no call leaked into another org.
      for (let i = 0; i < ORG_COUNT; i++) {
        const expected = Array.from({ length: CONCURRENCY }, (_, j) => j).filter((j) => j % ORG_COUNT === i).length;
        const { rows } = await admin.query(`SELECT count(*)::int AS c FROM calls WHERE org_id = $1`, [orgIds[i]]);
        expect(rows[0].c).toBe(expected);
      }

      // No provider_call_id collisions across the whole concurrent batch.
      const { rows: distinctRows } = await admin.query(
        `SELECT count(DISTINCT provider_call_id)::int AS distinct_count, count(*)::int AS total_count
           FROM calls WHERE org_id = ANY($1)`,
        [orgIds]
      );
      expect(distinctRows[0].distinct_count).toBe(distinctRows[0].total_count);
    },
    120_000
  );
});
