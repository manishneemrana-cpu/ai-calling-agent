"""Production process entrypoint: `python -m voice_gateway`.

Starts the internal service-to-service HTTP responder
(`media_stream.internal_api.serve()`, port 8100 by default — the ONE thing
apps/web calls, per `apps/web/lib/voice-gateway/client.ts`) and keeps the
process alive.

Known gap, called out honestly rather than papered over (see
docs/AUDIO_BRIDGE.md's own "Deferred" list, item 7): the actual
`/media-stream/{call_id}` WebSocket route that a live telephony provider's
media stream connects to (`media_stream/server.py`'s
`handle_media_stream()`) is implemented and unit-tested
(`tests/media_stream/test_server.py`) as a framework-agnostic function, but
is NOT YET wired to a standalone `websockets.serve()`/ASGI listener in this
codebase — that listener is real follow-up work, tracked in
docs/AUDIO_BRIDGE.md, not fabricated here. `deploy/nginx/ai.sitesnsign.com.conf`
already reserves the `/media-stream/` proxy path for it so no Nginx change
is needed the day it ships; until then, telephony providers configured
against this deployment will have their `POST /internal/pipelines/*/start`
call succeed but no live media-stream socket will actually be served.
"""

from __future__ import annotations

import asyncio
import logging
import os
import signal

from .db import get_pool
from .media_stream.internal_api import serve
from .media_stream.pipeline_manager import PipelineManager

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger("voice_gateway")


async def main() -> None:
    host = os.environ.get("VOICE_GATEWAY_HOST", "0.0.0.0")
    port = int(os.environ.get("VOICE_GATEWAY_PORT", "8100"))

    # Fail fast on a bad DATABASE_URL rather than accepting requests and
    # failing confusingly on the first one.
    await get_pool()
    pipeline_manager = PipelineManager()

    server = await serve(pipeline_manager, host=host, port=port)
    logger.info("voice-gateway internal API listening on %s:%s", host, port)

    stop_event = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        try:
            loop.add_signal_handler(sig, stop_event.set)
        except NotImplementedError:  # pragma: no cover - not available on some platforms
            pass

    await stop_event.wait()
    server.close()
    await server.wait_closed()


if __name__ == "__main__":
    asyncio.run(main())
