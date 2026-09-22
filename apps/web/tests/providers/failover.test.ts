import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { Client } from "pg";
import { randomUUID } from "crypto";
import { callWithFailover, AllProvidersFailedError } from "@/lib/providers/failover";
import { registerAdapter, _unregisterAdapterForTests } from "@/lib/providers/adapter-map";

/**
 * Phase 9 provider failover proofs (TS/apps-web side) — mirrors
 * services/voice-gateway/tests/providers/test_failover.py exactly:
 *   1. primary throws -> automatic fallback to next-priority provider,
 *      operation still succeeds.
 *   2. every configured provider fails -> a clear AllProvidersFailedError,
 *      not a silent hang/crash.
 *   3. each failover writes a correctly-populated
 *      `provider_failover_events` row.
 */

const ADMIN_URL =
  process.env.DATABASE_URL_MIGRATE ?? "postgresql://postgres:postgres@localhost:5432/ai_calling_agent";

let admin: Client;
let orgId: string;

class AlwaysFailsTelephony {
  readonly providerKey = "test_failover_primary";
}
class AlwaysWorksTelephony {
  readonly providerKey = "test_failover_fallback";
}

beforeAll(async () => {
  process.env.PROVIDER_CONFIG_ENCRYPTION_KEY ??= "test-only-encryption-key-do-not-use-in-prod";
  admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();

  const suffix = randomUUID().slice(0, 8);
  const orgResult = await admin.query("INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id", [
    `Failover Test Org ${suffix}`,
    `failover-test-org-${suffix}`,
  ]);
  orgId = orgResult.rows[0].id;

  registerAdapter("telephony.test_failover_primary", () => new AlwaysFailsTelephony());
  registerAdapter("telephony.test_failover_fallback", () => new AlwaysWorksTelephony());
  await admin.query(
    `INSERT INTO providers (layer, provider_key, display_name, adapter_class_identifier, config_schema, status, default_priority, capabilities)
     VALUES
       ('telephony', 'test_failover_primary', 'Test Failover Primary', 'telephony.test_failover_primary', '{}'::jsonb, 'active', 999, '{}'::jsonb),
       ('telephony', 'test_failover_fallback', 'Test Failover Fallback', 'telephony.test_failover_fallback', '{}'::jsonb, 'active', 999, '{}'::jsonb)
     ON CONFLICT (layer, provider_key) DO NOTHING`
  );
});

afterAll(async () => {
  await admin.query(
    "DELETE FROM providers WHERE provider_key IN ('test_failover_primary', 'test_failover_fallback')"
  );
  await admin.query("DELETE FROM organizations WHERE id = $1", [orgId]);
  await admin.end();
  _unregisterAdapterForTests("telephony.test_failover_primary");
  _unregisterAdapterForTests("telephony.test_failover_fallback");
});

afterEach(async () => {
  await admin.query("DELETE FROM tenant_provider_config WHERE org_id = $1", [orgId]);
  await admin.query("DELETE FROM provider_failover_events WHERE org_id = $1", [orgId]);
});

async function configure(providerKey: string, priority: number, isDefault = false) {
  await admin.query(
    `INSERT INTO tenant_provider_config (org_id, layer, provider_key, is_default, priority, config)
     VALUES ($1, 'telephony', $2, $3, $4, '{}'::jsonb)`,
    [orgId, providerKey, isDefault, priority]
  );
}

describe("provider failover", () => {
  it("falls back to the next-priority provider when the primary throws", async () => {
    await configure("test_failover_primary", 1, true);
    await configure("test_failover_fallback", 2);

    const { result, providerKey } = await callWithFailover<
      AlwaysFailsTelephony | AlwaysWorksTelephony,
      string
    >("telephony", orgId, null, async (provider) => {
      if (provider.providerKey === "test_failover_primary") {
        throw new Error("simulated primary telephony outage");
      }
      return `handled-by-${provider.providerKey}`;
    });

    expect(providerKey).toBe("test_failover_fallback");
    expect(result).toBe("handled-by-test_failover_fallback");

    const { rows } = await admin.query(
      `SELECT layer, from_provider, to_provider, reason FROM provider_failover_events WHERE org_id = $1`,
      [orgId]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].layer).toBe("telephony");
    expect(rows[0].from_provider).toBe("test_failover_primary");
    expect(rows[0].to_provider).toBe("test_failover_fallback");
    expect(rows[0].reason).toContain("simulated primary telephony outage");
  });

  it("surfaces a clear AllProvidersFailedError when every provider fails, not a hang", async () => {
    await configure("test_failover_primary", 1, true);
    await configure("test_failover_fallback", 2);

    await expect(
      callWithFailover("telephony", orgId, null, async () => {
        throw new Error("simulated total outage");
      })
    ).rejects.toBeInstanceOf(AllProvidersFailedError);

    const { rows } = await admin.query(
      `SELECT reason FROM provider_failover_events WHERE org_id = $1 ORDER BY created_at`,
      [orgId]
    );
    expect(rows).toHaveLength(2); // one mid-chain failover + one terminal exhaustion event
    expect(rows[rows.length - 1].reason).toContain("all_providers_exhausted");
  });

  it("a timeout also triggers failover to the next provider", async () => {
    await configure("test_failover_primary", 1, true);
    await configure("test_failover_fallback", 2);

    const { providerKey } = await callWithFailover<AlwaysFailsTelephony | AlwaysWorksTelephony, string>(
      "telephony",
      orgId,
      null,
      async (provider) => {
        if (provider.providerKey === "test_failover_primary") {
          await new Promise((resolve) => setTimeout(resolve, 500)); // longer than the 50ms timeout below
        }
        return "ok";
      },
      { timeoutMs: 50 }
    );

    expect(providerKey).toBe("test_failover_fallback");
  });
});
