import pytest

from tests.fakes import FakeHTTPClient, FakeStreamResponse, sse
from voice_gateway.llm.adapters.gemini import GeminiLLMProvider
from voice_gateway.llm.types import Message, ToolDefinition


@pytest.mark.asyncio
async def test_gemini_streams_text_deltas_and_usage():
    lines = [
        sse({"candidates": [{"content": {"parts": [{"text": "Hello"}]}}]}),
        sse(
            {
                "candidates": [{"content": {"parts": [{"text": " there"}]}}],
                "usageMetadata": {"promptTokenCount": 5, "candidatesTokenCount": 2},
            }
        ),
    ]
    client = FakeHTTPClient(stream_response=FakeStreamResponse(lines=lines))
    llm = GeminiLLMProvider(
        {"api_key": "fake_key", "model": "gemini-flash-lite-latest"},
        http_client=client,
        provider_key="gemini_flash_lite",
    )

    events = [e async for e in llm.stream_chat([Message(role="user", content="hi")])]
    text = "".join(e.text_delta for e in events if e.type == "text_delta")
    assert text == "Hello there"
    done = events[-1]
    assert done.type == "done"
    assert done.usage.extra == {"input_tokens": 5, "output_tokens": 2}
    assert done.usage.provider_key == "gemini_flash_lite"

    call = client.stream_calls[0]
    assert "gemini-flash-lite-latest" in call["url"]
    assert call["params"]["alt"] == "sse"


@pytest.mark.asyncio
async def test_gemini_emits_tool_call_from_function_call_part():
    lines = [
        sse(
            {
                "candidates": [
                    {
                        "content": {
                            "parts": [{"functionCall": {"name": "get_weather", "args": {"city": "Delhi"}}}]
                        }
                    }
                ]
            }
        )
    ]
    client = FakeHTTPClient(stream_response=FakeStreamResponse(lines=lines))
    llm = GeminiLLMProvider({"api_key": "fake_key"}, http_client=client)

    tools = [ToolDefinition(name="get_weather", description="x", parameters={"type": "object"})]
    events = [e async for e in llm.stream_chat([Message(role="user", content="weather?")], tools)]
    tool_events = [e for e in events if e.type == "tool_call"]
    assert tool_events[0].tool_call.name == "get_weather"
    assert tool_events[0].tool_call.arguments == {"city": "Delhi"}


def test_gemini_requires_api_key():
    with pytest.raises(ValueError):
        GeminiLLMProvider({})


def test_gemini_default_model_uses_rolling_alias_not_a_dated_string():
    llm = GeminiLLMProvider({"api_key": "k"}, http_client=object())
    assert llm._model == "gemini-flash-latest"
    assert "2.5" not in llm._model and "2026" not in llm._model
