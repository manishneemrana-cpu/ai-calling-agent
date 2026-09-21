# Provider Registry (Phase 2)

Status: implemented for the `telephony` layer. This document is also the
design contract Phase 3 (`stt`, `tts`, `llm`) will reuse **with zero schema
changes** — see "Reuse in Phase 3" at the end.

## Why this exists

The founder's one non-negotiable rule across this whole project: no layer
(telephony, STT, TTS, LLM) may ever be limited to 1-2 hardcoded providers.
`docs/VERIFICATION.md` §7 is the concrete proof this isn't hypothetical —
the cheapest verified telephony provider changed mid-research (Plivo →
FreJun Teler), and several other providers turned out equally
streaming-capable with only pricing left to confirm. A tenant or white-label
reseller may also already have a negotiated contract with a specific vendor.
The Provider Registry makes "which vendor a tenant/layer uses" a config row,
never a code path.

## Schema

### `providers` (platform-wide catalog, not tenant-scoped)

One row per (layer, provider_key) pair — the catalog of adapters this
deployment knows how to instantiate, regardless of which tenants use them.

| column | purpose |
|---|---|
| `layer` | `'telephony' \| 'stt' \| 'tts' \| 'llm'` (plain `text` + `CHECK`, not a Postgres `ENUM`, so adding a layer is a one-line `CHECK` edit, never `ALTER TYPE`) |
| `provider_key` | stable string id, e.g. `plivo`, `frejun_teler`, `mock` — the only thing application code and DB rows ever reference |
| `display_name` | human label for admin/tenant UI |
| `adapter_class_identifier` | the key an adapter module self-registers under, e.g. `telephony.plivo` — see "Why not dynamic `import()`" below |
| `config_schema` | jsonb description of what fields a tenant must supply (`{"required": [...], "properties": {...}}`) — informational/validation only, never contains actual values |
| `status` | `active \| inactive \| beta` |
| `default_priority` | lower = preferred default across tenants, all else equal |
| `cost_notes` | free text, e.g. current per-minute estimate + caveats |
| `capabilities` | jsonb, e.g. `{"streaming": true, "dtmf": true}` |

RLS is intentionally **off** here (same rationale as `provider_rate_cards`
in `004_billing_providers.sql`): this is platform-managed data with no
`org_id`, written by migrations/seeds or a future internal admin tool, and
every tenant is meant to see the same catalog.

### `tenant_provider_config` (tenant-scoped)

Which provider(s) a given org uses at a given layer, in priority order, plus
that tenant's own config for the chosen adapter.

| column | purpose |
|---|---|
| `org_id` | tenant — RLS-scoped (`FORCE ROW LEVEL SECURITY`, same pattern as every other tenant table) |
| `layer`, `provider_key` | FK to `providers (layer, provider_key)` |
| `priority` / `is_default` | selection order when a layer has more than one configured provider (e.g. FreJun Teler as primary, Plivo as fallback) — exactly one `is_default` row per `(org_id, layer)`, enforced by a partial unique index |
| `config` | **encrypted-at-rest** jsonb envelope — see "Secrets" below |

### `telephony_webhook_events` (idempotency ledger)

`UNIQUE (provider_key, idempotency_key)` — see "Idempotency" below.

### Relationship to Phase 1's `provider_accounts` / `provider_rate_cards`

Those tables (`004_billing_providers.sql`) remain for cost accounting
(usage/cost records, vendor rate cards). `providers` /
`tenant_provider_config` are the separate, new concern of **adapter
selection**: which class implements provider X, and which provider a tenant
is configured to use. They share `provider_key` strings by convention, not a
foreign key — different phases, different purposes, may be merged later.

## The adapter interface contract

`apps/web/lib/providers/telephony/types.ts` defines `TelephonyProvider`:

```ts
interface TelephonyProvider {
  readonly providerKey: string;
  createCall(params: CreateCallParams): Promise<CreateCallResult>;
  endCall(providerCallId: string): Promise<void>;
  transferCall(providerCallId: string, toNumber: string): Promise<void>;
  getCallStatus(providerCallId: string): Promise<CallStatusResult>;
  streamAudio(params: StreamAudioParams): Promise<void>;
  receiveWebhook(headers, rawBody: string): Promise<NormalizedWebhookEvent>; // throws WebhookSignatureError
  recordCall(providerCallId: string): Promise<RecordCallResult>;
}
```

This is the TypeScript realization of the conceptual `TelephonyAdapter`
Python `Protocol` in `services/voice-gateway/PROVIDERS.md` (that file
describes the future voice-gateway service's shape; this interface is what
`apps/web` actually imports and calls today, e.g. from
`app/api/calls/route.ts`).

Business logic (API routes, server actions, and — later — the voice-gateway
service) must depend **only** on this interface, obtained through the
factory. It must never `import` a concrete adapter class directly, and must
never `switch`/`if-else` on `providerKey`.

## The factory / loader

`apps/web/lib/providers/registry.ts` exports `getTelephonyProvider(orgId,
userId, opts?)`:

1. Looks up the tenant's configured provider for the layer in
   `tenant_provider_config` (explicit `opts.providerKey`, or the
   `is_default`/lowest-`priority` row), joined to `providers` for its
   `adapter_class_identifier`.
2. Decrypts `config` if it's an encrypted envelope.
3. Looks up `adapter_class_identifier` in an in-memory **adapter map** and
   calls its registered factory function with the decrypted config.

### Why not dynamic `import(adapter_module_path)`?

Next.js/webpack statically analyzes `import()` calls at build time — it
cannot resolve an arbitrary string assembled from a DB row at runtime (the
module simply won't be in the bundle). Instead, `adapter_class_identifier`
is an opaque string like `"telephony.plivo"` that each adapter module
registers itself under, at import time, via
`registerAdapter(identifier, factory)` in
`apps/web/lib/providers/adapter-map.ts`. `registry.ts` imports every
built-in adapter module once (for that side effect) and then does a single
`Map.get(identifier)` — no branching on provider identity anywhere in this
file.

### How to add a new provider (telephony OR any future layer)

1. Write a new adapter file implementing the layer's interface (e.g.
   `apps/web/lib/providers/telephony/adapters/exotel.ts` implementing
   `TelephonyProvider`), ending with:
   ```ts
   registerAdapter("telephony.exotel", (config) => new ExotelTelephonyProvider(config));
   ```
2. Add one side-effect import of that file to `registry.ts`'s import list.
3. Insert one row into `providers` (layer, provider_key, display_name,
   `adapter_class_identifier: "telephony.exotel"`, `config_schema`,
   capabilities, etc).
4. Tenants opt in by inserting/updating their own `tenant_provider_config`
   row — **no other application code changes**.

`apps/web/tests/providers/registry.test.ts` has a test that does exactly
this at test time (a fake adapter class + a fake `providers` row, with
`registry.ts` completely untouched) and asserts the factory resolves it —
proving the claim, not just documenting it.

## Secrets

`tenant_provider_config.config` is never plaintext. `apps/web/lib/providers/
crypto.ts` implements AES-256-GCM envelope encryption
(`encryptProviderConfig` / `decryptProviderConfig`), keyed by the
`PROVIDER_CONFIG_ENCRYPTION_KEY` env var — **never stored in the database**.
Postgres has no visibility into the key or the plaintext; encryption and
decryption happen entirely in the Next.js process.

**TODO (before onboarding real tenant secrets in production):** this is a
single symmetric key from an env var — the minimum viable "never plaintext
in Postgres" bar for Phase 2, not the final design. Before go-live, replace
it with a real secrets manager/KMS (per-tenant data keys, rotation, an audit
log of decrypt calls). No migration, seed file, or test fixture in this
repo contains a real API key/secret — tests use `mock` (needs no
credentials) or fabricated values (`faketoken`, `fake_api_key`, etc), and
`.env.example`/`.env.local` only ever hold placeholder/dev-only values.

## Idempotency (webhook retries)

Any telephony provider may retry a webhook delivery on timeout or a 5xx.
`telephony_webhook_events` has `UNIQUE (provider_key, idempotency_key)`. The
SECURITY DEFINER function `process_telephony_webhook_event(...)` (see
`db/migrations/007_provider_registry.sql`, same pattern as the auth
functions in `006_auth_functions.sql`) atomically:

1. Resolves which org a `provider_call_id` belongs to (necessary because a
   webhook arrives with no session/tenant context).
2. `INSERT ... ON CONFLICT (provider_key, idempotency_key) DO NOTHING` into
   the ledger.
3. Only applies the call-status transition if that insert actually happened
   (`was_new`) — a retried delivery of the same event is a guaranteed no-op,
   never a duplicate state transition.

Each adapter's `receiveWebhook()` derives `idempotencyKey` from the
provider's own event/delivery id when one exists (FreJun Teler's
`event_id`), or a SHA-256 hash of the raw body when it doesn't (Plivo sends
no separate event id — a retried delivery has byte-identical params, so the
hash is stable across retries).

`app/api/calls/webhook/[providerKey]/route.ts` wires this together: it
resolves the adapter from the same self-registering map the factory uses
(never branching on `providerKey` itself), verifies the signature via the
adapter, then calls `process_telephony_webhook_event`.

## Reuse in Phase 3 (STT / TTS / LLM) — do not implement yet

`providers.layer` and `tenant_provider_config.layer` already accept `'stt'`,
`'tts'`, `'llm'` (see the `CHECK` constraints in
`db/migrations/007_provider_registry.sql`) — **no migration is needed** to
add those layers. Phase 3 only needs to:

1. Define `STTProvider` / `TTSProvider` / `LLMProvider` interfaces (mirror
   the conceptual Python `Protocol`s already sketched in
   `services/voice-gateway/PROVIDERS.md`) in
   `apps/web/lib/providers/{stt,tts,llm}/types.ts`.
2. Write adapter classes that `registerAdapter("stt.sarvam", ...)` etc., in
   the identical self-registration pattern.
3. Insert `providers` rows for those layers.
4. Call `getProvider<STTProvider>("stt", orgId, userId)` (the generic
   `getProvider` in `registry.ts` already supports any layer — the
   `telephony`-specific `getTelephonyProvider` is a thin convenience
   wrapper around it).

Nothing else changes.
