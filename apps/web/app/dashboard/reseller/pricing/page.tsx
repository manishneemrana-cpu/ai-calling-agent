import { getSession } from "@/lib/auth";
import { withTenant } from "@/lib/db/tenant";
import { getResellerBuyRate, getResellerSellRate } from "@/lib/reseller/pricing";
import { getOwnBranding } from "@/lib/reseller/branding";
import { updateSellRateAction, updateBrandingAction } from "../actions";

/**
 * /dashboard/reseller/pricing — where a reseller configures their own sell
 * price (Z in the spec) and white-label branding. The buy rate (Y) shown
 * here is read-only: it comes from `reseller_buy_rates`, which only the
 * platform owner can write (see docs/RESELLER_HIERARCHY.md).
 */
export default async function ResellerPricingPage() {
  const session = await getSession();
  if (!session) return null;
  if (session.orgRole !== "reseller") {
    return (
      <div className="card">
        <h1>Pricing</h1>
        <p className="error">This page is only available to reseller accounts.</p>
      </div>
    );
  }

  const { buyRate, sellRate, branding } = await withTenant(session.orgId, session.userId, async (client) => ({
    buyRate: await getResellerBuyRate(client, session.orgId),
    sellRate: await getResellerSellRate(client, session.orgId),
    branding: await getOwnBranding(client, session.orgId),
  }));

  return (
    <div className="card">
      <h1>Pricing &amp; Branding</h1>

      <h2>Your buy rate (what YOU pay the platform)</h2>
      <p className="empty-state" style={{ marginBottom: "1rem" }}>
        Set only by the platform owner (<code>set_reseller_buy_rate()</code> — you have no write access to this
        number, by design; see <code>reseller_buy_rates</code> in
        db/migrations/013_phase8_reseller_hierarchy.sql).
      </p>
      <p>
        {buyRate ? (
          <>
            <strong>${buyRate.buyPricePerMinuteUsd.toFixed(6)}</strong> {buyRate.currency}/minute
          </>
        ) : (
          "Not yet set by the platform owner."
        )}
      </p>

      <h2 style={{ marginTop: "2rem" }}>Your sell rate (what your CUSTOMERS pay you)</h2>
      <p className="empty-state" style={{ marginBottom: "1rem" }}>
        Configurable per-minute sell price. See docs/RESELLER_HIERARCHY.md for why this is a single global rate
        rather than a per-provider markup matrix — per-customer negotiated pricing still uses Phase 7&apos;s
        <code> billing_plans</code>.
      </p>
      <form action={updateSellRateAction}>
        <label>
          Sell price (USD/minute)
          <input
            type="number"
            step="0.0001"
            min="0"
            name="sellPricePerMinuteUsd"
            defaultValue={sellRate?.sellPricePerMinuteUsd ?? ""}
            required
          />
        </label>
        <button type="submit">Save sell rate</button>
      </form>

      <h2 style={{ marginTop: "2rem" }}>White-label branding</h2>
      <p className="empty-state" style={{ marginBottom: "1rem" }}>
        Shown in your customers&apos; dashboard chrome, resolved by domain/subdomain — see
        docs/RESELLER_HIERARCHY.md &quot;Domain routing&quot;.
      </p>
      <form action={updateBrandingAction}>
        <label>
          Company name
          <input type="text" name="companyName" defaultValue={branding?.companyName ?? ""} />
        </label>
        <label>
          Logo URL
          <input type="text" name="logoUrl" defaultValue={branding?.logoUrl ?? ""} />
        </label>
        <label>
          Primary color
          <input type="text" name="primaryColor" placeholder="#1a73e8" defaultValue={branding?.primaryColor ?? ""} />
        </label>
        <label>
          Secondary color
          <input type="text" name="secondaryColor" placeholder="#111827" defaultValue={branding?.secondaryColor ?? ""} />
        </label>
        <label>
          Subdomain
          <input type="text" name="subdomain" placeholder="acme" />
        </label>
        <label>
          Support email
          <input type="email" name="supportEmail" defaultValue={branding?.supportEmail ?? ""} />
        </label>
        <label>
          Support phone
          <input type="text" name="supportPhone" defaultValue={branding?.supportPhone ?? ""} />
        </label>
        <button type="submit">Save branding</button>
      </form>
    </div>
  );
}
