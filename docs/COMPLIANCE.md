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

## Explicit disclaimer (repeated per the founder's spec)

**Nothing in this document, or in any other Phase 0 document in this repository, constitutes legal advice. Before any real customer is called by this platform, a licensed Indian telecom/data-privacy lawyer must review: the DLT registration model chosen, the consent-capture and expiry logic, the numbering-series classification of the platform's call types, and the data-retention policy for recordings and transcripts.**
