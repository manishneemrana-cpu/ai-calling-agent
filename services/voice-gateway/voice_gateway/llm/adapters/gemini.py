"""GeminiLLMProvider — streaming chat + tool-calling via Google's Gemini
API `streamGenerateContent` SSE endpoint.

Primary LLM per docs/STACK_PROPOSAL.md (Flash-Lite for simple turns, Flash
for complex turns — this one class serves both `providers` rows,
`llm.gemini_flash_lite` and `llm.gemini_flash`, differing only in which
`model` string their `tenant_provider_config.config` supplies).

MODEL NAME NOTE (2026-09-21 re-verification, see docs/VERIFICATION.md's
dated appendix): the spec originally named Gemini 2.5 Flash-Lite/Flash,
both retiring 2026-10-16, with successors (3.1/3.5 Flash-Lite) that turned
out MORE expensive per-token. Rather than hardcode a dated model string
that will need another code change at the next retirement, this adapter
defaults to Google's own rolling aliases `gemini-flash-lite-latest` /
`gemini-flash-latest`, which Google documents as always resolving to the
current non-deprecated build of that tier (with ~2 weeks' notice before the
alias moves). A tenant needing a pinned, contractually-stable model for
cost predictability can still override `config.model` with a dated string.

API shape:
  - Endpoint: `POST https://generativelanguage.googleapis.com/v1beta/models/
    {model}:streamGenerateContent?alt=sse&key=<api_key>`
  - Body: `{"contents": [{"role": "user"|"model", "parts": [{"text": str}]}],
    "tools": [{"functionDeclarations": [{"name", "description",
    "parameters"}]}], "systemInstruction": {"parts": [{"text": str}]}}`
    (role="tool" messages are folded into a "user" turn carrying a
    `functionResponse` part, per Gemini's tool-result contract).
  - Response: server-sent-events, each `data: <json>` line a
    `GenerateContentResponse` chunk; `candidates[0].content.parts[]` holds
    either `{"text": str}` or `{"functionCall": {"name", "args"}}`; the
    final chunk carries `usageMetadata.{promptTokenCount,candidatesTokenCount}`.

DI: `http_client` injectable (`httpx.AsyncClient`-shaped `.stream()`).
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator
from typing import Any

from ...adapter_map import register_adapter
from ...usage import UsageReport
from ..types import LLMStreamEvent, Message, ToolCall, ToolDefinition

GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models"


class GeminiLLMProvider:
    provider_key = "gemini"  # overridden per-row below (gemini_flash_lite / gemini_flash)

    def __init__(
        self, config: dict[str, Any], *, http_client: Any | None = None, provider_key: str | None = None
    ):
        api_key = config.get("api_key")
        if not api_key:
            raise ValueError("GeminiLLMProvider requires config.api_key")
        self._api_key = api_key
        self._model = config.get("model", "gemini-flash-latest")
        if provider_key:
            self.provider_key = provider_key
        if http_client is None:
            import httpx

            http_client = httpx.AsyncClient()
        self._client = http_client

    async def stream_chat(
        self, messages: list[Message], tools: list[ToolDefinition] | None = None
    ) -> AsyncIterator[LLMStreamEvent]:
        body = self._build_request_body(messages, tools)
        url = f"{GEMINI_BASE_URL}/{self._model}:streamGenerateContent"
        params = {"alt": "sse", "key": self._api_key}

        prompt_tokens = 0
        output_tokens = 0
        async with self._client.stream("POST", url, params=params, json=body) as response:
            response.raise_for_status()
            async for line in response.aiter_lines():
                if not line.startswith("data:"):
                    continue
                raw = line[len("data:") :].strip()
                if not raw:
                    continue
                chunk = json.loads(raw)
                usage_meta = chunk.get("usageMetadata")
                if usage_meta:
                    prompt_tokens = usage_meta.get("promptTokenCount", prompt_tokens)
                    output_tokens = usage_meta.get("candidatesTokenCount", output_tokens)
                for candidate in chunk.get("candidates", []):
                    for part in candidate.get("content", {}).get("parts", []):
                        if "text" in part:
                            yield LLMStreamEvent(type="text_delta", text_delta=part["text"])
                        elif "functionCall" in part:
                            fc = part["functionCall"]
                            yield LLMStreamEvent(
                                type="tool_call",
                                tool_call=ToolCall(
                                    id=fc.get("name", "call"), name=fc["name"], arguments=fc.get("args", {})
                                ),
                            )
        yield LLMStreamEvent(
            type="done",
            usage=UsageReport(
                provider_key=self.provider_key,
                layer="llm",
                unit="tokens",
                quantity=prompt_tokens + output_tokens,
                extra={"input_tokens": prompt_tokens, "output_tokens": output_tokens},
            ),
        )

    @staticmethod
    def _build_request_body(messages: list[Message], tools: list[ToolDefinition] | None) -> dict[str, Any]:
        system_parts = [m.content for m in messages if m.role == "system"]
        contents: list[dict[str, Any]] = []
        for m in messages:
            if m.role == "system":
                continue
            if m.role == "tool":
                contents.append(
                    {
                        "role": "user",
                        "parts": [{"functionResponse": {"name": m.name, "response": {"result": m.content}}}],
                    }
                )
            else:
                contents.append(
                    {"role": "model" if m.role == "assistant" else "user", "parts": [{"text": m.content}]}
                )
        body: dict[str, Any] = {"contents": contents}
        if system_parts:
            body["systemInstruction"] = {"parts": [{"text": "\n".join(system_parts)}]}
        if tools:
            body["tools"] = [
                {
                    "functionDeclarations": [
                        {"name": t.name, "description": t.description, "parameters": t.parameters}
                        for t in tools
                    ]
                }
            ]
        return body


register_adapter(
    "llm.gemini_flash_lite", lambda config: GeminiLLMProvider(config, provider_key="gemini_flash_lite")
)
register_adapter("llm.gemini_flash", lambda config: GeminiLLMProvider(config, provider_key="gemini_flash"))
