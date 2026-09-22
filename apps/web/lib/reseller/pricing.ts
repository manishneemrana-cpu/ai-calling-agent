import type { PoolClient } from "pg";

/**
 * Phase 8 reseller buy/sell pricing — the mechanism proving Platform cost
 * (Y, what a reseller pays) vs Reseller sell price (Z, what their customer
 * pays) vs margin (Z - Y), per the spec's resale economics.
 *
 * Granularity decision (documented in docs/RESELLER_HIERARCHY.md): a single
 * configurable USD-per-minute buy rate and sell rate per reseller, not a
 * per-provider markup matrix. A reseller's per-customer negotiated pricing
 * still flows through Phase 7's existing `billing_plans` (org-scoped custom
 * plan rows) — this pair of numbers exists to (a) prove the buy/sell/margin
 * mechanism and (b) drive the Reseller Starter Kit's cost-simulator export,
 * not to replace billing_plans.
 *
 * Visibility is enforced by the DB, not by this module:
 * - `reseller_buy_rates` is SELECT-only for app_user (see
 *   db/migrations/013_phase8_reseller_hierarchy.sql) — only
 *   `set_reseller_buy_rate()` (platform-only, checked inside the function)
 *   can write it. A reseller reading their own row via `withTenant` sees
 *   only their OWN buy rate, never another reseller's or the platform's raw
 *   `provider_rate_cards`.
 * - `reseller_sell_rates` is normal org-isolated (reseller manages their
 *   own). A customer org querying either table sees zero rows (RLS
 *   `org_id = current_org_id()`, and a customer's own org_id is never the
 *   reseller's org_id).
 */

export type ResellerBuyRate = { buyPricePerMinuteUsd: number; currency: string } | null;
export type ResellerSellRate = { sellPricePerMinuteUsd: number; currency: string } | null;

export async function getResellerBuyRate(client: PoolClient, resellerOrgId: string): Promise<ResellerBuyRate> {
  const { rows } = await client.query(
    `SELECT buy_price_per_minute_usd, currency FROM reseller_buy_rates WHERE org_id = $1`,
    [resellerOrgId]
  );
  if (!rows[0]) return null;
  return { buyPricePerMinuteUsd: Number(rows[0].buy_price_per_minute_usd), currency: rows[0].currency };
}

export async function getResellerSellRate(client: PoolClient, resellerOrgId: string): Promise<ResellerSellRate> {
  const { rows } = await client.query(
    `SELECT sell_price_per_minute_usd, currency FROM reseller_sell_rates WHERE org_id = $1`,
    [resellerOrgId]
  );
  if (!rows[0]) return null;
  return { sellPricePerMinuteUsd: Number(rows[0].sell_price_per_minute_usd), currency: rows[0].currency };
}

/** Reseller-managed: upsert their own sell rate. Ordinary tenant-scoped
 * write — no elevated privilege needed, unlike the buy rate. */
export async function setResellerSellRate(
  client: PoolClient,
  resellerOrgId: string,
  sellPricePerMinuteUsd: number,
  currency = "USD"
): Promise<void> {
  await client.query(
    `INSERT INTO reseller_sell_rates (org_id, sell_price_per_minute_usd, currency)
     VALUES ($1, $2, $3)
     ON CONFLICT (org_id) DO UPDATE SET sell_price_per_minute_usd = $2, currency = $3, updated_at = now()`,
    [resellerOrgId, sellPricePerMinuteUsd, currency]
  );
}

/** Platform-only: sets a reseller's buy rate via the SECURITY DEFINER
 * function, which itself re-checks current_org_role() = 'platform' — this
 * wrapper does not add a check of its own; the DB is the boundary. */
export async function setResellerBuyRate(
  client: PoolClient,
  resellerOrgId: string,
  buyPricePerMinuteUsd: number,
  currency = "USD",
  setByPlatformUser?: string | null
): Promise<void> {
  await client.query(`SELECT set_reseller_buy_rate($1, $2, $3, $4)`, [
    resellerOrgId,
    buyPricePerMinuteUsd,
    currency,
    setByPlatformUser ?? null,
  ]);
}

export type ResellerMargin = {
  buyPricePerMinuteUsd: number | null;
  sellPricePerMinuteUsd: number | null;
  marginPerMinuteUsd: number | null;
  marginPercent: number | null;
};

/** Pure computation — margin = sell - buy. Null when either rate isn't
 * configured yet, never a fabricated 0. */
export function computeResellerMargin(buy: ResellerBuyRate, sell: ResellerSellRate): ResellerMargin {
  const buyPrice = buy?.buyPricePerMinuteUsd ?? null;
  const sellPrice = sell?.sellPricePerMinuteUsd ?? null;
  if (buyPrice === null || sellPrice === null) {
    return { buyPricePerMinuteUsd: buyPrice, sellPricePerMinuteUsd: sellPrice, marginPerMinuteUsd: null, marginPercent: null };
  }
  const margin = sellPrice - buyPrice;
  return {
    buyPricePerMinuteUsd: buyPrice,
    sellPricePerMinuteUsd: sellPrice,
    marginPerMinuteUsd: margin,
    marginPercent: sellPrice === 0 ? 0 : (margin / sellPrice) * 100,
  };
}
