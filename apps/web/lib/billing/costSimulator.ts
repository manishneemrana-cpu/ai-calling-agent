import type { PoolClient } from "pg";

/**
 * Cost Simulator (Phase 7) — a REAL computation, not hardcoded output.
 * Given the platform's current `provider_rate_cards` (the vendor-cost side
 * — see db/migrations/004_billing_providers.sql / 009_.../012_...) plus a
 * set of per-call usage assumptions, it computes cost-per-line
 * (telephony/STT/TTS/LLM/infra), total cost, a configurable selling
 * price, and gross revenue/margin/margin% for each call-volume tier.
 *
 * Nothing here is a hardcoded price point. Every number that varies by
 * business decision (rate cards, per-call assumptions, selling price) is
 * an input; this module is pure math over those inputs (see
 * `computeCostSimulation`, which takes no DB connection at all — the same
 * separation-of-pure-math-from-IO pattern as
 * services/voice-gateway/voice_gateway/billing/cost_writer.py's
 * `compute_cost_usd`), so its correctness is testable without Postgres.
 */

export type RateCardLookup = {
  telephony: { unitPriceUsd: number; unit: "per_minute" };
  stt: { unitPriceUsd: number; unit: "per_minute" };
  tts: { unitPriceUsd: number; unit: "per_1k_chars" };
  llm: { unitPriceUsd: number; unit: "per_1m_tokens" };
};

export type SimulatorAssumptions = {
  /** Average conversational turns per connected minute. */
  avgTurnsPerMinute: number;
  /** Average LLM input tokens per turn (system+history+user utterance). */
  avgLlmInputTokensPerTurn: number;
  /** Average LLM output tokens per turn (agent reply). */
  avgLlmOutputTokensPerTurn: number;
  /** Average TTS characters synthesized per turn (agent reply). */
  avgTtsCharsPerTurn: number;
  /** Infra allocation per connected minute, in USD — a rough amortized
   * estimate (compute/hosting/observability/on-call/support), fully
   * configurable, not derived from a rate card (there is no vendor for
   * "your own infra"). */
  infraCostPerMinuteUsd: number;
  /** What the platform charges the customer per connected minute, in USD.
   * NEVER hardcoded elsewhere — this is the one number every "selling
   * price" example in project docs is illustrative of, and it must always
   * flow from here (ultimately from a tenant's billing_plans row in a
   * real invoicing flow), never a literal in code. */
  sellingPricePerMinuteUsd: number;
};

export const DEFAULT_TIERS_MINUTES_PER_MONTH = [100, 1_000, 5_000, 10_000, 50_000, 100_000, 500_000] as const;

export type SimulatorTierResult = {
  minutesPerMonth: number;
  telephonyCostUsd: number;
  sttCostUsd: number;
  ttsCostUsd: number;
  llmCostUsd: number;
  infraCostUsd: number;
  totalCostUsd: number;
  grossRevenueUsd: number;
  grossMarginUsd: number;
  grossMarginPercent: number;
};

/**
 * Pure function — given known rate cards + known assumptions, produces
 * cost-per-line + totals for one tier. Multiplying this by minutesPerMonth
 * is exactly what the per-connected-minute figures in
 * docs/COST_MODEL_V1.md represent, generalized to be rate-card-driven
 * instead of a document's hand-typed numbers.
 */
export function computeTierCost(
  minutesPerMonth: number,
  rateCards: RateCardLookup,
  assumptions: SimulatorAssumptions
): SimulatorTierResult {
  const turnsPerMonth = minutesPerMonth * assumptions.avgTurnsPerMinute;

  const telephonyCostUsd = minutesPerMonth * rateCards.telephony.unitPriceUsd;
  const sttCostUsd = minutesPerMonth * rateCards.stt.unitPriceUsd;

  const ttsCharsPerMonth = turnsPerMonth * assumptions.avgTtsCharsPerTurn;
  const ttsCostUsd = (ttsCharsPerMonth / 1_000) * rateCards.tts.unitPriceUsd;

  const llmTokensPerMonth =
    turnsPerMonth * (assumptions.avgLlmInputTokensPerTurn + assumptions.avgLlmOutputTokensPerTurn);
  const llmCostUsd = (llmTokensPerMonth / 1_000_000) * rateCards.llm.unitPriceUsd;

  const infraCostUsd = minutesPerMonth * assumptions.infraCostPerMinuteUsd;

  const totalCostUsd = telephonyCostUsd + sttCostUsd + ttsCostUsd + llmCostUsd + infraCostUsd;
  const grossRevenueUsd = minutesPerMonth * assumptions.sellingPricePerMinuteUsd;
  const grossMarginUsd = grossRevenueUsd - totalCostUsd;
  const grossMarginPercent = grossRevenueUsd === 0 ? 0 : (grossMarginUsd / grossRevenueUsd) * 100;

  return {
    minutesPerMonth,
    telephonyCostUsd: round4(telephonyCostUsd),
    sttCostUsd: round4(sttCostUsd),
    ttsCostUsd: round4(ttsCostUsd),
    llmCostUsd: round4(llmCostUsd),
    infraCostUsd: round4(infraCostUsd),
    totalCostUsd: round4(totalCostUsd),
    grossRevenueUsd: round4(grossRevenueUsd),
    grossMarginUsd: round4(grossMarginUsd),
    grossMarginPercent: round4(grossMarginPercent),
  };
}

export function computeCostSimulation(
  tiersMinutesPerMonth: readonly number[],
  rateCards: RateCardLookup,
  assumptions: SimulatorAssumptions
): SimulatorTierResult[] {
  return tiersMinutesPerMonth.map((minutes) => computeTierCost(minutes, rateCards, assumptions));
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

/**
 * Loads the current (latest effective_from) rate card for a given
 * provider_key at each layer, from the real `provider_rate_cards` table —
 * so the simulator UI can run against actual platform-configured vendor
 * prices rather than test fixtures.
 */
export async function loadRateCards(
  client: PoolClient,
  providerKeys: { telephony: string; stt: string; tts: string; llm: string }
): Promise<RateCardLookup> {
  async function load(providerType: string, providerKey: string): Promise<{ unitPriceUsd: number; unit: string }> {
    const { rows } = await client.query(
      `SELECT unit, unit_price_usd FROM provider_rate_cards
        WHERE provider_type = $1 AND provider_key = $2 AND effective_from <= current_date
        ORDER BY effective_from DESC LIMIT 1`,
      [providerType, providerKey]
    );
    if (!rows[0]) {
      throw new Error(`No provider_rate_cards row for ${providerType}/${providerKey}`);
    }
    return { unitPriceUsd: Number(rows[0].unit_price_usd), unit: rows[0].unit };
  }

  const [telephony, stt, tts, llm] = await Promise.all([
    load("telephony", providerKeys.telephony),
    load("stt", providerKeys.stt),
    load("tts", providerKeys.tts),
    load("llm", providerKeys.llm),
  ]);

  return {
    telephony: telephony as RateCardLookup["telephony"],
    stt: stt as RateCardLookup["stt"],
    tts: tts as RateCardLookup["tts"],
    llm: llm as RateCardLookup["llm"],
  };
}
