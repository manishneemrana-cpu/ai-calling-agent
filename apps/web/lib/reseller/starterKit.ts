import type { PoolClient } from "pg";
import { randomBytes } from "crypto";

/**
 * Reseller Starter Kit — cost-simulator export (section 4 of the Phase 8
 * spec). Deliberately computed ONLY from a reseller's own buy/sell numbers
 * (`reseller_buy_rates`/`reseller_sell_rates`), never from
 * `provider_rate_cards` — a prospect (or the reseller sharing the link)
 * must never be able to reverse-engineer the platform's real vendor cost
 * from this export. Pure math lives here, same
 * separation-of-pure-math-from-IO pattern as
 * lib/billing/costSimulator.ts's `computeTierCost`.
 */

export type StarterKitTierResult = {
  minutesPerMonth: number;
  costUsd: number; // what the RESELLER pays (their buy rate * minutes)
  revenueUsd: number; // what the reseller charges the CUSTOMER (sell rate * minutes)
  marginUsd: number;
  marginPercent: number;
};

export const DEFAULT_STARTER_KIT_TIERS_MINUTES = [500, 2_000, 10_000, 50_000] as const;

export function computeResellerTierEconomics(
  minutesPerMonth: number,
  buyPricePerMinuteUsd: number,
  sellPricePerMinuteUsd: number
): StarterKitTierResult {
  const costUsd = round4(minutesPerMonth * buyPricePerMinuteUsd);
  const revenueUsd = round4(minutesPerMonth * sellPricePerMinuteUsd);
  const marginUsd = round4(revenueUsd - costUsd);
  const marginPercent = revenueUsd === 0 ? 0 : round4((marginUsd / revenueUsd) * 100);
  return { minutesPerMonth, costUsd, revenueUsd, marginUsd, marginPercent };
}

export function computeResellerStarterKitTable(
  tiersMinutesPerMonth: readonly number[],
  buyPricePerMinuteUsd: number,
  sellPricePerMinuteUsd: number
): StarterKitTierResult[] {
  return tiersMinutesPerMonth.map((m) => computeResellerTierEconomics(m, buyPricePerMinuteUsd, sellPricePerMinuteUsd));
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

export function tableToCsv(rows: StarterKitTierResult[], currency: string): string {
  const header = ["Minutes/month", `Cost (${currency})`, `Revenue (${currency})`, `Margin (${currency})`, "Margin %"];
  const lines = [header.join(",")];
  for (const r of rows) {
    lines.push([r.minutesPerMonth, r.costUsd, r.revenueUsd, r.marginUsd, r.marginPercent].join(","));
  }
  return lines.join("\n") + "\n";
}

/**
 * Creates a durable, shareable snapshot a reseller can hand to a prospect —
 * a link the prospect can open without ever logging in
 * (`get_starter_kit_share()`, db/migrations/013_phase8_reseller_hierarchy.sql).
 * The buy/sell rates are snapshotted at creation time, not live-joined, so
 * the link keeps showing what was true when it was created even if the
 * reseller's rates change later (see that function's own comment).
 */
export async function createStarterKitShare(
  client: PoolClient,
  params: {
    resellerOrgId: string;
    prospectName?: string;
    planLabel?: string;
    estimatedMinutesPerMonth: number;
    buyPricePerMinuteUsd: number;
    sellPricePerMinuteUsd: number;
    currency?: string;
    expiresAt?: Date | null;
  }
): Promise<{ shareToken: string }> {
  const shareToken = randomBytes(16).toString("hex");
  await client.query(
    `INSERT INTO reseller_starter_kit_shares
       (reseller_org_id, share_token, prospect_name, plan_label, estimated_minutes_per_month,
        buy_price_per_minute_usd, sell_price_per_minute_usd, currency, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      params.resellerOrgId,
      shareToken,
      params.prospectName ?? null,
      params.planLabel ?? null,
      params.estimatedMinutesPerMonth,
      params.buyPricePerMinuteUsd,
      params.sellPricePerMinuteUsd,
      params.currency ?? "USD",
      params.expiresAt ?? null,
    ]
  );
  return { shareToken };
}

export type StarterKitShareSnapshot = {
  prospectName: string | null;
  planLabel: string | null;
  estimatedMinutesPerMonth: number;
  buyPricePerMinuteUsd: number;
  sellPricePerMinuteUsd: number;
  currency: string;
  createdAt: string;
  expiresAt: string | null;
} | null;

/** Public, token-authenticated read — no session/org context required. Uses
 * the SECURITY DEFINER function directly (any PoolClient works, tenant-scoped
 * or not, same as scoreboard.ts's platform-level reads). */
export async function readStarterKitShare(client: PoolClient, shareToken: string): Promise<StarterKitShareSnapshot> {
  const { rows } = await client.query(`SELECT * FROM get_starter_kit_share($1)`, [shareToken]);
  if (!rows[0]) return null;
  const r = rows[0];
  return {
    prospectName: r.prospect_name,
    planLabel: r.plan_label,
    estimatedMinutesPerMonth: Number(r.estimated_minutes_per_month),
    buyPricePerMinuteUsd: Number(r.buy_price_per_minute_usd),
    sellPricePerMinuteUsd: Number(r.sell_price_per_minute_usd),
    currency: r.currency,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
  };
}
