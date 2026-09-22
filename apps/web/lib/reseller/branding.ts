import type { PoolClient } from "pg";
import { withoutTenant } from "../db/tenant";

/**
 * White-label branding (Phase 8). Nothing here is real-estate/founder-brand
 * specific — every field is reseller-configured data, same "no hardcoding"
 * discipline as every prior phase's provider/pipeline config.
 */

export type ResellerBranding = {
  orgId: string;
  companyName: string | null;
  logoUrl: string | null;
  primaryColor: string | null;
  secondaryColor: string | null;
  supportEmail: string | null;
  supportPhone: string | null;
};

export async function getOwnBranding(client: PoolClient, orgId: string): Promise<ResellerBranding | null> {
  const { rows } = await client.query(
    `SELECT org_id, company_name, logo_url, primary_color, secondary_color, subdomain, custom_domain,
            support_email, support_phone
       FROM reseller_branding WHERE org_id = $1`,
    [orgId]
  );
  if (!rows[0]) return null;
  return mapRow(rows[0]);
}

export async function upsertOwnBranding(
  client: PoolClient,
  orgId: string,
  fields: Partial<{
    companyName: string;
    logoUrl: string;
    primaryColor: string;
    secondaryColor: string;
    subdomain: string;
    customDomain: string;
    supportEmail: string;
    supportPhone: string;
  }>
): Promise<void> {
  await client.query(
    `INSERT INTO reseller_branding
       (org_id, company_name, logo_url, primary_color, secondary_color, subdomain, custom_domain, support_email, support_phone)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (org_id) DO UPDATE SET
       company_name = COALESCE($2, reseller_branding.company_name),
       logo_url = COALESCE($3, reseller_branding.logo_url),
       primary_color = COALESCE($4, reseller_branding.primary_color),
       secondary_color = COALESCE($5, reseller_branding.secondary_color),
       subdomain = COALESCE($6, reseller_branding.subdomain),
       custom_domain = COALESCE($7, reseller_branding.custom_domain),
       support_email = COALESCE($8, reseller_branding.support_email),
       support_phone = COALESCE($9, reseller_branding.support_phone),
       updated_at = now()`,
    [
      orgId,
      fields.companyName ?? null,
      fields.logoUrl ?? null,
      fields.primaryColor ?? null,
      fields.secondaryColor ?? null,
      fields.subdomain ?? null,
      fields.customDomain ?? null,
      fields.supportEmail ?? null,
      fields.supportPhone ?? null,
    ]
  );
}

function mapRow(r: Record<string, unknown>): ResellerBranding {
  return {
    orgId: r.org_id as string,
    companyName: (r.company_name as string) ?? null,
    logoUrl: (r.logo_url as string) ?? null,
    primaryColor: (r.primary_color as string) ?? null,
    secondaryColor: (r.secondary_color as string) ?? null,
    supportEmail: (r.support_email as string) ?? null,
    supportPhone: (r.support_phone as string) ?? null,
  };
}

/**
 * White-label domain routing (section 2 of the Phase 8 spec).
 *
 * Why this isn't Next.js Edge Middleware: `resolve_reseller_branding_by_host`
 * needs a real Postgres connection (`pg`), and Next's Edge runtime forbids
 * raw TCP sockets — `pg` cannot run there. This resolver is called instead
 * from the (Node-runtime) dashboard layout as a request-scoped lookup, using
 * exactly the same Host/X-Tenant-Domain header logic true edge middleware or
 * a reverse proxy would use — see docs/RESELLER_HIERARCHY.md "Domain
 * routing" for the full reasoning and the deployment-time follow-up (a real
 * `voice.clientdomain.com` custom domain needs DNS/SSL/reverse-proxy infra
 * this dev sandbox doesn't have).
 *
 * Resolution order:
 * 1. `X-Tenant-Domain` header — explicit override for local dev/testing
 *    (curl/tests can simulate any reseller's domain without real DNS).
 * 2. `Host` header — the production mechanism: `{slug}.yourplatform.com`.
 * Bypasses RLS deliberately (pre-auth, no session yet) via the SECURITY
 * DEFINER function, same rationale as `resolve_session`.
 */
export function extractSubdomain(host: string, baseDomain: string): string | null {
  const bare = host.split(":")[0].toLowerCase();
  const base = baseDomain.toLowerCase();
  if (bare === base || bare === `www.${base}`) return null;
  if (bare.endsWith(`.${base}`)) {
    return bare.slice(0, -1 * (base.length + 1)) || null;
  }
  return null; // not a *.baseDomain host — could still be a registered custom_domain
}

export async function resolveTenantBranding(
  headersLike: { get(name: string): string | null },
  baseDomain: string
): Promise<ResellerBranding | null> {
  const overrideHost = headersLike.get("x-tenant-domain");
  const host = overrideHost ?? headersLike.get("host");
  if (!host) return null;

  const subdomain = extractSubdomain(host.split(":")[0], baseDomain);
  const customDomainCandidate = subdomain ? null : host.split(":")[0].toLowerCase();

  return withoutTenant(async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM resolve_reseller_branding_by_host($1, $2)`,
      [subdomain, customDomainCandidate]
    );
    if (!rows[0]) return null;
    return {
      orgId: rows[0].org_id,
      companyName: rows[0].company_name,
      logoUrl: rows[0].logo_url,
      primaryColor: rows[0].primary_color,
      secondaryColor: rows[0].secondary_color,
      supportEmail: rows[0].support_email,
      supportPhone: rows[0].support_phone,
    };
  });
}
