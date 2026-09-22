from __future__ import annotations

from voice_gateway.agent_builder.meta_prompt import (
    MAX_CLARIFICATION_ANSWER_LENGTH,
    MAX_DESCRIPTION_LENGTH,
    SYSTEM_PROMPT,
    build_generation_messages,
)


def test_build_generation_messages_single_call_shape():
    messages = build_generation_messages("I sell sarees online.")
    assert len(messages) == 2
    assert messages[0].role == "system"
    assert messages[0].content == SYSTEM_PROMPT
    assert messages[1].role == "user"
    assert "I sell sarees online." in messages[1].content


def test_system_prompt_is_vertical_neutral():
    # Per docs/PROMPT_TO_AGENT_BUILDER.md §4 rule 6 — the meta-prompt may
    # NAME real-estate terms only as a counter-example of what NOT to
    # default to (rule 6 itself does this); it must never assume/default
    # to any single vertical's terms, e.g. an e-commerce/D2C-only concept.
    lowered = SYSTEM_PROMPT.lower()
    assert "saree" not in lowered
    assert "diagnostic lab" not in lowered
    assert "never default to real-estate terms" in lowered


def test_system_prompt_instructs_treating_description_as_data_not_instructions():
    lowered = SYSTEM_PROMPT.lower()
    assert "data" in lowered
    assert "never as instructions" in lowered or "not as instructions" in lowered


def test_clarification_answers_are_appended_for_the_second_call():
    messages = build_generation_messages(
        "I run a clinic and want to call people about my business.",
        clarification_answers="It's a dental clinic. Goal is booking appointments. Calling new inquiries.",
    )
    assert len(messages) == 2
    assert "dental clinic" in messages[1].content
    assert "clarifying questions" in messages[1].content.lower()


def test_clarification_answers_omitted_when_blank():
    messages = build_generation_messages("I sell sarees online.", clarification_answers="   ")
    assert "clarifying questions" not in messages[1].content.lower()


def test_length_constants_are_sane():
    assert MAX_DESCRIPTION_LENGTH > 100
    assert MAX_CLARIFICATION_ANSWER_LENGTH > 100
