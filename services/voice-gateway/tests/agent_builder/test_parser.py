from __future__ import annotations

from voice_gateway.agent_builder.parser import parse_generation_response

from .fixtures import (
    CLARIFICATION_RESPONSE,
    DIAGNOSTICS_RESPONSE,
    ECOMMERCE_D2C_RESPONSE,
    MALFORMED_RESPONSE_TEXT,
    REAL_ESTATE_RESPONSE,
    raw,
)


def test_real_estate_worked_example_parses_fully():
    parsed = parse_generation_response(raw(REAL_ESTATE_RESPONSE))

    assert parsed.needs_review is False
    assert parsed.clarification_needed is False
    assert parsed.inferred_vertical == "real_estate"
    assert parsed.inferred_vertical_confidence == "high"
    assert parsed.agent_persona is not None
    assert parsed.agent_persona.name == "Priya"
    assert "Namaste" in parsed.greeting_script
    assert len(parsed.qualification_questions) == 5
    assert parsed.qualification_questions[0].maps_to_field == "budget"
    assert any(o.objection == "price too high" for o in parsed.objection_handling)
    tool_names = [t.tool_name for t in parsed.tools_needed]
    assert "check_availability" in tool_names
    assert "book_appointment" in tool_names
    assert "check_eligibility" in tool_names
    assert parsed.suggested_pipeline_stages == [
        "New", "Contacted", "Qualified", "Site Visit Booked", "Negotiation", "Won", "Lost",
    ]
    assert "Interested-Hot" in parsed.suggested_dispositions
    criteria = {c.criterion: c.weight_hint for c in parsed.suggested_lead_scoring_criteria}
    assert criteria["budget confirmed"] == "high"
    assert criteria["financing pre-approved"] == "medium"
    assert parsed.raw_llm_output is None


def test_diagnostics_worked_example_parses_fully_and_carries_compliance_flags():
    parsed = parse_generation_response(raw(DIAGNOSTICS_RESPONSE))

    assert parsed.needs_review is False
    assert parsed.inferred_vertical == "healthcare_diagnostics"
    assert parsed.agent_persona.name == "Anaya"
    tool_names = [t.tool_name for t in parsed.tools_needed]
    assert "escalate_to_human" in tool_names
    assert len(parsed.compliance_flags) == 2
    assert any("diagnosis" in flag for flag in parsed.compliance_flags)
    assert parsed.suggested_pipeline_stages[0] == "Report Ready"


def test_ecommerce_d2c_worked_example_parses_fully():
    parsed = parse_generation_response(raw(ECOMMERCE_D2C_RESPONSE))

    assert parsed.needs_review is False
    assert parsed.inferred_vertical == "ecommerce_d2c"
    assert parsed.agent_persona.name == "Meera"
    tool_names = [t.tool_name for t in parsed.tools_needed]
    assert "apply_discount_code" in tool_names
    assert "Cart Abandoned" in parsed.suggested_pipeline_stages
    assert "Purchased After Call" in parsed.suggested_dispositions
    criteria = {c.criterion: c.weight_hint for c in parsed.suggested_lead_scoring_criteria}
    assert criteria["cart value above threshold"] == "high"


def test_clarification_branch_triggers_on_a_vague_description_response():
    parsed = parse_generation_response(raw(CLARIFICATION_RESPONSE))

    assert parsed.clarification_needed is True
    assert parsed.needs_review is False
    assert len(parsed.clarification_questions) == 3
    assert all(isinstance(q, str) and q for q in parsed.clarification_questions)
    # Everything else stays empty/default on a clarification turn — no
    # half-generated config leaks through.
    assert parsed.suggested_pipeline_stages == []
    assert parsed.agent_persona is None


def test_clarification_flag_true_but_no_questions_is_flagged_for_review():
    parsed = parse_generation_response(raw({"clarification_needed": True, "clarification_questions": []}))
    assert parsed.clarification_needed is True
    assert parsed.needs_review is True
    assert parsed.raw_llm_output is not None


def test_malformed_non_json_output_never_crashes_and_flags_for_review():
    parsed = parse_generation_response(MALFORMED_RESPONSE_TEXT)

    assert parsed.needs_review is True
    assert parsed.raw_llm_output == MALFORMED_RESPONSE_TEXT
    assert parsed.suggested_pipeline_stages == []
    assert parsed.agent_persona is None
    assert parsed.clarification_needed is False


def test_markdown_fenced_json_is_still_parsed():
    fenced = "```json\n" + raw(REAL_ESTATE_RESPONSE) + "\n```"
    parsed = parse_generation_response(fenced)
    assert parsed.needs_review is False
    assert parsed.inferred_vertical == "real_estate"


def test_partial_response_missing_required_fields_flags_for_review_but_keeps_partial_data():
    partial = {
        "clarification_needed": False,
        "inferred_vertical": "real_estate",
        "greeting_script": "Namaste...",
        # Missing agent_persona, qualification_questions, pipeline stages, dispositions.
    }
    parsed = parse_generation_response(raw(partial))

    assert parsed.needs_review is True
    assert parsed.inferred_vertical == "real_estate"
    assert parsed.greeting_script == "Namaste..."
    assert parsed.agent_persona is None
    assert parsed.raw_llm_output is not None


def test_non_object_json_is_flagged_for_review():
    parsed = parse_generation_response("[1, 2, 3]")
    assert parsed.needs_review is True


def test_empty_string_is_flagged_for_review():
    parsed = parse_generation_response("")
    assert parsed.needs_review is True


def test_garbage_types_inside_otherwise_valid_json_are_ignored_not_crashed_on():
    payload = dict(REAL_ESTATE_RESPONSE)
    payload["tools_needed"] = "not a list"
    payload["qualification_questions"] = [{"question": 123}, "not a dict"]
    parsed = parse_generation_response(raw(payload))
    # qualification_questions had no usable string `question` -> filtered
    # out -> required_present fails -> needs_review, but nothing crashed.
    assert parsed.tools_needed == []
    assert parsed.qualification_questions == []
    assert parsed.needs_review is True
