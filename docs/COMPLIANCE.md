# Compliance Notes — TRAI / DLT / DND / TCCCPR

> **This document is a plain-language summary of publicly available regulatory information gathered on 2026-09-21, for internal planning purposes only. It is NOT legal advice. A qualified telecom/data-privacy legal professional must review the platform's actual call flows, consent capture, and vendor contracts against current TRAI regulations before any commercial go-live, and again before onboarding each reseller/white-label partner. Regulations in this space have changed twice in the last 18 months (Feb 2025 and Sep 2026 amendments) and should be assumed to keep changing.**

## What this platform must account for

1. **TCCCPR 2018 (as amended)** — the base framework governing all "commercial communications" in India, which explicitly includes automated/AI-driven voice calls, not just human agents. TRAI has stated automated voice systems are subject to the same rules as human-operated call centres.

2. **DLT (Distributed Ledger Technology) registration** — any entity making outbound commercial calls/messages in India must be registered on the DLT platform, with registered telemarketer entity, headers, and message/call templates, **before** placing calls. This applies per business entity (i.e., likely per SitesNSign customer/tenant, not just SitesNSign itself as the platform operator) — a critical multi-tenancy/reseller design question for Phase 1: does each tenant need their own DLT registration, or can calls be routed under an aggregator/platform-level registration? This must be confirmed with legal counsel and the chosen telephony provider (Plivo/Exotel), as it directly affects onboarding friction for resellers.

3. **DND / NDNC (National Do Not Disturb registry)** — numbers on the NDNC list must be excluded from outbound commercial calling unless valid consent exists. As of the February 2025 amendment:
   - **Explicit consent** for a specific commercial transaction is valid for only **7 days** from when it was captured — after that window, fresh consent is required before calling that number again for that purpose.
   - **Inferred consent** (e.g., from an existing customer relationship) remains valid only for the duration of that contractual relationship.
   - This has direct product implications: the platform needs a consent-tracking data model (who consented, when, for what purpose, expiry) wired into the outbound-dialing job queue so it can refuse to dial numbers whose consent has lapsed or that are DND-registered without valid consent.

4. **Numbering series requirements**: promotional/marketing commercial calls must originate from **140-series** numbers; BFSI (banking/financial services/insurance)-related service calls must use **1600-series** numbers, with a compliance deadline of **1 January 2026**. Real estate sales calls would likely fall under the promotional/140-series bucket, but this classification should be confirmed with counsel and the telephony provider, since misclassification risks regulatory penalties and call-blocking by telecom operators.

5. **Spam reporting / enforcement window**: customers can report a call as spam within **7 days** (extended from 3 days in the Feb 2025 amendment) — the platform should assume its calling patterns are subject to faster, more visible complaint cycles than before.

6. **September 2026 amendment**: TRAI has begun mandating **AI/ML-based detection by telecom service providers** to identify Customer Line Identifications (CLIs) with a high probability of being used for unsolicited commercial communication. This means the enforcement side is now automated too — a platform with clean DLT registration, consistent sender IDs, and low complaint rates is important not just for legal compliance but to avoid being auto-flagged/throttled by carriers.

## Design implications flagged for Phase 1 (not yet designed, noted for continuity)

- A consent/DND data model in Postgres, checked by the orchestrator/dialer before every outbound call attempt.
- A per-tenant (and possibly per-reseller) DLT registration and sender-ID/number-series management workflow — likely needs direct integration with whichever telephony provider's DLT tooling is confirmed usable for bot-originated calls (see VERIFICATION.md open item #6).
- Retention and access-control policy for call recordings/transcripts (who can access them, how long they're kept, whether tenants can opt out of recording) — this overlaps with India's broader data-protection regime (DPDP Act) which is out of scope for this document but must be covered in the legal review.
- Inbound vs. outbound calling may have different compliance postures (inbound calls initiated by the customer generally carry fewer DND/consent restrictions than outbound cold/warm calling) — the product's initial use case (inbound sales inquiries vs. outbound lead follow-up) should be clarified with the founder, since it materially changes the compliance burden for Phase 1 launch.

## 2026-09-22 re-verification (Phase 6 — compliance gate build)

Re-searched rather than assumed still-current, per the founder's brief.
**Confirms and sharpens** the 2026-09-21 findings above; no reversal.

- **Third TCCCPR amendment, dated 2026-09-18** (four days before this
  re-check, and one day after the initial 2026-09-21 pass here — same
  amendment, now with more implementation detail found): TRAI formalized
  **Regulation 21A**, requiring telecom service providers themselves to
  run **AI/ML-based detection** of Customer Line Identifications (CLIs)
  with a high probability of being used for unsolicited commercial
  communication, and to share flagged CLIs across TSPs. **Graded
  enforcement is now explicit and automatic**: 5+ flagged CLIs from one
  sender within a 10-day window triggers KYC re-verification, physical
  verification, barring of outgoing service, and — for repeat/severe
  cases — disconnection of the telecom resource entirely. This raises the
  stakes on this platform's compliance gate being airtight: a bug that
  lets even a handful of non-compliant calls through in a short window
  could get a tenant's number(s) auto-flagged and barred by the carrier,
  independent of any TRAI complaint process.
- **A2P (Application-to-Person) calling is now formally defined**: "voice
  calls initiated by an application, software system or automated
  platform without direct human dialing, including autodialing, robo-calls
  and pre-recorded/artificial voice technologies." This is an explicit,
  named regulatory category this platform's entire outbound-calling
  product falls into — not an edge case or a gray area needing
  interpretation. Every call this platform places is an A2P call under
  this definition.
- **Call-management app carve-out**: TRAI's amendment also restricts apps
  like Truecaller from filtering/blocking calls from TRAI-designated
  commercial number series (140/1600). This is informational for this
  platform (it affects how a called party's phone treats the call, not
  what this platform must do) but is a signal that correct number-series
  registration (140 promotional vs 1600 BFSI-service, per the 1 Jan 2026
  deadline already noted above) has carrier-level consequences beyond
  regulatory risk.
- **No change** to the core enforceable rules this phase's compliance
  gate implements: DLT registration prerequisite, DND/NDNC exclusion
  absent valid consent, 7-day explicit-consent expiry, and the spam-report
  window. The Phase 6 `lead_compliance` schema and
  `assertCallIsCompliant()` gate (`apps/web/lib/compliance/gate.ts`) target
  exactly these — consent status + expiry, DND flag, opt-out, and (via
  `campaigns`) calling-hour windows and per-campaign rate limits — as the
  enforceable minimum a technical gate can check. **DLT registration
  itself, and per-tenant telemarketer/header registration, remain a
  business/legal onboarding step outside this codebase** (as flagged since
  Phase 0) — the gate assumes a lead's `lead_compliance` row was populated
  correctly upstream (by a properly DLT-registered consent-capture flow),
  it cannot itself verify DLT registration status.

Sources (2026-09-22 pass): medianama.com/2026/09/223-trai-truecaller-140-1600-calls-spam-rules;
etvbharat.com trai-tightens-regulations-on-spam-callers; business-standard.com
ai-calls-how-to-identify-legitimate-calls-spam-scams; indiantelevision.com
trai-tightens-anti-spam-rules-with-ai-based-enforcement.

**This re-verification is still not legal advice — see the disclaimer
below, which applies with equal force to this section.**

## Explicit disclaimer (repeated per the founder's spec)

**Nothing in this document, or in any other Phase 0 document in this repository, constitutes legal advice. Before any real customer is called by this platform, a licensed Indian telecom/data-privacy lawyer must review: the DLT registration model chosen, the consent-capture and expiry logic, the numbering-series classification of the platform's call types, and the data-retention policy for recordings and transcripts. This applies equally to the Phase 6 compliance gate (`apps/web/lib/compliance/gate.ts`) and its `lead_compliance`/`campaigns` schema — a qualified professional must review the actual consent-capture UX, DND-list refresh mechanism, and calling-hour/rate-limit defaults before any real tenant is allowed to dial real numbers through it.**
