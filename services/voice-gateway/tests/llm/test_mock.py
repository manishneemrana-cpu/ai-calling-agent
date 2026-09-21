import pytest

from voice_gateway.llm.adapters.mock import MockLLMProvider
from voice_gateway.llm.types import Message, ToolDefinition


@pytest.mark.asyncio
async def test_mock_llm_emits_tool_call_first_then_final_reply_after_result():
    llm = MockLLMProvider()
    tools = [ToolDefinition(name="lookup_order_status", description="x")]

    events = [e async for e in llm.stream_chat([Message(role="user", content="where is my order")], tools)]
    tool_events = [e for e in events if e.type == "tool_call"]
    assert len(tool_events) == 1
    assert tool_events[0].tool_call.name == "lookup_order_status"
    done = [e for e in events if e.type == "done"][0]
    assert done.usage.provider_key == "mock"
    assert done.usage.extra["output_tokens"] == 0

    messages_with_result = [
        Message(role="user", content="where is my order"),
        Message(
            role="tool", content="out_for_delivery", tool_call_id="mock-call-1", name="lookup_order_status"
        ),
    ]
    events2 = [e async for e in llm.stream_chat(messages_with_result, tools)]
    text = "".join(e.text_delta for e in events2 if e.type == "text_delta")
    assert "out for delivery" in text
    done2 = [e for e in events2 if e.type == "done"][0]
    assert done2.usage.extra["output_tokens"] > 0


@pytest.mark.asyncio
async def test_mock_llm_without_tools_streams_text_directly():
    llm = MockLLMProvider()
    events = [e async for e in llm.stream_chat([Message(role="user", content="hi")], tools=None)]
    assert any(e.type == "text_delta" for e in events)
    assert events[-1].type == "done"
