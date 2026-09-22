# n8n Workflows (Phase 6)

**Honest status: these workflow JSONs were structurally validated in this
task, not run end-to-end against a live n8n instance.** No n8n container
was stood up in this dev environment. What was actually done:

1. Every workflow below was hand-written as a valid n8n export (name,
   `nodes[]` with real n8n node types, `connections`, `settings`,
   `versionId`) and machine-checked by
   `apps/web/tests/n8n/workflows.test.ts`: valid shape, no dangling
   connections (every connection target is a real node in the same file),
   and — critically — every `httpRequest` node's URL resolves to a real
   route this app implements (checked against an exhaustive allow-list, so
   a workflow pointing at a fabricated/dead endpoint fails the test).
2. The receiving endpoints on the apps/web side
   (`app/api/webhooks/n8n/*/route.ts`) were built and have their own
   passing test suite (`apps/web/tests/webhooks/n8n.test.ts`) exercising
   them exactly as an n8n HTTP Request node would call them (same JSON
   body/headers), including the shared-secret auth rejecting an invalid
   token and the compliance gate blocking a call for a consent-less lead.
3. **What was NOT done**: importing these JSON files into a running n8n
   instance and clicking "Execute Workflow" against a live deployment.
   That requires a real n8n container (Docker) and a reachable
   `APP_BASE_URL` — infra steps outside this task's dev sandbox. Do the
   manual smoke test below before trusting these in production.

## Non-negotiable rule these workflows all follow

n8n is **control-plane only** and **never carries live call audio**. Every
workflow here only ever calls small JSON endpoints (create a lead, trigger
a call *record* through this app's own compliance-gated path, trigger a
WhatsApp send through this app's own Provider Registry, or read a small
report). No workflow proxies telephony media, and no workflow holds
WhatsApp/telephony credentials directly — those stay in
`tenant_provider_config` (encrypted), never in an n8n credential.

## Required n8n environment variables

Every workflow references these (set once per n8n instance/tenant):

| Variable | Purpose |
|---|---|
| `APP_BASE_URL` | This app's base URL, e.g. `https://app.example.com` |
| `N8N_WEBHOOK_SHARED_SECRET` | Must match this app's `N8N_WEBHOOK_SHARED_SECRET` env var — see `apps/web/lib/webhooks/n8n-auth.ts` |
| `TENANT_ORG_ID` | The org these workflows act on behalf of (Phase 6 minimum: one shared secret + explicit org id per n8n instance; see "Deferred" below) |
| `DEFAULT_CALLER_ID` | Outbound caller-id number for call-triggering workflows |
| `SUMMARY_FROM_EMAIL` / `OWNER_EMAIL` | Only for `daily-summary-to-owner.json`'s Email node |

## The 6 workflows

| File | Spec item | What it does |
|---|---|---|
| `website-form-to-ai-call.json` | Website form -> create lead -> AI call | n8n's own inbound webhook receives a form POST, forwards to `/api/webhooks/n8n/lead-intake`, which creates the lead + a 7-day web-form consent record and places the first call through `createOutboundCall()` (compliance-gated). |
| `crm-lead-to-ai-call.json` | CRM lead -> AI call | Reacts to a CRM pipeline-stage-change event; when a lead reaches `ready_to_call`, calls `/api/webhooks/n8n/crm-lead-call` to dial an **existing** lead — same compliance gate applies (an opted-out/DND lead is still blocked here). |
| `ai-qualified-lead-to-whatsapp.json` | AI-qualified lead -> WhatsApp | Fired when a lead is marked qualified; calls `/api/webhooks/n8n/qualified-lead-whatsapp`, which sends a templated WhatsApp message via this app's own WhatsApp Provider Registry (Mock/Interakt/Gupshup) — n8n never talks to WhatsApp directly. |
| `appointment-reminder-failsafe.json` | Site-visit/appointment -> reminder | **Failsafe only** — the app already self-schedules and sends appointment reminders via its own job queue the instant an appointment is created (`lib/appointments/reminders.ts`). This workflow polls `/api/webhooks/n8n/due-appointments` every 15 minutes so ops can be alerted if that internal queue ever misses one. No notification node is wired by default (no ops Slack/email credentials exist in this dev environment) — add one before relying on this. |
| `no-answer-follow-up.json` | No-answer lead -> follow-up automation | Hourly: fetches leads whose latest disposition is `no_answer` via `/api/webhooks/n8n/no-answer-leads` and sends each a WhatsApp nudge — runs *alongside*, never instead of, the built-in smart-retry call schedule (`lib/campaigns/dialer.ts`). |
| `daily-summary-to-owner.json` | Daily summary to owner | Daily at 20:00 IST, fetches counts from `/api/webhooks/n8n/daily-summary` and emails the founder via n8n's own Email node. |

## Manual smoke-test checklist (do this before trusting these in production)

1. `docker run -d --name n8n -p 5678:5678 n8nio/n8n` (or your existing
   self-hosted instance — Docker, per the spec).
2. In n8n, **Settings -> Environment Variables**, set the 5 vars above
   (matching this app's real `N8N_WEBHOOK_SHARED_SECRET` and a real
   `APP_BASE_URL` reachable from the n8n container).
3. **Workflows -> Import from File** each `n8n/workflows/*.json`.
4. For `website-form-to-ai-call.json`: copy its Webhook node's Test URL,
   `curl -X POST <url> -d '{"name":"Test","phone":"+91XXXXXXXXXX"}'`, confirm
   a `leads` row and a `calls` row appear (mock telephony provider is
   enough — no real phone needs to ring).
5. For `crm-lead-to-ai-call.json`: POST a fake CRM event payload with
   `pipelineStage: "ready_to_call"`, confirm the IF branch routes correctly
   and a call attempt is made (or blocked, if that lead has no consent —
   confirm the block is visible in the HTTP Request node's response, not a
   silent failure).
6. For `ai-qualified-lead-to-whatsapp.json` / `no-answer-follow-up.json`:
   confirm a `whatsapp_messages` row is created with `provider_key='mock'`
   in dev, and re-point `tenant_provider_config` at `interakt` with real
   sandbox credentials before trusting a real send.
7. For `appointment-reminder-failsafe.json` / `daily-summary-to-owner.json`:
   manually execute the workflow (n8n's "Execute Workflow" button) rather
   than waiting for the schedule, and confirm the HTTP Request node's
   response shape matches what's documented above.
8. Confirm **every** workflow fails cleanly (401, not a crash) when
   `x-n8n-webhook-token` is wrong — this is the same check
   `apps/web/tests/webhooks/n8n.test.ts` automates against the endpoint
   side; this step just confirms n8n itself is sending the header at all.

## Deferred / follow-up (Phase 7+)

- **Per-tenant webhook tokens.** Phase 6 ships one shared secret plus an
  explicit `orgId` field/env var per n8n instance. A leaked shared secret
  currently lets a caller address any org's endpoints if they also guess/
  know that org's id. A per-tenant token (looked up server-side, never
  supplied by the caller) is the correct design for multi-tenant
  production use and is not yet built.
- **A real n8n container actually wired up and exercised** against a
  staging deployment of this app, replacing this document's manual
  checklist with an actual executed run log.
- Ops notification node (Slack/email) for the appointment-reminder
  failsafe workflow — no credentials exist in this dev environment to wire
  one concretely.
