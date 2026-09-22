# Reseller & White-Label Hierarchy (Phase 8)

Builds directly on Phase 1's `organizations` (the tenant table) and Phase 7's
`billing_accounts` / `wallets` / `cost_records` / `provider_rate_cards`. No
table is forked or duplicated — the hierarchy is columns and small new
tables layered on the existing tenant-isolation (RLS) machinery.

## 1. Hierarchy modeling decision

**Chosen: option (a)** — extend `organizations` with `org_role` (`platform`
\| `reseller` \| `customer`) and a nullable self-reference
`parent_reseller_id`, rather than a separate `resellers` table (option (b)).

```
organizations
  id              uuid
  org_role        text  ('platform' | 'reseller' | 'customer')
  parent_reseller_id  uuid REFERENCES organizations(id)
```

- Platform owner: `org_role='platform'`, `parent_reseller_id IS NULL`.
- Reseller: `org_role='reseller'`, `parent_reseller_id` = the platform org's id.
- Customer (directly sold): `org_role='customer'`, `parent_reseller_id IS NULL`.
- Customer (resold): `org_role='customer'`, `parent_reseller_id` = a reseller's org id.

### Why (a), not a dedicated `resellers` table

A reseller **is** an organization in every sense the spec asks for: it needs
its own users, its own provider config (`tenant_provider_config`), its own
billing (`billing_accounts`), its own agents/campaigns/leads — every one of
those tables is already `org_id`-scoped and RLS-isolated. A separate
`resellers` table with a 1:1/1:N link to `organizations` rows it manages
would either (i) duplicate all of that machinery for the reseller's own
identity, or (ii) still need a `1:1` FK to an `organizations` row for the
reseller's own tenant data anyway — at which point it's an extra join for no
extra guarantee. Reusing the same table means:

- **Zero new RLS pattern to design.** Every reseller-scoped table in this
  phase (`reseller_branding`, `reseller_buy_rates`, `reseller_sell_rates`,
  `reseller_starter_kit_shares`) uses the exact same
  `org_id = current_org_id()` policy every other tenant table in this
  codebase uses. A customer can never see a reseller's row in any of these
  tables for the same reason it can never see another customer's `wallets`
  row today — different `org_id`, RLS returns zero rows, full stop.
- **`billing_accounts.reseller_id`** (added in `012_phase7_billing.sql`
  specifically as this phase's extension point) is simply a
  `organizations(id)` FK — it needed no change at all; it now points at a
  row that happens to have `org_role='reseller'`.
- **The hierarchy query is one self-join**, not a cross-table join:
  `SELECT * FROM organizations WHERE parent_reseller_id = :resellerId`.

The tradeoff: nothing in the schema enforces "a reseller's
`parent_reseller_id` must itself be `org_role='platform'`" as a `CHECK`
constraint (Postgres `CHECK` can't reference another row). This is
documented, not silently assumed — the only two places `parent_reseller_id`
is ever set are `promote_org_role()` and `create_customer_org()`, both
`SECURITY DEFINER` functions that only the platform owner or a reseller
(respectively) can call, and both set it correctly by construction. A
constraint trigger could enforce it as a follow-up; not needed to prove the
mechanism in this phase.

## 2. Buy-side / sell-side pricing (resale economics)

Per the spec: **platform cost** (Y-source) = real vendor cost from
`cost_records`/`provider_rate_cards` (Phase 1/3.5/4/7, unchanged). A
reseller **buys** at a configured price Y, **sells** to their customer at a
configured price Z, **margin = Z − Y**.

Two new tables, both a single global USD-per-minute rate (not a
per-provider markup matrix — see "Granularity" below):

- `reseller_buy_rates` (Y) — **platform-owner-write-only**. `app_user` has
  `SELECT`-only grant on this table; the only way to write it is
  `set_reseller_buy_rate()`, a `SECURITY DEFINER` function that itself
  checks `current_org_role() = 'platform'` before writing anything. A
  reseller reading their own row sees only their own number.
- `reseller_sell_rates` (Z) — **reseller-write**, ordinary RLS-scoped
  `INSERT`/`UPDATE` (`org_id = current_org_id()`), same as any other tenant
  table a tenant manages themselves.

### Granularity: why one global rate, not a per-provider markup matrix

The spec explicitly allows either and asks for a documented, simpler choice
if a single rate is "enough to prove the mechanism." A per-provider markup
matrix (different margin on `frejun_teler` vs `plivo`, `sarvam` vs
`deepgram`, etc.) adds real complexity — it would need its own UI, its own
resolution-order rules when a call could be billed under more than one
provider combination, and its own visibility rules — for no additional
proof of the underlying buy/sell/margin mechanism this phase needs to
demonstrate. A single configurable USD/minute buy rate and sell rate per
reseller proves `margin = sell − buy` exactly as well, and is trivially
extensible to a matrix later (same shape as `provider_rate_cards` itself,
should a founder ever need it) without a breaking schema change — just more
rows keyed by `(org_id, provider_type, provider_key)` instead of one row
per org.

**Per-customer pricing is a separate, already-solved concern**: Phase 7's
`billing_plans` already supports an org-scoped custom plan
(`billing_plans.org_id` set to a specific tenant). A reseller negotiating a
bespoke rate with one specific customer creates a `billing_plans` row for
that customer's org, exactly as a platform owner would for a direct
customer today — this phase does not need to invent a second pricing path
for that; `reseller_sell_rates` is the reseller's own *default/list* price
(the number the Reseller Starter Kit's cost-simulator export uses when
pitching a prospect who has no plan yet), not the only price a reseller can
ever charge.

## 3. The hard visibility rule — how it's enforced

> A reseller's queries NEVER return platform-level `provider_rate_cards` /
> raw cost data. A reseller's customer NEVER sees the reseller's
> cost/margin.

This is enforced at the **database** layer, the same standard as every
prior phase's "structurally impossible to bypass" gate:

1. **`current_org_role()`** (new SQL function, same pattern as
   `current_org_id()`/`current_app_user_id()` from
   `001_extensions_and_core.sql`) reads a new `app.current_org_role`
   transaction-local setting. `apps/web/lib/db/tenant.ts`'s `withTenant()`
   sets it on **every** transaction by re-reading the caller's own
   `organizations.org_role` row from the DB itself — never trusted from a
   caller-supplied argument or a cached session field. Even a compromised
   application code path cannot spoof a different `org_role` than what the
   org's row in the DB actually says.
2. **`provider_rate_cards` now has RLS enabled and FORCED**
   (`013_phase8_reseller_hierarchy.sql`), gated to
   `current_org_role() = 'platform'`. Before this phase, this table had RLS
   *intentionally off* (Phase 1/7's own comment: "not tenant data, every
   tenant sees the same catalog") — that was true before resale was a
   requirement, and is exactly the assumption Phase 8 breaks. Any
   `withTenant()`-scoped connection from a reseller or customer org now
   gets **zero rows**, full stop, regardless of what application code
   around it does or doesn't check.
3. **`reseller_buy_rates`/`reseller_sell_rates`** are plain
   `org_id = current_org_id()`-isolated, so a customer org (whose
   `current_org_id()` is never the reseller's `org_id`) gets zero rows from
   either table by the same mechanism every other tenant table in this
   codebase already relies on.
4. **Platform-only cross-tenant reads** (`platform_list_resellers()`,
   `/dashboard/admin/resellers`) are `SECURITY DEFINER` functions that
   *themselves* `RAISE EXCEPTION` unless `current_org_role() = 'platform'`
   — the same "check inside the function, not just at the call site"
   discipline as `set_reseller_buy_rate()`/`promote_org_role()`. This is
   stricter than Phase 7's own `platform_provider_cost_stats()` (which has
   no such internal check, since it carries no per-org identifying data to
   leak) because `platform_list_resellers()` explicitly does name
   individual resellers and their configured rates.
5. Two API-route/page-level fixes closed **existing Phase 7 gaps** this
   phase's rule would otherwise leave open: `/dashboard/admin/provider-scoreboard`
   (aggregates real cost across every tenant) and
   `/dashboard/billing/simulator` (reads `provider_rate_cards` directly)
   were both only gated on "any logged-in user" before this phase — now
   both require `session.orgRole === "platform"`.

### The test — `apps/web/tests/reseller/pricing-visibility.test.ts`

Attacks the rule from both directions, at the DB layer (an app_user
connection scoped to a real reseller/customer org, the same methodology as
every other tenant-isolation test in this codebase — see
`apps/web/tests/billing/tenant-isolation-billing.test.ts`):

- A reseller's connection querying `provider_rate_cards` directly: **zero
  rows** (RLS).
- A reseller's connection calling `platform_list_resellers()`: **raises**
  (function-internal role check).
- A reseller's connection calling `set_reseller_buy_rate()` for itself:
  **raises** (same check) — a reseller cannot even set its OWN buy rate,
  let alone another reseller's.
- A customer's connection querying `reseller_buy_rates`/`reseller_sell_rates`
  for its parent reseller's `org_id`: **zero rows** (RLS — the customer's
  `current_org_id()` is its own id, never the reseller's).
- A customer's connection reading `platform_provider_cost_stats()` (Phase
  7's function): still callable (unchanged — it has no per-org identity to
  leak, same rationale as before), but it can no longer be reached through
  any dashboard page except the platform-owner-gated one.
- Control case: the reseller CAN read its own `reseller_buy_rates`/
  `reseller_sell_rates` row, and the platform owner CAN call
  `platform_list_resellers()` / read `provider_rate_cards` — proving the
  rule blocks the right direction, not everything.

## 4. Domain routing (white-label)

**Mechanism built**: subdomain-based routing —
`{reseller-slug}.yourplatform.example` (base domain configurable via
`NEXT_PUBLIC_PLATFORM_BASE_DOMAIN`) — plus an `X-Tenant-Domain` header
override for local dev/testing without real DNS. `reseller_branding.subdomain`
is the lookup key; `resolve_reseller_branding_by_host()` (a `SECURITY
DEFINER` SQL function, since this runs pre-auth — no session/org context
exists yet, same rationale as `resolve_session`) resolves a host to that
reseller's `company_name`/`logo_url`/colors/support details, which
`apps/web/lib/reseller/branding.ts`'s `resolveTenantBranding()` injects into
the dashboard layout's chrome (`app/dashboard/layout.tsx`).

**Why this isn't literal Next.js Edge Middleware**: the resolution needs a
real Postgres connection (`pg`), and Next's Edge runtime forbids raw TCP
sockets — `pg` cannot run there. Rather than fake the mechanism with a
runtime that can't actually touch the database, `resolveTenantBranding()` is
called from the dashboard layout (a Node-runtime Server Component,
evaluated per-request, before anything is rendered) using the exact same
Host / `X-Tenant-Domain` header inspection logic true edge middleware or a
reverse proxy would use. A future move to real Next.js `nodejs`-runtime
middleware (or a reverse-proxy layer doing the same header rewrite) can call
`resolveTenantBranding()` verbatim — no logic changes, just where it's
invoked from.

### What's still needed for a REAL custom domain (`voice.clientdomain.com`) — deployment-time follow-up, not built here

This is real infrastructure work outside a dev sandbox, deliberately not
faked:

1. **DNS**: the reseller adds a `CNAME` (or `A`/`ALIAS`) record for
   `voice.clientdomain.com` pointing at the platform's edge (a load
   balancer / CDN / reverse proxy hostname).
2. **TLS/SSL**: an ACME certificate (e.g. Let's Encrypt) issued for that
   exact hostname — either the platform's reverse proxy does this
   automatically per-host (Caddy, Traefik, an ALB+ACM setup, or a CDN like
   Cloudflare/Vercel that supports customer-managed custom domains), or a
   manual cert-issuance step per onboarded reseller domain.
3. **Reverse-proxy / edge routing config**: whatever terminates TLS needs a
   host-based routing rule forwarding `voice.clientdomain.com` to the same
   Next.js app, with the original `Host` header preserved (or forwarded as
   `X-Forwarded-Host`) so `resolveTenantBranding()` still sees the real
   hostname to resolve against `reseller_branding.custom_domain`.
4. **Verification step before activation**: confirm the reseller actually
   controls the domain (DNS TXT-record challenge, the same pattern as
   Let's Encrypt's own DNS-01 challenge or platforms like Vercel's "Domains"
   API) before serving their branding on that hostname, so one tenant can't
   claim a domain it doesn't own.

`reseller_branding.custom_domain` is already a column, unique-indexed, and
`resolve_reseller_branding_by_host()` already matches on it — the moment
that infra exists, wiring it in is a zero-migration change.

## 5. Onboarding functions (SECURITY DEFINER, same pattern as `006_auth_functions.sql`)

- `promote_org_role(target_org_id, new_role, parent_reseller_id?)` —
  platform-owner-only. Turns any org into a reseller (or reassigns the one
  platform org, or moves a customer's `parent_reseller_id`).
- `create_customer_org(...)` — reseller-only (checked inside the function,
  `current_org_role() = 'reseller'`). Atomically creates a customer org +
  its owner user + a `billing_accounts` row already stamped
  `reseller_id = <caller's org id>`, `billing_mode = 'reseller_managed'` —
  mirrors `signup_organization()`'s all-in-one creation, so a reseller's
  customer is never billed "directly" even for a moment before someone
  remembers to wire the reseller relationship.

## 6. What's deferred to Phase 9+

- Per-provider markup matrices (see "Granularity" above) — not needed to
  prove the mechanism; the schema shape to extend to one is documented.
- A `CHECK`/trigger enforcing `parent_reseller_id`'s target `org_role` —
  currently only guaranteed by the two functions that ever set it.
- Real custom-domain DNS/SSL/reverse-proxy provisioning (section 4).
- A UI to actually walk a platform owner through `promote_org_role()` — for
  now this is a direct DB call (same bar as Phase 7's provider/plan seeding,
  which is also not yet a UI flow).
