import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "pg";
import { randomUUID } from "crypto";
import { getTelephonyProvider, ProviderNotConfiguredError } from "@/lib/providers/registry";
import { MockTelephonyProvider } from "@/lib/providers/telephony/adapters/mock";
import { PlivoTelephonyProvider } from "@/lib/providers/telephony/adapters/plivo";
import { FreJunTelerTelephonyProvider } from "@/lib/providers/telephony/adapters/frejun-teler";
import { registerAdapter, _unregisterAdapterForTests } from "@/lib/providers/adapter-map";
import { encryptProviderConfig } from "@/lib/providers/crypto";

/**
 * Registry/factory tests — the "no core rewrite to add a provider" proof.
 *
 * Uses a real Postgres connection the same way tenant-isolation.test.ts
 * does: seed as the migration/admin role, exercise as app_user with
 * app.current_org_id set, exactly like production request handling.
 */

const ADMIN_URL =
  process.env.DATABASE_URL_MIGRATE ?? "postgresql://postgres:postgres@localhost:5432/ai_calling_agent";

let admin: Client;
let orgId: string;

beforeAll(async () => {
  process.env.PROVIDER_CONFIG_ENCRYPTION_KEY ??= "test-only-encryption-key-do-not-use-in-prod";

  admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();

  const suffix = randomUUID().slice(0, 8);
  const orgResult = await admin.query("INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id", [
    `Registry Test Org ${suffix}`,
    `registry-test-org-${suffix}`,
  ]);
  orgId = orgResult.rows[0].id;
});

afterAll(async () => {
  await admin.query("DELETE FROM organizations WHERE id = $1", [orgId]);
  await admin.end();
});

async function setDefaultProvider(layer: string, providerKey: string, config: Record<string, unknown> = {}) {
  await admin.query(
    `INSERT INTO tenant_provider_config (org_id, layer, provider_key, is_default, priority, config)
     VALUES ($1, $2, $3, true, 1, $4)`,
    [orgId, layer, providerKey, JSON.stringify(config)]
  );
}

async function clearProviderConfig() {
  await admin.query("DELETE FROM tenant_provider_config WHERE org_id = $1", [orgId]);
}

describe("Provider Registry factory", () => {
  afterAll(clearProviderConfig);

  it("resolves the mock adapter when tenant_provider_config points at 'mock'", async () => {
    await clearProviderConfig();
    await setDefaultProvider("telephony", "mock");
    const provider = await getTelephonyProvider(orgId, null);
    expect(provider).toBeInstanceOf(MockTelephonyProvider);
    expect(provider.providerKey).toBe("mock");
  });

  it("resolves the plivo adapter when tenant_provider_config points at 'plivo'", async () => {
    await clearProviderConfig();
    await setDefaultProvider("telephony", "plivo", {
      auth_id: "MAtest",
      auth_token: "faketoken",
      answer_url: "https://example.com/answer",
    });
    const provider = await getTelephonyProvider(orgId, null);
    expect(provider).toBeInstanceOf(PlivoTelephonyProvider);
    expect(provider.providerKey).toBe("plivo");
  });

  it("resolves the frejun_teler adapter when tenant_provider_config points at 'frejun_teler'", async () => {
    await clearProviderConfig();
    await setDefaultProvider("telephony", "frejun_teler", {
      api_key: "fake",
      account_id: "acct",
      flow_url: "https://example.com/flow",
      status_callback_url: "https://example.com/status",
    });
    const provider = await getTelephonyProvider(orgId, null);
    expect(provider).toBeInstanceOf(FreJunTelerTelephonyProvider);
    expect(provider.providerKey).toBe("frejun_teler");
  });

  it("decrypts an encrypted config envelope before constructing the adapter", async () => {
    await clearProviderConfig();
    const encrypted = encryptProviderConfig({
      auth_id: "MAtest",
      auth_token: "secret-token",
      answer_url: "https://example.com/answer",
    });
    await admin.query(
      `INSERT INTO tenant_provider_config (org_id, layer, provider_key, is_default, priority, config)
       VALUES ($1, 'telephony', 'plivo', true, 1, $2)`,
      [orgId, JSON.stringify(encrypted)]
    );
    const provider = await getTelephonyProvider(orgId, null);
    expect(provider).toBeInstanceOf(PlivoTelephonyProvider);
  });

  it("throws ProviderNotConfiguredError when the tenant has no provider set for the layer", async () => {
    await clearProviderConfig();
    await expect(getTelephonyProvider(orgId, null)).rejects.toBeInstanceOf(ProviderNotConfiguredError);
  });

  it(
    "PROOF: a brand-new provider (new adapter class + a new `providers` row) is resolvable " +
      "by the factory with ZERO changes to registry.ts or any existing adapter",
    async () => {
      // 1) Write a new adapter class right here in the test, exactly the way
      //    a real new-provider PR would add apps/web/lib/providers/telephony/adapters/some-new-vendor.ts.
      //    It self-registers, per the documented pattern — registry.ts is
      //    never touched, never imported anything new, never branches on
      //    this provider's name.
      class FakeTestOnlyTelephonyProvider {
        readonly providerKey = "fake_test_only_vendor";
        constructor(public config: Record<string, unknown>) {}
        async createCall() {
          return { providerCallId: "fake-1", status: "queued" as const };
        }
      }
      registerAdapter("telephony.fake_test_only_vendor", (config) => new FakeTestOnlyTelephonyProvider(config));

      try {
        // 2) Insert the catalog row a real deploy would add via a migration
        //    or an internal admin tool — again, no application code change.
        await admin.query(
          `INSERT INTO providers (layer, provider_key, display_name, adapter_class_identifier, config_schema, status, default_priority, capabilities)
           VALUES ('telephony', 'fake_test_only_vendor', 'Fake Test-Only Vendor', 'telephony.fake_test_only_vendor', '{}'::jsonb, 'active', 999, '{}'::jsonb)
           ON CONFLICT (layer, provider_key) DO NOTHING`
        );

        // 3) Point this tenant at it.
        await clearProviderConfig();
        await setDefaultProvider("telephony", "fake_test_only_vendor");

        // 4) The SAME factory function, completely unmodified, returns an
        //    instance of the brand-new adapter class.
        const provider = (await getTelephonyProvider(orgId, null)) as unknown as InstanceType<
          typeof FakeTestOnlyTelephonyProvider
        >;
        expect(provider).toBeInstanceOf(FakeTestOnlyTelephonyProvider);
        expect(provider.providerKey).toBe("fake_test_only_vendor");
        const result = await provider.createCall();
        expect(result.providerCallId).toBe("fake-1");
      } finally {
        await clearProviderConfig();
        await admin.query("DELETE FROM providers WHERE provider_key = 'fake_test_only_vendor'");
        _unregisterAdapterForTests("telephony.fake_test_only_vendor");
      }
    }
  );
});
