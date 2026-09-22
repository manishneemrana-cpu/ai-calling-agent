"""Prompt-to-Agent Builder (gap-closing pass — was designed in
docs/PROMPT_TO_AGENT_BUILDER.md since Phase 0, never implemented in code
through Phase 1-10). See that doc for the full design and
docs/PROMPT_TO_AGENT_BUILDER.md's "Implementation (gap-closing pass)"
addendum for why this lives here (services/voice-gateway) rather than
apps/web.

Owns exactly the one-LLM-call meta-prompt + structured-output parsing
(`meta_prompt.py`, `parser.py`, `generator.py`) — consuming the EXISTING
Phase 3 LLM Provider Registry (`voice_gateway.registry.get_provider`), no
new LLM integration. It does NOT write to any apps/web-owned table itself;
`apps/web`'s `/api/agents/generate-from-prompt` route calls this service's
`/internal/agent-builder/generate` endpoint (same call-direction and DI
pattern as `notifyCallAnswered()` / `/internal/pipelines/{id}/start` from
Phase 3.5/4's audio bridge) and then commits the result into
`agent_prompts`/`pipeline_stages`/`dispositions`/`lead_scoring_criteria`
itself, reusing Phase 5's existing `instantiate*FromSuggestions` functions.
"""
