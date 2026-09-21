"""Shared usage-reporting shape returned by every STT/TTS/LLM adapter call.

Per the Phase 3 task: every adapter must report real usage (seconds
processed for STT, characters synthesized for TTS, tokens for LLM) in a
shape that can feed the existing `usage_records` / `cost_records` tables
(db/migrations/004_billing_providers.sql — unchanged, already has the
columns this needs). Wiring this UsageReport into an actual INSERT against
those tables end-to-end (i.e. the orchestrator calling a cost-engine
service after each adapter call) is explicitly DEFERRED as a follow-up —
see services/voice-gateway/README.md "Deferred / follow-up work" for why
(it's a call-lifecycle/billing-service integration decision that belongs
with Phase 1's usage_records writer, not this adapter layer, and doing it
properly needs org_id/call_id plumbing this Phase doesn't yet thread through
every adapter call site). Every adapter DOES return this value today, so
that wiring is additive, not a rework.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

UsageUnit = Literal["seconds", "characters", "tokens"]


@dataclass(frozen=True)
class UsageReport:
    provider_key: str
    layer: Literal["stt", "tts", "llm"]
    unit: UsageUnit
    quantity: float
    # For LLM: {"input_tokens": int, "output_tokens": int}. For STT/TTS this
    # is usually empty; kept generic so a future provider with a richer
    # metering shape (e.g. diarization surcharge) doesn't need a schema bump.
    extra: dict[str, float] = field(default_factory=dict)
