"""Shared test doubles: fake WebSocket + fake httpx-shaped HTTP client, used
to test each real adapter's request shape / response parsing without any
live network access or API key — the Phase 2 Plivo/FreJun DI pattern,
extended to STT/TTS/LLM."""

from __future__ import annotations

import json
from typing import Any


class FakeWebSocket:
    """Records every `.send()` call and replays a scripted list of `.recv()`
    responses in order."""

    def __init__(self, recv_queue: list[Any]):
        self.sent: list[Any] = []
        self._recv_queue = list(recv_queue)
        self.closed = False

    async def send(self, data: Any) -> None:
        self.sent.append(data)

    async def recv(self) -> Any:
        if not self._recv_queue:
            raise RuntimeError("FakeWebSocket.recv() called with an empty queue")
        return self._recv_queue.pop(0)

    async def close(self) -> None:
        self.closed = True


def make_ws_connect(recv_queue: list[Any]):
    ws = FakeWebSocket(recv_queue)

    async def _connect(url: str, **kwargs: Any) -> FakeWebSocket:
        ws.connect_url = url  # type: ignore[attr-defined]
        ws.connect_kwargs = kwargs  # type: ignore[attr-defined]
        return ws

    return _connect, ws


class FakeJSONResponse:
    def __init__(self, payload: dict[str, Any], status_code: int = 200):
        self._payload = payload
        self.status_code = status_code

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")

    def json(self) -> dict[str, Any]:
        return self._payload


class FakeStreamResponse:
    """Mimics httpx's `async with client.stream(...) as response:` shape."""

    def __init__(
        self, lines: list[str] | None = None, byte_chunks: list[bytes] | None = None, status_code: int = 200
    ):
        self._lines = lines or []
        self._byte_chunks = byte_chunks or []
        self.status_code = status_code

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")

    async def aiter_lines(self):
        for line in self._lines:
            yield line

    async def aiter_bytes(self):
        for chunk in self._byte_chunks:
            yield chunk

    async def __aenter__(self) -> FakeStreamResponse:
        return self

    async def __aexit__(self, *exc: Any) -> None:
        return None


class FakeHTTPClient:
    """Records requests; returns pre-scripted responses for `.post()` (used
    by the Groq Whisper STT adapter) and `.stream()` (used by ElevenLabs/
    Piper TTS and the Gemini/Groq-Llama LLM adapters)."""

    def __init__(
        self,
        *,
        post_response: FakeJSONResponse | None = None,
        stream_response: FakeStreamResponse | None = None,
    ):
        self.post_calls: list[dict[str, Any]] = []
        self.stream_calls: list[dict[str, Any]] = []
        self._post_response = post_response
        self._stream_response = stream_response

    async def post(self, url: str, **kwargs: Any) -> FakeJSONResponse:
        self.post_calls.append({"url": url, **kwargs})
        assert self._post_response is not None, "FakeHTTPClient: no post_response configured"
        return self._post_response

    def stream(self, method: str, url: str, **kwargs: Any) -> FakeStreamResponse:
        self.stream_calls.append({"method": method, "url": url, **kwargs})
        assert self._stream_response is not None, "FakeHTTPClient: no stream_response configured"
        return self._stream_response


def sse(payload: dict[str, Any]) -> str:
    return f"data: {json.dumps(payload)}"
