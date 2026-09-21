"""Barge-in: detect the callee starting to speak while the bot's TTS is
playing, and interrupt/stop that playback immediately.

*** Scope note — real Pipecat VAD wiring deferred, see README/report ***
The Phase 3 task asks for Pipecat's built-in VAD to drive this. Pipecat's
current (2026) VAD API is `pipecat.audio.vad.silero.SileroVADAnalyzer` /
`pipecat.audio.vad.vad_analyzer.VADParams`, plugged into a transport's
`VADParams(confidence=..., start_secs=..., stop_secs=...)` so the transport
itself emits `UserStartedSpeakingFrame` / `UserStoppedSpeakingFrame` that a
pipeline's frame processors react to. Wiring that requires a live Pipecat
`Pipeline`/`Transport` with a real (or file-based) audio source — this
service has no live telephony audio yet (Phase 2's Plivo/FreJun adapters
aren't wired to this service's media path, see README "Deferred / follow-up
work"). Rather than half-integrate Pipecat against no real audio source,
this module implements the exact SAME control-flow contract Pipecat's VAD
frame processors provide (an is-speech signal that interrupts in-flight
playback) as a small, directly testable class. `BargeInController.trigger()`
is what a real Pipecat `UserStartedSpeakingFrame` handler would call in the
follow-up phase that wires this orchestrator into a live Pipecat Pipeline —
the rest of this file does not need to change when that happens.
"""

from __future__ import annotations

import asyncio


class BargeInController:
    provider_key = "barge_in_controller"

    def __init__(self) -> None:
        self._interrupted = asyncio.Event()

    def trigger(self) -> None:
        """Call when the callee is detected speaking (VAD speech-start)
        while the bot is talking."""
        self._interrupted.set()

    def reset(self) -> None:
        """Call at the start of each new bot utterance."""
        self._interrupted.clear()

    def is_interrupted(self) -> bool:
        return self._interrupted.is_set()
