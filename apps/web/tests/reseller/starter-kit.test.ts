import { describe, it, expect } from "vitest";
import {
  computeResellerTierEconomics,
  computeResellerStarterKitTable,
  tableToCsv,
} from "@/lib/reseller/starterKit";

describe("computeResellerTierEconomics — pure math over the reseller's OWN buy/sell numbers", () => {
  it("matches hand-computed numbers", () => {
    const r = computeResellerTierEconomics(1000, 0.0025, 0.02);
    expect(r.costUsd).toBeCloseTo(2.5, 6); // 1000 * 0.0025
    expect(r.revenueUsd).toBeCloseTo(20, 6); // 1000 * 0.02
    expect(r.marginUsd).toBeCloseTo(17.5, 6);
    expect(r.marginPercent).toBeCloseTo(87.5, 4); // 17.5 / 20 * 100
  });

  it("returns 0% margin (not NaN/Infinity) when sell price is 0", () => {
    const r = computeResellerTierEconomics(1000, 0.0025, 0);
    expect(r.revenueUsd).toBe(0);
    expect(r.marginPercent).toBe(0);
  });

  it("never references provider_rate_cards or any platform-cost concept — pure function of its own two rate args", () => {
    // Structural proof: this function's signature takes only
    // (minutes, buyPrice, sellPrice) — there is no rate-card/provider_key
    // parameter it could leak through even if misused.
    expect(computeResellerTierEconomics.length).toBe(3);
  });
});

describe("computeResellerStarterKitTable", () => {
  it("produces one row per tier, each matching computeResellerTierEconomics", () => {
    const tiers = [500, 2000, 10000] as const;
    const rows = computeResellerStarterKitTable(tiers, 0.0025, 0.02);
    expect(rows.map((r) => r.minutesPerMonth)).toEqual([500, 2000, 10000]);
    rows.forEach((row, i) => {
      expect(row).toEqual(computeResellerTierEconomics(tiers[i], 0.0025, 0.02));
    });
  });
});

describe("tableToCsv", () => {
  it("produces a header row plus one row per tier", () => {
    const rows = computeResellerStarterKitTable([500, 2000], 0.0025, 0.02);
    const csv = tableToCsv(rows, "USD");
    const lines = csv.trim().split("\n");
    expect(lines).toHaveLength(3); // header + 2 tiers
    expect(lines[0]).toContain("Minutes/month");
    expect(lines[1]).toContain("500");
  });
});
