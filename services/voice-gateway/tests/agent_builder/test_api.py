from __future__ import annotations

import pytest

from voice_gateway.agent_builder.api import GenerateAgentConfigRequestError, handle_generate_request
from voice_gateway.llm.types import LLMStreamEvent

from .fixtures import REAL_ESTATE_RESPONSE, raw

pytestmark = pytest.mark.asyncio


class _FakeLLM:
    provider_key = "fake"

    def __init__(self, text: str):
        self._text = text

    async def stream_chat(self, messages, tools=None):
        yield LLMStreamEvent(type="text_delta", text_delta=self._text)
        yield LLMStreamEvent(type="done", usage=None)


async def _fake_get_provider(layer, org_id, user_id):
    assert layer == "llm"
    assert org_id == "org-123"
    return _FakeLLM(raw(REAL_ESTATE_RESPONSE))


async def test_handle_generate_request_happy_path():
    body = {"orgId": "org-123", "userId": "user-1", "description": "I'm a real estate broker..."}
    result = await handle_generate_request(body, get_provider=_fake_get_provider)
    assert result["needs_review"] is False
    assert result["inferred_vertical"] == "real_estate"


async def test_handle_generate_request_missing_org_id():
    with pytest.raises(GenerateAgentConfigRequestError):
        await handle_generate_request({"description": "x"}, get_provider=_fake_get_provider)


async def test_handle_generate_request_missing_description():
    with pytest.raises(GenerateAgentConfigRequestError):
        await handle_generate_request({"orgId": "org-123"}, get_provider=_fake_get_provider)


async def test_handle_generate_request_rejects_oversized_description():
    with pytest.raises(GenerateAgentConfigRequestError):
        await handle_generate_request(
            {"orgId": "org-123", "description": "x" * 10000}, get_provider=_fake_get_provider
        )


async def test_handle_generate_request_rejects_non_string_clarification_answers():
    with pytest.raises(GenerateAgentConfigRequestError):
        await handle_generate_request(
            {"orgId": "org-123", "description": "x", "clarificationAnswers": 123},
            get_provider=_fake_get_provider,
        )
