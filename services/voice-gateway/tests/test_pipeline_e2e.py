"""End-to-end pipeline test using ALL-mock adapters (MockSTT -> MockLLM ->
MockTTS), proving:
  1. the orchestrator wiring produces a sane transcript -> reply -> audio flow
     (including a tool-dispatch round trip),
  2. barge-in interrupts TTS playback mid-utterance, and
  3. silence handling escalates correctly through the 2s/5s/10s stages
     (via the synchronous SilenceMonitor state machine — no real or
     "fast-forwarded" sleeping needed).
"""

from __future__ import annotations

import pytest

from voice_gateway.llm.adapters.mock import MockLLMProvider
from voice_gateway.llm.types import Message, ToolCall, ToolDefinition
from voice_gateway.orchestrator.barge_in import BargeInController
from voice_gateway.orchestrator.pipeline import ConversationOrchestrator
from voice_gateway.orchestrator.silence import SilenceHandlingConfig, SilenceMonitor, SilenceOutcome
from voice_gateway.stt.adapters.mock import MockSTTProvider
from voice_gateway.tts.adapters.mock import MockTTSProvider


async def _audio_chunks(n: int):
    for _ in range(n):
        yield b"\x00" * 160


@pytest.mark.asyncio
async def test_full_pipeline_transcript_tool_call_and_tts_flow():
    async def dispatcher(tool_call: ToolCall) -> str:
        assert tool_call.name == "lookup_order_status"
        return "out_for_delivery"

    orchestrator = ConversationOrchestrator(
        call_id="e2e-test-1",
        stt=MockSTTProvider(),
        llm=MockLLMProvider(),
        tts=MockTTSProvider(),
        tool_dispatcher=dispatcher,
        tools=[ToolDefinition(name="lookup_order_status", description="x")],
    )

    audio_out = [chunk async for chunk in orchestrator.run_turn(_audio_chunks(9))]

    # 1. Transcript captured from MockSTT's deterministic canned words.
    assert orchestrator.messages[0].role == "user"
    assert "recent order" in orchestrator.messages[0].content

    # 2. Tool round trip happened: a role="tool" message was appended.
    assert any(m.role == "tool" and m.content == "out_for_delivery" for m in orchestrator.messages)

    # 3. Final assistant reply is the mock's canned post-tool-call text.
    assert orchestrator.messages[-1].role == "assistant"
    assert "out for delivery" in orchestrator.messages[-1].content

    # 4. TTS actually produced audio bytes.
    assert len(audio_out) > 0
    assert all(isinstance(c, bytes) and len(c) > 0 for c in audio_out)


@pytest.mark.asyncio
async def test_barge_in_interrupts_tts_playback_immediately():
    orchestrator = ConversationOrchestrator(
        call_id="e2e-test-2",
        stt=MockSTTProvider(),
        llm=MockLLMProvider(config={"canned_reply": "one two three four five six seven eight"}),
        tts=MockTTSProvider(config={"num_chunks_per_10_chars": 3}),  # several chunks per utterance
        barge_in=BargeInController(),
    )
    orchestrator.messages.append(Message(role="user", content="tell me something"))

    from voice_gateway.latency import TurnLatencyTracker

    chunks_received = 0
    async for _chunk in orchestrator._reply_and_speak(TurnLatencyTracker("e2e-test-2"), False):
        chunks_received += 1
        if chunks_received == 2:
            orchestrator.barge_in.trigger()  # interrupt after the 2nd chunk

    # Played some audio, but stopped well before the full utterance's chunks.
    assert 0 < chunks_received < 20
    assert orchestrator.barge_in.is_interrupted()


def test_silence_escalation_ladder_without_real_sleeping():
    monitor = SilenceMonitor(SilenceHandlingConfig(wait_s=2.0, prompt_s=5.0, end_call_s=10.0))

    assert monitor.tick(0.0) == SilenceOutcome.STILL_WAITING
    assert monitor.tick(1.9) == SilenceOutcome.STILL_WAITING  # inside the 2s grace period
    assert monitor.tick(4.9) == SilenceOutcome.STILL_WAITING  # still below the 5s prompt threshold
    assert monitor.tick(5.0) == SilenceOutcome.PROMPTED
    assert monitor.tick(7.0) == SilenceOutcome.PROMPTED  # stays prompted, hasn't reached 10s
    assert monitor.tick(10.0) == SilenceOutcome.ENDED
    assert monitor.tick(10.5) == SilenceOutcome.ENDED  # terminal — stays ended


def test_silence_monitor_resets_on_activity():
    monitor = SilenceMonitor(SilenceHandlingConfig(wait_s=2.0, prompt_s=5.0, end_call_s=10.0))
    monitor.notify_activity(now=0.0)  # establish a baseline silence start
    assert monitor.tick(6.0) == SilenceOutcome.PROMPTED
    monitor.notify_activity(now=6.1)  # caller speaks again — resets the clock
    assert monitor.tick(6.2) == SilenceOutcome.STILL_WAITING
    assert monitor.tick(11.2) == SilenceOutcome.PROMPTED  # 5s after the NEW activity time, not the old one


@pytest.mark.asyncio
async def test_silence_monitor_async_run_loop_fires_callbacks_without_real_delay():
    """Exercises the production async loop with an injected fake clock/sleep
    so the test completes instantly instead of waiting 10 real seconds."""
    fake_time = {"t": 0.0}

    def fake_clock() -> float:
        return fake_time["t"]

    async def fake_sleep(seconds: float) -> None:
        fake_time["t"] += seconds  # advance instantly, no real delay

    prompted = []
    ended = []

    async def on_prompt():
        prompted.append(True)

    async def on_end():
        ended.append(True)

    monitor = SilenceMonitor(SilenceHandlingConfig(wait_s=2.0, prompt_s=5.0, end_call_s=10.0))
    await monitor.run(
        on_prompt=on_prompt,
        on_end=on_end,
        clock=fake_clock,
        sleep_fn=fake_sleep,
        poll_interval_s=1.0,
    )

    assert prompted == [True]
    assert ended == [True]
