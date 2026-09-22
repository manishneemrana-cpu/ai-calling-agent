import { getSession } from "@/lib/auth";
import { withTenant } from "@/lib/db/tenant";
import { getResellerBuyRate, getResellerSellRate } from "@/lib/reseller/pricing";
import { getOwnBranding } from "@/lib/reseller/branding";
import { updateSellRateAction, updateBrandingAction } from "../actions";
import { PageHeader } from "@/components/ui/PageHeader";

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
      <div>
        <PageHeader title="Pricing" />
        <div className="card">
          <p className="error">This page is only available to reseller accounts.</p>
        </div>
      </div>
    );
  }

  const { buyRate, sellRate, branding } = await withTenant(session.orgId, session.userId, async (client) => ({
    buyRate: await getResellerBuyRate(client, session.orgId),
    sellRate: await getResellerSellRate(client, session.orgId),
    branding: await getOwnBranding(client, session.orgId),
  }));

  return (
    <div>
      <PageHeader title="Pricing & Branding" />

      <div className="card">
        <h2>Your buy rate (what YOU pay the platform)</h2>
        <p className="text-muted">
          Set only by the platform owner — you have no write access to this number, by design.
        </p>
        <p style={{ marginBottom: 0 }}>
          {buyRate ? (
            <>
              <strong>${buyRate.buyPricePerMinuteUsd.toFixed(6)}</strong> {buyRate.currency}/minute
            </>
          ) : (
            "Not yet set by the platform owner."
          )}
        </p>
      </div>

      <div className="card">
        <h2>Your sell rate (what your CUSTOMERS pay you)</h2>
        <p className="text-muted">Configurable per-minute sell price.</p>
        <form action={updateSellRateAction}>
          <div className="field" style={{ maxWidth: 320 }}>
            <label htmlFor="sellPricePerMinuteUsd">Sell price (USD/minute)</label>
            <input
              id="sellPricePerMinuteUsd"
              type="number"
              step="0.0001"
              min="0"
              name="sellPricePerMinuteUsd"
              defaultValue={sellRate?.sellPricePerMinuteUsd ?? ""}
              required
            />
          </div>
          <button type="submit" className="btn-primary">Save sell rate</button>
        </form>
      </div>

      <div className="card">
        <h2>White-label branding</h2>
        <p className="text-muted">
          Shown in your customers&apos; dashboard chrome — logo, company name, and primary/accent colors override
          the default Navy/Gold theme for everyone under your reseller org.
        </p>
        <form action={updateBrandingAction}>
          <div className="field-row">
            <div className="field">
              <label htmlFor="companyName">Company name</label>
              <input id="companyName" type="text" name="companyName" defaultValue={branding?.companyName ?? ""} />
            </div>
            <div className="field">
              <label htmlFor="logoUrl">Logo URL</label>
              <input id="logoUrl" type="text" name="logoUrl" defaultValue={branding?.logoUrl ?? ""} />
            </div>
          </div>
          <div className="field-row">
            <div className="field">
              <label htmlFor="primaryColor">Primary color</label>
              <input
                id="primaryColor"
                type="text"
                name="primaryColor"
                placeholder="#0a1f44"
                defaultValue={branding?.primaryColor ?? ""}
              />
            </div>
            <div className="field">
              <label htmlFor="secondaryColor">Accent color</label>
              <input
                id="secondaryColor"
                type="text"
                name="secondaryColor"
                placeholder="#c9a227"
                defaultValue={branding?.secondaryColor ?? ""}
              />
            </div>
          </div>
          <div className="field">
            <label htmlFor="subdomain">Subdomain</label>
            <input id="subdomain" type="text" name="subdomain" placeholder="acme" />
          </div>
          <div className="field-row">
            <div className="field">
              <label htmlFor="supportEmail">Support email</label>
              <input id="supportEmail" type="email" name="supportEmail" defaultValue={branding?.supportEmail ?? ""} />
            </div>
            <div className="field">
              <label htmlFor="supportPhone">Support phone</label>
              <input id="supportPhone" type="text" name="supportPhone" defaultValue={branding?.supportPhone ?? ""} />
            </div>
          </div>
          <button type="submit" className="btn-primary">Save branding</button>
        </form>
      </div>
    </div>
  );
}
