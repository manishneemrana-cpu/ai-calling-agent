# Phase 1 Decisions — Foundation

This documents the concrete choices made building Phase 1 (auth,
multi-tenancy, database schema/migrations, dashboard shell, and
tenant-isolation tests), and why, per the approved Phase 0 spec in
`ARCHITECTURE.md` / `STACK_PROPOSAL.md`. Phase 1 deliberately does **not**
touch telephony/voice (that's Phase 2/3, scaffolded as a placeholder in
`services/voice-gateway/`).

## Monorepo layout

```
apps/web/              Next.js (App Router) + TypeScript dashboard + API layer
services/voice-gateway/  Placeholder only — Phase 2/3's Python/Pipecat service
db/                     Shared Postgres schema: raw SQL migrations + runner
docs/                   Phase 0 + Phase 1 planning docs (this file included)
```

- **npm workspaces**, not Turborepo/Nx. At Phase 1 there are two packages
  (`apps/web`, `db`) and no cross-package build graph worth caching yet —
  Turborepo/Nx would be pure overhead for a small team right now. Revisit
  once `services/voice-gateway` exists and there's an actual multi-language
  build/test pipeline to orchestrate.
- `db/` sits at the top level, not under `packages/`, because it isn't a
  reusable code package — it's the schema contract both `apps/web` and the
  future `services/voice-gateway` connect to directly (Python service
  included; migrations are plain SQL, not tied to Node).

## Database: plain PostgreSQL + pgvector, no ORM, raw SQL migrations

- **Postgres + pgvector** is spec-mandated (`STACK_PROPOSAL.md`), not a
  choice.
- **Plain Postgres, not Supabase.** Supabase would have given us hosted
  Auth + Postgres + RLS out of the box, but it requires a hosted project
  and API keys the founder has not provisioned yet, and Phase 1 must
  actually run and be tested end-to-end in this environment without any
  external account. A plain, self-hosted Postgres (local dev: the OS
  package; production: any managed Postgres) with hand-rolled RLS gets the
  identical security property (`ARCHITECTURE.md`: "row-level security or
  schema-per-tenant, to be decided in Phase 1" — this decides it: **RLS**)
  without an external dependency. Supabase remains a fine option to adopt
  later purely for its hosted Auth UI/SDK convenience; nothing here is
  Supabase-incompatible (it's still Postgres + RLS).
- **No ORM (no Prisma/Drizzle).** Migrations are numbered raw `.sql` files
  in `db/migrations/`, applied by a ~50-line runner (`db/migrate.js`) that
  tracks applied files in a `_migrations` table. Reasoning:
  - The schema leans on Postgres-specific features an ORM migration DSL
    typically only half-supports: RLS policies, `FORCE ROW LEVEL
    SECURITY`, `SECURITY DEFINER` functions, `SET LOCAL` session
    variables, `vector` columns. Writing these as raw SQL is more direct
    than fighting a DSL's escape hatches for all of them.
  - Tenant isolation is the single most important Phase 1 deliverable and
    it needs to be **auditable at a glance** — a reviewer (or the founder)
    can read `db/migrations/*.sql` top to bottom and see every RLS policy,
    with no ORM-generated SQL in between.
  - The app queries Postgres directly via `pg` (node-postgres) with
    parameterized SQL, wrapped by `apps/web/lib/db/tenant.ts`. This is
    intentionally low-abstraction for the same auditability reason. An
    ORM/query builder can be layered on top later without touching the
    schema or RLS policies.

## Tenant isolation: Postgres Row Level Security (RLS), not query-layer guards

This is implemented as a **database-enforced hard boundary**, per the
spec's explicit preference ("via Row Level Security if Supabase/Postgres
RLS is used (preferred, matches the spec's 'hard security boundary'
language)"):

1. Every tenant-scoped table has an `org_id` column, `ENABLE ROW LEVEL
   SECURITY`, `FORCE ROW LEVEL SECURITY`, and a policy of the shape
   `USING (org_id = current_org_id()) WITH CHECK (org_id = current_org_id())`.
   `FORCE` matters: without it, a table's *owner* role bypasses RLS
   entirely, which would be a silent hole if the app ever connected as the
   owning role by mistake.
2. The app connects as a dedicated, non-superuser, `NOBYPASSRLS` Postgres
   role — `app_user` — created in
   `db/migrations/001_extensions_and_core.sql`. Migrations themselves run
   as a superuser (`postgres` locally), which is the only role allowed to
   create tables/policies/functions and the only role that can legitimately
   bypass RLS.
3. `current_org_id()` (a `STABLE SQL` function) reads a
   **transaction-local** Postgres setting, `app.current_org_id`, set via
   `SELECT set_config('app.current_org_id', $1, true)` (the `true` = "local
   to transaction") at the start of every request. This lives in
   `apps/web/lib/db/tenant.ts`'s `withTenant()` — the only place
   application code is meant to touch tenant tables. Using `SET LOCAL`
   (via `set_config(..., true)`) rather than a plain `SET` is what makes
   this safe with a connection pool: the setting is guaranteed to reset at
   `COMMIT`/`ROLLBACK`, so one request's org context can never leak into
   the next request that reuses a pooled connection.
4. **Fail closed, not fail open**: if `app.current_org_id` is never set (a
   bug, or a connection outside `withTenant()`), `current_org_id()` returns
   `NULL`, which matches no `org_id`, so the query returns **zero rows**,
   not all rows. This is verified by an explicit test (see below).
5. `organizations` and `sessions` cannot be scoped by `current_org_id()`
   the same way (signup happens before an org exists; session lookup
   happens before the org is known). Those two exceptions are handled by a
   small number of `SECURITY DEFINER` functions
   (`db/migrations/006_auth_functions.sql`: `signup_organization`,
   `find_user_by_email`, `create_session`, `resolve_session`,
   `destroy_session`) that run as their owner (the superuser), not as
   `app_user`. `sessions` itself has a blanket `USING (false)` policy —
   `app_user` cannot read/write it directly under any circumstance; the
   only way in is through those five functions, which is exactly the
   narrow surface a session table should have.
6. `provider_rate_cards` intentionally has **no** RLS — it carries no
   `org_id` (it's platform-wide vendor pricing, not tenant data).

**Why this over a query-layer guard:** a query-layer guard (e.g., an ORM
middleware that injects `WHERE org_id = ?` everywhere) is only as strong as
every query author remembering to use it — one raw query, one new endpoint,
one future contributor unfamiliar with the convention, and it's a leak.
RLS makes the database itself refuse the row regardless of what SQL the
application sends, which is what "hard security boundary" should mean.

## Auth: hand-rolled email/password + server-side sessions (no Supabase Auth, no NextAuth/Lucia)

Given plain Postgres was chosen (see above), the spec offered Lucia or
NextAuth as the alternative. Neither was used:

- **Lucia** the library was sunset by its own author in 2024 in favor of
  documenting the pattern for people to implement directly (it was always a
  thin set of primitives, not a black box). Adding it as a dependency for
  what amounts to "hash a password, store a session row, set a cookie"
  buys little.
- **NextAuth (Auth.js)** is built around OAuth/magic-link providers and
  adapters; wiring plain credentials auth through it, plus a Postgres
  adapter, plus keeping session lookups on the same connection that needs
  to set `app.current_org_id` for RLS, was more integration surface than
  writing the ~120 lines directly.

What's implemented (`apps/web/lib/auth.ts`):

- Passwords hashed with `bcryptjs` (cost 12).
- Sessions are a random 32-byte token; only its SHA-256 hash is stored in
  the `sessions` table (`db/migrations/002_organizations_users_sessions.sql`).
  The raw token lives only in an `httpOnly`, `sameSite=lax` cookie, `secure`
  in production.
- Session resolution and creation go through the `SECURITY DEFINER`
  functions described above, specifically so the `sessions` table can carry
  a blanket-deny RLS policy rather than being scoped by an org that isn't
  known yet at that point in the request.

This is real, working code — not a stub — and is exercised by manual
end-to-end runs (signup → dashboard → agents; unauthenticated `/dashboard`
correctly 307-redirects to `/login`) during verification (see below).

## Dashboard shell

`apps/web/app/`: `/signup` and `/login` (React Server Components + Server
Actions, `useActionState` for inline error display), a `/dashboard` layout
that calls `getSession()` and redirects unauthenticated visitors to
`/login`, a dashboard home page showing the current org (name, slug, tier,
member count, the viewer's role), and `/dashboard/agents` listing
`agent_prompts` rows for the caller's org (empty-state copy when there are
none, which is the expected state for a brand-new org — Prompt-to-Agent
Builder is Phase 2+). No design system, no component library — plain CSS in
`app/globals.css`, deliberately minimal per the "not feature-complete"
scope of Phase 1.

## Schema (`db/migrations/*.sql`)

- `001`: extensions (`pgcrypto`, `vector`), the `app_user` role,
  `current_org_id()` / `current_app_user_id()` helper functions.
- `002`: `organizations`, `users` (with `citext` case-insensitive email,
  `user_role` enum: owner/admin/agent_manager/viewer), `sessions`.
- `003`: `agents`, `agent_prompts` (the Prompt-to-Agent Builder output
  table — `config jsonb` holds the full structured-output shape from
  `PROMPT_TO_AGENT_BUILDER.md` §3), `leads` (vertical-agnostic CRM stub —
  `pipeline_stage`/`disposition` are free text, not a fixed enum), `calls`
  (schema only, shaped to receive events from the future voice gateway —
  no call logic in Phase 1).
- `004`: `provider_accounts` (per-tenant provider selection/config
  reference — never a raw secret, just a `secret_ref` placeholder for a
  future secrets manager), `provider_rate_cards` (platform-wide, no
  `org_id`, no RLS), `usage_records`, `cost_records` — schema only, no
  metering pipeline yet (that needs live calls, Phase 2/3+).
- `005`: `knowledge_documents`, `knowledge_chunks` (`vector(768)` column —
  RAG source-of-truth per the "AI must never invent business facts" rule;
  ingestion/retrieval is Phase 4, this is schema-only), `audit_logs`.
- `006`: the five `SECURITY DEFINER` auth functions described above.

Every table but `provider_rate_cards` carries `org_id` + RLS. Column
choices (jsonb config blobs, free-text pipeline stages/dispositions,
provider_key strings instead of enums) directly follow the
"vertical-agnostic, provider-agnostic, never hardcoded" language repeated
throughout `ARCHITECTURE.md`.

## `.env.example`

Lists `DATABASE_URL` (the `app_user` connection the running app uses) and
`DATABASE_URL_MIGRATE` (the superuser connection `db/migrate.js` uses) —
deliberately two different roles/vars so it's structurally awkward to ever
run the app itself as a role that can bypass RLS. No third-party auth
provider keys are needed in Phase 1. Phase 2/3 provider keys
(Plivo/Sarvam/Gemini/etc.) are listed commented-out for forward visibility
only — not read by any Phase 1 code path.

## Known gaps / deferred (expected at this phase)

- No hosted Postgres/Supabase project — Phase 1 was built and verified
  against a local Postgres instance (see README quickstart). Standing up a
  managed instance is an infra task, not a Phase 1 code task, and needs a
  founder decision on hosting provider.
- No CI pipeline wiring these checks (build/lint/typecheck/test) — worth
  adding once there's a remote to push CI against; not blocking Phase 1's
  own verification, which was run locally (see README "Status").
- `npm audit` flags 4 dev-tooling vulnerabilities (a `postcss` issue via
  Next.js's own bundler tooling, a `vitest`/`@vitest/mocker` path-traversal
  issue) — both are build/test-time-only dependencies, not runtime/production
  code paths, and both fixes are breaking major-version bumps (Next 16,
  Vitest 5). Deferred rather than destabilizing Phase 1 on a version bump;
  revisit early Phase 2.
- pgvector's `ivfflat` index on `knowledge_chunks.embedding` is
  intentionally not created yet — it needs real data + `ANALYZE` to be
  meaningful, and Phase 1 has no ingestion pipeline to populate it (Phase 4).
