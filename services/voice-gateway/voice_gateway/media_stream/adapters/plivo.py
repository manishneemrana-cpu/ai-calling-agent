"""PlivoMediaStreamAdapter — Plivo's bidirectional Audio Streaming WebSocket
JSON message protocol.

Verified 2026-09-21 via WebSearch against Plivo's current published docs
(direct `WebFetch` to plivo.com is blocked by this environment's egress
proxy — same documented constraint as docs/VERIFICATION.md's Plivo
research, which hit the identical block; findings below are corroborated
across multiple independent search-indexed sources, not a single guess):

- **Audio format**: `audio/x-mulaw` @ 8000 Hz, mono, base64-encoded chunks
  (Plivo also supports `audio/x-l16` at 8000/16000 Hz, but mulaw/8kHz is
  this platform's default per docs/VERIFICATION.md §1.1/§7.1).
- **Inbound events** (Plivo -> our WebSocket), one JSON object per message,
  keyed by `"event"`:
  - `"start"`: `{"event": "start", "start": {"streamId", "callId",
    "accountId", "tracks": [...], "mediaFormat": {"encoding", "sampleRate",
    "channels"}}}`.
  - `"media"`: `{"event": "media", "sequenceNumber", "media": {"track",
    "chunk", "timestamp", "payload": "<base64>"}, "streamId"}`.
  - `"dtmf"`: `{"event": "dtmf", "dtmf": {"digit": "<0-9,*,#>"}, "streamId"}`.
  - `"stop"`: `{"event": "stop", "stop": {"callId"}, "streamId"}`.
  Sources: Plivo's own "Audio Streaming Guide" (plivo.com/docs/voice-agents/
  audio-streaming/concepts/audio-streaming-guide — fetch blocked, confirmed
  via search snippet), corroborated by Twilio Media Streams' near-identical
  format (Plivo's own docs describe this protocol as intentionally
  Twilio-Media-Streams-compatible) and Plivo's Java Streaming SDK
  (github.com/plivo/plivo-stream-sdk-java)'s `StartData`/`onStart` handler
  shape.
- **Outbound control messages** (our WebSocket -> Plivo):
  - `"playAudio"`: `{"event": "playAudio", "media": {"contentType":
    "audio/x-mulaw", "sampleRate": 8000, "payload": "<base64>"}}` — plays
    the given audio to the caller.
  - `"clearAudio"`: `{"event": "clearAudio"}` — Plivo's own documented
    barge-in primitive: "clears all buffered media events" queued via prior
    `playAudio` messages (support.plivo.com/hc/en-us/articles/
    32800291247001, confirmed via search snippet).
  - `"checkpoint"` also exists (playback-progress marker) but this bridge
    does not use it yet — noted in docs/AUDIO_BRIDGE.md's follow-up list.
"""

from __future__ import annotations

import base64
import json
from typing import Any

from ...adapter_map import register_adapter
from ..types import MediaStreamEvent


class PlivoMediaStreamAdapter:
    provider_key = "plivo"
    codec = "mulaw"
    sample_rate = 8000

    def __init__(self, config: dict[str, Any] | None = None):
        self._config = config or {}

    def parse_inbound(self, raw_message: str) -> MediaStreamEvent:
        payload = json.loads(raw_message)
        event = payload.get("event")

        if event == "start":
            start = payload.get("start", {})
            return MediaStreamEvent(kind="start", stream_id=start.get("streamId"), raw=payload)
        if event == "media":
            media = payload.get("media", {})
            audio = base64.b64decode(media["payload"]) if media.get("payload") else b""
            return MediaStreamEvent(kind="media", audio=audio, stream_id=payload.get("streamId"), raw=payload)
        if event == "dtmf":
            dtmf = payload.get("dtmf", {})
            return MediaStreamEvent(
                kind="dtmf", digit=dtmf.get("digit"), stream_id=payload.get("streamId"), raw=payload
            )
        if event == "stop":
            return MediaStreamEvent(kind="stop", stream_id=payload.get("streamId"), raw=payload)
        return MediaStreamEvent(kind="unknown", raw=payload)

    def encode_outbound_audio(self, pcm: bytes) -> str:
        return json.dumps(
            {
                "event": "playAudio",
                "media": {
                    "contentType": "audio/x-mulaw",
                    "sampleRate": self.sample_rate,
                    "payload": base64.b64encode(pcm).decode("ascii"),
                },
            }
        )

    def encode_clear(self) -> str | None:
        return json.dumps({"event": "clearAudio"})


register_adapter("media_stream.plivo", lambda config: PlivoMediaStreamAdapter(config))
