"""Runs the Prompt-to-Agent Builder's one meta-prompt LLM call end-to-end:
builds the messages (`meta_prompt.py`), drives an `LLMProvider` obtained
from the Phase 3 Provider Registry (never a new/bespoke LLM integration),
collects its streamed reply into one string, and parses it
(`parser.py`). Mirrors the "prompt construction / LLM call / parsing" split
`voice_gateway/crm/summary.py` documents, but this module additionally owns
the "make the call" step, since (unlike call-summary generation, which
piggybacks on a call already in flight) there is no other natural owner for
a builder-initiated, on-demand generation request.
"""

from __future__ import annotations

from ..llm.types import LLMProvider, Message
from .meta_prompt import (
    MAX_CLARIFICATION_ANSWER_LENGTH,
    MAX_DESCRIPTION_LENGTH,
    build_generation_messages,
)
from .parser import GeneratedAgentConfig, parse_generation_response


class InvalidDescriptionError(ValueError):
    """Raised for a business description (or clarification-answer text)
    that fails basic input-bounding — see module docstring in
    meta_prompt.py's "Input-safety note". The caller (the internal API
    handler / apps/web's API route) turns this into a 400."""


def _validate_length(value: str, max_len: int, field_name: str) -> None:
    if not value or not value.strip():
        raise InvalidDescriptionError(f"{field_name} must not be empty")
    if len(value) > max_len:
        raise InvalidDescriptionError(f"{field_name} exceeds the maximum length of {max_len} characters")


async def _collect_full_text(llm: LLMProvider, messages: list[Message]) -> str:
    """Drains an LLMProvider.stream_chat() call (no tools — this is a
    plain structured-JSON-in-text generation, not a tool-calling turn) into
    one concatenated string. Any tool_call events are ignored (the builder
    never wires tools for its own generation call)."""
    parts: list[str] = []
    async for event in llm.stream_chat(messages, tools=None):
        if event.type == "text_delta" and event.text_delta:
            parts.append(event.text_delta)
    return "".join(parts)


async def generate_agent_config(
    llm: LLMProvider,
    description: str,
    clarification_answers: str | None = None,
) -> GeneratedAgentConfig:
    """The single entry point: validates input length, builds the one
    meta-prompt call, runs it against the given `llm` (resolved by the
    caller via `voice_gateway.registry.get_provider("llm", org_id,
    user_id)` — a tenant-overridable choice, same as every other provider
    layer), and returns the parsed, never-raising result.

    Raises `InvalidDescriptionError` ONLY for the input-bounding check
    (a 400-shaped caller error, distinct from anything the LLM itself
    returns) — everything about the LLM's own response, malformed or not,
    is handled by `parse_generation_response` and surfaced via
    `needs_review`, never an exception.
    """
    _validate_length(description, MAX_DESCRIPTION_LENGTH, "description")
    if clarification_answers is not None and clarification_answers.strip():
        _validate_length(clarification_answers, MAX_CLARIFICATION_ANSWER_LENGTH, "clarification_answers")

    messages = build_generation_messages(description, clarification_answers)
    raw_text = await _collect_full_text(llm, messages)
    return parse_generation_response(raw_text)
