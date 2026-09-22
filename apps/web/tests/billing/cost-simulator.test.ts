import { describe, it, expect } from "vitest";
import { computeTierCost, computeCostSimulation, type RateCardLookup, type SimulatorAssumptions } from "@/lib/billing/costSimulator";

/**
 * Proves the Cost Simulator's math against hand-computed expected numbers
 * — given known rate-card fixtures and known assumptions, per the Phase 7
 * spec's required test.
 */

const rateCards: RateCardLookup = {
  telephony: { unitPriceUsd: 0.0032, unit: "per_minute" },
  stt: { unitPriceUsd: 0.006, unit: "per_minute" },
  tts: { unitPriceUsd: 0.034, unit: "per_1k_chars" },
  llm: { unitPriceUsd: 0.1, unit: "per_1m_tokens" },
};

const assumptions: SimulatorAssumptions = {
  avgTurnsPerMinute: 2,
  avgLlmInputTokensPerTurn: 200,
  avgLlmOutputTokensPerTurn: 80,
  avgTtsCharsPerTurn: 70,
  infraCostPerMinuteUsd: 0.0017,
  sellingPricePerMinuteUsd: 0.034, // e.g. ~Rs 2.99/min at ~Rs 88/$1 — illustrative test input only
};

describe("computeTierCost — hand-computed math", () => {
  it("matches exact expected numbers for 100 minutes/month", () => {
    const result = computeTierCost(100, rateCards, assumptions);

    // telephony: 100 min * $0.0032 = $0.32
    expect(result.telephonyCostUsd).toBeCloseTo(0.32, 6);
    // stt: 100 min * $0.006 = $0.60
    expect(result.sttCostUsd).toBeCloseTo(0.6, 6);
    // turns = 100 * 2 = 200; tts chars = 200 * 70 = 14,000 -> 14 * $0.034 = $0.476
    expect(result.ttsCostUsd).toBeCloseTo(0.476, 6);
    // llm tokens = 200 * (200+80) = 56,000 -> 0.056 * $0.1 = $0.0056
    expect(result.llmCostUsd).toBeCloseTo(0.0056, 6);
    // infra: 100 * 0.0017 = $0.17
    expect(result.infraCostUsd).toBeCloseTo(0.17, 6);

    const expectedTotal = 0.32 + 0.6 + 0.476 + 0.0056 + 0.17;
    expect(result.totalCostUsd).toBeCloseTo(expectedTotal, 6);

    // revenue: 100 * $0.034 = $3.40
    expect(result.grossRevenueUsd).toBeCloseTo(3.4, 6);
    const expectedMargin = 3.4 - expectedTotal;
    expect(result.grossMarginUsd).toBeCloseTo(expectedMargin, 6);
    expect(result.grossMarginPercent).toBeCloseTo((expectedMargin / 3.4) * 100, 4);
  });

  it("scales linearly with minutesPerMonth (10x minutes -> 10x every cost/revenue line)", () => {
    const t100 = computeTierCost(100, rateCards, assumptions);
    const t1000 = computeTierCost(1000, rateCards, assumptions);
    expect(t1000.totalCostUsd).toBeCloseTo(t100.totalCostUsd * 10, 4);
    expect(t1000.grossRevenueUsd).toBeCloseTo(t100.grossRevenueUsd * 10, 4);
  });

  it("returns 0% margin (not NaN/Infinity) when selling price is 0", () => {
    const result = computeTierCost(100, rateCards, { ...assumptions, sellingPricePerMinuteUsd: 0 });
    expect(result.grossRevenueUsd).toBe(0);
    expect(result.grossMarginPercent).toBe(0);
  });
});

describe("computeCostSimulation — full tier table", () => {
  it("produces one row per requested tier, in order, each matching computeTierCost", () => {
    const tiers = [100, 1000, 5000] as const;
    const rows = computeCostSimulation(tiers, rateCards, assumptions);
    expect(rows.map((r) => r.minutesPerMonth)).toEqual([100, 1000, 5000]);
    rows.forEach((row, i) => {
      expect(row).toEqual(computeTierCost(tiers[i], rateCards, assumptions));
    });
  });
});
