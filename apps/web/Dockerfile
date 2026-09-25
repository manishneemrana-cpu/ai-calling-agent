# apps/web — production image. Multi-stage: full workspace to build,
# then only Next's `output: "standalone"` bundle (next.config.ts) to run —
# see deploy/README.md / deploy/RUNBOOK.md for how this is used on the
# founder's VPS (docker-compose.prod.yml at the repo root).
#
# Build context MUST be the repo root (this is an npm workspaces monorepo —
# db/ and apps/web/ share package-lock.json), e.g.:
#   docker build -f apps/web/Dockerfile -t ai-calling-agent-web .
# docker-compose.prod.yml's `build.context` is already set to `.` for this
# reason.

FROM node:20-slim AS builder
WORKDIR /repo

COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/package.json
COPY db/package.json db/package.json
RUN npm ci

COPY apps/web apps/web
COPY db db

# Build-time-only placeholders: `next build` needs SOME value for these to
# type-check/collect routes, but the runtime container reads the REAL
# values from `.env` via docker-compose's `env_file` — see
# docs/PRODUCTION_CHECKLIST.md for what's actually mandatory at runtime.
ENV DATABASE_URL=postgresql://app_user:build-only@localhost:5432/ai_calling_agent
ENV PROVIDER_CONFIG_ENCRYPTION_KEY=build-only-placeholder-not-used-at-runtime
ENV NODE_ENV=production

RUN npm run build -w apps/web

FROM node:20-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

# `output: "standalone"` (apps/web/next.config.ts) bundles server.js + only
# the production node_modules subset actually needed — no `npm ci` at
# runtime, no dev dependencies in the final image.
COPY --from=builder /repo/apps/web/.next/standalone ./
COPY --from=builder /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder /repo/apps/web/public ./apps/web/public

EXPOSE 3000
# Internal only — Nginx (deploy/nginx/ai.sitesnsign.com.conf) fronts this,
# this port is never published to the internet directly (see
# docker-compose.prod.yml's comment on why `web` has no top-level `ports:`).
CMD ["node", "apps/web/server.js"]
