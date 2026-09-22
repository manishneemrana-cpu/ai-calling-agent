"""Structured-output parser for the Prompt-to-Agent Builder's one LLM call
— same robustness discipline as `voice_gateway/crm/summary.py`'s
`parse_summary_response` (docs/CRM_LOGIC.md): NEVER raises. Malformed or
incomplete LLM output is flagged for review (`needs_review=True`) with
whatever partial fields WERE recoverable still populated, and the raw text
preserved verbatim for a human to inspect/fix — never silently dropped.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Any

_CODE_FENCE_RE = re.compile(r"^\s*```(?:json)?\s*(.*?)\s*```\s*$", re.DOTALL)

_WEIGHT_HINTS = ("high", "medium", "low")
_CONFIDENCE_LEVELS = ("high", "medium", "low")


@dataclass
class QualificationQuestion:
    question: str
    purpose: str | None = None
    maps_to_field: str | None = None


@dataclass
class ObjectionHandling:
    objection: str
    response_stub: str | None = None


@dataclass
class ToolNeeded:
    tool_name: str
    description: str | None = None
    example_use: str | None = None


@dataclass
class SeedFaq:
    question: str
    answer_stub: str | None = None


@dataclass
class ScoringCriterionSuggestion:
    criterion: str
    weight_hint: str | None = None


@dataclass
class AgentPersona:
    name: str | None = None
    tone: str | None = None
    language_style: str | None = None


@dataclass
class GeneratedAgentConfig:
    """The parsed result of one meta-prompt call. `clarification_needed`
    short-circuits everything else — see docs/PROMPT_TO_AGENT_BUILDER.md
    §3's "Notes"."""

    clarification_needed: bool = False
    clarification_questions: list[str] = field(default_factory=list)

    inferred_vertical: str | None = None
    inferred_vertical_confidence: str | None = None
    agent_persona: AgentPersona | None = None
    greeting_script: str | None = None
    qualification_questions: list[QualificationQuestion] = field(default_factory=list)
    objection_handling: list[ObjectionHandling] = field(default_factory=list)
    tools_needed: list[ToolNeeded] = field(default_factory=list)
    knowledge_base_suggested_categories: list[str] = field(default_factory=list)
    knowledge_base_seed_faqs: list[SeedFaq] = field(default_factory=list)
    suggested_pipeline_stages: list[str] = field(default_factory=list)
    suggested_dispositions: list[str] = field(default_factory=list)
    suggested_lead_scoring_criteria: list[ScoringCriterionSuggestion] = field(default_factory=list)
    compliance_flags: list[str] = field(default_factory=list)

    needs_review: bool = False
    raw_llm_output: str | None = None


def _strip_code_fence(text: str) -> str:
    match = _CODE_FENCE_RE.match(text)
    return match.group(1) if match else text


def _get_str(data: dict[str, Any], key: str) -> str | None:
    value = data.get(key)
    return value if isinstance(value, str) and value.strip() else None


def _get_str_enum(data: dict[str, Any], key: str, allowed: tuple[str, ...]) -> str | None:
    value = _get_str(data, key)
    return value if value in allowed else None


def _get_list_str(data: dict[str, Any], key: str) -> list[str]:
    value = data.get(key)
    if isinstance(value, list):
        return [str(v) for v in value if isinstance(v, (str, int, float)) and str(v).strip()]
    return []


def _get_list_dict(data: dict[str, Any], key: str) -> list[dict[str, Any]]:
    value = data.get(key)
    if isinstance(value, list):
        return [v for v in value if isinstance(v, dict)]
    return []


def parse_generation_response(raw_text: str) -> GeneratedAgentConfig:
    """Parses the meta-prompt's structured-output response. Never raises —
    see module docstring."""
    cleaned = _strip_code_fence(raw_text or "")

    try:
        data = json.loads(cleaned)
    except (json.JSONDecodeError, TypeError):
        return GeneratedAgentConfig(needs_review=True, raw_llm_output=raw_text)

    if not isinstance(data, dict):
        return GeneratedAgentConfig(needs_review=True, raw_llm_output=raw_text)

    clarification_needed = bool(data.get("clarification_needed", False))

    if clarification_needed:
        questions = _get_list_str(data, "clarification_questions")
        # A clarification turn with no actual questions is itself
        # malformed — flag it, but still surface `clarification_needed`
        # (never silently downgrade to a full-generation attempt with
        # empty data).
        needs_review = len(questions) == 0
        return GeneratedAgentConfig(
            clarification_needed=True,
            clarification_questions=questions[:3],
            needs_review=needs_review,
            raw_llm_output=raw_text if needs_review else None,
        )

    # Full-generation branch.
    persona_data = data.get("agent_persona")
    agent_persona = (
        AgentPersona(
            name=_get_str(persona_data, "name"),
            tone=_get_str(persona_data, "tone"),
            language_style=_get_str(persona_data, "language_style"),
        )
        if isinstance(persona_data, dict)
        else None
    )

    qualification_questions = [
        QualificationQuestion(
            question=_get_str(q, "question") or "",
            purpose=_get_str(q, "purpose"),
            maps_to_field=_get_str(q, "maps_to_field"),
        )
        for q in _get_list_dict(data, "qualification_questions")
    ]
    qualification_questions = [q for q in qualification_questions if q.question]

    objection_handling = [
        ObjectionHandling(
            objection=_get_str(o, "objection") or "",
            response_stub=_get_str(o, "response_stub"),
        )
        for o in _get_list_dict(data, "objection_handling")
    ]
    objection_handling = [o for o in objection_handling if o.objection]

    tools_needed = [
        ToolNeeded(
            tool_name=_get_str(t, "tool_name") or "",
            description=_get_str(t, "description"),
            example_use=_get_str(t, "example_use"),
        )
        for t in _get_list_dict(data, "tools_needed")
    ]
    tools_needed = [t for t in tools_needed if t.tool_name]

    kb = data.get("knowledge_base_scaffold")
    kb_categories = _get_list_str(kb, "suggested_categories") if isinstance(kb, dict) else []
    kb_faqs_raw = kb.get("seed_faqs") if isinstance(kb, dict) else None
    kb_faqs = (
        [
            SeedFaq(question=_get_str(f, "question") or "", answer_stub=_get_str(f, "answer_stub"))
            for f in kb_faqs_raw
            if isinstance(f, dict)
        ]
        if isinstance(kb_faqs_raw, list)
        else []
    )
    kb_faqs = [f for f in kb_faqs if f.question]

    scoring_criteria = [
        ScoringCriterionSuggestion(
            criterion=_get_str(c, "criterion") or "",
            weight_hint=_get_str_enum(c, "weight_hint", _WEIGHT_HINTS),
        )
        for c in _get_list_dict(data, "suggested_lead_scoring_criteria")
    ]
    scoring_criteria = [c for c in scoring_criteria if c.criterion]

    greeting_script = _get_str(data, "greeting_script")
    suggested_pipeline_stages = _get_list_str(data, "suggested_pipeline_stages")
    suggested_dispositions = _get_list_str(data, "suggested_dispositions")

    # A full-generation response is "needs review" if any of the fields
    # that make it actually usable are missing/empty — mirrors
    # parse_summary_response's "any required key missing" rule, adapted to
    # this schema's nested shape. Partial data is still returned (never
    # dropped), per the flag-for-review requirement.
    required_present = (
        greeting_script is not None
        and agent_persona is not None
        and len(qualification_questions) > 0
        and len(suggested_pipeline_stages) > 0
        and len(suggested_dispositions) > 0
    )
    needs_review = not required_present

    return GeneratedAgentConfig(
        clarification_needed=False,
        inferred_vertical=_get_str(data, "inferred_vertical"),
        inferred_vertical_confidence=_get_str_enum(data, "inferred_vertical_confidence", _CONFIDENCE_LEVELS),
        agent_persona=agent_persona,
        greeting_script=greeting_script,
        qualification_questions=qualification_questions,
        objection_handling=objection_handling,
        tools_needed=tools_needed,
        knowledge_base_suggested_categories=kb_categories,
        knowledge_base_seed_faqs=kb_faqs,
        suggested_pipeline_stages=suggested_pipeline_stages,
        suggested_dispositions=suggested_dispositions,
        suggested_lead_scoring_criteria=scoring_criteria,
        compliance_flags=_get_list_str(data, "compliance_flags"),
        needs_review=needs_review,
        raw_llm_output=raw_text if needs_review else None,
    )
