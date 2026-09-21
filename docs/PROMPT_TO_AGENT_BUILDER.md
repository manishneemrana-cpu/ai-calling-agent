# Prompt-to-Agent Builder — Design (Phase 0)

**This is the platform's flagship differentiating feature.** A tenant (or a reseller's customer) types a plain-language description of their business and use-case, and the platform generates a working calling-agent configuration from it — no vertical dropdown, no manual prompt engineering required to get started. This document is a design spec only; no code is written in Phase 0.

## 1. Why this, and why it's simple to build

The founder's instruction is explicit: **this is one LLM call with a well-designed system prompt (a "meta-prompt"), not a separate ML model.** That constraint shapes the whole design:

- One meta-prompt (a fixed, carefully engineered system prompt) is sent to the platform's LLM adapter (Gemini Flash primary — see `STACK_PROPOSAL.md`) along with the tenant's free-text business description.
- The LLM is instructed to return **structured JSON** matching a fixed schema (§3 below) — using the LLM adapter's function-calling/structured-output mode, not free-form text parsing.
- The output populates the same `agent_prompts` / Agent Builder config table that a human admin could otherwise fill in by hand (see `ARCHITECTURE.md` — the orchestrator is vertical-agnostic and reads this config regardless of who/what wrote it).
- No fine-tuning, no vertical classifier model, no vector database of "industry templates" is required for v1 — the meta-prompt itself carries the domain knowledge (it is prompted to reason about common patterns across verticals), and a small library of **seed examples** (few-shot, §5) keeps output quality consistent. A lightweight template library (§6) can be layered on top later purely as an optimization, not a v1 requirement.

## 2. End-to-end flow

```
Tenant/reseller types free-text description
        │
        ▼
[Step 1] Meta-prompt + description → LLM (structured output call)
        │
        ▼
Is the description specific enough about industry/use-case?
        │
   ┌────┴─────┐
   │ No        │ Yes
   ▼           ▼
[Step 2]    [Step 3]
Clarification   Generate full
question(s)     Agent Builder config
returned to        (§3 schema)
tenant UI            │
   │                 ▼
   ▼            Tenant reviews/edits
Tenant answers   in Agent Builder UI
   │                 │
   └───────┬─────────┘
           ▼
   Tenant confirms → config saved to `agent_prompts`
   table, agent is live for that tenant
```

- **Step 1 is always the same LLM call** — the meta-prompt asks the model to both (a) attempt full generation and (b) self-report a confidence/completeness flag on whether the business description gave it enough to work with. This avoids a separate "classify vagueness" pre-step; it's one call either way.
- **Step 2 (clarification) only fires when the model reports low confidence** (e.g., "call people about my business" with no product, audience, or goal named) or when it detects genuine ambiguity between plausible verticals (e.g., "I run a clinic" — dental? diagnostics? general physician? — each implies different qualification questions and disposition sets). The model asks **1–3 short, concrete questions** (not a generic "tell me more"), and the tenant's answers are appended to the original description and re-sent through the same Step 1 call.
- **Step 3 output is always presented for tenant review before going live** — the generated config is a strong first draft, editable in the existing Agent Builder UI (persona, questions, script, tools, pipeline stages, dispositions are all editable fields, not a black box). This matters for trust and for correcting anything industry-specific the LLM inferred wrong.

## 3. Structured output schema

The LLM's structured-output call must return an object matching this shape (illustrative; exact types/enums to be finalized against the LLM adapter's schema format in Phase 1):

```json
{
  "clarification_needed": false,
  "clarification_questions": [],
  "inferred_vertical": "string — the platform's best-guess label, e.g. \"real_estate\", \"healthcare_diagnostics\", \"ecommerce_d2c\", \"custom\"",
  "inferred_vertical_confidence": "high | medium | low",
  "agent_persona": {
    "name": "string — a persona name/identity for the agent",
    "tone": "string — e.g. warm and consultative, brisk and transactional, empathetic",
    "language_style": "string — e.g. Hindi/English code-switching, formal English, casual regional"
  },
  "greeting_script": "string — the exact opening line(s) the agent should use, including any required disclosure/consent language",
  "qualification_questions": [
    { "question": "string", "purpose": "string — what this question is for", "maps_to_field": "string — CRM field it populates" }
  ],
  "objection_handling": [
    { "objection": "string — a likely pushback the caller may raise", "response_stub": "string — a starting response the agent can adapt" }
  ],
  "tools_needed": [
    { "tool_name": "string — generic capability name, e.g. check_availability, book_appointment, lookup_order_status, check_eligibility", "description": "string", "example_use": "string" }
  ],
  "knowledge_base_scaffold": {
    "suggested_categories": ["string — e.g. \"product catalog\", \"pricing/FAQs\", \"policy documents\""],
    "seed_faqs": [ { "question": "string", "answer_stub": "string" } ]
  },
  "suggested_pipeline_stages": ["string — ordered CRM/lead pipeline stages for this vertical, e.g. New → Contacted → Qualified → Appointment Booked → Won/Lost"],
  "suggested_dispositions": ["string — call-outcome tags, e.g. Interested, Not Interested, Callback Requested, Wrong Number, DNC Requested"],
  "suggested_lead_scoring_criteria": [
    { "criterion": "string — e.g. \"budget confirmed\", \"has report to discuss\", \"cart value above threshold\"", "weight_hint": "high | medium | low" }
  ],
  "compliance_flags": ["string — anything the meta-prompt should proactively flag, e.g. \"healthcare: avoid diagnostic claims\", \"collections: consent/DND sensitivity is elevated\""]
}
```

Notes:
- `clarification_needed: true` short-circuits everything after `clarification_questions` (those fields are omitted or null on that turn).
- `tools_needed` names **generic** capabilities (per `ARCHITECTURE.md`'s vertical-agnostic tool-slot design) — the LLM should not invent bespoke real-estate-only tool names; a human/ops step maps each named tool to an actual internal API or external integration per tenant.
- `compliance_flags` is deliberately generic and non-legal — it exists to prompt a human review step for sensitive verticals (healthcare, collections/BFSI, insurance), consistent with `COMPLIANCE.md`'s non-legal-advice framing, not to make the platform an automated compliance authority.

## 4. The meta-prompt (design, not final copy)

The system prompt given to the LLM for this feature should instruct it to:

1. Read the tenant's free-text business/use-case description.
2. Reason about the likely industry vertical, primary calling objective (sales, reminders/retention, support, collections, scheduling, etc.), and audience.
3. If the description lacks enough signal to fill the schema confidently (no clear product/service, no clear goal, or a genuinely ambiguous vertical), set `clarification_needed: true` and ask 1–3 short, concrete, non-generic questions targeted at exactly the missing signal — never a vague "tell me more about your business."
4. Otherwise, populate every field of the schema in §3, grounding each field in the specific description given (not generic boilerplate) — e.g., qualification questions should reference the tenant's actual product/service names where the description supplies them.
5. Keep the greeting script compliant-by-default: include a placeholder for required identity/consent disclosure appropriate to outbound AI calling (exact legal wording is a Phase 1/legal deliverable, not something the LLM should improvise definitively — flag it rather than assert it).
6. Prefer plain, natural spoken language throughout (this is a voice script, not a chat UI) — short sentences, no jargon, culturally appropriate to an Indian calling context by default unless the description implies otherwise.
7. Never hardcode assumptions from any one vertical (e.g., never default to real-estate terms like "site visit" or "EMI" unless the tenant's description is about property/finance) — the meta-prompt itself must stay vertical-neutral; only the *output* becomes vertical-specific, per tenant.

## 5. Worked examples

### 5.1 Real estate (the founder's own first tenant)

**Input prompt**: *"I'm a real estate broker in Patna, I sell 2-3 BHK flats and plots. I want an agent that calls leads from my property portal, checks their budget and timeline, and books a site visit if they're serious."*

**Generated config (abridged)**:
- `inferred_vertical`: `"real_estate"`, confidence `high`
- `agent_persona`: name "Priya", tone "warm, consultative, patient with price-sensitive buyers", language "Hindi/English code-switching (Hinglish)"
- `greeting_script`: "Namaste, main Priya bol rahi hoon [Broker name] ki taraf se... aapने हमारी website पर property inquiry की थी..."
- `qualification_questions`: budget range, preferred locality, 2BHK vs 3BHK vs plot, timeline to purchase, financing plan in place?
- `objection_handling`: "price too high" → offer nearby comparable options; "just browsing" → offer to send brochure/WhatsApp catalog and soft-close for a callback
- `tools_needed`: `check_availability` (unit/plot inventory), `book_appointment` (site visit), `check_eligibility` (EMI/loan pre-check, maps to existing Home Loan/EMI Agent)
- `suggested_pipeline_stages`: New → Contacted → Qualified → Site Visit Booked → Negotiation → Won/Lost
- `suggested_dispositions`: Interested–Hot, Interested–Nurture, Budget Mismatch, Not Interested, Wrong Number, Callback Requested
- `suggested_lead_scoring_criteria`: budget confirmed (high), timeline < 3 months (high), financing pre-approved (medium)

### 5.2 Diagnostics / healthcare lab

**Input prompt**: *"I run a diagnostic lab chain. I want to remind patients when their test reports are ready and also suggest relevant health checkup packages based on their test history."*

**Generated config (abridged)**:
- `inferred_vertical`: `"healthcare_diagnostics"`, confidence `high`
- `agent_persona`: name "Anaya", tone "empathetic, reassuring, non-alarmist", language "clear English/Hindi, avoids medical jargon"
- `greeting_script`: "Namaste, main Anaya bol rahi hoon [Lab name] se, aapki report ready ho gayi hai..."
- `qualification_questions`: preferred way to receive report (app/email/pickup), interested in a follow-up consultation, any symptoms since the test (routed to a human, not diagnosed by the agent), interested in a relevant checkup package (based on age/test-history bracket, not the AI inferring a diagnosis)
- `objection_handling`: "why are you calling me" → clarify this is a report-ready courtesy call, not a sales call, before any upsell; "not interested in packages" → thank and close politely, no repeated pressure
- `tools_needed`: `lookup_order_status` (report status), `check_availability` (checkup package slots), `escalate_to_human` (any clinical question)
- `suggested_pipeline_stages`: Report Ready → Notified → Package Offered → Booked/Declined
- `suggested_dispositions`: Report Collected, Package Booked, Not Interested, Escalated to Doctor, Unreachable
- `suggested_lead_scoring_criteria`: has abnormal-flagged test (routes to human review, never auto-upsold), package interest expressed (medium)
- `compliance_flags`: `"healthcare: agent must never state or imply a diagnosis; any clinical question escalates to a human"`, `"health data: report-status calls carry PHI-like sensitivity — treat consent/DND rules as elevated per COMPLIANCE.md"`

### 5.3 E-commerce / D2C (abandoned cart)

**Input prompt**: *"I sell sarees online. I want to call customers who added items to cart but didn't complete checkout, remind them, and offer a small discount if they seem hesitant."*

**Generated config (abridged)**:
- `inferred_vertical`: `"ecommerce_d2c"`, confidence `high`
- `agent_persona`: name "Meera", tone "friendly, upbeat, light sales pressure", language "casual Hindi/English"
- `greeting_script`: "Hii, main Meera bol rahi hoon [Store name] se, maine dekha aapne kuch sundar sarees cart mein daale the..."
- `qualification_questions`: what stopped checkout (price, shipping time, sizing/color doubt, changed mind), still interested in the same item or alternatives, preferred payment method (COD vs prepaid)
- `objection_handling`: "too expensive" → offer the pre-approved discount code once, don't stack further discounts; "changed my mind" → thank and ask permission to notify about future sales instead of pushing
- `tools_needed`: `lookup_order_status` (cart contents), `check_availability` (stock/size), `apply_discount_code` (bounded, pre-approved codes only, never invented by the agent), `book_appointment` not applicable here (schema field simply omitted/empty)
- `suggested_pipeline_stages`: Cart Abandoned → Contacted → Discount Offered → Converted/Not Converted
- `suggested_dispositions`: Purchased After Call, Declined Discount, Wrong Number, Opted Out of Marketing Calls, Unreachable
- `suggested_lead_scoring_criteria`: cart value above threshold (high), repeat customer (medium), responded positively to discount (high — near-term conversion signal)

## 6. Future optimization (explicitly out of scope for v1): a template library

Once enough tenants have gone through the builder, the platform can optionally cache/curate the best-performing generated configs per inferred vertical as a small **seed-example library**, fed back into the meta-prompt as few-shot examples to improve consistency and speed for common verticals (real estate, diagnostics, D2C, collections, etc.). This is an incremental quality improvement on top of the same one-LLM-call design — **it must never become a hardcoded vertical dropdown or a branch in the core orchestrator code**; it only ever changes what few-shot examples are included in the meta-prompt call.

## 7. How this plugs into the existing Agent Builder / `agent_prompts` design

- The Prompt-to-Agent Builder is a **generator for**, not a replacement of, the existing Agent Builder concept and its `agent_prompts` table referenced in `ARCHITECTURE.md`. It writes to the same table a human-authored config would.
- The Conversation Orchestrator (per `ARCHITECTURE.md`) is unaware of whether a given tenant's config was hand-written or LLM-generated — it just reads persona/prompt/tools/pipeline config at call time. This preserves the "never hardcode a vertical in the core pipeline" rule from `STACK_PROPOSAL.md`.
- Regeneration/iteration: a tenant can re-run the builder with an updated description (e.g., "also handle Diwali sale promotions now") and the same Step 1 call re-generates/merges into the existing config, with the tenant reviewing the diff before it goes live — full mechanics (diff UI, versioning of `agent_prompts` rows) are a Phase 1 implementation detail, not decided here.

## 8. Open questions for Phase 1

1. Exact structured-output/function-calling schema format supported by the chosen Gemini model at build time (schema in §3 is illustrative, not final JSON Schema).
2. UX for the clarification round-trip (inline chat-style Q&A vs. a short form) — a product/design decision, not an AI-architecture one.
3. Whether `agent_prompts` needs an explicit `generated_by: "prompt_builder" | "manual"` + `source_description` column for audit/debugging traceability — recommended, to be confirmed in Phase 1 schema design.
4. Legal/compliance review of any auto-generated greeting/consent language before it is used in production calls (per `COMPLIANCE.md`'s non-legal-advice framing) — the meta-prompt should never be the final authority on consent wording.
