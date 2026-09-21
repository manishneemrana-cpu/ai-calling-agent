"""Silence-handling state machine, per the spec's escalation ladder:
2s wait -> 5s "are you there?" prompt -> 10s "I'll call back later" + end.

Implemented as a pure, synchronous state machine (`SilenceMonitor.tick`)
driven by an explicit timestamp, plus a thin async polling loop
(`SilenceMonitor.run`) for production use against a real clock. Tests drive
`tick()` directly with synthetic timestamps — no real or "fast-forwarded"
sleeping needed to exercise all three thresholds, satisfying the task's
"can use a fast-forwarded/mocked clock... rather than actually sleeping 10s
in CI" requirement in the simplest possible way.
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from enum import Enum


class SilenceOutcome(Enum):
    STILL_WAITING = "still_waiting"  # < prompt_s elapsed — no action
    PROMPTED = "prompted"  # crossed prompt_s — caller should speak the prompt
    ENDED = "ended"  # crossed end_call_s — caller should speak the goodbye and hang up


@dataclass(frozen=True)
class SilenceHandlingConfig:
    wait_s: float = 2.0  # grace period before any escalation is even considered
    prompt_s: float = 5.0  # cumulative silence at which to ask "are you there?"
    end_call_s: float = 10.0  # cumulative silence at which to end the call
    prompt_text: str = "Are you still there?"
    end_text: str = "I'll call back later. Goodbye."


class SilenceMonitor:
    """One instance per call. `notify_activity()` on every detected user
    utterance (VAD speech-start, or a final transcript); `tick(now)` on
    every poll to get the current outcome for that instant."""

    def __init__(self, config: SilenceHandlingConfig | None = None):
        self.config = config or SilenceHandlingConfig()
        self._last_activity: float | None = None
        self._prompted = False
        self._ended = False

    def notify_activity(self, now: float) -> None:
        self._last_activity = now
        self._prompted = False
        self._ended = False

    def tick(self, now: float) -> SilenceOutcome:
        if self._ended:
            return SilenceOutcome.ENDED
        if self._last_activity is None:
            self._last_activity = now  # silence clock starts at first tick if never set
        elapsed = now - self._last_activity
        if elapsed >= self.config.end_call_s:
            self._ended = True
            return SilenceOutcome.ENDED
        if elapsed >= self.config.prompt_s:
            self._prompted = True
            return SilenceOutcome.PROMPTED
        return SilenceOutcome.STILL_WAITING

    async def run(
        self,
        *,
        on_prompt: Callable[[], Awaitable[None]],
        on_end: Callable[[], Awaitable[None]],
        clock: Callable[[], float] = time.monotonic,
        sleep_fn: Callable[[float], Awaitable[None]] = asyncio.sleep,
        poll_interval_s: float = 0.5,
    ) -> None:
        """Production loop: polls at `poll_interval_s`, firing `on_prompt`
        once when the PROMPTED threshold is crossed and `on_end` once when
        ENDED is crossed, then returns. Tests exercise the state machine via
        `tick()` directly instead of this loop."""
        already_prompted = False
        while True:
            outcome = self.tick(clock())
            if outcome is SilenceOutcome.PROMPTED and not already_prompted:
                already_prompted = True
                await on_prompt()
            elif outcome is SilenceOutcome.ENDED:
                await on_end()
                return
            await sleep_fn(poll_interval_s)
