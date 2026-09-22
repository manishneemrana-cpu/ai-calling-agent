import type { PoolClient } from "pg";
import { withTenant } from "../db/tenant";
import { decryptProviderConfig, isEncryptedConfig } from "./crypto";
import { resolveAdapterFactory } from "./adapter-map";
import type { TelephonyProvider } from "./telephony/types";
import type { WhatsAppProvider } from "./whatsapp/types";

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

export type Layer = "telephony" | "stt" | "tts" | "llm" | "whatsapp";

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
  opts: { providerKey?: string } = {}
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

export async function getProvider<T>(
  layer: Layer,
  orgId: string,
  userId: string | null,
  opts: { providerKey?: string } = {}
): Promise<T> {
  return withTenant(orgId, userId, async (client) => {
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
  });
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
