"""MockLLMProvider — deterministic canned response, no network calls.

Includes a fake tool-call on the FIRST call in a conversation (when no
role="tool" message is present yet), specifically so the orchestrator's
tool-dispatch path is exercised by the mock end-to-end pipeline test without
needing a real LLM to decide to call a tool. The SECOND call (after a tool
result has been appended) returns a plain canned text reply.
"""

from __future__ import annotations

from collections.abc import AsyncIterator

from ...adapter_map import register_adapter
from ...usage import UsageReport
from ..types import LLMStreamEvent, Message, ToolCall, ToolDefinition

CANNED_TOOL_CALL_ARGS = {"order_id": "unknown"}
CANNED_FINAL_REPLY = "Sure — I found your order, it's out for delivery and should arrive today."


class MockLLMProvider:
    provider_key = "mock"

    def __init__(self, config: dict | None = None):
        config = config or {}
        self._final_reply: str = config.get("canned_reply", CANNED_FINAL_REPLY)
        self._tool_name: str = config.get("canned_tool_name", "lookup_order_status")

    async def stream_chat(
        self, messages: list[Message], tools: list[ToolDefinition] | None = None
    ) -> AsyncIterator[LLMStreamEvent]:
        has_tool_result = any(m.role == "tool" for m in messages)
        input_tokens = sum(len(m.content.split()) for m in messages)

        if tools and not has_tool_result:
            call = ToolCall(id="mock-call-1", name=self._tool_name, arguments=CANNED_TOOL_CALL_ARGS)
            yield LLMStreamEvent(type="tool_call", tool_call=call)
            yield LLMStreamEvent(
                type="done",
                usage=UsageReport(
                    provider_key=self.provider_key,
                    layer="llm",
                    unit="tokens",
                    quantity=input_tokens,
                    extra={"input_tokens": input_tokens, "output_tokens": 0},
                ),
            )
            return

        # Stream the canned reply word-by-word so callers exercise
        # incremental text_delta handling (e.g. TTS can start on the first
        # few words) without needing a real streaming LLM.
        words = self._final_reply.split(" ")
        for i, word in enumerate(words):
            delta = word if i == 0 else f" {word}"
            yield LLMStreamEvent(type="text_delta", text_delta=delta)
        output_tokens = len(words)
        yield LLMStreamEvent(
            type="done",
            usage=UsageReport(
                provider_key=self.provider_key,
                layer="llm",
                unit="tokens",
                quantity=input_tokens + output_tokens,
                extra={"input_tokens": input_tokens, "output_tokens": output_tokens},
            ),
        )


register_adapter("llm.mock", lambda config: MockLLMProvider(config))
