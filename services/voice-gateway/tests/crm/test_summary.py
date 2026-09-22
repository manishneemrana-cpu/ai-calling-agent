from __future__ import annotations

import json

from voice_gateway.crm.summary import (
    SUMMARY_SYSTEM_PROMPT,
    build_summary_messages,
    parse_summary_response,
)
from voice_gateway.llm.types import Message

WELL_FORMED_RESPONSE = {
    "requirement": "Looking for a 2BHK flat",
    "budget": "50-60 lakh",
    "location": "Patna, Boring Road",
    "product_type": "2BHK flat",
    "intent": "purchase",
    "objections": ["price too high"],
    "next_action": "send comparable options",
    "follow_up_date": "2026-10-01",
    "lead_score": 78,
    "recommended_action": "prioritize for site visit",
}


def test_build_summary_messages_includes_system_prompt_and_transcript():
    transcript = [
        Message(role="user", content="I want a 2BHK flat"),
        Message(role="assistant", content="Sure, what's your budget?"),
    ]
    messages = build_summary_messages(transcript)

    assert messages[0].role == "system"
    assert messages[0].content == SUMMARY_SYSTEM_PROMPT
    assert messages[1].role == "user"
    assert "user: I want a 2BHK flat" in messages[1].content
    assert "assistant: Sure, what's your budget?" in messages[1].content


def test_build_summary_messages_skips_empty_content():
    transcript = [Message(role="tool", content=""), Message(role="user", content="hello")]
    messages = build_summary_messages(transcript)
    assert "tool:" not in messages[1].content
    assert "user: hello" in messages[1].content


def test_parse_well_formed_json_response():
    raw = json.dumps(WELL_FORMED_RESPONSE)
    parsed = parse_summary_response(raw)

    assert parsed.needs_review is False
    assert parsed.requirement == "Looking for a 2BHK flat"
    assert parsed.budget == "50-60 lakh"
    assert parsed.location == "Patna, Boring Road"
    assert parsed.product_type == "2BHK flat"
    assert parsed.intent == "purchase"
    assert parsed.objections == ["price too high"]
    assert parsed.next_action == "send comparable options"
    assert parsed.follow_up_date == "2026-10-01"
    assert parsed.lead_score == 78
    assert parsed.recommended_action == "prioritize for site visit"
    assert parsed.raw_llm_output is None


def test_parse_strips_markdown_code_fence():
    raw = "```json\n" + json.dumps(WELL_FORMED_RESPONSE) + "\n```"
    parsed = parse_summary_response(raw)
    assert parsed.needs_review is False
    assert parsed.requirement == "Looking for a 2BHK flat"


def test_parse_malformed_json_flags_for_review_without_crashing():
    parsed = parse_summary_response("this is not json at all {{{")
    assert parsed.needs_review is True
    assert parsed.raw_llm_output == "this is not json at all {{{"
    assert parsed.requirement is None
    assert parsed.objections == []


def test_parse_partial_response_flags_for_review_but_keeps_recoverable_fields():
    partial = {"requirement": "wants a checkup package", "objections": ["too expensive"]}
    raw = json.dumps(partial)
    parsed = parse_summary_response(raw)

    assert parsed.needs_review is True
    assert parsed.requirement == "wants a checkup package"
    assert parsed.objections == ["too expensive"]
    assert parsed.raw_llm_output == raw
    assert parsed.budget is None
    assert parsed.lead_score is None


def test_parse_non_object_json_flags_for_review():
    parsed = parse_summary_response(json.dumps(["not", "an", "object"]))
    assert parsed.needs_review is True


def test_parse_out_of_range_lead_score_is_clamped_and_flagged():
    payload = dict(WELL_FORMED_RESPONSE)
    payload["lead_score"] = 500
    parsed = parse_summary_response(json.dumps(payload))
    assert parsed.needs_review is True
    assert parsed.lead_score == 100


def test_parse_empty_string_flags_for_review():
    parsed = parse_summary_response("")
    assert parsed.needs_review is True
