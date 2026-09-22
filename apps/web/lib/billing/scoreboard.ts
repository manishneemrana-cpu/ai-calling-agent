import type { PoolClient } from "pg";

/**
 * Provider Scoreboard (Phase 7) — aggregates REAL data already being
 * collected: Phase 3.5/4's `cost_records` (joined through
 * `usage_records` for provider attribution — see
 * db/migrations/004_billing_providers.sql) for actual per-unit cost, and
 * the Phase 7 `call_latency_metrics` sink (fed from Phase 3's
 * `voice_gateway/latency.py` measurements — see
 * `services/voice-gateway/voice_gateway/billing/latency_writer.py`) for
 * average latency per stage.
 *
 * HONEST CAVEAT (per the spec): "best Hinglish quality" cannot be
 * measured automatically from usage data. This module does NOT fabricate
 * an automatic quality score — it reads a manually/admin-entered rating
 * from `provider_quality_ratings` (platform-level, tenant-independent)
 * and clearly labels it as manual input, never blending it silently into
 * an "automatic" number.
 *
 * The cost-quality composite score IS automatic, but only over cost +
 * latency (both real, measured data) plus the manual quality rating as an
 * explicit weighted input — the formula and weights are documented and
 * configurable (passed in, never hardcoded), per the spec.
 */

export type ProviderCostStat = {
  layer: string;
  providerKey: string;
  totalCostUsd: number;
  totalUsageQuantity: number;
  usageUnit: string | null;
  callCount: number;
  /** Cost per the layer's natural unit — per-minute for telephony/stt/tts
   * (tts here approximated per-1k-chars-equivalent via its own usage
   * unit), per-1k-tokens for llm. Simple totalCost/totalQuantity, scaled
   * by the usage unit's own convention (see usage_records.unit). */
  avgCostPerUnit: number;
};

export type ProviderLatencyStat = {
  layer: string;
  providerKey: string;
  stage: string;
  avgDurationS: number;
  sampleCount: number;
};

export type ProviderQualityRating = {
  layer: string;
  providerKey: string;
  metric: string;
  score: number; // 0-10, manually entered
  ratedBy: string | null;
  notes: string | null;
};

export type ScoreboardWeights = {
  /** Weight on (1 - normalized cost) — lower cost is better. */
  costWeight: number;
  /** Weight on (1 - normalized latency) — lower latency is better. */
  latencyWeight: number;
  /** Weight on normalized manual quality rating (0-10 -> 0-1). */
  qualityWeight: number;
};

export const DEFAULT_SCOREBOARD_WEIGHTS: ScoreboardWeights = {
  costWeight: 0.4,
  latencyWeight: 0.3,
  qualityWeight: 0.3,
};

/**
 * Reads from `platform_provider_cost_stats()` — a SECURITY DEFINER SQL
 * function (db/migrations/012_phase7_billing.sql) that deliberately
 * aggregates ACROSS every tenant's `cost_records`/`usage_records`, because
 * the Provider Scoreboard is a platform-level view by design (same
 * category as `provider_rate_cards` itself), not something a single
 * tenant-scoped RLS connection could see. Works with any `PoolClient`,
 * tenant-scoped or not — the function's own security context is what
 * grants the cross-org read, not the caller's `app.current_org_id`.
 */
export async function loadProviderCostStats(client: PoolClient): Promise<ProviderCostStat[]> {
  const { rows } = await client.query(
    `SELECT provider_type AS layer, provider_key, total_cost_usd, total_usage_quantity, usage_unit, call_count
       FROM platform_provider_cost_stats()`
  );
  return rows.map((r) => {
    const totalCost = Number(r.total_cost_usd);
    const totalQty = Number(r.total_usage_quantity);
    return {
      layer: r.layer,
      providerKey: r.provider_key,
      totalCostUsd: totalCost,
      totalUsageQuantity: totalQty,
      usageUnit: r.usage_unit,
      callCount: Number(r.call_count),
      avgCostPerUnit: totalQty === 0 ? 0 : totalCost / totalQty,
    };
  });
}

export async function loadProviderLatencyStats(client: PoolClient): Promise<ProviderLatencyStat[]> {
  const { rows } = await client.query(
    `SELECT layer, provider_key, stage, avg_duration_s, sample_count FROM platform_provider_latency_stats()`
  );
  return rows.map((r) => ({
    layer: r.layer,
    providerKey: r.provider_key,
    stage: r.stage,
    avgDurationS: Number(r.avg_duration_s),
    sampleCount: Number(r.sample_count),
  }));
}

export async function loadProviderQualityRatings(client: PoolClient): Promise<ProviderQualityRating[]> {
  const { rows } = await client.query(
    `SELECT layer, provider_key, metric, score, rated_by, notes FROM provider_quality_ratings`
  );
  return rows.map((r) => ({
    layer: r.layer,
    providerKey: r.provider_key,
    metric: r.metric,
    score: Number(r.score),
    ratedBy: r.rated_by,
    notes: r.notes,
  }));
}

export type ScoreboardRow = {
  layer: string;
  providerKey: string;
  avgCostPerUnit: number | null;
  avgLatencyS: number | null;
  manualQualityScore: number | null; // null = no manual rating entered yet
  compositeScore: number | null; // null when there isn't enough data (cost or latency missing)
};

/**
 * Builds the per-(layer, providerKey) scoreboard: joins the three
 * independently-aggregated stats above and computes the composite score.
 * min-max normalizes cost and latency WITHIN each layer (so telephony's
 * per-minute cost is never compared on the same scale as LLM's
 * per-1k-token cost) before applying the configurable weights.
 */
export function buildScoreboard(
  costStats: ProviderCostStat[],
  latencyStats: ProviderLatencyStat[],
  qualityRatings: ProviderQualityRating[],
  weights: ScoreboardWeights = DEFAULT_SCOREBOARD_WEIGHTS
): ScoreboardRow[] {
  const avgLatencyByProvider = new Map<string, { sum: number; n: number }>();
  for (const l of latencyStats) {
    const key = `${l.layer}:${l.providerKey}`;
    const entry = avgLatencyByProvider.get(key) ?? { sum: 0, n: 0 };
    entry.sum += l.avgDurationS * l.sampleCount;
    entry.n += l.sampleCount;
    avgLatencyByProvider.set(key, entry);
  }

  const qualityByProvider = new Map<string, number>();
  for (const q of qualityRatings) {
    if (q.metric === "hinglish_quality") {
      qualityByProvider.set(`${q.layer}:${q.providerKey}`, q.score);
    }
  }

  const rows: ScoreboardRow[] = costStats.map((c) => {
    const key = `${c.layer}:${c.providerKey}`;
    const latencyEntry = avgLatencyByProvider.get(key);
    return {
      layer: c.layer,
      providerKey: c.providerKey,
      avgCostPerUnit: c.avgCostPerUnit,
      avgLatencyS: latencyEntry ? latencyEntry.sum / latencyEntry.n : null,
      manualQualityScore: qualityByProvider.get(key) ?? null,
      compositeScore: null,
    };
  });

  // Normalize + score within each layer.
  const layers = new Set(rows.map((r) => r.layer));
  for (const layer of layers) {
    const inLayer = rows.filter((r) => r.layer === layer);
    const costs = inLayer.map((r) => r.avgCostPerUnit).filter((v): v is number => v !== null);
    const latencies = inLayer.map((r) => r.avgLatencyS).filter((v): v is number => v !== null);
    const minCost = Math.min(...costs);
    const maxCost = Math.max(...costs);
    const minLat = Math.min(...latencies);
    const maxLat = Math.max(...latencies);

    for (const r of inLayer) {
      if (r.avgCostPerUnit === null || r.avgLatencyS === null) continue;
      const normCost = maxCost === minCost ? 0 : (r.avgCostPerUnit - minCost) / (maxCost - minCost);
      const normLat = maxLat === minLat ? 0 : (r.avgLatencyS - minLat) / (maxLat - minLat);
      const normQuality = r.manualQualityScore === null ? 0 : r.manualQualityScore / 10;
      const qualityWeight = r.manualQualityScore === null ? 0 : weights.qualityWeight;
      const effectiveWeightSum = weights.costWeight + weights.latencyWeight + qualityWeight;
      r.compositeScore =
        effectiveWeightSum === 0
          ? null
          : (weights.costWeight * (1 - normCost) +
              weights.latencyWeight * (1 - normLat) +
              qualityWeight * normQuality) /
            effectiveWeightSum;
    }
  }

  return rows;
}
