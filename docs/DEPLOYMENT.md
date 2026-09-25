# Deployment — Phase 10

How to actually deploy this two-runtime system. Written for the first real
deployment, not a hypothetical scale-out — trade-offs are called out so a
later re-decision has the reasoning on record.

## System shape (recap from docs/ARCHITECTURE.md)

- **`apps/web`** — Next.js (App Router), the dashboard + REST API +
  webhook receivers. Request/response, no persistent connections of its
  own beyond a Postgres pool.
- **`services/voice-gateway`** — Python, the real-time voice pipeline.
  Needs long-lived WebSocket connections (telephony media streams) and,
  per its own README's "Deferred" notes, eventually background workers.
  This is the component most deployment platforms get wrong by defaulting
  to a request/response serverless model.
- **PostgreSQL 16 + pgvector** — the single shared database both runtimes
  connect to directly.
- **Redis** — only required if `QUEUE_BACKEND=bullmq` (see "Redis" below);
  the default `QUEUE_BACKEND=pg` needs no Redis at all.

## 1. `apps/web` (Next.js)

**Recommended: Vercel.** It's the natural fit for a Next.js App Router app
(zero-config builds, edge network for static assets, environment-variable
management, preview deployments per PR). Any Node host that can run
`next build && next start` works too (Railway, Render, a plain VPS with a
process manager) — nothing in this codebase is Vercel-specific (no Vercel
KV/Blob/Edge-Function-only APIs used; Postgres access via `pg` needs a
Node runtime, not the Edge runtime — already true today, see
`docs/RESELLER_HIERARCHY.md`'s domain-routing section on why branding
resolution runs in a Node Server Component, not Edge Middleware).

**Trade-off if not Vercel**: you lose zero-config preview deployments and
automatic CDN edge caching for static assets — not a blocker, just extra
ops work (a reverse proxy + a build pipeline you own).

Build/start commands: `npm run build -w apps/web` / `npm run start -w apps/web`
(the repo root `npm run build` already delegates to this).

## 2. `services/voice-gateway` (Python)

This needs a host that supports **long-lived WebSocket connections** (the
telephony media-stream bridge — see `docs/AUDIO_BRIDGE.md`) and, longer
term, **background workers** (a real ASGI/ WebSocket server process is
still deployment work per that doc's item 7). This rules out a pure
request/response serverless platform (AWS Lambda's default HTTP-only
model, Vercel Functions) for this component specifically.

| Option | Trade-off |
|---|---|
| **Fly.io** | Recommended default. First-class long-running-process + persistent WebSocket support, simple `fly.toml` deploy, machines can scale to zero when idle (cost-efficient pre-launch), regions close to India (Mumbai/Singapore) for latency. |
| **Railway** | Similarly simple for a single long-running Python process; slightly less control over region placement than Fly for India-specific latency needs. |
| **A plain VPS (Hetzner/DigitalOcean/AWS EC2)** | Full control (systemd service + `websockets`-based server, per `docs/AUDIO_BRIDGE.md`'s item 7 "production ASGI/WebSocket server process" — not yet built, this phase doesn't build it either), but you own OS patching, process supervision, and scaling — more ops burden for a small team. |
| **AWS ECS (Fargate)** | Viable, supports long-lived connections behind an ALB with WebSocket support, but meaningfully more setup (task definitions, ALB target groups, VPC networking) than Fly/Railway for a first deployment — revisit once traffic justifies AWS's finer-grained scaling/networking controls. |

**Recommended: Fly.io** for the first real deployment — lowest setup
overhead for the actual requirement (long-lived WebSocket + eventual
background workers), with a credible upgrade path to ECS/EKS once call
volume justifies AWS's operational complexity.

Both runtimes must share the SAME `PROVIDER_CONFIG_ENCRYPTION_KEY` (see
`.env.example`'s comment on this) — a byte-for-byte identical value in
both deployments' environment variables, since `voice_gateway/crypto.py` is
a port of `apps/web/lib/providers/crypto.ts` and both decrypt the same
`tenant_provider_config.config` envelopes.

## 3. PostgreSQL + pgvector (shared)

| Option | Trade-off |
|---|---|
| **Supabase** | Managed Postgres + pgvector pre-enabled, generous free tier for early testing, built-in connection pooling (PgBouncer) — good fit given `docs/PHASE1_DECISIONS.md` already noted Supabase remains fully compatible (plain Postgres + RLS, nothing Supabase-specific was used). **Recommended default** for the first real deployment. |
| **Neon** | Serverless Postgres, scale-to-zero branching (useful for preview environments), pgvector supported — a strong alternate if per-branch database copies for PR previews become valuable. |
| **AWS RDS for PostgreSQL** | Full control, VPC-native if `services/voice-gateway` is also on AWS (lower latency, no public internet hop) — more setup than Supabase/Neon, best once already committed to AWS for other reasons. |
| **Self-hosted** | Cheapest at scale, but you own backups, failover, and the `pgvector` extension install/upgrade path yourself — not recommended for the first real deployment given the team's current size. |

Whichever is chosen, both `apps/web` (as `app_user`, `NOBYPASSRLS`) and
`services/voice-gateway` connect to it directly — this is a hard
requirement, not a preference (see `docs/PHASE1_DECISIONS.md`'s RLS
design: both runtimes must go through the same RLS-enforcing role).

### Migration-running procedure for a fresh environment

```bash
# 1. Provision the Postgres instance, note its superuser/admin connection string
# 2. Enable extensions (most managed providers: via their dashboard or directly)
psql "$ADMIN_CONNECTION_STRING" -c "CREATE EXTENSION IF NOT EXISTS vector; CREATE EXTENSION IF NOT EXISTS pgcrypto;"

# 3. Run migrations — creates schema, RLS policies, and the app_user role
#    (db/migrate.js is idempotent — safe to re-run; it tracks applied files
#    in a _migrations table, per docs/PHASE1_DECISIONS.md)
export DATABASE_URL_MIGRATE="$ADMIN_CONNECTION_STRING"
npm run migrate

# 4. Set a real password for app_user (the migration creates the role;
#    set/rotate its password via your provider's dashboard or psql, then
#    put the resulting connection string in DATABASE_URL for both apps/web
#    and services/voice-gateway's deployed environments)
```

## 4. Redis (only if `QUEUE_BACKEND=bullmq`)

The default (`QUEUE_BACKEND=pg`, per `.env.example`) needs **no Redis at
all** — the Postgres-backed job queue (`lib/queue/pg-queue.ts`) is a
complete, tested implementation. Provision Redis only when moving to the
documented production-target `bullmq` backend (see
`db/migrations/011_phase6_whatsapp_appointments_campaigns_compliance.sql`'s
reasoning). Managed options: Upstash (serverless, pay-per-request, good
fit for bursty campaign-dispatch workloads), Redis Cloud, or a self-hosted
instance next to `services/voice-gateway` if it's already on a VPS/ECS.
The same Redis instance can also back the rate limiter's production
upgrade (see `docs/SECURITY_AUDIT.md` §8 — currently Postgres-backed,
documented Redis swap not yet built).

## 5. Environment variable checklist (cross-referenced against `.env.example`)

| Variable | Component(s) | Notes |
|---|---|---|
| `DATABASE_URL` | both | `app_user` connection string — never the superuser role |
| `DATABASE_URL_MIGRATE` | migration step only | superuser/admin connection — never set on a running app instance |
| `NODE_ENV=production` | apps/web | required for `secure` session cookies to actually be set |
| `PROVIDER_CONFIG_ENCRYPTION_KEY` | both | **must be byte-identical in both deployments**; generate with `openssl rand -hex 32`; store in your platform's secret store, never a committed file |
| `QUEUE_BACKEND` | apps/web | `pg` (default) or `bullmq` |
| `REDIS_URL` | apps/web | only if `QUEUE_BACKEND=bullmq` |
| `N8N_WEBHOOK_SHARED_SECRET` | apps/web | must match the same value configured in your n8n instance's environment variables |
| `NEXT_PUBLIC_PLATFORM_BASE_DOMAIN` | apps/web | the base domain resellers' subdomains route under — see "White-label custom domains" below |
| Real telephony/STT/TTS/LLM/WhatsApp/payment-gateway credentials | **never env vars** | these are per-tenant, stored encrypted in `tenant_provider_config.config` — see `docs/PROVIDER_REGISTRY.md`. The commented-out lines in `.env.example` are for local single-adapter smoke tests only. |

## 6. DNS/SSL/reverse-proxy for white-label custom domains (Phase 8's deferred item)

Per `docs/RESELLER_HIERARCHY.md` §4, the subdomain-routing *mechanism*
(`{reseller-slug}.yourplatform.example`) is built; a real custom domain
(`voice.clientdomain.com`) needs this deployment-time infra, not yet
provisioned anywhere in this repo:

1. **DNS**: the reseller adds a `CNAME` for their subdomain pointing at
   your edge (Vercel's own domain-alias flow if `apps/web` is on Vercel —
   it handles step 2 automatically per custom domain added in its
   dashboard/API; otherwise your reverse proxy's hostname).
2. **TLS/SSL**: Vercel/Cloudflare issue and renew certs automatically per
   added custom domain; a self-managed reverse proxy (Caddy/Traefik) can
   do the same via its own ACME/Let's Encrypt integration with zero extra
   code, or a manual per-domain cert step otherwise.
3. **Reverse-proxy routing**: whatever terminates TLS must forward the
   original `Host` header (or `X-Forwarded-Host`) unmodified to `apps/web`,
   so `resolveTenantBranding()` (`lib/reseller/branding.ts`) still resolves
   against the real hostname.
4. **Ownership verification before activation**: a DNS TXT-record challenge
   (same pattern as Let's Encrypt's DNS-01, or Vercel's own "Domains" API
   verification flow) before serving a reseller's branding on a domain
   they haven't proven they control.

`reseller_branding.custom_domain` is already a unique-indexed column and
`resolve_reseller_branding_by_host()` already matches on it — none of this
needs a schema or code change, only the infra steps above, per reseller,
as each one onboards a real custom domain.

## 7a. Same VPS as an existing, unrelated site (e.g. sitesnsign.com)

Everything above assumes a from-scratch cloud deployment (Vercel/Fly.io/a
fresh VPS). A common REAL scenario instead: deploying onto a VPS that
**already** runs a different, unrelated production site/stack (its own
Docker Compose project, its own Postgres container, its own Nginx), and
this app needs to live alongside it at a new subdomain without touching
anything about that existing site.

See **`deploy/README.md`** for that full setup: a dedicated
`docker-compose.prod.yml` (repo root) with this app's OWN Postgres
container/volume/Docker network — never the existing site's database — an
Nginx server-block config for the new subdomain (`deploy/nginx/`), and
`deploy/RUNBOOK.md`'s literal deploy-day checklist, including how to
debug/roll back this app's containers without ever needing to touch or
restart the existing site's stack.

## 7b. Monitoring/observability (Phase 9 built the metrics; wire alerting here)

Phase 9 wired latency recording (`call_latency_metrics`) and provider
failover tracking — see `docs/LOAD_TESTING.md`. This phase does not build
alerting; on deployment, point whatever your platform provides (Vercel's
own analytics, Fly's metrics, a hosted APM like Datadog/Grafana Cloud) at:
error rates on `/api/calls` and the webhook receivers, wallet
zero-balance/low-balance `billing_alerts` rows, and provider-failover
events — see `docs/PRODUCTION_CHECKLIST.md` for the concrete pre-launch
action item.
