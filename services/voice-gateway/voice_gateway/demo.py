"""Runnable mock end-to-end pipeline demo: MockSTT -> MockLLM -> MockTTS,
including one tool-dispatch round trip, with latency logging, and a
demonstration of barge-in interrupting TTS playback mid-utterance. No
network, no database, no live credentials — run with:

    python -m voice_gateway.demo
"""

from __future__ import annotations

import asyncio

from .latency import TurnLatencyTracker
from .llm.adapters.mock import MockLLMProvider
from .llm.types import Message, ToolCall, ToolDefinition
from .orchestrator.pipeline import ConversationOrchestrator
from .orchestrator.silence import SilenceMonitor
from .stt.adapters.mock import MockSTTProvider
from .tts.adapters.mock import MockTTSProvider


async def _fake_audio_chunks():
    for _ in range(9):  # MockSTTProvider's canned transcript has 9 words
        yield b"\x00" * 160
        await asyncio.sleep(0)  # yield control, no real delay


async def _tool_dispatcher(tool_call: ToolCall) -> str:
    print(f"  [tool dispatch] {tool_call.name}({tool_call.arguments}) -> 'out_for_delivery'")
    return "out_for_delivery"


async def main() -> None:
    print("=== Voice Gateway Phase 3 mock pipeline demo ===\n")

    orchestrator = ConversationOrchestrator(
        call_id="demo-call-1",
        stt=MockSTTProvider(),
        llm=MockLLMProvider(),
        tts=MockTTSProvider(),
        tool_dispatcher=_tool_dispatcher,
        tools=[ToolDefinition(name="lookup_order_status", description="Look up an order's status")],
    )

    print("Turn 1: caller speaks -> STT -> LLM (with a tool call) -> TTS\n")
    total_audio_bytes = 0
    chunk_count = 0
    async for audio_chunk in orchestrator.run_turn(_fake_audio_chunks()):
        chunk_count += 1
        total_audio_bytes += len(audio_chunk)

    print(f"\nTranscript captured: {orchestrator.messages[0].content!r}")
    print(f"Assistant reply: {orchestrator.messages[-1].content!r}")
    print(f"TTS produced {chunk_count} audio chunks, {total_audio_bytes} bytes total.\n")

    print("Turn 2: demonstrating barge-in mid-playback")
    orchestrator.messages.clear()
    orchestrator.messages.append(Message(role="user", content="never mind, one more question"))
    chunk_count_before_interrupt = 0
    gen = orchestrator._reply_and_speak(TurnLatencyTracker("demo-call-1"), False)
    async for _audio_chunk in gen:
        chunk_count_before_interrupt += 1
        if chunk_count_before_interrupt == 1:
            print("  (bot started speaking — triggering barge-in now)")
            orchestrator.barge_in.trigger()
    print(f"  Playback stopped after {chunk_count_before_interrupt} chunk(s) due to barge-in.\n")

    print("Silence escalation ladder (state machine, synthetic timestamps):")
    monitor = SilenceMonitor()
    for t in [0.0, 1.0, 3.0, 5.5, 9.0, 10.5]:
        outcome = monitor.tick(t)
        print(f"  t={t:>5.1f}s silence -> {outcome.value}")

    print("\n=== Demo complete ===")


if __name__ == "__main__":
    asyncio.run(main())
