"""GroqLlamaLLMProvider — streaming chat + tool-calling via Groq's
OpenAI-compatible `/chat/completions` endpoint.

Alternate LLM per docs/VERIFICATION.md §4.2.

MODEL NAME NOTE (2026-09-21 re-verification): Llama 3.3 70B moved to
enterprise-only "contact sales" pricing on 2026-08-26 and is no longer
self-serve — this adapter therefore defaults to `llama-3.1-8b-instant`
(still self-serve, cheapest viable Groq option) rather than the spec's
originally-named 3.1/3.3 pairing. A tenant with an enterprise Groq contract
for 3.3-70B can still override `config.model`.

API shape:
  - Endpoint: `POST https://api.groq.com/openai/v1/chat/completions`
  - Auth: `Authorization: Bearer <api_key>`.
  - Body: standard OpenAI chat-completions shape — `messages`, `tools`
    (OpenAI function-calling format), `stream: true`,
    `stream_options: {"include_usage": true}` (Groq supports this OpenAI
    extension to get a final usage chunk).
  - Response: SSE `data: <json>` lines, `choices[0].delta.content` for text
    deltas and `choices[0].delta.tool_calls[].function.{name,arguments}`
    for tool calls (arguments arrive as incremental JSON-string fragments
    that must be concatenated per tool_call index before parsing); the
    terminal `data: [DONE]` line ends the stream, with usage carried on the
    chunk immediately before it when `include_usage` is set.

DI: `http_client` injectable (`httpx.AsyncClient`-shaped `.stream()`).
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator
from typing import Any

from ...adapter_map import register_adapter
from ...usage import UsageReport
from ..types import LLMStreamEvent, Message, ToolCall, ToolDefinition

GROQ_CHAT_URL = "https://api.groq.com/openai/v1/chat/completions"


class GroqLlamaLLMProvider:
    provider_key = "groq_llama"

    def __init__(self, config: dict[str, Any], *, http_client: Any | None = None):
        api_key = config.get("api_key")
        if not api_key:
            raise ValueError("GroqLlamaLLMProvider requires config.api_key")
        self._api_key = api_key
        self._model = config.get("model", "llama-3.1-8b-instant")
        if http_client is None:
            import httpx

            http_client = httpx.AsyncClient()
        self._client = http_client

    async def stream_chat(
        self, messages: list[Message], tools: list[ToolDefinition] | None = None
    ) -> AsyncIterator[LLMStreamEvent]:
        body: dict[str, Any] = {
            "model": self._model,
            "messages": [self._to_openai_message(m) for m in messages],
            "stream": True,
            "stream_options": {"include_usage": True},
        }
        if tools:
            body["tools"] = [
                {
                    "type": "function",
                    "function": {"name": t.name, "description": t.description, "parameters": t.parameters},
                }
                for t in tools
            ]
        headers = {"Authorization": f"Bearer {self._api_key}"}

        pending_tool_calls: dict[int, dict[str, Any]] = {}
        input_tokens = 0
        output_tokens = 0

        async with self._client.stream("POST", GROQ_CHAT_URL, json=body, headers=headers) as response:
            response.raise_for_status()
            async for line in response.aiter_lines():
                if not line.startswith("data:"):
                    continue
                raw = line[len("data:") :].strip()
                if not raw or raw == "[DONE]":
                    continue
                chunk = json.loads(raw)
                usage = chunk.get("usage")
                if usage:
                    input_tokens = usage.get("prompt_tokens", input_tokens)
                    output_tokens = usage.get("completion_tokens", output_tokens)
                for choice in chunk.get("choices", []):
                    delta = choice.get("delta", {})
                    if delta.get("content"):
                        yield LLMStreamEvent(type="text_delta", text_delta=delta["content"])
                    for tc_delta in delta.get("tool_calls") or []:
                        idx = tc_delta.get("index", 0)
                        entry = pending_tool_calls.setdefault(
                            idx, {"id": None, "name": None, "arguments": ""}
                        )
                        if tc_delta.get("id"):
                            entry["id"] = tc_delta["id"]
                        fn = tc_delta.get("function", {})
                        if fn.get("name"):
                            entry["name"] = fn["name"]
                        if fn.get("arguments"):
                            entry["arguments"] += fn["arguments"]
                    if choice.get("finish_reason") == "tool_calls":
                        for entry in pending_tool_calls.values():
                            try:
                                args = json.loads(entry["arguments"] or "{}")
                            except json.JSONDecodeError:
                                args = {}
                            yield LLMStreamEvent(
                                type="tool_call",
                                tool_call=ToolCall(
                                    id=entry["id"] or "call", name=entry["name"], arguments=args
                                ),
                            )
                        pending_tool_calls.clear()

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

    @staticmethod
    def _to_openai_message(m: Message) -> dict[str, Any]:
        if m.role == "tool":
            return {"role": "tool", "tool_call_id": m.tool_call_id, "content": m.content}
        return {"role": m.role, "content": m.content}


register_adapter("llm.groq_llama", lambda config: GroqLlamaLLMProvider(config))
