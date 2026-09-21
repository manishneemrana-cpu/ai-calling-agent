"""usage_records / cost_records writer — Phase 3.5 Part B.

See docs/AUDIO_BRIDGE.md's sibling note in this package's docstring for
context: every STT/TTS/LLM adapter already returns a `UsageReport`
(voice_gateway/usage.py); `cost_writer.py` is the single place that turns a
call's collected `UsageReport`s into real `usage_records` +
`cost_records` rows, computing cost from `provider_rate_cards` rather than
a hardcoded number.
"""
