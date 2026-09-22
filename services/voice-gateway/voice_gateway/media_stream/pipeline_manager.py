"""PipelineManager — maps a `call_id` to a lazily-built
`ConversationOrchestrator`. This is what apps/web's telephony webhook
triggers on "call answered" (`POST /internal/pipelines/{call_id}/start` —
see docs/AUDIO_BRIDGE.md), and what `server.py`'s WebSocket handler looks up
once the provider's media-stream WebSocket actually connects.

Two-step lifecycle, matching the real order of events in a live call:
  1. `start_pipeline(call_id, org_id, ...)` — called from the "call
     answered" webhook, BEFORE any audio has arrived. Resolves this
     tenant's configured stt/tts/llm providers via the same
     `voice_gateway.registry.get_provider()` every other layer uses (zero
     new provider-selection logic), and remembers them against `call_id`.
  2. `get_orchestrator(call_id)` — called from `server.py` once the
     provider's WebSocket actually connects and sends its `start` event.
     Builds the `ConversationOrchestrator` from the providers resolved in
     step 1. Raises `PipelineNotStartedError` if the WebSocket connects
     before (or without) step 1 ever happening — a real bug to surface
     loudly, not silently fall back to some default.

Kept as a plain in-process dict for this phase (one voice-gateway process
handling all active calls) — see docs/AUDIO_BRIDGE.md's "Deferred" section
for why a multi-process deployment (Redis-backed session state, per
docs/ARCHITECTURE.md's Redis component) is explicitly out of scope here.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from ..llm.types import LLMProvider, ToolDefinition
from ..orchestrator.pipeline import ConversationOrchestrator, ToolDispatcher
from ..registry import get_provider_with_key
from ..stt.types import STTProvider
from ..tts.types import TTSProvider, VoiceProfile


class PipelineNotStartedError(Exception):
    def __init__(self, call_id: str):
        super().__init__(
            f'No pipeline was started for call_id "{call_id}" — the telephony '
            "webhook's call-answered event must call start_pipeline() before "
            "the provider's media-stream WebSocket connects."
        )


@dataclass
class _PipelineSession:
    org_id: str
    user_id: str | None
    stt: STTProvider
    llm: LLMProvider
    tts: TTSProvider
    stt_provider_key: str | None = None
    llm_provider_key: str | None = None
    tts_provider_key: str | None = None
    voice_profile: VoiceProfile = field(default_factory=VoiceProfile)
    tools: list[ToolDefinition] = field(default_factory=list)
    tool_dispatcher: ToolDispatcher | None = None
    orchestrator: ConversationOrchestrator | None = None


class PipelineManager:
    def __init__(self) -> None:
        self._sessions: dict[str, _PipelineSession] = {}

    async def start_pipeline(
        self,
        call_id: str,
        org_id: str,
        *,
        user_id: str | None = None,
        voice_profile: VoiceProfile | None = None,
        tools: list[ToolDefinition] | None = None,
        tool_dispatcher: ToolDispatcher | None = None,
    ) -> None:
        """Resolves this tenant's configured stt/tts/llm providers (via the
        shared Provider Registry — see docs/PROVIDER_REGISTRY.md) and stashes
        them against `call_id`, ready for `get_orchestrator()` once the
        provider's media WebSocket connects."""
        stt, stt_provider_key = await get_provider_with_key("stt", org_id, user_id)
        llm, llm_provider_key = await get_provider_with_key("llm", org_id, user_id)
        tts, tts_provider_key = await get_provider_with_key("tts", org_id, user_id)
        self.start_pipeline_with_providers(
            call_id,
            org_id,
            stt=stt,
            llm=llm,
            tts=tts,
            stt_provider_key=stt_provider_key,
            llm_provider_key=llm_provider_key,
            tts_provider_key=tts_provider_key,
            user_id=user_id,
            voice_profile=voice_profile,
            tools=tools,
            tool_dispatcher=tool_dispatcher,
        )

    def start_pipeline_with_providers(
        self,
        call_id: str,
        org_id: str,
        *,
        stt: STTProvider,
        llm: LLMProvider,
        tts: TTSProvider,
        stt_provider_key: str | None = None,
        llm_provider_key: str | None = None,
        tts_provider_key: str | None = None,
        user_id: str | None = None,
        voice_profile: VoiceProfile | None = None,
        tools: list[ToolDefinition] | None = None,
        tool_dispatcher: ToolDispatcher | None = None,
    ) -> None:
        """Same as `start_pipeline()` but takes already-resolved provider
        instances directly — the path production code never needs (it always
        goes through the registry above), but tests use to exercise
        `PipelineManager`/`server.py` against `MockSTT`/`MockLLM`/`MockTTS`
        without a live Postgres connection, exactly like every other
        adapter's dependency-injected test in this codebase (see
        `tests/fakes.py`). `*_provider_key` default to None — deliberately
        NOT inferred from each provider's own `.provider_key` attribute,
        because doing so would make every existing direct-injection test
        (which typically passes a fake, non-UUID `org_id` like "org-1")
        start attempting REAL `call_latency_metrics` writes it never opted
        into and never expects (see ConversationOrchestrator: a turn only
        writes latency rows when BOTH org_id and that stage's provider_key
        are non-None). Only `start_pipeline()`'s real registry-backed path
        passes both explicitly."""
        self._sessions[call_id] = _PipelineSession(
            org_id=org_id,
            user_id=user_id,
            stt=stt,
            llm=llm,
            tts=tts,
            stt_provider_key=stt_provider_key,
            llm_provider_key=llm_provider_key,
            tts_provider_key=tts_provider_key,
            voice_profile=voice_profile or VoiceProfile(),
            tools=tools or [],
            tool_dispatcher=tool_dispatcher,
        )

    def is_started(self, call_id: str) -> bool:
        return call_id in self._sessions

    def get_orchestrator(self, call_id: str) -> ConversationOrchestrator:
        session = self._sessions.get(call_id)
        if session is None:
            raise PipelineNotStartedError(call_id)
        if session.orchestrator is None:
            session.orchestrator = ConversationOrchestrator(
                call_id=call_id,
                stt=session.stt,
                llm=session.llm,
                tts=session.tts,
                voice_profile=session.voice_profile,
                tool_dispatcher=session.tool_dispatcher,
                tools=session.tools,
                org_id=session.org_id,
                stt_provider_key=session.stt_provider_key,
                llm_provider_key=session.llm_provider_key,
                tts_provider_key=session.tts_provider_key,
            )
        return session.orchestrator

    def end_pipeline(self, call_id: str) -> None:
        self._sessions.pop(call_id, None)
