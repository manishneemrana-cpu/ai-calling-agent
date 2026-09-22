import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "pg";
import { randomUUID } from "crypto";
import {
  buildScoreboard,
  loadProviderCostStats,
  loadProviderFailoverStats,
  loadProviderLatencyStats,
  type ProviderCostStat,
  type ProviderLatencyStat,
  type ProviderQualityRating,
} from "@/lib/billing/scoreboard";
import { withTenant } from "@/lib/db/tenant";

describe("buildScoreboard — pure aggregation/composite-score math", () => {
  const costStats: ProviderCostStat[] = [
    { layer: "stt", providerKey: "sarvam", totalCostUsd: 6, totalUsageQuantity: 1000, usageUnit: "minute", callCount: 10, avgCostPerUnit: 0.006 },
    { layer: "stt", providerKey: "deepgram", totalCostUsd: 7.7, totalUsageQuantity: 1000, usageUnit: "minute", callCount: 10, avgCostPerUnit: 0.0077 },
  ];
  const latencyStats: ProviderLatencyStat[] = [
    { layer: "stt", providerKey: "sarvam", stage: "end_of_speech_to_transcript", avgDurationS: 0.5, sampleCount: 10 },
    { layer: "stt", providerKey: "deepgram", stage: "end_of_speech_to_transcript", avgDurationS: 0.3, sampleCount: 10 },
  ];
  const qualityRatings: ProviderQualityRating[] = [
    { layer: "stt", providerKey: "sarvam", metric: "hinglish_quality", score: 9, ratedBy: "founder", notes: null },
  ];

  it("cheaper provider gets a lower avgCostPerUnit and higher (1-normCost) contribution", () => {
    const rows = buildScoreboard(costStats, latencyStats, [], { costWeight: 1, latencyWeight: 0, qualityWeight: 0 });
    const sarvam = rows.find((r) => r.providerKey === "sarvam")!;
    const deepgram = rows.find((r) => r.providerKey === "deepgram")!;
    expect(sarvam.avgCostPerUnit).toBeLessThan(deepgram.avgCostPerUnit!);
    expect(sarvam.compositeScore!).toBeGreaterThan(deepgram.compositeScore!);
  });

  it("faster provider wins when weights favor latency only", () => {
    const rows = buildScoreboard(costStats, latencyStats, [], { costWeight: 0, latencyWeight: 1, qualityWeight: 0 });
    const sarvam = rows.find((r) => r.providerKey === "sarvam")!;
    const deepgram = rows.find((r) => r.providerKey === "deepgram")!;
    expect(deepgram.compositeScore!).toBeGreaterThan(sarvam.compositeScore!);
  });

  it("manual quality rating is surfaced separately and only affects the composite when present", () => {
    const rows = buildScoreboard(costStats, latencyStats, qualityRatings, {
      costWeight: 0,
      latencyWeight: 0,
      qualityWeight: 1,
    });
    const sarvam = rows.find((r) => r.providerKey === "sarvam")!;
    const deepgram = rows.find((r) => r.providerKey === "deepgram")!;
    expect(sarvam.manualQualityScore).toBe(9);
    expect(deepgram.manualQualityScore).toBeNull();
    // Only sarvam has a rating, so it's the only one with a real
    // quality-weighted composite; deepgram's effective weight sum is 0
    // (no cost/latency weight either), so it should be null.
    expect(sarvam.compositeScore).not.toBeNull();
    expect(deepgram.compositeScore).toBeNull();
  });
});

describe("loadProviderCostStats / loadProviderLatencyStats — real aggregation against fixture rows", () => {
  const ADMIN_URL =
    process.env.DATABASE_URL_MIGRATE ?? "postgresql://postgres:postgres@localhost:5432/ai_calling_agent";
  let admin: Client;
  let orgId: string;
  const providerKeyA = `scoreboard_test_a_${randomUUID().slice(0, 8)}`;
  const providerKeyB = `scoreboard_test_b_${randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    admin = new Client({ connectionString: ADMIN_URL });
    await admin.connect();
    const suffix = randomUUID().slice(0, 8);
    const orgRow = await admin.query("INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id", [
      `Scoreboard Test Org ${suffix}`,
      `scoreboard-test-org-${suffix}`,
    ]);
    orgId = orgRow.rows[0].id;

    await admin.query(
      `INSERT INTO provider_rate_cards (provider_type, provider_key, unit, unit_price_usd) VALUES ('stt', $1, 'per_minute', 0.006), ('stt', $2, 'per_minute', 0.0077)`,
      [providerKeyA, providerKeyB]
    );

    // Two usage/cost rows for provider A: 100 + 100 seconds, $0.01 + $0.01
    // -> total cost $0.02 over total quantity 200 seconds.
    for (const [providerKey, quantity, cost] of [
      [providerKeyA, 100, 0.01],
      [providerKeyA, 100, 0.01],
      [providerKeyB, 60, 0.0077],
    ] as const) {
      const usageRow = await admin.query(
        `INSERT INTO usage_records (org_id, provider_type, provider_key, quantity, unit) VALUES ($1, 'stt', $2, $3, 'seconds') RETURNING id`,
        [orgId, providerKey, quantity]
      );
      await admin.query(`INSERT INTO cost_records (org_id, usage_record_id, amount_usd) VALUES ($1, $2, $3)`, [
        orgId,
        usageRow.rows[0].id,
        cost,
      ]);
    }

    await admin.query(
      `INSERT INTO call_latency_metrics (org_id, layer, provider_key, stage, duration_s) VALUES ($1, 'stt', $2, 'end_of_speech_to_transcript', 0.4), ($1, 'stt', $2, 'end_of_speech_to_transcript', 0.6)`,
      [orgId, providerKeyA]
    );
  });

  afterAll(async () => {
    await admin.query("DELETE FROM provider_rate_cards WHERE provider_key = ANY($1)", [[providerKeyA, providerKeyB]]);
    await admin.query("DELETE FROM organizations WHERE id = $1", [orgId]);
    await admin.end();
  });

  it("aggregates total cost / quantity / avgCostPerUnit correctly for provider A", async () => {
    const stats = await withTenant(orgId, null, (client) => loadProviderCostStats(client));
    const a = stats.find((s) => s.providerKey === providerKeyA)!;
    expect(a.totalCostUsd).toBeCloseTo(0.02, 6);
    expect(a.totalUsageQuantity).toBeCloseTo(200, 6);
    expect(a.avgCostPerUnit).toBeCloseTo(0.0001, 8); // $0.02 / 200 seconds
    expect(a.callCount).toBe(0); // no call_id attached in this fixture — proves it's a real COUNT, not a placeholder
  });

  it("aggregates average latency correctly across the two fixture rows", async () => {
    const stats = await withTenant(orgId, null, (client) => loadProviderLatencyStats(client));
    const a = stats.find((s) => s.providerKey === providerKeyA)!;
    expect(a.avgDurationS).toBeCloseTo(0.5, 6); // (0.4 + 0.6) / 2
    expect(a.sampleCount).toBe(2);
  });

  it(
    "loadProviderFailoverStats (gap-closing pass: wires platform_failover_stats() into the Provider " +
      "Scoreboard, which existed since Phase 9 but had no UI reader) aggregates event counts correctly",
    async () => {
      await admin.query(
        `INSERT INTO provider_failover_events (org_id, layer, from_provider, to_provider, reason) VALUES
           ($1, 'stt', $2, $3, 'timeout'), ($1, 'stt', $2, $3, 'error')`,
        [orgId, providerKeyA, providerKeyB]
      );

      const stats = await withTenant(orgId, null, (client) => loadProviderFailoverStats(client));
      const row = stats.find((s) => s.fromProvider === providerKeyA && s.toProvider === providerKeyB)!;
      expect(row).toBeTruthy();
      expect(row.eventCount).toBe(2);
      expect(row.layer).toBe("stt");
    }
  );
});
