# Cost Model v1 — Per-Connected-Minute Economics

**This is a Phase 0 modeling exercise, not a quote.** Every line item is built from the pricing recorded in `VERIFICATION.md` on 2026-09-21, several of which are third-party estimates (Exotel, and partially Plivo's India base voice rate, which this session could not fetch directly — see VERIFICATION.md §7). All figures assume **₹88 = $1** (approximate Sep-2026 rate) and must be re-priced against live vendor quotes before any commercial commitment is made.

**₹1/min is stated in the founder's spec as a target for the Economy tier only, under the specific assumptions below. It is NOT a guarantee, and the verified pricing gathered in this session puts the realistic Economy-tier floor closer to ~₹2/min unless telephony is renegotiated to high-volume/direct-SIP rates.** Telephony is the dominant cost line in both tiers — it, not the AI stack, is the main lever on whether ₹1/min is reachable.

---

## Assumptions (stated explicitly so the numbers are auditable)

| Assumption | Value |
|---|---|
| Exchange rate | ₹88 / $1 |
| Average connected call length | 3 minutes |
| Average conversational turns per connected minute | 2 |
| Average LLM input tokens per turn (system+history+user utterance) | ~200 tokens |
| Average LLM output tokens per turn (agent reply) | ~80 tokens |
| Average TTS characters synthesized per turn (agent reply) | ~60–80 characters (short, natural turns — not long monologues) |
| STT | transcribes the full connected-minute duration (continuous streaming, not just agent turns) |
| Infra allocation | amortized compute/hosting/observability/on-call/support cost per connected minute (rough allocation, not a detailed infra BOM) |
| Telephony base voice rate (Economy) | **UPDATED 2026-09-21**: ₹0.125/min — blended average of FreJun Teler's verified ₹0.10/min inbound + ₹0.15/min outbound rate (see VERIFICATION.md §7.2) |
| Telephony base voice rate (Premium) | ₹1.20/min — mid/high-end benchmark, assumes toll-free/BFSI-grade routing or Exotel (unchanged; Premium tier still assumed on Plivo/Exotel-class reliability, not re-priced against FreJun Teler in this pass) |
| Telephony streaming add-on (Economy) | **UPDATED**: FreJun Teler's published ₹0.15/min media-streaming add-on (see VERIFICATION.md §7.2) |
| Telephony streaming add-on (Premium) | Plivo's published $0.004/min (~₹0.35/min), unchanged from Phase 0 |

---

## Economy tier: Sarvam STT + Sarvam Bulbul TTS + Gemini Flash-Lite + **FreJun Teler** (updated 2026-09-21; was Plivo)

**Why the telephony line changed**: the founder asked for a wider telephony sweep (VERIFICATION.md §7). FreJun Teler came back as the cheapest *verified, streaming-capable* India telephony option found — see `STACK_PROPOSAL.md`'s ranked telephony list. This recomputes the Economy tier with FreJun Teler's rate in place of the earlier ₹0.60/min unverified benchmark (which, separately, turned out to be very close to Plivo's now-confirmed ₹0.60/min rate — the benchmark itself wasn't wrong, it's just no longer the cheapest *viable* option available).

| Cost line | Basis | ₹/connected-minute (NEW) | ₹/connected-minute (OLD, Plivo-benchmark) |
|---|---|---|---|
| Telephony (voice + streaming) | ₹0.125 blended base + ₹0.15 streaming add-on (FreJun Teler) | **₹0.28** | ₹0.95 (Plivo-class benchmark) |
| STT (Sarvam, no diarization) | ₹30/hr = ₹0.50/min | ₹0.50 | ₹0.50 |
| TTS (Sarvam Bulbul) | 2 turns × 70 chars = 140 chars/min × ₹0.003/char (₹30/10,000 chars) | ₹0.42 | ₹0.42 |
| LLM (Gemini 2.5 Flash-Lite)* | 400 input tok × $0.10/M + 160 output tok × $0.40/M = $0.000104/min | ₹0.01 | ₹0.01 |
| Infra allocation (Economy) | rough amortized estimate | ₹0.15 | ₹0.15 |
| **Total — Economy** | | **≈ ₹1.36/min** | ≈ ₹2.03/min |

\* Gemini 2.5 Flash-Lite is scheduled for retirement on 2026-10-16 — re-price against its successor model before committing (VERIFICATION.md §4.1).

**The delta, explained honestly**: swapping the telephony line from the Plivo-class ₹0.95/min benchmark to FreJun Teler's verified ₹0.28/min drops the Economy total from **₹2.03/min to ≈₹1.36/min** — a real ₹0.67/min improvement, and telephony's share of the total drops from ~47% to ~21%. **This is closer to the founder's ₹1/min aspiration than the Phase 0 model showed, but it is still ~36% above ₹1/min, not at or under it.** The founder's own spec rule stands: this is not a guarantee. Two caveats on the new number specifically:
1. FreJun Teler's rate comes from search-indexed vendor pricing pages, not a sales call or paid pilot (VERIFICATION.md §7.2/§9.3) — if a pilot reveals a materially different real-world rate (e.g. minimum billing increments, hidden per-call setup fees, or a different streaming-add-on structure than advertised), this number moves.
2. FreJun Teler is a newer/smaller brand with a 12-month minimum DID commitment and Aadhaar-based KYC — a real operational commitment, not risk-free, even though it is startup-viable rather than enterprise-only.

**To close the remaining ~₹0.36/min gap to ₹1/min**, the same two levers from Phase 0 still apply, now with telephony less dominant: (1) further telephony negotiation once volume justifies a quote from FreJun/Plivo/Exotel/Tata/Acefone at scale, and (2) shorter/optimized STT-TTS usage (VAD-gated transcription/synthesis instead of full-duration streaming, or a self-hosted Piper/faster-whisper stack once volume justifies ops overhead). Neither lever is verified as achievable in this session.

---

## Premium tier: Deepgram STT + Cartesia TTS + Gemini Flash + Plivo/Exotel

| Cost line | Basis | ₹/connected-minute |
|---|---|---|
| Telephony (voice + streaming) | ₹1.20 base + ₹0.35 streaming add-on | **₹1.55** |
| STT (Deepgram Nova-3, streaming) | $0.0077/min | **₹0.68** |
| TTS (Cartesia, per-character, mid-range plan) | 2 turns × 80 chars = 160 chars/min at ~$15/M chars (mid of $5–$37/M range) | **₹0.21** |
| LLM (Gemini 2.5 Flash)* | 400 input tok × $0.30/M + 160 output tok × $2.50/M = $0.00052/min | **₹0.05** |
| Infra allocation (Premium) | higher redundancy/observability | **₹0.30** |
| **Total — Premium** | | **≈ ₹2.79/min** |

\* Same Gemini deprecation caveat as above applies.

A further "flagship" option swaps Cartesia for ElevenLabs (~₹0.70/min TTS at this turn volume, using the Flash/Turbo model rate) for the highest perceived voice quality, pushing Premium to roughly ₹3.3/min.

---

## Why the two tiers are closer together than "Economy vs Premium" branding suggests

**Note (2026-09-21): the Economy-tier telephony figure below was updated from ₹0.95/min to ₹0.28/min (FreJun Teler) — see the recomputed Economy table above. Premium's telephony line is unchanged (still Plivo/Exotel-class ₹1.55/min) since this pass only re-verified the cheapest streaming-capable option, not a full Premium-tier telephony re-rank.** With the update, telephony is no longer the largest line in the Economy tier — the AI stack (STT+TTS+LLM, ≈₹0.93/min) now exceeds telephony (₹0.28/min) in Economy, while telephony (~55%) remains the largest single line in Premium. This is a meaningful shift from the original framing: for Economy specifically, further cost reduction now has to come from BOTH telephony (already the cheapest verified option) AND the AI stack, not telephony alone.

---

## Volume simulator (cost only, no margin/pricing-to-customer layered in)

| Minutes/month | Economy (≈₹1.36/min, updated) | Premium (≈₹2.79/min) |
|---:|---:|---:|
| 100 | ₹136 | ₹279 |
| 1,000 | ₹1,360 | ₹2,790 |
| 10,000 | ₹13,600 | ₹27,900 |
| 100,000 | ₹1,36,000 | ₹2,79,000 |

These are linear extrapolations of the per-minute model above; they do **not** include volume-discount tiers that Plivo/FreJun/Exotel/Sarvam/Deepgram/Groq/Google typically offer at higher commitment levels (e.g., Sarvam's Pro/Business monthly plans, Deepgram's Growth annual-prepaid rate, or a negotiated telephony SIP contract) — at 100,000 min/month, all of those discounts would likely apply and should be re-modeled with actual negotiated rates, not the retail/PAYG rates used here.

## What Phase 1/2 must confirm before this model is trusted for pricing customers

1. **FreJun Teler's actual production rate via a paid pilot**, not just its published pricing page (see VERIFICATION.md §7.2, §9.3) — this is now the single most load-bearing unverified number in the Economy model, having replaced the old Plivo-benchmark uncertainty.
2. Plivo/Exotel/Tata Smartflo/Acefone India per-minute quotes at the founder's expected volume, kept as fallback/alternate options (see VERIFICATION.md §9.1–9.2, §9.4).
3. Whether Sarvam's Business tier (₹50,000/mo, 1,000 req/min) changes the effective per-minute STT/TTS cost at scale vs. the PAYG rate used here.
4. Gemini's post-October-2026 successor model and its price.
5. Real measured average call length, turns/min, and character/token counts from a pilot — the assumptions above are reasoned estimates, not measured data.
6. Whether Bhashini's government tier (if it turns out to support real-time streaming — unconfirmed, VERIFICATION.md §8.5) or Smallest.ai's TTS (§8.2) beat Sarvam on a hands-on Phase 1 eval — if so, re-run this model with those figures.

## 2026-09-21 follow-up #1: does the alternate STT/TTS/LLM-provider research change the Economy-tier figure?

**No**, on the AI-stack side specifically. A broader sweep (Smallest.ai, Neuphonic, Rime, Bhashini, OpenAI Realtime, Azure/AWS/Google Cloud, Coqui/XTTS, Vosk — full findings in `VERIFICATION.md` §8) turned up nothing confirmed cheaper than the Sarvam STT (₹0.50/min) + Sarvam Bulbul TTS (₹0.42/min at this turn volume) + Gemini Flash-Lite (₹0.01/min) combination already in the Economy-tier line above:
- Smallest.ai's TTS (~$13.50/M chars) is cheaper than Cartesia/ElevenLabs but still well above Bulbul's ~$3.60/M chars — would *increase*, not decrease, the TTS line if swapped in.
- Bhashini's government tier could in principle beat Bulbul on price (free/near-free for Indian languages), but its real-time streaming support is unconfirmed — it cannot be plugged into this model until that is verified hands-on, so it is **not** used to revise the figure yet (tracked as an open item above).
- OpenAI Realtime API's audio layer alone (~₹4.4/min) is more expensive than this entire Economy stack combined — the opposite of a cost win.
- Vosk (self-hosted STT) trades Sarvam's ₹0.50/min for infra/ops cost instead — not modeled as cheaper without a concrete self-hosting cost estimate, which Phase 1 has not built.

## 2026-09-21 follow-up #2: does the expanded telephony research change the Economy-tier figure?

**Yes** — this is the update reflected in the Economy table above. The founder specifically asked for a wider telephony sweep (`VERIFICATION.md` §7), which found FreJun Teler as a verified, streaming-capable option at roughly a third of Plivo's cost. **The Economy-tier total moves from ≈₹2.03/min to ≈₹1.36/min** as a direct result — a real, if partial, step toward the founder's ₹1/min aspiration, achieved by re-verifying telephony rather than by any AI-stack change. **This is still not ₹1/min, and is not presented as such** — the remaining gap (~₹0.36/min) requires either a further-negotiated telephony rate at volume or AI-stack usage optimization (VAD-gated STT/TTS, self-hosting), neither of which is verified in this session.
