# Testing (Phase 10)

This repo is two runtimes (`apps/web` — TypeScript/Vitest, `services/voice-gateway`
— Python/pytest) sharing one Postgres database. "Run the tests" is not a
single obvious command for a newcomer — this doc, plus `npm run test:all`
at the repo root, fixes that.

## Quickstart: run everything

```bash
# From the repo root, after the README's Quickstart (migrations already run):
npm run test:all
```

This runs, in order: the TypeScript suite (`apps/web`, Vitest), then the
Python suite (`services/voice-gateway`, pytest), against the SAME local
Postgres database both runtimes share (per `docs/ARCHITECTURE.md`). It
stops and reports failure if either suite fails.

### One-time setup this script assumes

Both suites need a real reachable Postgres — most tests in both runtimes
open a real `pg`/`asyncpg` connection to prove tenant isolation, idempotency,
and concurrency against the actual database, not mocks (per this
project's own "the database is the hard boundary" design — see
`docs/PHASE1_DECISIONS.md`).

```bash
# 1. Fresh local Postgres 16 + pgvector (see README Quickstart for full detail)
sudo -u postgres psql -c "CREATE DATABASE ai_calling_agent;"
sudo -u postgres psql -d ai_calling_agent -c "CREATE EXTENSION IF NOT EXISTS vector; CREATE EXTENSION IF NOT EXISTS pgcrypto;"

# 2. Run migrations from scratch (creates schema, RLS policies, app_user role)
export DATABASE_URL_MIGRATE="postgresql://postgres:postgres@localhost:5432/ai_calling_agent"
npm install
npm run migrate

# 3. Env files both suites read
cp .env.example apps/web/.env.local
cp .env.example services/voice-gateway/.env
# Python's venv (services/voice-gateway/.venv) and its dev deps:
#   cd services/voice-gateway && python -m venv .venv && source .venv/bin/activate
#   pip install -e ".[dev]"
```

## Running each suite individually

```bash
# TypeScript (apps/web) — Vitest, 187 tests as of Phase 10 (177 through
# Phase 9 + 10 new Phase 10 RBAC/rate-limit/audit-log tests)
npm run test -w apps/web

# Python (services/voice-gateway) — pytest, 109 tests as of Phase 9,
# unchanged this phase (Phase 10's fixes were all TypeScript-side)
cd services/voice-gateway && source .venv/bin/activate && python -m pytest -q
```

Cumulative: **296 tests** (187 + 109) as of Phase 10, all against a fresh
migration on a clean database, verified as part of this phase's own
verification step (not just claimed — see the Phase 10 commit).

## What "no reachable Postgres" skips mean (and why they're fine)

A handful of Python tests (`test_registry.py`, `test_tenant_isolation.py`,
`crm/test_handoff.py`, `providers/test_failover.py`,
`loadtest/test_pipeline_load.py`, `billing/test_latency_writer.py`,
`billing/test_pipeline_latency_wiring.py`, `billing/test_cost_writer.py`,
`media_stream/test_pipeline_manager.py`, `media_stream/test_internal_api.py`,
`knowledge/test_ingestion_and_retrieval.py`) call `pytest.skip("No
reachable Postgres...")` when `DATABASE_URL` doesn't resolve to a live
database. This is an intentional, documented guard for running the pure/
unit-level parts of the suite without any DB (e.g. a quick sanity check
before a full environment is set up) — **it should never actually trigger
in CI or in the `npm run test:all` flow above**, both of which set up a
real Postgres first. If you see these skip in an environment where you
expect a live DB, that's a real setup problem to fix (check `DATABASE_URL`),
not an expected state to ignore.

Audited this phase (grepped both runtimes for `.skip(`, `xit(`, `xdescribe(`,
`pytest.mark.skip`, `@skip`): **no other skips exist anywhere in either
suite** — every skip found is one of the conditional "no live Postgres"
guards above, none is a "couldn't figure out the assertion" skip.

## CI

No CI pipeline exists yet (documented as deferred since
`docs/PHASE1_DECISIONS.md`'s "Known gaps" — "worth adding once there's a
remote to push CI against"). `npm run test:all` is written to be the exact
command a CI workflow (GitHub Actions, etc.) would run in its test step
once one is set up — see `docs/PRODUCTION_CHECKLIST.md`.
