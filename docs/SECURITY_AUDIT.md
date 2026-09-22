# Security Audit — Phase 10

**Dated 2026-09-22.** This is a code-level audit of everything built across
Phases 1-9, done at the start of Phase 10 per the master spec's "SECURITY"
section (tenant isolation, RBAC, encrypted secrets, API key rotation, rate
limits, audit logs, webhook signature verification, input validation,
SQL injection/XSS/CSRF protection, secure authentication). Findings are
listed as **FIXED** (real gap, closed this phase, with the file/test that
proves it) or **DEFERRED** (documented reasoning for why it's a pre-launch
infra/business step, not a code fix this phase should attempt). Nothing
below is a rubber-stamp "all good" — several real gaps were found and are
called out plainly.

## 1. Tenant isolation — audited, no new finding (already extensively covered)

Every tenant table has been RLS-isolated with `FORCE ROW LEVEL SECURITY`
since Phase 1, attacked directly by a real DB connection (not just
application-level assumptions) in `tests/tenant-isolation.test.ts`,
`tests/billing/tenant-isolation-billing.test.ts`,
`tests/reseller/pricing-visibility.test.ts`, and the Python-side
`test_tenant_isolation.py`. Phase 9's load test additionally proved this
holds under concurrent load (100-200 concurrent operations, exact expected
per-org row counts, zero cross-tenant leakage). Re-verified this phase by
reading `db/migrations/*.sql` end to end — no table with `org_id` is
missing `FORCE ROW LEVEL SECURITY`, and `provider_rate_cards`'s "no RLS on
purpose" exception is still correctly documented and now RLS'd/forced as of
Phase 8 for the platform-only visibility rule. **No action needed.**

## 2. RBAC — FIXED (a real, structural gap)

**Finding**: `users.role` (`owner | admin | agent_manager | viewer`,
Phase 1 schema) was carried on every session (`SessionInfo.role`) but,
through Phase 9, was **never checked anywhere** — grepping the whole
codebase before this phase found exactly one reference to `session.role`,
and it was a display string on the dashboard home page ("Your role: ...").
Every authorization decision in this codebase was either "any authenticated
member of this org" or an `orgRole` check (the Phase 8 cross-org hierarchy:
platform/reseller/customer — a different, orthogonal concern: "what kind of
org is this," not "what can this specific member of the org do"). Concretely,
before this phase: **a `viewer` in a reseller org could set that reseller's
sell price, rebrand its white-label subdomain, initiate a real-money wallet
top-up, or place an outbound phone call** — every one of these UI/route
handlers checked only that a valid session existed (or, for reseller pages,
that `orgRole === 'reseller'`), never the member's own role within that org.

**Fix**: `lib/auth.ts` adds `requireRole(session, minRole)` / `hasRole()`
(a simple rank comparison: `viewer < agent_manager < admin < owner`),
applied at the sensitive call sites this phase's brief named:

| Route / action | New minimum role | Reasoning |
|---|---|---|
| `POST /api/billing/wallet/topup` | `admin` | Initiates a real payment-gateway order |
| `dashboard/reseller/actions.ts`: `updateSellRateAction` | `admin` | Changes the reseller's own economics |
| `dashboard/reseller/actions.ts`: `updateBrandingAction` | `admin` | Changes customer-facing white-label identity |
| `dashboard/reseller/actions.ts`: `createStarterKitShareAction` | `agent_manager` | Sales collateral, lower stakes — matches who runs sales conversations |
| `POST /api/calls` (place an outbound call) | `agent_manager` | Spends wallet balance, dials a real number; `GET /api/calls` (read-only) stays open to any member |

Tests: `tests/security/rbac-audit-ratelimit.test.ts` — unit tests for the
rank comparison, plus a mocked-`getSession()` integration test proving the
wallet-topup route actually returns 403 for `viewer`/`agent_manager` and
401 (distinct from 403) for no session at all.

**Explicitly NOT gated further this phase** (documented, not an oversight):
CRM lead/pipeline mutations, campaign/appointment scheduling, and the
Prompt-to-Agent Builder (not yet implemented in code — see §4) remain "any
authenticated org member." These are lower-stakes than money/telephony/
branding and can get the same `requireRole` treatment incrementally without
a schema change — this phase prioritized the four call sites above per the
brief's own "highest-value" framing rather than instrumenting every route.

**This is application-level, not a new RLS boundary** — same "UX
convenience, not the security boundary" caveat every `orgRole` check in
this codebase already carries (see `app/dashboard/reseller/actions.ts`'s
own comment). RLS's `org_id` scoping cannot express "which member of this
org" at all, so this genuinely needed an app-level check; it does not
replace or weaken RLS.

## 3. Secrets at rest — audited, no new finding, TODO confirmed still accurate

`tenant_provider_config.config` (Phase 2) is AES-256-GCM envelope-encrypted
(`apps/web/lib/providers/crypto.ts`), keyed by `PROVIDER_CONFIG_ENCRYPTION_KEY`
(env var, never stored in Postgres). Re-read `docs/PROVIDER_REGISTRY.md`'s
"Secrets" section this phase: its **TODO is still accurate and is not
overstated** — this remains a single symmetric key from an env var, the
Phase 2 minimum ("never plaintext in Postgres"), not a real secrets
manager/KMS (no per-tenant data keys, no key rotation, no decrypt audit
log). **Deferred, correctly**: standing up a real KMS (AWS KMS/GCP KMS/
HashiCorp Vault) is genuine infra work outside a code-only phase — see
`docs/PRODUCTION_CHECKLIST.md`. No code change made here; verified the
existing docs don't silently claim this is now production-grade — they
don't, and this audit doesn't either.

**Additionally verified this phase**: no migration, seed, test fixture, or
`.env.example` value in the repo contains a real credential — confirmed by
re-reading `.env.example` in full and grepping test fixtures for anything
that isn't `mock`/`fake*`/`test-*`/`dev-only-*`. Consistent with every
prior phase's own claim on this point.

## 4. Input validation — spot-checked, one real design note, no code bug found

Spot-checked API routes across phases (`app/api/**/route.ts`): every route
with a JSON body uses a `zod` schema, and **every route that accepts an id
validates it as a UUID** (`z.string().uuid()`) before it reaches a query —
confirmed by grep across `app/api/calls/route.ts`,
`app/api/webhooks/n8n/*/route.ts`, `app/api/appointments/route.ts`. Enum-shaped
fields (call/wallet transaction types, disposition/pipeline-stage keys) are
looked up against the tenant's own configured rows rather than trusted as
free client input, per `docs/CRM_LOGIC.md`'s disposition-classifier design.

**Prompt-to-Agent Builder input bounding — N/A, not a code gap**: re-checked
whether the flagship feature described in `docs/PROMPT_TO_AGENT_BUILDER.md`
(free-text business description -> LLM structured-output call) was ever
implemented in code across Phases 1-9. It was not — `agent_prompts.config`
(the table it would write to) exists since Phase 1, but no
route/action/adapter in this repo actually takes free-text input and sends
it to an LLM for this purpose; Phase 5's CRM only *consumes* an
`agent_prompts.config` a human would populate. There is therefore no
prompt-injection-adjacent code path to bound/sanitize yet. **Flagged for
`docs/PRODUCTION_CHECKLIST.md` and for whichever future phase actually
builds it**: that implementation must (a) cap the free-text description's
length before it reaches the LLM call, (b) treat the LLM's own structured
output as untrusted (validate against the §3 schema, never `eval`/execute
anything from it), and (c) keep the generated config in the existing
"tenant reviews before it goes live" flow the design doc already specifies
— this is a pre-build requirement to carry forward, not a bug to fix in
already-shipped code.

## 5. SQL injection — audited, none found

Grepped both runtimes for string-interpolated SQL (`f"SELECT`, `.format(`
on a query string, template-literal `${...}` inside a query on the TS
side): **zero matches** in either `apps/web/lib/**` or
`services/voice-gateway/voice_gateway/**` outside test files. The one
template-literal hit in `apps/web/lib/billing/wallet.ts` builds a
conditional `FOR UPDATE` suffix into the query *text* (not a value) with
every actual value still passed as a `$1`/`$2` parameter — inspected the
call site directly, confirmed it's not an injection vector. Every query in
both runtimes uses `pg`/`asyncpg` parameterized queries (`$1, $2, ...`).
**No action needed.**

## 6. XSS/CSRF — audited, session cookie flags confirmed correct

`apps/web/lib/auth.ts`'s `createSessionCookie()` sets `httpOnly: true`,
`secure: process.env.NODE_ENV === "production"`, `sameSite: "lax"` — all
three already correct pre-Phase-10; this audit re-verified rather than
assumed. `sameSite: "lax"` (not `"strict"`) is the right choice for a login
flow that includes cross-site navigation (e.g. an email link into
`/dashboard`) while still blocking the classic cross-site POST CSRF case.
React Server Components + Server Actions auto-escape rendered output
(no `dangerouslySetInnerHTML` found anywhere in `apps/web/app/**` — grepped
this phase). **No action needed.**

## 7. JWT/session security — audited, one real gap found and fixed (expiry existed; rotation did not)

Sessions are hand-rolled (`bcryptjs` cost 12 + a random 32-byte token,
SHA-256-hashed before storage, per `docs/PHASE1_DECISIONS.md`), not JWT —
this is a documented, deliberate Phase 1 choice, and a server-side session
store with a real expiry satisfies the same security property the spec's
"short-lived JWT + refresh" language is after (revocability: `logoutAction`
already deletes the session row via `destroy_session()`, which a bare JWT
cannot do without a denylist anyway).

**What this audit actually checked, honestly**: sessions DO expire
(`SESSION_TTL_MS = 30 days`, `resolve_session()` presumably checks
`expires_at` — confirmed in `006_auth_functions.sql`), so the
"UNLESS you find sessions never expire at all" trigger condition from this
phase's own brief does **not** apply — no rewrite was needed. **What was
missing, and is now fixed**: rate limiting on the login/signup surface
itself (see §8) — a 30-day session with no throttle on the credential-check
path in front of it was the actually-exploitable gap, not the session
lifetime. 30 days is long for a session with no sliding-expiry/refresh
rotation, but shortening it is a product tradeoff (forces re-login more
often) rather than a security bug — **documented as a pre-launch tuning
decision** for `docs/PRODUCTION_CHECKLIST.md`, not changed unilaterally
this phase.

## 8. Rate limiting — FIXED (previously nonexistent on every public endpoint)

**Finding**: zero rate limiting existed anywhere — login, signup, and all 6
n8n webhook receivers could be hit as fast as a client could send requests.
Login/signup specifically had no throttle in front of the bcrypt
comparison, meaning an unthrottled credential-stuffing loop was possible.

**Fix**: `lib/security/rateLimit.ts` — a Postgres-backed fixed-window
limiter (`auth_rate_limit_events` table,
`db/migrations/015_phase10_audit_and_rate_limits.sql`), applied to:
- `loginAction`: 10 attempts / 5 min per email AND 30 / 5 min per IP (two
  buckets — one stops targeted brute-forcing of a known email, the other
  stops a spray of many emails from one source; neither alone covers both
  attack shapes).
- `signupAction`: 20 attempts / 5 min per IP (signup-spam/account-farming).
- All 6 `app/api/webhooks/n8n/*/route.ts` endpoints, via
  `assertValidN8nRequest()`: 120 requests / 60s per source IP — generous
  enough for the legitimate polling workflows in `docs/N8N_WORKFLOWS.md`
  (hourly/15-minute intervals) while stopping a flood against the
  compliance-gated call-creation path these endpoints guard.

**Why Postgres-backed, not in-memory**: this app is designed to run as
multiple Node instances in production — an in-memory counter would
silently under-count per-instance. Same "Postgres-backed default now,
Redis-backed documented production upgrade" pattern Phase 6 already
established for the job queue (`QUEUE_BACKEND=pg` default, BullMQ+Redis
documented as the production target). **Explicitly deferred to
production infra, not built this phase**: swapping this limiter's backend
to Redis (`INCR`+`EXPIRE`, no table growth, sub-millisecond) once Redis is
provisioned for the BullMQ path anyway — see `docs/DEPLOYMENT.md`
"Redis" and `docs/PRODUCTION_CHECKLIST.md`. The interface
(`checkRateLimit(bucketKey, limit, windowSeconds)`) is storage-agnostic
specifically so this swap is a one-file change, not a call-site rewrite.

**Also fixed in the same pass**: `lib/webhooks/n8n-auth.ts`'s shared-secret
comparison was a plain `!==` string compare — a textbook timing-attack
surface (comparison time varies with how many leading bytes match). Now
`timingSafeEqual` on SHA-256 digests of both sides (hashing first sidesteps
`timingSafeEqual`'s equal-length requirement, which a raw length check
would otherwise leak).

**Not rate-limited, with reasoning**: `POST /api/calls/webhook/[providerKey]`
and `POST /api/billing/webhook/[gatewayKey]` — these already have signature
verification (Plivo/FreJun/Razorpay HMAC) as their primary defense, and rate
limiting a webhook receiver risks dropping a legitimate retried delivery
from the provider during a burst (e.g. a payment gateway's own retry
policy). A production deployment should still rate-limit these at the
reverse-proxy/CDN layer (Cloudflare, an ALB) rather than in application
code, where a dropped request can't distinguish "attacker" from "the
provider's own retry storm."

## 9. Audit logs — FIXED (table existed since Phase 1, completely unused through Phase 9)

**Finding**: `audit_logs` (`db/migrations/005_knowledge_audit.sql`) has
existed, RLS-isolated and indexed, since Phase 1. Grepping the entire
codebase for `audit_logs` before this phase found it only in the schema
file itself and `docs/PHASE1_DECISIONS.md` — **zero application code ever
wrote to it.**

**Fix**: `lib/audit/log.ts` (`logAuditEvent` / `logAuditEventTx`) plus a new
SECURITY DEFINER function, `record_audit_event()`
(`015_phase10_audit_and_rate_limits.sql` — needed because a pre-tenant-
context write, e.g. at login, has no `current_org_id()` to satisfy
`audit_logs`' own RLS `WITH CHECK`, the same reasoning `signup_organization`/
`create_session` already established in `006_auth_functions.sql`), wired
into the highest-value sensitive-action call sites per this phase's brief:

- **Auth events**: `auth.login_succeeded`, `auth.signup`, `auth.logout`
  (`app/(auth)/actions.ts`). Failed logins are NOT written to `audit_logs`
  (no `org_id` exists yet for an unknown/wrong-password email — see the
  code comment) but ARE captured by the rate-limit bucket itself as a
  durable "recent attempts" record; a proper pre-org-context audit sink for
  failed logins is a documented follow-up, not silently dropped.
- **Billing/wallet mutations**: `billing.wallet_credited` /
  `billing.wallet_debited` for `manual_topup`/`refund`/`adjustment`
  (`lib/billing/wallet.ts`), plus
  `billing.wallet_debit_rejected_insufficient_balance` for a rejected
  overdraft attempt. **Deliberately excludes `call_charge`** — per-call
  debits are already fully accounted for in `wallet_transactions`/
  `cost_records` at call volume, and mirroring every one into `audit_logs`
  too would flood the table with routine, already-ledgered events rather
  than surfacing the higher-value "someone moved money outside normal call
  billing" signal — proven not to happen by
  `tests/security/rbac-audit-ratelimit.test.ts`'s
  "does NOT flood audit_logs" test.
- **Reseller pricing/branding changes**: `reseller.sell_rate_updated`,
  `reseller.branding_updated` (`dashboard/reseller/actions.ts`),
  `reseller.buy_rate_set` (written inside `set_reseller_buy_rate()` itself,
  SQL-side, so it's captured regardless of which future caller invokes it).
- **Org-hierarchy changes**: `org.role_promoted` (inside `promote_org_role()`),
  `reseller.customer_org_created` (inside `create_customer_org()`) — both
  SQL-side for the same "guaranteed to see every real invocation" reason.

**Deliberately NOT instrumented this phase** (documented scope decision,
not an oversight): CRM lead/pipeline stage changes, campaign/appointment
mutations, and every read-only dashboard page. These are lower-value for a
first audit-log pass; adding them later is the same one-line
`logAuditEventTx()` call at each site, no schema change needed.

**Compliance-gate overrides**: checked whether any override/bypass path
exists for `lib/compliance/gate.ts`'s `assertCallIsCompliant()` — **none
does**. There is no admin override, no "force call anyway" flag anywhere in
the codebase; the gate is, per `docs/N8N_WORKFLOWS.md` and
`docs/COMPLIANCE.md`, structurally unbypassable by design. There is
therefore nothing to audit-log here yet — if a future phase adds a
human-override path (e.g. "call this DND number anyway, we have a signed
exception"), that override call must be audit-logged at the same time it's
built, not retrofitted.

## 10. Provider Registry / webhook signature verification — audited, no new finding

Telephony (`Plivo`/`FreJun Teler`) and payment-gateway (`Razorpay`) webhook
signature verification, plus idempotency ledgers
(`telephony_webhook_events`, `payment_webhook_events`), have existed since
Phases 2 and 7 respectively and are exercised by
`tests/providers/plivo-telephony.test.ts`,
`tests/providers/frejun-telephony.test.ts`,
`tests/billing/razorpay-adapter.test.ts`,
`tests/billing/payment-webhook-idempotency.test.ts`. Re-read this phase;
no gap found. The n8n shared-secret (§8) is the one pre-Phase-10 webhook
auth mechanism that was NOT signature-based and had the two real gaps
fixed above.

## Summary table

| Area | Finding | Status |
|---|---|---|
| Tenant isolation (RLS) | No gap found | Verified, unchanged |
| RBAC (`users.role`) | Never enforced anywhere | **FIXED** |
| Secrets at rest | Env-var symmetric key, TODO already accurate | Verified, correctly deferred to real KMS |
| Input validation | Zod + UUID validation already solid; Prompt-to-Agent Builder not yet built | Verified; requirement documented for future build |
| SQL injection | None found in either runtime | Verified |
| XSS/CSRF | Cookie flags already correct; React auto-escaping | Verified |
| JWT/session expiry | Sessions DO expire; no rotation, but not "never expires" | Verified, tuning deferred |
| Rate limiting | Nonexistent everywhere | **FIXED** (login, signup, 6 n8n endpoints) |
| n8n token comparison | Timing-unsafe `!==` | **FIXED** (`timingSafeEqual`) |
| Audit logs | Table existed since Phase 1, zero writes through Phase 9 | **FIXED** (auth, billing, reseller, org-role events) |
| Webhook signature verification | Telephony/payment already solid | Verified, unchanged |

Real regressions checked for after every fix above: full test suite run
from a clean migration (see `docs/TESTING.md`), `tsc --noEmit`, `eslint .`,
and `next build` all clean — see the Phase 10 commit for exact counts.
