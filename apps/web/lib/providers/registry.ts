import type { PoolClient } from "pg";
import { withTenant } from "../db/tenant";
import { decryptProviderConfig, isEncryptedConfig } from "./crypto";
import { resolveAdapterFactory } from "./adapter-map";
import type { TelephonyProvider } from "./telephony/types";
import type { WhatsAppProvider } from "./whatsapp/types";
import type { PaymentGatewayProvider } from "./payment_gateway/types";

// Import every built-in adapter module once, for its side-effecting
// registerAdapter() call. This file is the ONLY place that needs to know
// the built-in adapters exist at all — everything below this import list is
// generic and layer-agnostic. Adding a new provider never touches this
// import list's *logic*, only adds one more side-effect import (or, for a
// provider loaded from a plugin package in a later phase, nothing here at
// all — see docs/PROVIDER_REGISTRY.md).
import "./telephony/adapters/mock";
import "./telephony/adapters/plivo";
import "./telephony/adapters/frejun-teler";
import "./whatsapp/adapters/mock";
import "./whatsapp/adapters/interakt";
import "./payment_gateway/adapters/mock";
import "./payment_gateway/adapters/razorpay";

export type Layer = "telephony" | "stt" | "tts" | "llm" | "whatsapp" | "payment_gateway";

export class ProviderNotConfiguredError extends Error {
  constructor(orgId: string, layer: Layer) {
    super(`No ${layer} provider configured for org ${orgId}`);
    this.name = "ProviderNotConfiguredError";
  }
}

export class ProviderNotRegisteredError extends Error {
  constructor(identifier: string) {
    super(`No adapter registered for identifier "${identifier}" — is its module imported?`);
    this.name = "ProviderNotRegisteredError";
  }
}

type ProviderRow = {
  provider_key: string;
  adapter_class_identifier: string;
};

type TenantProviderConfigRow = {
  provider_key: string;
  config: unknown;
  adapter_class_identifier: string;
};

/**
 * Resolves the tenant's default (or explicitly requested) provider at a
 * given layer and instantiates its adapter. This is the ONLY function
 * calling code (API routes, server actions) should use to obtain a
 * provider — never `new PlivoTelephonyProvider(...)` directly, and never a
 * switch/if-else on providerKey. See docs/PROVIDER_REGISTRY.md.
 */
export async function getTelephonyProvider(
  orgId: string,
  userId: string | null,
  opts: { providerKey?: string; client?: PoolClient } = {}
): Promise<TelephonyProvider> {
  return getProvider<TelephonyProvider>("telephony", orgId, userId, opts);
}

export async function getWhatsAppProvider(
  orgId: string,
  userId: string | null,
  opts: { providerKey?: string } = {}
): Promise<WhatsAppProvider> {
  return getProvider<WhatsAppProvider>("whatsapp", orgId, userId, opts);
}

export async function getPaymentGatewayProvider(
  orgId: string,
  userId: string | null,
  opts: { providerKey?: string } = {}
): Promise<PaymentGatewayProvider> {
  return getProvider<PaymentGatewayProvider>("payment_gateway", orgId, userId, opts);
}

export async function getProvider<T>(
  layer: Layer,
  orgId: string,
  userId: string | null,
  opts: { providerKey?: string; client?: PoolClient } = {}
): Promise<T> {
  const resolve = async (client: PoolClient): Promise<T> => {
    const row = await loadTenantProviderConfig(client, orgId, layer, opts.providerKey);
    if (!row) {
      throw new ProviderNotConfiguredError(orgId, layer);
    }
    const factory = resolveAdapterFactory(row.adapter_class_identifier);
    if (!factory) {
      throw new ProviderNotRegisteredError(row.adapter_class_identifier);
    }
    const config = decryptConfigIfNeeded(row.config);
    return factory(config) as T;
  };

  // Phase 9 concurrency fix: when the caller is ALREADY inside a
  // withTenant() transaction (e.g. createOutboundCall — see
  // lib/calls/createCall.ts), reuse that same PoolClient instead of
  // opening a second, nested `withTenant()` (a second `pool.connect()`).
  // Under concurrent load equal to or above the pool's `max` size, every
  // in-flight outer transaction holding a connection while ALSO waiting
  // on a second (inner) connection from the SAME exhausted pool is a
  // connection-pool deadlock — none of them can ever get their second
  // connection because none of them ever release their first. This was
  // found for real by the Phase 9 load test (docs/LOAD_TESTING.md) at
  // concurrency >= the pool's default max (10): every request hung
  // until the test timed out. Passing `opts.client` through is the fix;
  // every existing call site that doesn't pass one keeps opening its own
  // `withTenant()` exactly as before, so this is purely additive.
  if (opts.client) {
    return resolve(opts.client);
  }
  return withTenant(orgId, userId, resolve);
}

async function loadTenantProviderConfig(
  client: PoolClient,
  orgId: string,
  layer: Layer,
  providerKey?: string
): Promise<TenantProviderConfigRow | null> {
  if (providerKey) {
    const { rows } = await client.query<TenantProviderConfigRow>(
      `SELECT tpc.provider_key, tpc.config, p.adapter_class_identifier
         FROM tenant_provider_config tpc
         JOIN providers p ON p.layer = tpc.layer AND p.provider_key = tpc.provider_key
        WHERE tpc.org_id = $1 AND tpc.layer = $2 AND tpc.provider_key = $3
        LIMIT 1`,
      [orgId, layer, providerKey]
    );
    return rows[0] ?? null;
  }

  const { rows } = await client.query<TenantProviderConfigRow>(
    `SELECT tpc.provider_key, tpc.config, p.adapter_class_identifier
       FROM tenant_provider_config tpc
       JOIN providers p ON p.layer = tpc.layer AND p.provider_key = tpc.provider_key
      WHERE tpc.org_id = $1 AND tpc.layer = $2
      ORDER BY tpc.is_default DESC, tpc.priority ASC
      LIMIT 1`,
    [orgId, layer]
  );
  return rows[0] ?? null;
}

function decryptConfigIfNeeded(config: unknown): Record<string, unknown> {
  if (isEncryptedConfig(config)) {
    return decryptProviderConfig(config);
  }
  // The mock provider (and any provider needing zero credentials) may
  // legitimately have an empty, non-encrypted `{}` config.
  return (config as Record<string, unknown>) ?? {};
}

/** Lists the platform-wide provider catalog for a layer (admin/UI use). */
export async function listProviders(client: PoolClient, layer: Layer): Promise<ProviderRow[]> {
  const { rows } = await client.query<ProviderRow>(
    `SELECT provider_key, adapter_class_identifier FROM providers WHERE layer = $1 AND status != 'inactive' ORDER BY default_priority ASC`,
    [layer]
  );
  return rows;
}
