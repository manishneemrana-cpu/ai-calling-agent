import json

import pytest

from tests.fakes import FakeHTTPClient, FakeStreamResponse
from voice_gateway.llm.adapters.groq_llama import GroqLlamaLLMProvider
from voice_gateway.llm.types import Message, ToolDefinition


@pytest.mark.asyncio
async def test_groq_llama_streams_text_and_usage():
    lines = [
        f"data: {json.dumps({'choices': [{'delta': {'content': 'Hi'}}]})}",
        f"data: {json.dumps({'choices': [{'delta': {}, 'finish_reason': 'stop'}], 'usage': {'prompt_tokens': 3, 'completion_tokens': 1}})}",
        "data: [DONE]",
    ]
    client = FakeHTTPClient(stream_response=FakeStreamResponse(lines=lines))
    llm = GroqLlamaLLMProvider({"api_key": "fake_key"}, http_client=client)

    events = [e async for e in llm.stream_chat([Message(role="user", content="hi")])]
    text = "".join(e.text_delta for e in events if e.type == "text_delta")
    assert text == "Hi"
    done = events[-1]
    assert done.usage.extra == {"input_tokens": 3, "output_tokens": 1}

    call = client.stream_calls[0]
    assert call["json"]["model"] == "llama-3.1-8b-instant"
    assert call["headers"]["Authorization"] == "Bearer fake_key"


@pytest.mark.asyncio
async def test_groq_llama_accumulates_streamed_tool_call_arguments():
    lines = [
        f"data: {json.dumps({'choices': [{'delta': {'tool_calls': [{'index': 0, 'id': 'call_1', 'function': {'name': 'lookup', 'arguments': ''}}]}}]})}",
        "data: "
        + json.dumps(
            {"choices": [{"delta": {"tool_calls": [{"index": 0, "function": {"arguments": '{"order_id"'}}]}}]}
        ),
        "data: "
        + json.dumps(
            {
                "choices": [
                    {
                        "delta": {"tool_calls": [{"index": 0, "function": {"arguments": ': "123"}'}}]},
                        "finish_reason": "tool_calls",
                    }
                ]
            }
        ),
        "data: [DONE]",
    ]
    client = FakeHTTPClient(stream_response=FakeStreamResponse(lines=lines))
    llm = GroqLlamaLLMProvider({"api_key": "fake_key"}, http_client=client)
    tools = [ToolDefinition(name="lookup", description="x")]

    events = [e async for e in llm.stream_chat([Message(role="user", content="x")], tools)]
    tool_events = [e for e in events if e.type == "tool_call"]
    assert len(tool_events) == 1
    assert tool_events[0].tool_call.name == "lookup"
    assert tool_events[0].tool_call.arguments == {"order_id": "123"}


def test_groq_llama_requires_api_key():
    with pytest.raises(ValueError):
        GroqLlamaLLMProvider({})


def test_groq_llama_default_model_is_self_serve_8b_not_enterprise_only_70b():
    llm = GroqLlamaLLMProvider({"api_key": "k"}, http_client=object())
    assert llm._model == "llama-3.1-8b-instant"
