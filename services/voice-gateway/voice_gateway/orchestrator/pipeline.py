"""ConversationOrchestrator — minimal working STT -> LLM -> TTS pipeline
wiring, with barge-in and per-turn latency instrumentation.

Provider selection is entirely external: callers pass in already-resolved
STTProvider/TTSProvider/LLMProvider instances (obtained via
`voice_gateway.registry.get_provider(...)`), so this class never imports a
concrete adapter or branches on provider_key — per-tenant provider choice
happens at the registry layer, not here.

*** Scope note (see README "Deferred / follow-up work" for the full
explanation) ***: this drives the pipeline against an in-process
`AsyncIterator[bytes]` of audio chunks and a tool-dispatch callback — it
does not open a live Pipecat `Pipeline`/`Transport` or a real telephony
media WebSocket. That is intentional per the task's own scoping allowance
("does NOT need real telephony audio yet... local audio loopback /
WebSocket test harness / file-based transport... demonstrable without a
live phone call"). The mock end-to-end pipeline test
(tests/test_pipeline_e2e.py) and `python -m voice_gateway.demo` exercise
this exact class against MockSTT/MockLLM/MockTTS.
"""

from __future__ import annotations

import time
from collections.abc import AsyncIterator, Awaitable, Callable

from ..latency import TurnLatencyTracker
from ..llm.types import LLMProvider, Message, ToolCall, ToolDefinition
from ..stt.types import STTProvider
from ..tts.types import TTSProvider, VoiceProfile
from .barge_in import BargeInController
from .silence import SilenceMonitor

ToolDispatcher = Callable[[ToolCall], Awaitable[str]]


class ConversationOrchestrator:
    def __init__(
        self,
        *,
        call_id: str,
        stt: STTProvider,
        llm: LLMProvider,
        tts: TTSProvider,
        voice_profile: VoiceProfile | None = None,
        tool_dispatcher: ToolDispatcher | None = None,
        tools: list[ToolDefinition] | None = None,
        barge_in: BargeInController | None = None,
        silence_monitor: SilenceMonitor | None = None,
    ):
        self.call_id = call_id
        self.stt = stt
        self.llm = llm
        self.tts = tts
        self.voice_profile = voice_profile or VoiceProfile()
        self.tool_dispatcher = tool_dispatcher
        self.tools = tools or []
        self.barge_in = barge_in or BargeInController()
        self.silence_monitor = silence_monitor or SilenceMonitor()
        self.messages: list[Message] = []

    async def run_turn(self, audio_chunks: AsyncIterator[bytes]) -> AsyncIterator[bytes]:
        """One conversational turn: transcribe the caller's utterance, get
        the LLM's (possibly tool-using) reply, and yield the bot's TTS audio
        chunks — stopping early if barge-in fires mid-playback."""
        tracker = TurnLatencyTracker(self.call_id)

        await self.stt.start_stream()
        final_text: str | None = None
        async for chunk in audio_chunks:
            async for event in self.stt.feed_audio_chunk(chunk):
                if event.type == "final":
                    final_text = event.text
        tracker.mark_end_of_speech()
        trailing_final, _stt_usage = await self.stt.end_stream()
        if trailing_final is not None:
            final_text = trailing_final.text
        tracker.mark_transcript_received()

        if not final_text:
            return
        self.silence_monitor.notify_activity(now=time.monotonic())
        self.messages.append(Message(role="user", content=final_text))

        first_token_marked = False
        async for audio_chunk in self._reply_and_speak(tracker, first_token_marked):
            yield audio_chunk

        tracker.finish()

    async def _reply_and_speak(
        self, tracker: TurnLatencyTracker, first_token_marked: bool
    ) -> AsyncIterator[bytes]:
        text_buffer = ""
        async for event in self.llm.stream_chat(self.messages, self.tools):
            if event.type == "text_delta" and event.text_delta:
                if not first_token_marked:
                    tracker.mark_llm_first_token()
                    first_token_marked = True
                text_buffer += event.text_delta
            elif event.type == "tool_call" and event.tool_call:
                result_text = await self._dispatch_tool(event.tool_call)
                self.messages.append(
                    Message(
                        role="tool",
                        content=result_text,
                        tool_call_id=event.tool_call.id,
                        name=event.tool_call.name,
                    )
                )
                # Tool result available -> ask the LLM again for its final
                # reply (mirrors a real function-calling round trip).
                async for chunk in self._reply_and_speak(tracker, first_token_marked):
                    yield chunk
                return
            elif event.type == "done":
                pass

        if not text_buffer:
            return
        self.messages.append(Message(role="assistant", content=text_buffer))

        self.barge_in.reset()
        first_byte_marked = False
        async for audio_chunk in self.tts.synthesize_stream(text_buffer, self.voice_profile):
            if self.barge_in.is_interrupted():
                break
            if not first_byte_marked:
                tracker.mark_first_tts_byte()
                first_byte_marked = True
            yield audio_chunk

    async def _dispatch_tool(self, tool_call: ToolCall) -> str:
        if self.tool_dispatcher is None:
            return f"(no tool dispatcher configured for {tool_call.name})"
        return await self.tool_dispatcher(tool_call)
