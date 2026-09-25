# Deployment Runbook — ai.sitesnsign.com on the existing VPS

Literal, numbered, copy-pasteable steps for deploy day. Assumes SSH access
to the VPS exists by the time you run this (it does not exist yet as of
this doc being written — see the bottom "What's needed before this can
run" section).

Replace every `<PLACEHOLDER>` below with a real value. Nothing here
hardcodes a real IP, domain secret, or credential.

## 0. Before you start

- SSH access to the VPS as `<YOUR_SSH_USER>` (confirm sudo/root access for
  the Nginx + certbot steps).
- Confirm where sitesnsign.com's own repo/stack lives on the VPS
  (`ls /opt` or ask the founder) so step 1 doesn't collide with it.
- `docker` and `docker compose` (v2, the `docker compose` subcommand, not
  the standalone `docker-compose` v1 binary) already installed on the VPS —
  they almost certainly are, since sitesnsign.com's own stack already runs
  on Docker Compose there. Verify: `docker compose version`.

## 1. Clone the repo

```bash
ssh <YOUR_SSH_USER>@<VPS_IP>
sudo mkdir -p /opt/ai-calling-agent
sudo chown "$USER":"$USER" /opt/ai-calling-agent
git clone https://github.com/<YOUR_GITHUB_ORG>/ai-calling-agent.git /opt/ai-calling-agent
cd /opt/ai-calling-agent
```

`/opt/ai-calling-agent` is a sensible default that's clearly separate from
wherever sitesnsign.com's own repo lives — **confirm this against the VPS's
actual existing directory layout first** (e.g. if everything else lives
under `/home/deploy/`, use `/home/deploy/ai-calling-agent` instead for
consistency — it just must not be inside or alongside sitesnsign.com's own
repo directory).

## 2. Create `.env`

```bash
cp .env.example .env
nano .env   # or your editor of choice
```

Every var `.env.example` documents is explained there; below is the split
between what's needed for a working **DEMO-mode** deployment (mock
providers, no real phone calls/money yet) vs. what can wait until real
provider credentials exist. Cross-reference `docs/PRODUCTION_CHECKLIST.md`
Category A/B for the full "before a real call / before real money" list —
this is the narrower "what does the container even need to boot and let
you click around" list.

**Mandatory for ANY deployment (demo or real) to boot at all:**

- `DATABASE_URL` — set by `docker-compose.prod.yml` itself for the `web`/
  `voice-gateway` containers (points at the `postgres` service by Docker
  service name) — you don't need to hand-edit this one in `.env`, but the
  compose file DOES need `APP_DB_PASSWORD` and `POSTGRES_SUPERUSER_PASSWORD`
  set (see below).
- `APP_DB_PASSWORD` — a real password for the `app_user` Postgres role.
  `db/migrations/001_extensions_and_core.sql` creates that role with a
  hardcoded dev password (`app_user_dev_password`) if it doesn't already
  exist — a known pre-existing dev-default in the codebase (see
  `docs/PRODUCTION_CHECKLIST.md`), not something changed for this task.
  **After running migrations (step 4) for the first time, rotate it**
  rather than editing the tracked migration file:
  ```bash
  docker compose -f docker-compose.prod.yml exec postgres \
    psql -U postgres -d ai_calling_agent \
    -c "ALTER ROLE app_user PASSWORD '<APP_DB_PASSWORD>';"
  ```
  Use the SAME value here as `.env`'s `APP_DB_PASSWORD` (which
  `docker-compose.prod.yml` already plugs into `web`/`voice-gateway`'s
  `DATABASE_URL`), then restart both: `docker compose -f
  docker-compose.prod.yml restart web voice-gateway`.
- `POSTGRES_SUPERUSER_PASSWORD` — a real password for the `postgres`
  Docker Compose service's superuser role (used only by the `migrate`
  one-shot).
- `PROVIDER_CONFIG_ENCRYPTION_KEY` — generate with `openssl rand -hex 32`.
  Must be the SAME value in both `apps/web` and `services/voice-gateway`
  (both read it from this one `.env` via `docker-compose.prod.yml`'s
  `env_file: .env` on both services — already wired).
- `N8N_WEBHOOK_SHARED_SECRET` — any random string; only actually matters
  once you configure a real n8n instance (Category B item).
- `NEXT_PUBLIC_PLATFORM_BASE_DOMAIN` — set to `sitesnsign.com` or
  `ai.sitesnsign.com` per how you want reseller-subdomain routing to behave
  (see `docs/RESELLER_HIERARCHY.md`) — for the founder's own single-tenant
  use, this mostly doesn't matter yet; leave the example value if unsure.
- `QUEUE_BACKEND=pg` — leave as the default; no Redis needed.

**Can wait until real provider credentials exist (Category A/B in
`docs/PRODUCTION_CHECKLIST.md`) — a demo deployment runs fine without
these, using the Mock adapters:**

- Real telephony (FreJun Teler / Plivo), STT/TTS (Sarvam), LLM (Gemini),
  WhatsApp (Interakt), and payment gateway (Razorpay) credentials — these
  are NEVER env vars in this app (see `.env.example`'s own comments); they
  are configured per-tenant in `tenant_provider_config` via the dashboard
  or an admin script, AFTER the app is running. Nothing here blocks first
  boot.
- `sitesnsign_webhook_tokens` / `webhook_subscriptions` rows (the
  sitesnsign.com integration itself — see
  `docs/SITESNSIGN_INTEGRATION.md`) — also configured after first boot,
  once the founder's own org exists in this app's database (see that org's
  own signup flow, or an admin insert).

## 3. Build and start containers

```bash
docker compose -f docker-compose.prod.yml up -d --build
```

This builds and starts `postgres`, `web`, and `voice-gateway`. Confirm all
three are healthy:

```bash
docker compose -f docker-compose.prod.yml ps
docker compose -f docker-compose.prod.yml logs -f web            # ctrl-C to stop following
docker compose -f docker-compose.prod.yml logs -f voice-gateway
```

## 4. Run migrations

```bash
docker compose -f docker-compose.prod.yml --profile tools run --rm migrate
```

Safe to re-run on later deploys — `db/migrate.js` tracks which migrations
already applied (`_migrations` table) and only applies new ones.

Verify:

```bash
docker compose -f docker-compose.prod.yml exec postgres \
  psql -U postgres -d ai_calling_agent -c "\dt" | head -20
```

## 5. Add the Nginx config + reload

See `deploy/README.md`'s "How this coexists with the VPS's existing Nginx"
section for the two common layouts. In short:

```bash
sudo cp deploy/nginx/ai.sitesnsign.com.conf /etc/nginx/sites-available/ai.sitesnsign.com.conf
sudo ln -s /etc/nginx/sites-available/ai.sitesnsign.com.conf /etc/nginx/sites-enabled/ai.sitesnsign.com.conf
sudo nginx -t
sudo systemctl reload nginx
```

(swap for the `conf.d/` variant if that's how the existing setup is
organized — again, `deploy/README.md` covers both).

At this point `web`/`voice-gateway` must be reachable on `127.0.0.1:3000`/
`127.0.0.1:8100` for Nginx to proxy to them — `docker-compose.prod.yml`
already publishes them that way (loopback only). Sanity check from the VPS
itself:

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3000/login
```

## 6. Confirm DNS

**This is the founder's own action** (already discussed with him): an A
record for `ai.sitesnsign.com` pointing at `<VPS_IP>`. Confirm it's live
before running certbot:

```bash
dig +short ai.sitesnsign.com
```

## 7. Run certbot for SSL

```bash
sudo certbot --nginx -d ai.sitesnsign.com
```

See `deploy/README.md`'s SSL section for the `webroot` fallback if
`--nginx` mode isn't usable in this VPS's actual Nginx setup.

## 8. Smoke-test

```bash
curl -sI https://ai.sitesnsign.com/login | head -5
```

Confirm a `200`/`3xx` (not a 502/504 — a 502 usually means Nginx can't
reach `127.0.0.1:3000`, i.e. the `web` container isn't up; a 504 usually
means it's up but slow/hung). Then actually open
`https://ai.sitesnsign.com/login` in a browser and confirm the login page
renders.

## 9. Rollback / debugging — WITHOUT touching sitesnsign.com's stack

Every command below is scoped to THIS app's containers only, by name
(`ai-calling-agent-*`) or by compose project (`-f docker-compose.prod.yml`,
project name `ai-calling-agent` per that file's `name:` field) — none of
them ever need to reference or restart anything from sitesnsign.com's own
compose project.

**Stop/remove just this app's containers** (keeps the Postgres volume, so
data survives):

```bash
docker compose -f docker-compose.prod.yml stop
# or, to also remove the containers (not volumes/images):
docker compose -f docker-compose.prod.yml down
```

**Full teardown including the dedicated Postgres volume** (destructive —
only if you actually want to wipe this app's data, e.g. a broken first
deploy you're redoing from scratch):

```bash
docker compose -f docker-compose.prod.yml down -v
```

**Check status/logs scoped to only this app:**

```bash
docker ps --filter "name=ai-calling-agent"
docker logs ai-calling-agent-web --tail 200 -f
docker logs ai-calling-agent-voice-gateway --tail 200 -f
docker logs ai-calling-agent-postgres --tail 200 -f
```

**Nginx**: `sudo nginx -t` before every reload (catches a config typo
before it affects ANY site on the box, including sitesnsign.com); if this
subdomain's config needs to come down temporarily without touching
sitesnsign.com's:

```bash
sudo rm /etc/nginx/sites-enabled/ai.sitesnsign.com.conf   # (or conf.d/ variant)
sudo nginx -t && sudo systemctl reload nginx
```

## What's needed from the founder before this runbook can actually be run

1. **VPS SSH access** (host/IP + a user with sudo, or root) — not handed
   over yet as of this doc.
2. **The DNS A record** for `ai.sitesnsign.com` -> the VPS's IP (step 6
   above) — the founder's own action, already discussed with him
   separately.
3. **Confirmation of the VPS's actual existing layout**, specifically:
   - Where sitesnsign.com's own repo/compose files live (so step 1 picks a
     non-colliding path).
   - Whether Nginx runs directly on the VPS host or as its own Docker
     container (changes which of `deploy/nginx/ai.sitesnsign.com.conf`'s
     two upstream options applies — see that file's top comment).
   - Whether `/etc/nginx/sites-available` + `sites-enabled` or a flat
     `conf.d/` layout is already in use.

Everything else in this repo (`docker-compose.prod.yml`, the Dockerfiles,
the Nginx config, migrations) is ready to run mechanically the moment those
three things are known.
