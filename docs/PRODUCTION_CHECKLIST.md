# Production Launch Checklist — Phase 10 (final phase)

Everything that must happen before real customers, real money, and real
calls flow through this platform. Cross-referenced against every
"deferred to Phase X+" / "needs live credentials" item mentioned from
`docs/PHASE1_DECISIONS.md` through `docs/LOAD_TESTING.md` and this phase's
`docs/SECURITY_AUDIT.md`. Organized by urgency: nothing here is buildable
in a code-only phase — everything below is a business/infra/legal step a
human (the founder, or someone he hires/contracts) must do.

## Category A — must-have before this platform can place ONE real phone call

- [ ] **Real telephony account + credentials** — an actual FreJun Teler or
  Plivo account (see `docs/STACK_PROPOSAL.md`'s ranked list; FreJun Teler
  recommended default pending a paid pilot, Plivo as the better-documented
  fallback), inserted into a real `tenant_provider_config` row (encrypted,
  never a `.env` value — see `docs/PROVIDER_REGISTRY.md`).
- [ ] **Real STT/TTS/LLM credentials** — Sarvam (STT+TTS) and Gemini (LLM)
  accounts at minimum for the Economy-tier default stack
  (`docs/COST_MODEL_V1.md`); Deepgram/Cartesia/ElevenLabs if launching a
  Premium tier too.
- [ ] **DLT (Distributed Ledger Technology) registration** — per
  `docs/COMPLIANCE.md`, mandatory before ANY outbound commercial call in
  India, for the platform entity and/or each tenant depending on the
  registration model chosen (an open legal question, not yet resolved —
  see `docs/COMPLIANCE.md`'s item 2). **The founder said he's starting
  this from zero — this is not instant and should be started well before
  a launch date is set.**
- [ ] **Numbering-series compliance** — 140-series for promotional calls,
  1600-series for BFSI service calls, deadline 1 January 2026 per
  `docs/COMPLIANCE.md` §4 — confirm which series this platform's calls
  fall under with the chosen telephony provider before going live.
- [ ] **Legal/compliance review of `docs/COMPLIANCE.md`** — every version of
  that document, since Phase 0, explicitly says it is NOT legal advice and
  requires review by a licensed Indian telecom/data-privacy lawyer before
  any real call. This has not happened. Required before Category A is
  actually satisfiable, not just before Category B.
- [ ] **A production ASGI/WebSocket server process for `services/voice-gateway`**
  — per `docs/AUDIO_BRIDGE.md` item 7, `server.py`'s functions are
  framework-agnostic and tested, but never wired into an actual running
  server process. This is deployment work (see `docs/DEPLOYMENT.md`), not
  yet done anywhere.
- [ ] **A real-provider smoke test — one real end-to-end phone call** —
  place one actual outbound call through the real telephony/STT/TTS/LLM
  stack (not the mock adapters this repo's tests use) before any customer
  traffic. Confirms audio codec compatibility end-to-end
  (`docs/AUDIO_BRIDGE.md`'s unverified item 1) and that the whole pipeline
  actually works outside a test harness.
- [ ] **Real network/jitter hardening** — `docs/AUDIO_BRIDGE.md` items 2, 5,
  6: no jitter buffer, single-turn-per-connection (not continuous
  multi-turn), and sequential (not truly concurrent) barge-in handling are
  all real gaps found in testing with a synchronous fake transport. A live
  call's real timing will expose these — budget engineering time to fix
  before or immediately after the first real pilot calls, not after a full
  customer launch.
- [ ] **DND/consent data correctness in production** — the compliance gate
  (`lib/compliance/gate.ts`) is structurally unbypassable and tested, but
  it only enforces what `lead_compliance` rows say; it cannot itself verify
  a lead's consent was captured correctly by whatever real-world flow
  populates that table (a website form, a CRM import, etc.) — that upstream
  flow needs its own review before real numbers are dialed.

## Category B — must-have before real money changes hands

- [ ] **Real Razorpay account + credentials** — the Mock/Razorpay adapter
  pattern is fully implemented and tested against a mocked HTTP client
  (`docs/STACK_PROPOSAL.md`), but a live Razorpay merchant account with
  real API keys has never been used. Required before any real wallet
  top-up.
- [ ] **Provision a real secrets manager/KMS** — `PROVIDER_CONFIG_ENCRYPTION_KEY`
  is currently a single symmetric key from an env var (Phase 2 minimum,
  documented and re-confirmed accurate in `docs/SECURITY_AUDIT.md` §3).
  Before real tenant telephony/payment credentials are stored, move to a
  real KMS (AWS KMS, GCP KMS, HashiCorp Vault) with per-tenant data keys,
  rotation, and a decrypt audit log. This is genuine infra work, correctly
  scoped out of a code-only phase (see `docs/PROVIDER_REGISTRY.md`'s TODO).
- [ ] **Legal entity / GST setup for invoicing** — `billing_accounts`/
  `invoices` (Phase 7) model an `issuing_entity_name` but assume a real,
  GST-registered business entity exists to legally issue them. Confirm
  the founder's business registration status covers invoicing customers
  (and resellers' customers) before real invoices are sent.
- [ ] **Two real LLM-pricing input-token/output-token rate cards** — per
  `docs/AUDIO_BRIDGE.md`'s "Known simplification": `provider_rate_cards`
  currently prices only the input-token rate for LLM usage, not a real
  blended input+output cost. Fix the rate-card convention (or schema)
  before real billing runs on real call volume, not just the mock-cost
  math the current tests verify.
- [ ] **A per-tenant DLT/telemarketer registration workflow** — even once
  the platform's own DLT registration exists (Category A), Phase 6's
  `lead_compliance` schema assumes upstream consent capture was already
  DLT-compliant; a real onboarding flow for each tenant's own registration
  status is a business process, not yet built or specified.
- [ ] **Rotate `PROVIDER_CONFIG_ENCRYPTION_KEY` out of any dev-shared value**
  — confirm the value used in any early pilot/demo deployment is never the
  same key committed to `.env.example`'s placeholder text, before a single
  real credential is encrypted with it.
- [ ] **Real n8n container, wired and exercised** — `docs/N8N_WORKFLOWS.md`'s
  6 workflows are structurally validated but never run against a live n8n
  instance (see that doc's manual smoke-test checklist). Do the checklist
  before relying on any n8n-driven automation (lead intake, WhatsApp
  follow-up, daily summary) for real revenue-generating traffic.
- [ ] **Per-tenant n8n webhook tokens** — Phase 6 shipped one shared secret
  per n8n instance (`docs/N8N_WORKFLOWS.md`'s "Deferred" section); a leaked
  shared secret currently lets a caller address any org's n8n endpoints if
  they also know that org's id. Move to a per-tenant, server-resolved
  token before onboarding a second real tenant with n8n automation enabled.

## Category C — must-have before scaling beyond a first pilot tenant

- [ ] **Real DNS/SSL for white-label custom domains** — per
  `docs/DEPLOYMENT.md` §6 and `docs/RESELLER_HIERARCHY.md` §4, the
  subdomain mechanism works; a real reseller custom domain
  (`voice.clientdomain.com`) needs the DNS/TLS/reverse-proxy/ownership-
  verification steps done per reseller as each one signs up.
- [ ] **Provision Redis, if using the BullMQ queue path** — the default
  Postgres-backed queue works without it; only needed if/when campaign
  dispatch volume justifies the `bullmq` backend (`docs/DEPLOYMENT.md` §4).
- [ ] **Swap the rate limiter to Redis-backed** — the current Postgres-
  backed limiter (`docs/SECURITY_AUDIT.md` §8) is correct but not the
  most efficient at scale; swap once Redis is provisioned for the queue
  path anyway (same instance can back both).
- [ ] **Load-test against real providers, not just mocks** — Phase 9's load
  test (`docs/LOAD_TESTING.md`) proves the mock-adapter path is safe under
  100-200 concurrent operations; it explicitly does NOT prove real
  provider behavior under load (real STT/TTS/LLM latency, real carrier
  behavior, real webhook retry volume). Re-run an equivalent test against
  real adapters — start with single-digit concurrent real calls, not 100+
  — once live credentials exist.
- [ ] **A sustained soak test, not just a burst test** — Phase 9's test
  fires all requests near-simultaneously; connection-pool exhaustion,
  memory growth, or slow leaks under sustained load over minutes/hours are
  untested. Needed before trusting the platform under real all-day traffic.
- [ ] **Realistic connection-pool / infra sizing** — Phase 9 used each
  runtime's small default pool size; size `pg`/`asyncpg` pools and
  Postgres `max_connections` against actual expected call volume before a
  real launch, not just the concurrency levels this repo's tests ran at.
- [ ] **Monitoring/alerting wired to a real on-call channel** — Phase 9
  built the metrics (`call_latency_metrics`, provider failover tracking,
  `billing_alerts`); no alerting destination (PagerDuty/Slack/email) is
  wired yet. See `docs/DEPLOYMENT.md` §7.
- [ ] **A real ops-notification node for the appointment-reminder failsafe
  n8n workflow** — `docs/N8N_WORKFLOWS.md`'s "Deferred" section: no
  Slack/email credentials exist in dev to wire this; needed before relying
  on the failsafe (not the primary reminder path, which already works)
  for a real multi-tenant deployment.
- [ ] **Multi-instance/horizontal-scale verification** — Phase 9's tests run
  against a single voice-gateway process and a single Next.js process
  (documented scope). Shared session state and load-balancer behavior
  across multiple instances is untested — relevant once traffic requires
  more than one instance of either runtime.

## Category D — nice-to-have, not blocking

- [ ] **A UI for `promote_org_role()` / reseller onboarding** — currently a
  direct DB call (`docs/RESELLER_HIERARCHY.md` §6), same bar as Phase 7's
  provider/plan seeding. Fine for a founder-run early stage; worth a UI
  once reseller onboarding volume justifies it.
  A `CHECK`/trigger enforcing `parent_reseller_id`'s target `org_role` is
  the same "not needed to prove the mechanism yet" deferral.
- [ ] **A per-provider markup matrix** for reseller buy/sell rates (currently
  one global USD/minute rate per reseller — `docs/RESELLER_HIERARCHY.md` §2)
  — extensible without a breaking schema change whenever a reseller
  actually needs per-provider pricing.
- [ ] **Cashfree adapter implementation** (currently cataloged but not built
  — `docs/STACK_PROPOSAL.md`'s payment-gateway section) — a cost-
  optimization fallback once real Razorpay volume justifies a quote
  comparison, not needed for launch.
- [ ] **Gupshup/direct Meta Cloud API WhatsApp adapters** beyond the
  existing Interakt default — same "documented alternate, not urgent"
  status as Cashfree.
- [ ] **A CI pipeline** running `docs/TESTING.md`'s `npm run test:all` plus
  lint/typecheck/build on every push — deferred since Phase 1
  (`docs/PHASE1_DECISIONS.md`'s "Known gaps"), still not built. Worth
  doing early once a second contributor joins, not blocking a solo-founder
  launch.
- [ ] **Bhashini / Smallest.ai hands-on evaluation** — both flagged in
  `docs/VERIFICATION.md` §8 as worth a technical spike (possible cheaper
  STT/TTS path) but never actually spiked. Pure cost optimization, not a
  launch blocker.
- [ ] **Broader within-org RBAC coverage** — Phase 10 gated the four
  highest-value routes (billing top-up, reseller pricing/branding, call
  creation — see `docs/SECURITY_AUDIT.md` §2); CRM/campaign/appointment
  mutations remain "any org member." Extend incrementally as real
  multi-user-per-org usage reveals which roles actually need restricting.

## How to read this checklist

Categories are ordered by urgency, not by effort — some Category A items
(DLT registration, legal review) take longer than some Category C items
(provisioning Redis). Start the slow, non-technical items (DLT
registration, legal review, real vendor accounts) in parallel with any
remaining engineering work, since they are the actual critical path to a
real launch date, not the code in this repository.
