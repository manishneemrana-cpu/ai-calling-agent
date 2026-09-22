"""The internal, service-to-service endpoint apps/web calls to run one
Prompt-to-Agent Builder generation — see docs/PROMPT_TO_AGENT_BUILDER.md's
"Implementation (gap-closing pass)" addendum and
`apps/web/lib/voice-gateway/client.ts`'s `generateAgentConfig()`. Same
call-direction and DI shape as
`voice_gateway/media_stream/internal_api.py`'s
`handle_start_pipeline_request` (which this module's route is wired
alongside — see that module's `serve()`).

`handle_generate_request()` is deliberately a plain, framework-agnostic
async function (directly unit-testable, no HTTP listener needed) — exactly
what `tests/agent_builder/test_api.py` does, injecting a fake
`get_provider` so no live LLM key or registry DB row is needed to test the
request-shape validation.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import asdict
from typing import Any

from .. import registry
from .generator import InvalidDescriptionError, generate_agent_config

GetProviderFn = Callable[..., Awaitable[Any]]


class GenerateAgentConfigRequestError(Exception):
    """Raised for a malformed request body or an input-bounding failure —
    the caller (the raw-socket `serve()` wrapper, or a test) turns this
    into a 400 response, same convention as
    `internal_api.StartPipelineRequestError`."""


async def handle_generate_request(
    body: dict[str, Any],
    get_provider: GetProviderFn = registry.get_provider,
) -> dict[str, Any]:
    """Body shape (matches `apps/web/lib/voice-gateway/client.ts`'s
    `generateAgentConfig()` POST body exactly):
    `{"orgId": str, "userId": str | None, "description": str,
    "clarificationAnswers": str | None}`.

    Resolves the org's configured LLM provider via the Phase 3 Provider
    Registry (`get_provider("llm", org_id, user_id)` — tenant-overridable,
    same as every other layer; no hardcoded model choice here), runs the
    one meta-prompt call, and returns the parsed result as a plain dict
    (JSON-serializable) — `clarification_needed` tells the caller which
    shape it got, exactly per docs/PROMPT_TO_AGENT_BUILDER.md §2/§3.
    """
    org_id = body.get("orgId")
    if not org_id:
        raise GenerateAgentConfigRequestError("Missing required field: orgId")

    description = body.get("description")
    if not isinstance(description, str) or not description.strip():
        raise GenerateAgentConfigRequestError("Missing required field: description")

    clarification_answers = body.get("clarificationAnswers")
    if clarification_answers is not None and not isinstance(clarification_answers, str):
        raise GenerateAgentConfigRequestError("clarificationAnswers must be a string when provided")

    try:
        llm = await get_provider("llm", org_id, body.get("userId"))
        result = await generate_agent_config(llm, description, clarification_answers)
    except InvalidDescriptionError as err:
        raise GenerateAgentConfigRequestError(str(err)) from err

    return asdict(result)
