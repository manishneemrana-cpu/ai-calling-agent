import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "pg";
import { randomUUID } from "crypto";
import { getWhatsAppProvider, ProviderNotConfiguredError } from "@/lib/providers/registry";
import { MockWhatsAppProvider } from "@/lib/providers/whatsapp/adapters/mock";
import { InteraktWhatsAppProvider } from "@/lib/providers/whatsapp/adapters/interakt";
import { registerAdapter, _unregisterAdapterForTests } from "@/lib/providers/adapter-map";

/**
 * WhatsApp layer registry/factory tests — same "no core rewrite to add a
 * provider" proof as apps/web/tests/providers/registry.test.ts (Phase 2),
 * applied to the Phase 6 `whatsapp` layer.
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
    `WhatsApp Registry Test Org ${suffix}`,
    `whatsapp-registry-test-org-${suffix}`,
  ]);
  orgId = orgResult.rows[0].id;
});

afterAll(async () => {
  await admin.query("DELETE FROM organizations WHERE id = $1", [orgId]);
  await admin.end();
});

async function setDefaultProvider(providerKey: string, config: Record<string, unknown> = {}) {
  await admin.query(
    `INSERT INTO tenant_provider_config (org_id, layer, provider_key, is_default, priority, config)
     VALUES ($1, 'whatsapp', $2, true, 1, $3)`,
    [orgId, providerKey, JSON.stringify(config)]
  );
}

async function clearProviderConfig() {
  await admin.query("DELETE FROM tenant_provider_config WHERE org_id = $1 AND layer = 'whatsapp'", [orgId]);
}

describe("WhatsApp Provider Registry factory", () => {
  afterAll(clearProviderConfig);

  it("resolves the mock adapter when tenant_provider_config points at 'mock'", async () => {
    await clearProviderConfig();
    await setDefaultProvider("mock");
    const provider = await getWhatsAppProvider(orgId, null);
    expect(provider).toBeInstanceOf(MockWhatsAppProvider);
    expect(provider.providerKey).toBe("mock");
  });

  it("resolves the interakt adapter when tenant_provider_config points at 'interakt'", async () => {
    await clearProviderConfig();
    await setDefaultProvider("interakt", { api_key: "fake", waba_id: "waba_1" });
    const provider = await getWhatsAppProvider(orgId, null);
    expect(provider).toBeInstanceOf(InteraktWhatsAppProvider);
    expect(provider.providerKey).toBe("interakt");
  });

  it("throws ProviderNotConfiguredError when the tenant has no whatsapp provider set", async () => {
    await clearProviderConfig();
    await expect(getWhatsAppProvider(orgId, null)).rejects.toBeInstanceOf(ProviderNotConfiguredError);
  });

  it(
    "PROOF: a brand-new WhatsApp provider (new adapter class + a new `providers` row) is " +
      "resolvable by the factory with ZERO changes to registry.ts or any existing adapter",
    async () => {
      class FakeTestOnlyWhatsAppProvider {
        readonly providerKey = "fake_test_only_wa_vendor";
        constructor(public config: Record<string, unknown>) {}
        async sendReminder() {
          return { providerMessageId: "fake-wa-1", status: "sent" as const };
        }
      }
      registerAdapter("whatsapp.fake_test_only_wa_vendor", (config) => new FakeTestOnlyWhatsAppProvider(config));

      try {
        await admin.query(
          `INSERT INTO providers (layer, provider_key, display_name, adapter_class_identifier, config_schema, status, default_priority, capabilities)
           VALUES ('whatsapp', 'fake_test_only_wa_vendor', 'Fake Test-Only WA Vendor', 'whatsapp.fake_test_only_wa_vendor', '{}'::jsonb, 'active', 999, '{}'::jsonb)
           ON CONFLICT (layer, provider_key) DO NOTHING`
        );

        await clearProviderConfig();
        await setDefaultProvider("fake_test_only_wa_vendor");

        const provider = (await getWhatsAppProvider(orgId, null)) as unknown as InstanceType<
          typeof FakeTestOnlyWhatsAppProvider
        >;
        expect(provider).toBeInstanceOf(FakeTestOnlyWhatsAppProvider);
        expect(provider.providerKey).toBe("fake_test_only_wa_vendor");
        const result = await provider.sendReminder();
        expect(result.providerMessageId).toBe("fake-wa-1");
      } finally {
        await clearProviderConfig();
        await admin.query("DELETE FROM providers WHERE provider_key = 'fake_test_only_wa_vendor'");
        _unregisterAdapterForTests("whatsapp.fake_test_only_wa_vendor");
      }
    }
  );
});
