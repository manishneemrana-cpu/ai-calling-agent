# sitesnsign.com <-> ai-calling-agent integration

The founder's own real-estate site, `sitesnsign.com`, is a separate NestJS +
PostgreSQL/PostGIS codebase this task has NO access to. This document
specifies BOTH integration directions precisely enough that a developer
with access to that codebase (or a future session with that access) can
implement the sitesnsign.com side without further back-and-forth.

**What this task actually implemented** (in `apps/web`, this repo):
- The RECEIVING endpoint for direction 1 (`POST
  /api/webhooks/sitesnsign/lead-intake`) — real, tested code.
- The SENDING side of direction 2 (a generic outbound-webhook module) —
  real, tested code.

**What this task did NOT implement** (out of scope — different repo, no
access): the sitesnsign.com NestJS code that calls direction 1, and the
sitesnsign.com receiving endpoint for direction 2. Those are specified
below as a contract for whoever implements that side.

---

## Direction 1 — Inbound: sitesnsign.com's CRM lead -> a call here

**Trigger** (sitesnsign.com side, NOT implemented here): whenever a new row
is created in sitesnsign.com's own `leads` table (per the founder's Google
Sheet structure: Date, Buyer Name, Phone, Source, Stage, Broker, Listing
ID, Requirement), its `leads.service.ts`-equivalent should fire a webhook.

**Endpoint** (implemented here):
`POST https://ai.sitesnsign.com/api/webhooks/sitesnsign/lead-intake`

### Request headers

| Header | Required | Meaning |
|---|---|---|
| `x-sitesnsign-token` | yes | Opaque per-tenant identifier (see "Provisioning" below). Identifies WHICH org's row to use, nothing more — not itself a secret proof of authenticity. |
| `x-sitesnsign-signature` | yes | `sha256=<hex>` — HMAC-SHA256 of the raw request body, keyed by that same org's signing secret. |
| `content-type` | yes | `application/json` |

### Request body (JSON)

```json
{
  "externalLeadId": "string, required — sitesnsign.com's own leads.id, used for idempotency",
  "date": "string, optional, ISO date — informational only",
  "buyerName": "string, optional",
  "phone": "string, required — E.164 or any format the founder's telephony provider accepts",
  "source": "string, optional — e.g. 'sitesnsign_website', 'referral'",
  "stage": "string, optional — sitesnsign.com's own pipeline stage label, stored as-is (informational; this app has its own separate pipeline_stage/disposition fields it manages independently)",
  "broker": "string, optional",
  "listingId": "string, optional — sitesnsign.com's own listing id",
  "requirement": "string, optional — free text",
  "agentId": "string (uuid), optional — which of this org's AI agents should handle the call; omit to use the org's default",
  "fromNumber": "string, optional — caller-id number to place the call from; omit to use the org's default",
  "triggerCall": "boolean, optional, default true — false creates the lead without placing a call"
}
```

### Field mapping into this app's `leads` table (Phase 5 schema, `db/migrations/003_agents_leads_calls.sql`)

| sitesnsign.com field | `leads` column |
|---|---|
| `buyerName` | `full_name` |
| `phone` | `phone_number` |
| `agentId` | `agent_id` |
| `externalLeadId`, `source`, `stage`, `broker`, `listingId`, `requirement` | packed into `custom_fields` jsonb as `{sitesnsign_external_lead_id, source, stage, broker, listing_id, requirement}` — this app never adds real-estate-specific columns to `leads` itself (multi-industry design, per `docs/ARCHITECTURE.md`) |

A `lead_compliance` row is created alongside it: `consent_source =
'sitesnsign_crm'`, `consent_status = 'granted'`, 7-day expiry (same
explicit-consent window as every other intake path — `docs/COMPLIANCE.md`)
— UNLESS this phone number already has a recorded opt-out under this org
(any prior lead), in which case `consent_status = 'revoked'` /
`opted_out = true` is carried forward instead, so a do-not-call request is
never silently overridden just because a new CRM lead came in for the same
number.

### The actual "auto-call" behavior

If `triggerCall` is true (default) and this is a new lead (see
Idempotency), the endpoint calls `createOutboundCall()`
(`lib/calls/createCall.ts`) — the SAME function every other call-creation
path in this codebase uses. This means:

- The compliance gate (`lib/compliance/gate.ts`) runs first — consent,
  DND, opt-out. A blocked call does NOT roll back the already-created lead;
  the response reports `callBlocked` instead (see Response shape).
- The wallet-balance gate (`lib/billing/callGuard.ts`) runs next, same
  rule.
- Only then is the telephony provider actually invoked.

There is no bypass for this integration — it is not special-cased.

### Response

- `201 Created`, `{ "lead": { "id": "<uuid>" }, "call": { ... } }` — lead
  created, call placed.
- `201 Created`, `{ "lead": { "id": "<uuid>" }, "callBlocked": "<reason>" }`
  — lead created, call blocked by compliance/wallet/provider-config; retry
  the call later some other way (e.g. a manual dashboard action) rather
  than retrying this webhook (retrying would just re-hit the idempotency
  short-circuit below).
- `200 OK`, `{ "lead": { "id": "<uuid>" }, "alreadyExisted": true }` — a
  retried delivery of an `externalLeadId` already seen; no duplicate
  lead/call.
- `400 Bad Request` — malformed body (missing `phone`/`externalLeadId`,
  etc).
- `401 Unauthorized` — missing/unknown token, or a bad/missing signature.
  sitesnsign.com's implementation should log this loudly (it means the
  configured token/secret drifted) and NOT silently drop the lead.

### Retry / idempotency

sitesnsign.com's sender should retry on `5xx` or a network error (a plain
exponential backoff, a few attempts, is enough — this endpoint's own DB
work is fast). It should NOT retry on `400`/`401` (a malformed/misauthed
request will keep failing the same way). Idempotency is keyed on
`externalLeadId` within an org: a retried delivery with the same
`externalLeadId` returns `200` with `alreadyExisted: true` and creates
nothing new — safe to retry freely on transient failures.

### Provisioning (per org, done once, by whoever operates this app)

A row in `sitesnsign_webhook_tokens` (`db/migrations/017_sitesnsign_integration.sql`):
a random token (its SHA-256 hash stored, raw value handed to sitesnsign.com's
developer once) and a random HMAC signing secret (application-encrypted at
rest, same envelope-encryption module as
`tenant_provider_config.config` — `lib/providers/crypto.ts`). Generate both
with e.g. `openssl rand -hex 32`. There is currently no dashboard UI for
this (unlike n8n's per-tenant token, which has one — see
`/dashboard/settings/n8n`); it's a one-time admin DB insert for the
founder's own org, since only one org needs this integration today. A
dashboard UI for it is natural future work, out of this task's scope.

### Why a signature on TOP of a per-tenant token, when n8n's webhooks only
use a token?

n8n instances are each provisioned/operated BY this platform (Phase 6);
sitesnsign.com's NestJS backend is a wholly separate codebase/team crossing
a real trust boundary — a signed body means a leaked token alone (e.g. from
a log line) can't be replayed with an arbitrary payload, only with a
payload that codebase itself actually signed with the secret. See
`apps/web/lib/webhooks/sitesnsignAuth.ts`'s doc comment for the full
reasoning.

---

## Direction 2 — Outbound: a call's outcome -> sitesnsign.com

**Trigger** (implemented here): a call reaches a terminal status
(`completed`, `failed`, `no_answer`) — wired into
`app/api/calls/webhook/[providerKey]/route.ts`, the same place the
telephony-provider-webhook -> voice-gateway "call answered" trigger already
lives.

**What's implemented**: a GENERIC, multi-tenant outbound-webhook module
(`lib/webhooks/outboundWebhookSender.ts`) — not sitesnsign-specific in any
way. Any org can have a `webhook_subscriptions` row for `event_type =
'call.completed'` pointing at ANY target URL; this module doesn't know or
care that one particular org's target happens to be a sitesnsign.com
endpoint. Delivery is queued (`webhook_deliveries` table) and retried with
exponential backoff (0s, 30s, 2m, 10m, 1h, 6h — 6 attempts total, then
`exhausted`) by `processDueOutboundWebhooks()`, meant to be invoked on an
interval by a worker process (see `deploy/RUNBOOK.md`'s note on running a
worker loop — not yet wired into `docker-compose.prod.yml` as its own
service; the simplest first cut is a cron-triggered
`docker compose exec web node -e "require('...').processDueOutboundWebhooks()"`
or a small dedicated script, left as a follow-up alongside the founder's
own `webhook_subscriptions` row provisioning).

### What sitesnsign.com's receiving endpoint should look like (SPEC — not
implemented on their side)

**Path** (their choice, but this is the recommended shape):
`POST https://sitesnsign.com/api/ai-calling-agent/call-summary`

**Auth**: verify `x-ai-calling-agent-signature: sha256=<hex>` — HMAC-SHA256
of the raw request body, keyed by the SAME secret configured in this app's
`webhook_subscriptions.secret_enc` for their org (generate it the same way
as direction 1's signing secret; the two directions use independent
secrets even though the scheme is identical). Timing-safe compare, same
discipline as this app's own inbound verification.

**Request body this app sends:**

```json
{
  "eventType": "call.completed",
  "data": {
    "callId": "<uuid>",
    "providerKey": "plivo|frejun_teler|mock",
    "status": "completed|failed|no_answer",
    "recordingUrl": "string | null"
  }
}
```

(`lead.disposition_changed` is reserved as a second `event_type` for a
future extension — e.g. when this app's CRM pipeline marks a lead
`qualified`/`not_interested` — not yet wired to fire anywhere; the
`webhook_subscriptions.event_type` column already supports it without a
schema change when that trigger point is added.)

**Expected response**: `2xx` (any) — this app doesn't need or use a
response body. A non-`2xx` or a timeout is treated as a delivery failure
and retried per the backoff schedule above.

**Idempotency**: sitesnsign.com's implementation should treat
`callId`+`eventType` as the natural dedupe key (a retried delivery after a
timeout that actually DID succeed the first time is possible under an
at-least-once retry policy — standard webhook-consumer hygiene, no
special support needed from this app for it).

---

## Summary of what's genuinely out of scope here

- sitesnsign.com's own `leads.service.ts`-equivalent trigger code (calling
  direction 1). Different repo, no access.
- sitesnsign.com's own receiving endpoint for direction 2. Different repo,
  no access — direction 2's SENDING side above is real, tested code ready
  the moment their receiving endpoint exists.
- A dashboard UI in THIS app for provisioning `sitesnsign_webhook_tokens` /
  `webhook_subscriptions` rows (currently a one-time manual DB insert,
  same status as n8n's tokens were before Phase 6 shipped a settings page
  for them).
