"""Post-call structured summary generation. Mirrors
voice_gateway/knowledge/grounding.py's pattern: a pure, testable
prompt-construction function plus a paired, independently-testable parser
for the LLM's structured output — the actual `LLMProvider.stream_chat()`
call is made by whatever holds a call's provider (Phase 3 Provider
Registry; no new adapter needed here), never inside this module, so
neither function needs network access or a live key to test.

See docs/CRM_LOGIC.md "Call summary generation" for the documented
behavior, including the malformed-response handling.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field

from ..llm.types import Message

SUMMARY_SYSTEM_PROMPT = (
    "You are a call-summarization assistant for a business voice-calling "
    "platform. You will be given a full call transcript between an AI "
    "voice agent and a caller. Read it and return ONLY a single JSON "
    "object (no prose, no markdown fence) with exactly these keys:\n"
    "{\n"
    '  "requirement": "string — what the caller needs/wants, or null",\n'
    '  "budget": "string — budget/value mentioned, or null",\n'
    '  "location": "string — location, if relevant to this business, or null",\n'
    '  "product_type": "string — product/service/property type discussed, or null",\n'
    '  "intent": "string — the caller\'s overall intent, or null",\n'
    '  "objections": ["array of strings — objections the caller raised"],\n'
    '  "next_action": "string — recommended next action, or null",\n'
    '  "follow_up_date": "string — an ISO date (YYYY-MM-DD) if one was agreed, or null",\n'
    '  "lead_score": "integer 0-100 — your own estimate of lead quality, or null",\n'
    '  "recommended_action": "string — a one-line recommendation for the sales team, or null"\n'
    "}\n"
    "Never invent facts not present in the transcript. If a field genuinely "
    "cannot be determined, use null (or [] for objections) rather than "
    "guessing."
)

REQUIRED_KEYS = (
    "requirement",
    "budget",
    "location",
    "product_type",
    "intent",
    "objections",
    "next_action",
    "follow_up_date",
    "lead_score",
    "recommended_action",
)


def build_summary_messages(transcript_messages: list[Message]) -> list[Message]:
    """Builds the message list for the summary-generation LLM call: the
    fixed system prompt above, followed by the call's transcript rendered
    as a single user message (role-prefixed lines) so any LLMProvider
    (which only understands system/user/assistant/tool Messages) can
    consume it without a bespoke "transcript" concept."""
    transcript_text = "\n".join(f"{m.role}: {m.content}" for m in transcript_messages if m.content)
    return [
        Message(role="system", content=SUMMARY_SYSTEM_PROMPT),
        Message(role="user", content=f"Transcript:\n{transcript_text}"),
    ]


@dataclass
class ParsedCallSummary:
    requirement: str | None = None
    budget: str | None = None
    location: str | None = None
    product_type: str | None = None
    intent: str | None = None
    objections: list[str] = field(default_factory=list)
    next_action: str | None = None
    follow_up_date: str | None = None
    lead_score: int | None = None
    recommended_action: str | None = None
    needs_review: bool = False
    raw_llm_output: str | None = None


def _strip_code_fence(text: str) -> str:
    match = re.match(r"^\s*```(?:json)?\s*(.*?)\s*```\s*$", text, re.DOTALL)
    return match.group(1) if match else text


def parse_summary_response(raw_text: str) -> ParsedCallSummary:
    """Parses the LLM's structured-output response into a
    `ParsedCallSummary`. NEVER raises: any parse/validation failure returns
    a summary with `needs_review=True`, `raw_llm_output` set to the
    original text, and every field that WAS recoverable still populated —
    per the task's "flags for review rather than silently dropping data"
    requirement."""
    cleaned = _strip_code_fence(raw_text or "")

    try:
        data = json.loads(cleaned)
    except (json.JSONDecodeError, TypeError):
        return ParsedCallSummary(needs_review=True, raw_llm_output=raw_text)

    if not isinstance(data, dict):
        return ParsedCallSummary(needs_review=True, raw_llm_output=raw_text)

    needs_review = any(key not in data for key in REQUIRED_KEYS)

    def _get_str(key: str) -> str | None:
        value = data.get(key)
        return value if isinstance(value, str) and value.strip() else None

    def _get_list_str(key: str) -> list[str]:
        value = data.get(key)
        if isinstance(value, list):
            return [str(v) for v in value if isinstance(v, (str, int, float))]
        return []

    def _get_int(key: str) -> int | None:
        value = data.get(key)
        if isinstance(value, bool):
            return None
        if isinstance(value, int):
            return value
        if isinstance(value, str) and value.strip().isdigit():
            return int(value.strip())
        return None

    lead_score = _get_int("lead_score")
    if lead_score is not None and not (0 <= lead_score <= 100):
        # Out-of-range score is itself a sign the response was malformed —
        # clamp it into range but flag for review rather than storing a
        # nonsensical value silently.
        lead_score = max(0, min(100, lead_score))
        needs_review = True

    return ParsedCallSummary(
        requirement=_get_str("requirement"),
        budget=_get_str("budget"),
        location=_get_str("location"),
        product_type=_get_str("product_type"),
        intent=_get_str("intent"),
        objections=_get_list_str("objections"),
        next_action=_get_str("next_action"),
        follow_up_date=_get_str("follow_up_date"),
        lead_score=lead_score,
        recommended_action=_get_str("recommended_action"),
        needs_review=needs_review,
        raw_llm_output=raw_text if needs_review else None,
    )
