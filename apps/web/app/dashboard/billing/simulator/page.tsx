import { getSession } from "@/lib/auth";
import { withTenant } from "@/lib/db/tenant";
import {
  computeCostSimulation,
  DEFAULT_TIERS_MINUTES_PER_MONTH,
  loadRateCards,
  type SimulatorAssumptions,
} from "@/lib/billing/costSimulator";
import { PageHeader } from "@/components/ui/PageHeader";

/**
 * /dashboard/billing/simulator — plumbing-proof Cost Simulator page.
 * Renders a REAL computation (lib/billing/costSimulator.ts) against the
 * platform's actual `provider_rate_cards` for its default demo providers
 * (mock, which is $0 — see the note below the table for how to point this
 * at a real provider_key). Every assumption shown is a query-string
 * override, never a hardcoded number in this page's own code.
 */

const DEFAULT_ASSUMPTIONS: SimulatorAssumptions = {
  avgTurnsPerMinute: 2,
  avgLlmInputTokensPerTurn: 200,
  avgLlmOutputTokensPerTurn: 80,
  avgTtsCharsPerTurn: 70,
  infraCostPerMinuteUsd: 0.0017,
  sellingPricePerMinuteUsd: 0.034,
};

function numOr(value: string | string[] | undefined, fallback: number): number {
  const v = Array.isArray(value) ? value[0] : value;
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

export default async function CostSimulatorPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await getSession();
  if (!session) return null;
  if (session.orgRole !== "platform") {
    // Phase 8: provider_rate_cards is now RLS-gated to the platform owner
    // (db/migrations/013_phase8_reseller_hierarchy.sql) — a reseller or
    // customer org's connection gets zero rows here by design. Resellers
    // get their own cost-simulator EXPORT instead, built off their own
    // buy/sell rates — see /dashboard/reseller/starter-kit.
    return (
      <div>
        <PageHeader title="Cost Simulator" />
        <div className="card">
          <p className="error">
            Platform-owner only — this simulator runs against real vendor <code>provider_rate_cards</code>.
            Resellers: see /dashboard/reseller/starter-kit for your own cost-simulator export.
          </p>
        </div>
      </div>
    );
  }
  const sp = await searchParams;

  const providerKeys = {
    telephony: (Array.isArray(sp.telephony) ? sp.telephony[0] : sp.telephony) ?? "mock",
    stt: (Array.isArray(sp.stt) ? sp.stt[0] : sp.stt) ?? "mock",
    tts: (Array.isArray(sp.tts) ? sp.tts[0] : sp.tts) ?? "mock",
    llm: (Array.isArray(sp.llm) ? sp.llm[0] : sp.llm) ?? "mock",
  };

  const assumptions: SimulatorAssumptions = {
    avgTurnsPerMinute: numOr(sp.avgTurnsPerMinute, DEFAULT_ASSUMPTIONS.avgTurnsPerMinute),
    avgLlmInputTokensPerTurn: numOr(sp.avgLlmInputTokensPerTurn, DEFAULT_ASSUMPTIONS.avgLlmInputTokensPerTurn),
    avgLlmOutputTokensPerTurn: numOr(sp.avgLlmOutputTokensPerTurn, DEFAULT_ASSUMPTIONS.avgLlmOutputTokensPerTurn),
    avgTtsCharsPerTurn: numOr(sp.avgTtsCharsPerTurn, DEFAULT_ASSUMPTIONS.avgTtsCharsPerTurn),
    infraCostPerMinuteUsd: numOr(sp.infraCostPerMinuteUsd, DEFAULT_ASSUMPTIONS.infraCostPerMinuteUsd),
    sellingPricePerMinuteUsd: numOr(sp.sellingPricePerMinuteUsd, DEFAULT_ASSUMPTIONS.sellingPricePerMinuteUsd),
  };

  const { rateCards, error } = await withTenant(session.orgId, session.userId, async (client) => {
    try {
      return { rateCards: await loadRateCards(client, providerKeys), error: null as string | null };
    } catch (e) {
      return { rateCards: null, error: e instanceof Error ? e.message : "Failed to load rate cards" };
    }
  });

  const rows = rateCards ? computeCostSimulation(DEFAULT_TIERS_MINUTES_PER_MONTH, rateCards, assumptions) : [];

  return (
    <div>
      <PageHeader
        title="Cost Simulator"
        description={
          <>
            Real computation over the platform&apos;s current provider_rate_cards (vendor cost) — never hardcoded
            output. Adjust assumptions via query params, e.g. ?sellingPricePerMinuteUsd=0.04&avgTurnsPerMinute=3.
          </>
        }
      />

      <div className="card">
        {error && (
          <p className="error">
            Could not load rate cards for {JSON.stringify(providerKeys)}: {error}
          </p>
        )}

        {rateCards && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Minutes/month</th>
                  <th>Telephony</th>
                  <th>STT</th>
                  <th>TTS</th>
                  <th>LLM</th>
                  <th>Infra</th>
                  <th>Total cost</th>
                  <th>Gross revenue</th>
                  <th>Gross margin</th>
                  <th>Margin %</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.minutesPerMonth}>
                    <td>{r.minutesPerMonth.toLocaleString()}</td>
                    <td>${r.telephonyCostUsd.toFixed(2)}</td>
                    <td>${r.sttCostUsd.toFixed(2)}</td>
                    <td>${r.ttsCostUsd.toFixed(2)}</td>
                    <td>${r.llmCostUsd.toFixed(2)}</td>
                    <td>${r.infraCostUsd.toFixed(2)}</td>
                    <td>${r.totalCostUsd.toFixed(2)}</td>
                    <td>${r.grossRevenueUsd.toFixed(2)}</td>
                    <td>${r.grossMarginUsd.toFixed(2)}</td>
                    <td>{r.grossMarginPercent.toFixed(1)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
