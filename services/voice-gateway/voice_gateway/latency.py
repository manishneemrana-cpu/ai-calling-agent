"""Structured latency instrumentation for the voice pipeline.

Per the Phase 3 task: measure and log (structured, not print) the key
latency stages the spec calls out — end-of-user-speech -> transcript ->
LLM response -> first TTS audio byte — as real wall-clock measurements.
No dashboard yet (that's Phase 9/observability); this module is the
measurement + structured-logging layer Phase 9 will consume.

Uses the stdlib `logging` module with a JSON formatter (no extra
dependency) so log lines are machine-parseable (`jq`, a log shipper, etc)
rather than free-form print()s.
"""

from __future__ import annotations

import json
import logging
import time
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import asdict, dataclass, field

logger = logging.getLogger("voice_gateway.latency")
if not logger.handlers:
    _handler = logging.StreamHandler()
    _handler.setFormatter(logging.Formatter("%(message)s"))
    logger.addHandler(_handler)
    logger.setLevel(logging.INFO)


@dataclass
class TurnLatency:
    """One conversational turn's measured stage latencies, in seconds.
    Populated incrementally as the orchestrator crosses each boundary;
    `None` until that stage has actually happened."""

    call_id: str
    end_of_speech_to_transcript_s: float | None = None
    transcript_to_llm_first_token_s: float | None = None
    llm_first_token_to_first_tts_byte_s: float | None = None
    end_of_speech_to_first_tts_byte_s: float | None = None  # end-to-end
    extra: dict[str, float] = field(default_factory=dict)

    def log(self) -> None:
        logger.info(json.dumps({"event": "turn_latency", **asdict(self)}))


class TurnLatencyTracker:
    """Call-scoped helper: mark() each boundary as it's crossed, in order.
    Uses an injectable clock (defaults to time.monotonic) so tests can
    fast-forward without real sleeps."""

    def __init__(self, call_id: str, *, clock=time.monotonic):
        self._clock = clock
        self._result = TurnLatency(call_id=call_id)
        self._t_end_of_speech: float | None = None
        self._t_transcript: float | None = None
        self._t_llm_first_token: float | None = None

    def mark_end_of_speech(self) -> None:
        self._t_end_of_speech = self._clock()

    def mark_transcript_received(self) -> None:
        self._t_transcript = self._clock()
        if self._t_end_of_speech is not None:
            self._result.end_of_speech_to_transcript_s = self._t_transcript - self._t_end_of_speech

    def mark_llm_first_token(self) -> None:
        self._t_llm_first_token = self._clock()
        if self._t_transcript is not None:
            self._result.transcript_to_llm_first_token_s = self._t_llm_first_token - self._t_transcript

    def mark_first_tts_byte(self) -> None:
        t = self._clock()
        if self._t_llm_first_token is not None:
            self._result.llm_first_token_to_first_tts_byte_s = t - self._t_llm_first_token
        if self._t_end_of_speech is not None:
            self._result.end_of_speech_to_first_tts_byte_s = t - self._t_end_of_speech

    def finish(self) -> TurnLatency:
        self._result.log()
        return self._result


@contextmanager
def log_stage(call_id: str, stage: str, *, clock=time.monotonic) -> Iterator[None]:
    """Generic single-stage timing helper for anything not covered by
    TurnLatencyTracker's fixed stage set (e.g. a provider's own internal
    connect time)."""
    start = clock()
    try:
        yield
    finally:
        duration = clock() - start
        logger.info(
            json.dumps({"event": "stage_latency", "call_id": call_id, "stage": stage, "duration_s": duration})
        )
