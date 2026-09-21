"""FreJunTelerMediaStreamAdapter — FreJun Teler's bidirectional audio
WebSocket JSON message protocol.

Verified 2026-09-21 via WebSearch/WebFetch (Teler's own GitHub repos —
github.com/frejun-tech/teler-py's README sample code — were fetchable;
frejun.com/frejun.ai pages were reachable via search snippets only, same
egress-proxy constraint noted throughout docs/VERIFICATION.md and this
adapter's Plivo sibling):

- **Audio format**: raw L16 (16-bit signed linear PCM) @ 8000 Hz
  ("`sample_rate: "8k"`" in the call-flow config that tells Teler where to
  open this WebSocket — frejun.ai/how-can-a-voice-api-for-developers-handle
  -real-time-audio-streaming), base64-encoded, sent in a configurable
  `chunk_size` (Teler's own docs sample: 400 bytes).
- **Inbound messages** (Teler -> our WebSocket), one JSON object per
  message, keyed by `"type"` (NOT `"event"` — this is a different shape
  from Plivo/Twilio-style adapters, one reason this bridge needs a
  per-provider frame adapter rather than one shared parser):
  - `{"type": "audio", "data": {"audio_b64": "<base64>"}}` — one inbound
    audio chunk from the caller.
  - `{"type": "interruption"}` — Teler's own barge-in signal: the caller
    started speaking while our TTS audio was still playing back to them.
    Source: github.com/frejun-tech/teler-py's documented sample handler
    (`elif msg["type"] == "interruption"`).
  There is no separately documented `"start"`/`"stop"` message type in any
  source this research could reach — Teler's call-flow API (a separate
  REST call, not this WebSocket) is what tells it to open/close the stream
  in the first place, so this adapter treats the WebSocket's own
  open/close as the start/stop boundary (see `server.py`) rather than
  waiting for an in-band event. **This is a documentation gap, not a
  confirmed absence** — see docs/AUDIO_BRIDGE.md's "needs a live account"
  list.
- **Outbound messages** (our WebSocket -> Teler):
  - `{"type": "audio", "audio_b64": "<base64>", "chunk_id": <int>}` — plays
    the given audio to the caller; `chunk_id` is a per-connection,
    monotonically increasing sequence number (Teler's sample code passes an
    incrementing integer; exact semantics if chunks arrive out of order are
    unconfirmed — noted in docs/AUDIO_BRIDGE.md).
  - No documented outbound "clear buffered audio" message was found (unlike
    Plivo's `clearAudio`) — `encode_clear()` returns `None`; barge-in on
    this provider can only stop sending FURTHER chunks, not flush ones
    already buffered on Teler's side. Flagged explicitly in
    docs/AUDIO_BRIDGE.md's "what still needs a live account to verify" list.
"""

from __future__ import annotations

import base64
import json
from typing import Any

from ...adapter_map import register_adapter
from ..types import MediaStreamEvent


class FreJunTelerMediaStreamAdapter:
    provider_key = "frejun_teler"
    codec = "l16"
    sample_rate = 8000

    def __init__(self, config: dict[str, Any] | None = None):
        self._config = config or {}
        self._next_chunk_id = 0

    def parse_inbound(self, raw_message: str) -> MediaStreamEvent:
        payload = json.loads(raw_message)
        msg_type = payload.get("type")

        if msg_type == "audio":
            data = payload.get("data", {})
            b64 = data.get("audio_b64", "")
            audio = base64.b64decode(b64) if b64 else b""
            return MediaStreamEvent(kind="media", audio=audio, raw=payload)
        if msg_type == "interruption":
            return MediaStreamEvent(kind="interruption", raw=payload)
        return MediaStreamEvent(kind="unknown", raw=payload)

    def encode_outbound_audio(self, pcm: bytes) -> str:
        chunk_id = self._next_chunk_id
        self._next_chunk_id += 1
        return json.dumps(
            {
                "type": "audio",
                "audio_b64": base64.b64encode(pcm).decode("ascii"),
                "chunk_id": chunk_id,
            }
        )

    def encode_clear(self) -> str | None:
        # No documented FreJun Teler "clear buffered playback" message —
        # see module docstring. Returning None is a deliberate signal to
        # server.py: it must fall back to stop-sending-new-chunks-only.
        return None


register_adapter("media_stream.frejun_teler", lambda config: FreJunTelerMediaStreamAdapter(config))
