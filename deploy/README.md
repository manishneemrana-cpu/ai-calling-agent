# Deploying ai-calling-agent onto the sitesnsign.com VPS

This directory holds everything needed to deploy this app onto Manish's
**existing production Hostinger VPS** — the same server that already runs
`sitesnsign.com` (a separate, unrelated Next.js + NestJS + PostgreSQL/PostGIS
Docker Compose stack) — at the new subdomain **`ai.sitesnsign.com`**.

For the generic "which cloud platform should host this" guidance (Vercel,
Fly.io, Supabase, etc.), see `docs/DEPLOYMENT.md` — that's still correct for
a from-scratch deployment. **This directory is specifically for the
same-VPS-as-sitesnsign.com scenario.** See `docs/DEPLOYMENT.md`'s own "Same
VPS as an existing site" section, which points here.

Files:

- `../docker-compose.prod.yml` (repo root) — the app's own containers:
  `web`, `voice-gateway`, a dedicated `postgres`, and a `migrate` one-shot.
- `nginx/ai.sitesnsign.com.conf` — the Nginx server block for the new
  subdomain.
- `RUNBOOK.md` — the literal, copy-pasteable deploy-day checklist.

## Non-negotiables this whole setup is built around

1. **Never touch sitesnsign.com's own containers, database, or Nginx
   server block(s).** This app gets its own Postgres container
   (`ai-calling-agent-postgres`, own volume), own Docker network
   (`ai-calling-agent-net`), and a separate Nginx `server {}` block for a
   different `server_name`. There is no shared state with the
   `sitesnsign-postgres-1` container or database.
2. **`web`/`voice-gateway` are never reachable from the internet
   directly** — only Nginx reaches them, and only on `127.0.0.1`.

## Where does this app's repo live on the VPS?

Recommended: `/opt/ai-calling-agent`, kept separate from wherever
sitesnsign.com's own repo lives (commonly `/opt/sitesnsign` or under a
`deploy`/`www` user's home directory — **confirm this against the VPS's
actual existing layout on deploy day**; see RUNBOOK.md step 1).

## How this coexists with the VPS's existing Nginx

Two common ways an existing Nginx setup on a VPS like this is organized —
this app's config works with either:

**A) `sites-available` / `sites-enabled` (Debian/Ubuntu default, most
common on a plain VPS setup like Hostinger's):**

```bash
sudo cp deploy/nginx/ai.sitesnsign.com.conf /etc/nginx/sites-available/ai.sitesnsign.com.conf
sudo ln -s /etc/nginx/sites-available/ai.sitesnsign.com.conf /etc/nginx/sites-enabled/ai.sitesnsign.com.conf
sudo nginx -t   # ALWAYS test before reloading
sudo systemctl reload nginx
```

**B) `conf.d/*.conf` (common when sitesnsign.com's own stack was set up
with a single flat `conf.d` directory, e.g. if Nginx itself runs inside a
Docker container for that stack):**

```bash
sudo cp deploy/nginx/ai.sitesnsign.com.conf /etc/nginx/conf.d/ai.sitesnsign.com.conf
sudo nginx -t
sudo systemctl reload nginx
```

Either way, this is an ADDITIONAL file — nothing about sitesnsign.com's own
`server_name sitesnsign.com` block is edited or reloaded differently.
**Before doing either, run `ls /etc/nginx/sites-enabled/ /etc/nginx/conf.d/`
(whichever exists) once to see which pattern is already in use**, and match
it, rather than guessing.

If sitesnsign.com's Nginx runs as its OWN Docker container (rather than
directly on the VPS host) rather than a host-level `nginx` package, see
`nginx/ai.sitesnsign.com.conf`'s top comment for the option (b) variant
(proxy to `http://web:3000` by Docker service name instead of
`127.0.0.1:3000`, with that Nginx container joined to
`ai-calling-agent-net`) — confirm which setup exists on deploy day.

## SSL — certbot

Once DNS for `ai.sitesnsign.com` points at the VPS (the founder's own
action — an A record, see RUNBOOK.md step 6):

```bash
sudo certbot --nginx -d ai.sitesnsign.com
```

This both obtains the certificate AND edits the Nginx config to add the
`443 server {}` block + the HTTP->HTTPS redirect automatically — it only
touches the `ai.sitesnsign.com` server block, never sitesnsign.com's own.
If `certbot --nginx` isn't available (e.g. Nginx is containerized and
certbot isn't installed on the host), use the `webroot` method instead
against the `.well-known/acme-challenge` location this config already
reserves:

```bash
sudo certbot certonly --webroot -w /var/www/certbot -d ai.sitesnsign.com
# then manually uncomment/fill in the 443 server{} block in
# deploy/nginx/ai.sitesnsign.com.conf using the cert paths certbot prints
```

Certbot auto-renewal (`certbot renew`, usually already cron'd/systemd-timed
from whatever initially installed certbot for sitesnsign.com) covers this
cert too — no separate renewal setup needed.

## Everything else (containers, migrations, the actual deploy sequence)

See `RUNBOOK.md`.
