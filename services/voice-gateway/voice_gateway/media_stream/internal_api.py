"""The internal, service-to-service endpoint apps/web's telephony webhook
calls on "call answered" — see docs/AUDIO_BRIDGE.md's architecture diagram
and `apps/web/lib/voice-gateway/client.ts`.

`handle_start_pipeline_request()` is the actual business logic, deliberately
kept as a plain, framework-agnostic async function (same pattern as
`server.py`'s `handle_media_stream()`) so it is directly unit-testable
without spinning up a real HTTP listener — exactly what
`tests/media_stream/test_internal_api.py` does.

`serve()` is the thin production wrapper: a minimal hand-rolled
`asyncio.start_server` HTTP/1.1 responder (no new framework dependency —
this service's `pyproject.toml` intentionally has none yet; see
docs/AUDIO_BRIDGE.md's "Deferred" list for adopting a real ASGI framework
once this service also needs the `/media-stream/{call_id}` WebSocket route
served from the same process). It only understands the one route this
bridge needs (`POST /internal/pipelines/{call_id}/start`) and is not meant
to be a general-purpose web server.
"""

from __future__ import annotations

import json
from typing import Any

from .pipeline_manager import PipelineManager


class StartPipelineRequestError(Exception):
    """Raised for a malformed request body — the caller (the raw-socket
    `serve()` wrapper, or a test) turns this into a 400 response."""


async def handle_start_pipeline_request(
    body: dict[str, Any],
    pipeline_manager: PipelineManager,
) -> dict[str, Any]:
    """Body shape (matches `apps/web/lib/voice-gateway/client.ts`'s
    `notifyCallAnswered()` POST body exactly):
    `{"orgId": str, "userId": str | None, "providerKey": str}` (providerKey
    is the TELEPHONY provider — plivo/frejun_teler/mock — used only for
    logging/observability here; which STT/TTS/LLM providers this call's
    pipeline uses is resolved independently via the Provider Registry
    inside `start_pipeline()`, per docs/PROVIDER_REGISTRY.md — a tenant's
    telephony vendor choice never determines its AI-stack vendor choice)."""
    org_id = body.get("orgId")
    if not org_id:
        raise StartPipelineRequestError("Missing required field: orgId")

    call_id = body.get("callId")
    if not call_id:
        raise StartPipelineRequestError("Missing required field: callId")

    await pipeline_manager.start_pipeline(call_id, org_id, user_id=body.get("userId"))
    return {"started": True, "callId": call_id}


def _parse_http_request_line_and_body(raw_request: bytes) -> tuple[str, str, dict[str, Any]]:
    """Minimal HTTP/1.1 request parser for `serve()` below — good enough for
    a same-process/internal-network trigger call with a small JSON body,
    NOT a general-purpose HTTP parser (no chunked transfer-encoding, no
    keep-alive). Returns (method, path, json_body)."""
    header_blob, _, raw_body = raw_request.partition(b"\r\n\r\n")
    lines = header_blob.decode("utf-8").split("\r\n")
    method, path, _version = lines[0].split(" ")
    body = json.loads(raw_body.decode("utf-8")) if raw_body.strip() else {}
    return method, path, body


async def serve(pipeline_manager: PipelineManager, *, host: str = "0.0.0.0", port: int = 8100) -> Any:
    """Starts the minimal internal HTTP responder described above. Returns
    the `asyncio.Server` (call `.close()` / `await .wait_closed()` to stop
    it) — not exercised by the test suite, which calls
    `handle_start_pipeline_request()` directly; this exists for the actual
    deployed process's entrypoint.

    Also serves `POST /internal/agent-builder/generate` (the
    Prompt-to-Agent Builder's one-LLM-call generation endpoint — see
    `voice_gateway/agent_builder/api.py`), wired here rather than as a
    second listener so apps/web only ever needs one `VOICE_GATEWAY_URL`
    for every internal call this service exposes."""
    import asyncio
    import re

    from ..agent_builder.api import GenerateAgentConfigRequestError, handle_generate_request

    pipeline_route_re = re.compile(r"^/internal/pipelines/(?P<call_id>[^/]+)/start$")
    agent_builder_route = "/internal/agent-builder/generate"

    async def _client_connected(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        raw = await reader.read(65536)
        try:
            method, path, body = _parse_http_request_line_and_body(raw)
            pipeline_match = pipeline_route_re.match(path)
            if method == "POST" and pipeline_match:
                body["callId"] = pipeline_match.group("call_id")
                result = await handle_start_pipeline_request(body, pipeline_manager)
                _write_response(writer, 200, result)
            elif method == "POST" and path == agent_builder_route:
                result = await handle_generate_request(body)
                _write_response(writer, 200, result)
            else:
                _write_response(writer, 404, {"error": "not found"})
        except StartPipelineRequestError as err:
            _write_response(writer, 400, {"error": str(err)})
        except GenerateAgentConfigRequestError as err:
            _write_response(writer, 400, {"error": str(err)})
        except Exception as err:  # pragma: no cover - defensive
            _write_response(writer, 500, {"error": str(err)})
        finally:
            writer.close()

    return await asyncio.start_server(_client_connected, host, port)


def _write_response(writer: Any, status: int, payload: dict[str, Any]) -> None:
    body = json.dumps(payload).encode("utf-8")
    reason = {200: "OK", 400: "Bad Request", 404: "Not Found", 500: "Internal Server Error"}[status]
    response = (
        f"HTTP/1.1 {status} {reason}\r\n"
        f"Content-Type: application/json\r\n"
        f"Content-Length: {len(body)}\r\n"
        "Connection: close\r\n\r\n"
    ).encode() + body
    writer.write(response)
