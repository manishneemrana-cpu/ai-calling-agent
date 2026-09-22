# Load Testing (Phase 9)

## Tool choice

This sandbox has no live provider credentials (no real Plivo/FreJun/Deepgram/
Sarvam/Groq/Gemini/Razorpay accounts), so a load test against real providers
is not possible here — it belongs on the pre-launch checklist (see "What
this can't prove" below). What IS possible, and what the Phase 9 spec asks
for, is a real, runnable concurrency test of the **mock-adapter path**:
call creation → mock telephony → mock STT/LLM/TTS → cost/latency recording,
through the exact same application code every real call goes through.

We deliberately did **not** reach for k6 or Artillery:

- Neither is installed in this sandbox, and adding new tooling/infra just to
  run a bounded, one-off concurrency proof is not worth the footprint.
- k6/Artillery drive load over HTTP. This app's Next.js dev/prod server
  would have to be running, and the measurement would mostly capture
  HTTP/Node-loopback overhead, not the actual code paths (RLS-scoped
  transactions, the compliance/wallet gates, the provider registry, the
  orchestrator) that Phase 9 needs proven safe under concurrency.
- Both runtimes already have first-class concurrent-test infrastructure
  (Vitest + real Postgres on the TS side, pytest-asyncio + real Postgres on
  the Python side). A **custom concurrent-request script written as a test
  file** in each runtime, firing `Promise.allSettled` / `asyncio.gather`
  batches of the real production functions, is simpler, needs zero new
  dependencies, and measures the real thing.

This is the "simple custom concurrent-request script" option the spec
explicitly allows, applied natively to each runtime.

## What was run

| Harness | Path exercised | File |
|---|---|---|
| TS / apps-web | `createOutboundCall()` — the ONE function every real call-creation path uses: compliance gate → wallet gate → mock telephony adapter → `calls` row insert | `apps/web/tests/loadtest/call-creation-load.test.ts` |
| Python / voice-gateway | `ConversationOrchestrator.run_turn()` — the real per-call turn: MockSTT → MockLLM → MockTTS → `call_latency_metrics` writes (Phase 9's newly-wired latency recording) | `services/voice-gateway/tests/loadtest/test_pipeline_load.py` |
| TS / apps-web | Concurrent wallet debits against ONE wallet (`applyWalletTransaction`) — the classic lost-update race condition class | `apps/web/tests/billing/wallet-concurrency.test.ts` |

Both harnesses spread requests across 5 distinct tenant orgs and verify
per-org row counts afterward (tenant isolation under load), and verify no
`provider_call_id` collisions (idempotency under concurrent creation).

Run with `LOADTEST_CONCURRENCY=<n> npx vitest run tests/loadtest/call-creation-load.test.ts`
(TS) and `LOADTEST_CONCURRENCY=<n> python -m pytest tests/loadtest/test_pipeline_load.py -s`
(Python). Default is 100 if unset.

## Real numbers from this run (this sandbox's single Postgres instance, default `pg`/`asyncpg` pool sizes)

### Call creation (TS, mock telephony + real compliance/wallet gates)

| Concurrency | Wall clock | Throughput | p50 | p95 | Errors |
|---|---|---|---|---|---|
| 100 | 82–155 ms | ~650–1200 req/s | ~55–106 ms | ~76–150 ms | 0/100 |
| 200 | 233 ms | 858 req/s | 150 ms | 224 ms | 0/200 |

### Pipeline turns (Python, MockSTT/MockLLM/MockTTS + real latency writes)

| Concurrency | Wall clock | Throughput | p50 | p95 | Errors |
|---|---|---|---|---|---|
| 150 | 0.47 s | 319 turns/s | 395 ms | 453 ms | 0/150 |
| 200 | 0.64 s | 313 turns/s | 536 ms | 604 ms | 0/200 |

### Wallet concurrency (the targeted race-condition proof)

30 concurrent `applyWalletTransaction` debits of ₹5 each against a wallet
that starts at ₹100 (only 20 can possibly succeed): **exactly 20 succeeded,
10 correctly rejected with `InsufficientBalanceError`, final balance exactly
₹0** (never negative, never left with slack), exactly 20 ledger rows.

## Two real concurrency bugs this load test found and fixed

Running these harnesses at real concurrency (not just the 1-2 concurrent
calls prior test suites exercised) surfaced two genuine bugs — exactly the
class of bug the spec called out ("a common class of bug that only shows up
under concurrency"):

1. **Wallet lost-update race** (`apps/web/lib/billing/wallet.ts`):
   `getOrCreateWallet`'s balance read had no row lock. Reproduced directly:
   with the lock removed, all 30 concurrent ₹5 debits against a ₹100 wallet
   "succeeded" (30×₹5 = ₹150 debited from a ₹100 wallet — a real overdraft).
   **Fix**: `SELECT ... FOR UPDATE` on the wallet row inside
   `applyWalletTransaction`'s transaction, serializing concurrent debits for
   the same org. Verified fixed by `wallet-concurrency.test.ts` above (and
   verified it reproduces the bug when the lock is removed).

2. **Connection-pool deadlock in `createOutboundCall`** (`apps/web/lib/calls/createCall.ts` +
   `apps/web/lib/providers/registry.ts`): the compliance/wallet gates ran
   inside one `withTenant()` transaction (holding one pooled connection),
   then `getTelephonyProvider()` opened a **second**, nested `withTenant()`
   (a second `pool.connect()`) to resolve the provider. At concurrency ≥ the
   `pg.Pool` default `max` (10), every in-flight request grabs its outer
   connection and then blocks forever waiting for an inner connection from
   the same exhausted pool — a real deadlock (reproduced: the test hung
   until Vitest's 120s timeout at concurrency=100, before the fix).
   **Fix**: `getProvider()` now accepts an already-open `PoolClient` and
   reuses it instead of opening a second connection; `createOutboundCall`
   passes its own transaction's client through. Verified fixed above (0
   errors at concurrency 100 and 200).

3. **Pool-creation race in the Python `asyncpg` pool** (`services/voice-gateway/voice_gateway/db.py`):
   `get_pool()`'s `if _pool is None: _pool = await asyncpg.create_pool(...)`
   was not guarded — many concurrent first-callers could all observe
   `_pool is None` and each start their own 10-connection pool
   simultaneously, exhausting Postgres's `max_connections` before any of
   them finished (reproduced: `TooManyConnectionsError` at concurrency 150
   on a fresh process). **Fix**: an `asyncio.Lock` guards pool creation
   (double-checked locking). Verified fixed above (0 errors at concurrency
   150 and 200).

## What this proves

- The mock-adapter path is correct and safe under real concurrent load: no
  errors, no crashes, no hangs, at 100–200 concurrent operations on a single
  small Postgres instance.
- **Tenant isolation holds under concurrent load**: each org's row count
  after a concurrent batch matches exactly what was routed to it — no
  cross-tenant leakage, verified directly against the database, not just
  application-level assumptions.
- **Idempotency/uniqueness holds under concurrent load**: no
  `provider_call_id` collisions across concurrently-created calls.
- **The wallet-deduction path has no lost-update race condition** (after
  the fix above) — the highest-value correctness proof in this phase, since
  a silent double-spend or overdraft on the billing ledger would be a real
  production incident, not a cosmetic bug.
- Real throughput/latency numbers for the mock path, useful as a rough
  baseline for "how much headroom does the plumbing itself have" separate
  from real provider latency.

## What this can't prove (pre-launch checklist item, not buildable now)

- **Real provider behavior under load**: no live Plivo/FreJun/Deepgram/
  Sarvam/Groq/Gemini/Razorpay credentials exist in this sandbox. Real STT/
  TTS/LLM latency, real telephony carrier behavior under concurrent calls,
  real webhook delivery timing/retries, and real payment-gateway webhook
  volume are all unmeasured here — the mock adapters are deterministic,
  near-zero-latency stand-ins by design (see Phase 2/3's own scope notes).
- **Real network conditions**: no packet loss, jitter, DNS flakiness, or
  cross-region latency is simulated.
- **Sustained/soak load**: this is a burst test (all requests fired near-
  simultaneously), not a sustained-throughput test over minutes/hours —
  connection pool exhaustion, memory growth, or slow leaks under sustained
  load are not covered.
- **Multi-process/horizontal-scale behavior**: this runs against a single
  voice-gateway process and a single Next.js process, matching this phase's
  documented single-process scope (see `PipelineManager`'s own "Deferred"
  note in `orchestrator/pipeline.py`) — a real deployment's multi-instance
  behavior (shared session state, load balancer behavior) is untested.
- **Realistic pool/infra sizing for production traffic**: this sandbox uses
  each runtime's small default connection-pool size. Before real launch,
  pool sizes, Postgres `max_connections`, and infra capacity need sizing
  against actual expected call volume — this test only proves correctness
  at the concurrency levels run, not capacity planning for a specific
  target load.

**Action item for the pre-launch checklist**: once live provider credentials
exist for at least one telephony/STT/TTS/LLM vendor each, re-run an
equivalent load test against the real adapters (start small — single-digit
concurrent real calls — before scaling up) to validate real-world latency
and error rates, and run a sustained soak test, not just a burst test.
