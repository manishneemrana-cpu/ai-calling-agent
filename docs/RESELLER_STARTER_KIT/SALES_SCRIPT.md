# Reseller Starter Kit — Demo-Mode Sales Script

A canned, no-real-call walkthrough a reseller can read (or paraphrase) to a
prospect. This is content, not infrastructure — it describes what to SAY
while pointing at the actual product, using demo/mock data (no live
telephony spend, no real PII), never a hardcoded vertical. Swap the
bracketed placeholders for the prospect's own business.

> **Honest scope note**: this codebase does not currently ship a dedicated
> `NEXT_PUBLIC_APP_DEFAULT_MODE=demo` toggle — that env var is referenced in
> this phase's own spec text but does not exist in `.env.example` or
> anywhere in `apps/web` as of Phase 7. Rather than invent one to match a
> reference that isn't real, this script instead walks the reseller through
> the platform's actual `mock` provider adapters (telephony/STT/TTS/LLM —
> see `docs/PROVIDER_REGISTRY.md`), which already give a zero-cost,
> zero-real-call demo path with no schema or app change needed. If a real
> demo-mode toggle is added in a later phase, this script should be updated
> to reference it directly.

## Before the call

- Log into a `mock`-provider-configured org (or your own reseller demo
  tenant) — every telephony/STT/TTS/LLM adapter set to `mock` means every
  "call" in this walkthrough is simulated, deterministic, and free (see
  `docs/PROVIDER_REGISTRY.md`).
- Have the prospect's vertical in mind ([real estate / diagnostics /
  D2C e-commerce / education / collections / logistics / insurance /
  support / other]) — nothing in the product assumes one, and you should
  say so explicitly; it's a selling point, not a caveat.

## The script

**Opening**

> "[Prospect name], thanks for the time. I want to show you an AI voice
> calling platform I resell — it handles [inbound/outbound] calls for
> [prospect's vertical] end-to-end: qualifying a lead, answering questions
> from your own knowledge base, booking [appointments/site visits/demos],
> and handing off to a human when it should. I'll walk you through it live,
> using our demo/mock mode so nothing costs anything and no real numbers
> get dialed."

**1. Show the Agent Builder concept**

> "Every agent's persona, script, and knowledge base is configured per
> business — nothing is hardcoded to one industry. For [prospect's
> business], we'd configure it with your actual FAQs, your actual
> qualification questions, your actual disposition set (what counts as a
> hot/warm/cold lead for you specifically)."

Point at `/dashboard/agents` — show the current demo agent's config.

**2. Show a simulated call end-to-end**

> "Here's what a call looks like." (Walk through a transcript/summary from
> a `mock`-provider test call, or a recorded demo transcript.) "Notice: it
> handles interruptions [barge-in], it stays on your script, and at the end
> it automatically updates the CRM pipeline stage and — if you want —
> triggers a WhatsApp follow-up."

**3. Show the CRM/pipeline view**

> "Your pipeline stages and dispositions are yours to define — this isn't a
> fixed real-estate funnel forced onto your business." Point at
> `/dashboard/leads`.

**4. Show cost transparency — WITHOUT showing platform internals**

> "Here's what this would cost you at different call volumes." Open (or
> hand over) a **Starter Kit cost-simulator share link**
> (`/dashboard/reseller/starter-kit` → create a share) — this shows the
> prospect their estimated price at several monthly-minute tiers, computed
> from the rate YOU'VE set for them, never our own underlying vendor costs.

**5. Compliance & trust**

> "Every outbound call goes through a mandatory compliance gate before it's
> ever placed — DND/consent checks, TRAI/DLT rules for India — this isn't
> optional or something that can be accidentally skipped in code; every
> call-creation path is forced through it." (`docs/COMPLIANCE.md`)

**6. Close**

> "If this fits, next step is a proposal — I'll put together your specific
> plan, estimated monthly minutes, and monthly cost based on what we
> discussed." → hand them the **Proposal Template**
> (`docs/RESELLER_STARTER_KIT/PROPOSAL_TEMPLATE.md`, filled in).

## After the call

- Fill in `PROPOSAL_TEMPLATE.md` with their specifics.
- Create a starter-kit share link (`/dashboard/reseller/starter-kit`) scoped
  to their estimated minutes/month and send them the link + CSV.
