import type { PoolClient } from "pg";
import { withTenant } from "../db/tenant";
import { decryptProviderConfig, isEncryptedConfig } from "./crypto";
import { resolveAdapterFactory } from "./adapter-map";
import { writeFailoverEvent } from "./failoverEvents";
import type { Layer } from "./registry";

/**
 * Phase 9 provider failover — the TS side of the SAME conceptual pattern as
 * `voice_gateway/providers/failover.py`. `tenant_provider_config.priority`
 * (Phase 2, see 007_provider_registry.sql) already ranks every provider
 * configured for a (org_id, layer); this walks that ranked list, invoking a
 * caller-supplied `operation(provider)` against each candidate in turn until
 * one succeeds. Any thrown error or timeout counts as that candidate
 * failing — logs a `provider_failover_events` row and moves to the
 * next-priority provider, capped at `maxAttempts` so a broken configuration
 * fails loudly (AllProvidersFailedError) instead of hanging or cascading
 * forever.
 */

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_ATTEMPTS = 3;

export class NoProvidersConfiguredError extends Error {
  constructor(orgId: string, layer: Layer) {
    super(`No providers configured for org ${orgId} at layer ${layer}`);
    this.name = "NoProvidersConfiguredError";
  }
}

export class AllProvidersFailedError extends Error {
  constructor(
    orgId: string,
    layer: Layer,
    public readonly attempts: { providerKey: string; reason: string }[]
  ) {
    const detail = attempts.map((a) => `${a.providerKey}: ${a.reason}`).join("; ");
    super(`All ${attempts.length} configured provider(s) for org ${orgId} layer ${layer} failed: ${detail}`);
    this.name = "AllProvidersFailedError";
  }
}

type Candidate = {
  provider_key: string;
  config: unknown;
  adapter_class_identifier: string;
};

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

/**
 * Runs `operation(providerInstance)` against the tenant's highest-priority
 * configured provider for `layer`; on exception/timeout, logs a failover
 * event and retries the next-priority provider, up to `maxAttempts`
 * candidates. Returns `{ result, providerKey }` on success.
 */
export async function callWithFailover<TProvider, TResult>(
  layer: Layer,
  orgId: string,
  userId: string | null,
  operation: (provider: TProvider) => Promise<TResult>,
  opts: { callId?: string | null; timeoutMs?: number; maxAttempts?: number } = {}
): Promise<{ result: TResult; providerKey: string }> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;

  const candidates = await withTenant(orgId, userId, async (client: PoolClient) => {
    const { rows } = await client.query<Candidate>(
      `SELECT tpc.provider_key, tpc.config, p.adapter_class_identifier
         FROM tenant_provider_config tpc
         JOIN providers p ON p.layer = tpc.layer AND p.provider_key = tpc.provider_key
        WHERE tpc.org_id = $1 AND tpc.layer = $2
        ORDER BY tpc.is_default DESC, tpc.priority ASC`,
      [orgId, layer]
    );
    return rows;
  });

  if (candidates.length === 0) {
    throw new NoProvidersConfiguredError(orgId, layer);
  }

  const attempted = candidates.slice(0, maxAttempts);
  const failures: { providerKey: string; reason: string }[] = [];

  for (let i = 0; i < attempted.length; i++) {
    const candidate = attempted[i];
    try {
      const factory = resolveAdapterFactory(candidate.adapter_class_identifier);
      if (!factory) {
        throw new Error(`No adapter registered for identifier "${candidate.adapter_class_identifier}"`);
      }
      const config = decryptConfigIfNeeded(candidate.config);
      const provider = factory(config) as TProvider;

      const result = await withTimeout(operation(provider), timeoutMs);
      return { result, providerKey: candidate.provider_key };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      failures.push({ providerKey: candidate.provider_key, reason: `exception: ${reason}` });

      const next = attempted[i + 1];
      if (next) {
        await writeFailoverEvent({
          orgId,
          layer,
          fromProvider: candidate.provider_key,
          toProvider: next.provider_key,
          reason: `exception: ${reason}`,
          callId: opts.callId ?? null,
        });
      }
    }
  }

  const last = failures[failures.length - 1];
  await writeFailoverEvent({
    orgId,
    layer,
    fromProvider: last.providerKey,
    toProvider: last.providerKey,
    reason: `all_providers_exhausted: ${last.reason}`,
    callId: opts.callId ?? null,
  });
  throw new AllProvidersFailedError(orgId, layer, failures);
}

function decryptConfigIfNeeded(config: unknown): Record<string, unknown> {
  if (isEncryptedConfig(config)) {
    return decryptProviderConfig(config);
  }
  return (config as Record<string, unknown>) ?? {};
}
