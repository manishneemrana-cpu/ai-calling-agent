from __future__ import annotations

import pytest

from voice_gateway.agent_builder.generator import InvalidDescriptionError, generate_agent_config
from voice_gateway.agent_builder.meta_prompt import MAX_DESCRIPTION_LENGTH
from voice_gateway.llm.types import LLMStreamEvent

from .fixtures import CLARIFICATION_RESPONSE, REAL_ESTATE_RESPONSE, raw

pytestmark = pytest.mark.asyncio


class FakeLLMProvider:
    """A minimal LLMProvider stand-in (same shape/role as MockLLMProvider)
    that streams a canned JSON response word-chunked, so generator.py's
    `_collect_full_text` incremental-assembly path is exercised, not just a
    single-event happy path."""

    provider_key = "fake"

    def __init__(self, reply_text: str):
        self._reply_text = reply_text
        self.received_messages = None

    async def stream_chat(self, messages, tools=None):
        self.received_messages = messages
        # Chunk into a few pieces to prove concatenation works.
        mid = len(self._reply_text) // 2
        yield LLMStreamEvent(type="text_delta", text_delta=self._reply_text[:mid])
        yield LLMStreamEvent(type="text_delta", text_delta=self._reply_text[mid:])
        yield LLMStreamEvent(type="done", usage=None)


async def test_generate_agent_config_end_to_end_real_estate():
    llm = FakeLLMProvider(raw(REAL_ESTATE_RESPONSE))
    result = await generate_agent_config(llm, "I'm a real estate broker in Patna...")

    assert result.needs_review is False
    assert result.inferred_vertical == "real_estate"
    assert llm.received_messages[0].role == "system"
    assert "real estate broker" in llm.received_messages[1].content


async def test_generate_agent_config_clarification_branch():
    llm = FakeLLMProvider(raw(CLARIFICATION_RESPONSE))
    result = await generate_agent_config(llm, "I run a clinic and want to call people about my business.")

    assert result.clarification_needed is True
    assert len(result.clarification_questions) == 3


async def test_generate_agent_config_second_call_with_clarification_answers():
    llm = FakeLLMProvider(raw(REAL_ESTATE_RESPONSE))
    result = await generate_agent_config(
        llm,
        "I run a clinic and want to call people about my business.",
        clarification_answers="It's a dental clinic focused on bookings.",
    )
    assert result.needs_review is False
    assert "dental clinic" in llm.received_messages[1].content


async def test_generate_agent_config_never_raises_on_malformed_llm_output():
    llm = FakeLLMProvider("not json at all {{{")
    result = await generate_agent_config(llm, "I sell sarees online.")
    assert result.needs_review is True
    assert result.raw_llm_output == "not json at all {{{"


async def test_generate_agent_config_rejects_empty_description():
    llm = FakeLLMProvider(raw(REAL_ESTATE_RESPONSE))
    with pytest.raises(InvalidDescriptionError):
        await generate_agent_config(llm, "   ")


async def test_generate_agent_config_rejects_oversized_description():
    llm = FakeLLMProvider(raw(REAL_ESTATE_RESPONSE))
    with pytest.raises(InvalidDescriptionError):
        await generate_agent_config(llm, "x" * (MAX_DESCRIPTION_LENGTH + 1))
