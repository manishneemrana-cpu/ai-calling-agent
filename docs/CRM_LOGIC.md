# CRM Logic — Phase 5

Documents the rule-based logic and design decisions introduced by
`db/migrations/010_crm_pipeline.sql` and the CRM modules in `apps/web` and
`services/voice-gateway`. Companion to `docs/ARCHITECTURE.md` (vertical-
neutral core) and `docs/PROMPT_TO_AGENT_BUILDER.md` (the config shape this
phase consumes).

## Multi-industry tenant-configurability (the non-negotiable constraint)

Nothing in this phase hardcodes real estate. Every pipeline stage,
disposition, and scoring criterion is a row in a tenant-owned table
(`pipeline_stages`, `dispositions`, `lead_scoring_criteria`), instantiated
from one of two mechanisms, both producing the exact same shape the
orchestrator/dashboard read:

1. **A platform template** (`pipeline_stage_templates` / `disposition_templates`
   — platform-wide catalogs, same RLS-disabled pattern as `providers`).
   Two templates ship: `generic_default` (vertical-neutral: New → Contacted
   → Qualified → Hot/Warm/Cold → Proposal Sent → Follow Up → Closed
   Won/Lost) and `real_estate` (the master spec's own real-estate-flavored
   pipeline: NEW → AI_CALLED → CONNECTED → QUALIFIED → HOT/WARM/COLD →
   PROPERTY_SHARED → SITE_VISIT → VISIT_COMPLETED → NEGOTIATION → BOOKING →
   CLOSED | LOST). A tenant/reseller picks either at agent setup time; more
   templates (diagnostics, D2C, collections, ...) are pure data — new rows
   in these two tables — never new code.
2. **The Prompt-to-Agent Builder's own output** — `agent_prompts.config`'s
   `suggested_pipeline_stages` / `suggested_dispositions` /
   `suggested_lead_scoring_criteria` (docs/PROMPT_TO_AGENT_BUILDER.md §3)
   can be instantiated directly into the same tables instead of a fixed
   template, for a fully bespoke-per-tenant pipeline. This phase's
   `apps/web/lib/crm/pipeline.ts` / `dispositions.ts` expose one
   `instantiate*` function per path, both writing the same row shape.

The orchestrator, the disposition classifier, and the scoring engine never
branch on vertical name or import a real-estate-specific constant — they
only ever read whatever rows a tenant's `pipeline_stages` /
`dispositions` / `lead_scoring_criteria` contain.

## Where the transcript lives

Phase 1's `calls.transcript jsonb` column is this platform's transcript
store — there was no separate `transcripts` table to find, and this phase
does not add one. `call_summaries` references `call_id` only; the summary
generator (`voice_gateway/crm/summary.py`) reads `calls.transcript` at
generation time and never copies transcript text into the summary row,
per the task's explicit "don't duplicate raw transcript text into every
summary row" instruction.

## Why `lead_scoring_criteria` is a dedicated table, not `agent_prompts.config` jsonb

`agent_prompts.config` already carries `suggested_lead_scoring_criteria`
from the builder, and could technically serve as the live config too. A
dedicated table was chosen instead because:
- the scoring engine and the dashboard both need to read/update individual
  criteria (toggle one off, tweak a weight) without touching the entire
  versioned agent config blob;
- it gets RLS + a tenant-isolation test "for free," in the exact same
  pattern as every other table in this migration, rather than needing
  bespoke isolation tests for a jsonb array nested inside another table.

## Pipeline stage transitions: ordered vs. freely jumpable

**Decision: freely jumpable, not strictly enforced order.** `pipeline_stages
.sort_order` exists so the dashboard can *display* stages in their intended
sequence, but `transitionLeadStage()` (apps/web) / the equivalent Python
helper does not reject an "out of order" move (e.g. NEW straight to
CLOSED_LOST). Reasoning: real phone conversations don't obey a linear
funnel even when the tenant's template is drawn as one — a caller can say
"not interested" on the very first call, or a human salesperson can
manually correct a stage. What IS enforced, unconditionally, is that every
transition is recorded: `transitionLeadStage()` always inserts one
`lead_stage_history` row (from_stage_id, to_stage_id, changed_by_user_id,
timestamp) in the same transaction as the `leads.pipeline_stage_id`
update — this is the "every status change timestamped" requirement, proven
append-only and non-optional rather than the ordering itself.

## Disposition auto-classification (`voice_gateway/crm/dispositions.py`)

A small, deterministic, rule-based classifier — `classify_disposition(signals,
available_dispositions)` — takes a `CallOutcomeSignals` dataclass:

- `telephony_status`: `answered | no_answer | busy | failed`
- `duration_seconds`: int
- `had_transcript`: bool (STT ever produced a final transcript)
- `tool_signals`: set of tool-call names/flags the LLM's turn produced
  during the call (e.g. `"not_interested"`, `"schedule_callback"`,
  `"request_dnd"`, `"transfer_to_human"`)
- `wrong_number_flag`: bool (LLM/caller explicitly said this is the wrong
  person)

Ruleset (first matching rule wins, evaluated in this order):
1. `telephony_status != "answered"` → maps directly (`no_answer` → `no_answer`,
   `busy` → `busy`, `failed` → `failed`).
2. `wrong_number_flag` → `wrong_number`.
3. `"request_dnd" in tool_signals` → `dnd_request`.
4. `"transfer_to_human" in tool_signals` → `transferred`.
5. `"schedule_callback" in tool_signals` → `callback`.
6. `"site_visit_booked" in tool_signals` (or any vertical's equivalent
   "booked/scheduled" tool signal, named generically) → `site_visit`
   (kept as the category `qualification`, not a real-estate-only branch —
   a diagnostics tenant's booked-checkup call produces the exact same
   disposition key if its `dispositions` table defines one under that key;
   the classifier only ever looks up keys, never hardcodes what they mean).
7. `"qualified" in tool_signals` → `qualified`.
8. `"not_interested" in tool_signals` → `not_interested`.
9. `had_transcript and duration_seconds > 0` → `connected`.
10. Otherwise → `failed` (a real call attempt that produced no signal at
    all — visible for review rather than silently defaulted to something
    that looks like a normal outcome).

Every returned key is looked up against the tenant's actual
`available_dispositions` (its configured rows, from whichever template it
picked); if the tenant's set doesn't include a rule's key (e.g. a tenant
removed `dnd_request`), the classifier falls back to the closest available
category, and if nothing matches at all, to whichever disposition is
marked `category = "failed"`, or `None` if even that's missing (never a
raised exception — a call must always be storable even with unusual tenant
config).

This is intentionally simple (per the task's own scoping — "the spec
doesn't demand ML here"); it is a pure function over pre-computed signals,
independently testable without a live call.

## Lead scoring: HOT / WARM / COLD (`voice_gateway/crm/scoring.py`)

`score_lead(criteria, satisfied_criterion_keys)` sums the `weight` of every
`lead_scoring_criteria` row whose `criterion_key` is present in
`satisfied_criterion_keys` (the set of criteria the call summary / LLM
determined were met — e.g. "budget confirmed", "timeline < 3 months",
"cart value above threshold" — all tenant-defined, never hardcoded), then
bands the resulting integer:

- `score >= 0.66 * max_possible_score` → `HOT`
- `score >= 0.33 * max_possible_score` → `WARM`
- otherwise → `COLD`

`max_possible_score` is the sum of weights of every *active*
(`is_active = true`) criterion for that org/agent, so the thresholds stay
proportional regardless of how many criteria a given tenant configured —
a tenant with 3 criteria and a tenant with 12 both get a meaningful
HOT/WARM/COLD split rather than one tenant's absolute score being
incomparable to another's. If a tenant has configured zero active
criteria, a documented default ruleset applies instead: `score_band =
WARM` (never silently COLD or HOT — an unconfigured tenant isn't asserted
to be either a bad or a great lead by default) with a `used_default =
true` flag surfaced in the result. This is the "sensible default ruleset"
required by the task and is fully swappable: replacing this module with a
different scoring function is the entire migration path (no schema
change needed) to a tenant-pluggable scoring model later, if ever needed.

## Call summary generation (`voice_gateway/crm/summary.py`)

Mirrors `voice_gateway/knowledge/grounding.py`'s pattern exactly:
`build_summary_prompt(persona_prompt, transcript_messages)` is a pure,
testable prompt-construction function (returns a `str` system prompt plus
the transcript as the user content) — the actual LLM call is made by
whatever holds a call's `LLMProvider` (obtained from the same Phase 3
Provider Registry, no new adapter). The prompt instructs the LLM to
return ONLY a JSON object matching the `call_summaries` column shape
(requirement, budget, location, product_type, intent, objections[],
next_action, follow_up_date, lead_score, recommended_action).

`parse_summary_response(raw_text)` is the paired, independently-testable
parser:
- attempts `json.loads` on the raw text (stripping a ```json fence if the
  model wrapped it, since that's a common real-world LLM quirk even in
  "JSON mode");
- validates every expected key is present and of a plausible type;
- on ANY parse/validation failure, or a response missing more than a
  couple of fields, returns a `ParsedCallSummary` with `needs_review=True`
  and whatever partial fields WERE recoverable populated (never raises,
  never silently drops the whole summary) — `raw_llm_output` is kept
  verbatim on the row precisely so a human can review and fix it, per the
  task's "flags for review rather than silently dropping data" requirement.

## Human handoff (`voice_gateway/crm/handoff.py`)

`TRANSFER_TO_HUMAN_TOOL` is a new `ToolDefinition` (`transferToHuman`)
wired into the orchestrator's existing generic tool-dispatch path from
Phase 3 (`ConversationOrchestrator.tool_dispatcher` / `.tools` — no
orchestrator code changed, since that path already accepts any tool set a
caller wires up). Its handler, `handle_transfer_to_human`, is called with
the tool call's arguments (`reason`, `transfer_type`) plus the call's
already-known `org_id`/`call_id`/`lead_id` and the latest `call_summaries`
row (if one exists yet) or in-call-so-far signals, and:
1. builds the `handoff_payload` snapshot (name, requirement, budget,
   location, summary text, lead score, product/property discussed,
   objections) exactly per the master spec's list;
2. inserts one `handoff_requests` row, `status = 'pending'`.

Trigger detection is intentionally simple and LLM-tool-call-driven, not a
separate NLU classifier: the agent's own system prompt (tenant-configured,
per `docs/PROMPT_TO_AGENT_BUILDER.md`) instructs it to call
`transferToHuman` when the caller explicitly asks for a human, and the
orchestrator/business layer additionally calls it automatically once a
call's live `lead_score_at_call` crosses that tenant's HOT threshold (see
scoring.py above) — both paths converge on the same handler and the same
row shape.

**Deferred to Phase 6+ (explicitly out of scope here):** actually ringing,
messaging, or notifying a human salesperson (SMS/WhatsApp/app push/live
call transfer) — this phase's testable deliverable stops at a correctly
populated `handoff_requests` row with `status='pending'`. Real-time
notification delivery depends on the WhatsApp/notifications
infrastructure the master spec places in Phase 6, which does not exist
yet in this codebase.
