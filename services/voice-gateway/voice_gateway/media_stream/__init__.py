"""Telephony <-> voice-gateway audio bridge (Phase 3.5 — Part A).

See docs/AUDIO_BRIDGE.md (repo root) for the full architecture writeup,
verified provider frame formats, and what still needs a live account to
confirm. In short:

- `types.py` — the internal, provider-agnostic frame representation every
  adapter normalizes into/out of.
- `frame_adapter.py` — the `MediaStreamFrameAdapter` Protocol each
  provider's adapter implements (mirrors the STT/TTS/LLM Provider Registry
  pattern from docs/PROVIDER_REGISTRY.md, reusing the SAME self-registering
  `adapter_map` under a new `media_stream.<provider_key>` namespace).
- `adapters/plivo.py`, `adapters/frejun_teler.py` — the two providers'
  actual WebSocket JSON message formats.
- `pipeline_manager.py` — maps a `call_id` to a lazily-built
  `ConversationOrchestrator` (STT/LLM/TTS resolved via the same
  `voice_gateway.registry.get_provider`), and is what
  apps/web's telephony webhook triggers on "call answered".
- `server.py` — the WebSocket connection handler that decodes inbound
  provider frames, drives `ConversationOrchestrator.run_turn`, and encodes
  outbound TTS audio back into the same provider's frame format.
"""
