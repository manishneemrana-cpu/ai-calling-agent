# services/voice-gateway — production image. Build context is this
# directory (unlike apps/web, this Python package has no monorepo-wide
# dependency to pull in):
#   docker build -f services/voice-gateway/Dockerfile -t ai-calling-agent-voice-gateway services/voice-gateway
# docker-compose.prod.yml's `build.context` is set accordingly.

FROM python:3.11-slim AS runner
WORKDIR /app

# No native deps beyond what pip needs for cryptography/asyncpg wheels on
# slim — if a future provider adapter needs one (e.g. audio codec libs),
# add it here rather than switching off -slim.
RUN apt-get update && apt-get install -y --no-install-recommends build-essential \
    && rm -rf /var/lib/apt/lists/*

COPY pyproject.toml ./
COPY voice_gateway ./voice_gateway
RUN pip install --no-cache-dir .

ENV PYTHONUNBUFFERED=1
EXPOSE 8100
# Internal only — see docker-compose.prod.yml's comment on why this service
# has no top-level `ports:` (Nginx proxies the future media-stream
# WebSocket route; the internal_api HTTP trigger is only ever called by
# `web`, never from outside the Docker network).
CMD ["python", "-m", "voice_gateway"]
