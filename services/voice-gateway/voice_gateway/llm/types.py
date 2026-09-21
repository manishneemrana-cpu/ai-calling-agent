"""LLMProvider — the adapter contract every LLM provider implements. Python
realization of the conceptual `LLMAdapter` Protocol sketched in
services/voice-gateway/PROVIDERS.md, extended with tool/function-calling
and token-usage reporting per the Phase 3 task.

Business/orchestrator code must depend ONLY on this Protocol, obtained via
`voice_gateway.registry.get_provider("llm", ...)`.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import Any, Literal, Protocol, runtime_checkable

from ..usage import UsageReport

Role = Literal["system", "user", "assistant", "tool"]


@dataclass(frozen=True)
class Message:
    role: Role
    content: str
    tool_call_id: str | None = None  # set on role="tool" replies
    name: str | None = None  # tool name, for role="tool" replies


@dataclass(frozen=True)
class ToolCall:
    id: str
    name: str
    arguments: dict[str, Any]


@dataclass(frozen=True)
class LLMStreamEvent:
    """One streamed event: either a text delta, a completed tool call, or
    the terminal event carrying usage."""

    type: Literal["text_delta", "tool_call", "done"]
    text_delta: str | None = None
    tool_call: ToolCall | None = None
    usage: UsageReport | None = None  # set only on type == "done"


@dataclass(frozen=True)
class ToolDefinition:
    name: str
    description: str
    parameters: dict[str, Any] = field(default_factory=dict)  # JSON Schema


@runtime_checkable
class LLMProvider(Protocol):
    provider_key: str

    def stream_chat(
        self, messages: list[Message], tools: list[ToolDefinition] | None = None
    ) -> AsyncIterator[LLMStreamEvent]:
        """Streams the model's reply: zero or more text_delta events,
        zero or more tool_call events (the orchestrator dispatches each and
        is expected to append the tool's result as a role="tool" Message for
        a follow-up call), then exactly one terminal `done` event carrying
        this call's UsageReport (input/output token counts in `.extra`)."""
        ...
