import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { Client } from "pg";
import { randomUUID, createHmac } from "crypto";
import { POST as leadIntake } from "@/app/api/webhooks/sitesnsign/lead-intake/route";
import { hashSitesnsignToken, encryptSitesnsignSecret } from "@/lib/webhooks/sitesnsignAuth";

/**
 * Proves the sitesnsign.com lead-intake endpoint's auth (bad token/bad
 * signature both rejected), correct field mapping into `leads`, and that
 * it runs through the SAME compliance-gated `createOutboundCall()` as
 * every other call-creation path (docs/SITESNSIGN_INTEGRATION.md) — never
 * a special-cased bypass. Mirrors apps/web/tests/webhooks/n8n.test.ts's
 * proof shape.
 */

const ADMIN_URL =
  process.env.DATABASE_URL_MIGRATE ?? "postgresql://postgres:postgres@localhost:5432/ai_calling_agent";
const TOKEN = "test-sitesnsign-token";
const SECRET = "test-sitesnsign-hmac-secret";

let admin: Client;
let orgId: string;

function sign(body: string): string {
  return `sha256=${createHmac("sha256", SECRET).update(body, "utf8").digest("hex")}`;
}

function req(body: unknown, opts: { token?: string; signature?: string } = {}): NextRequest {
  const raw = JSON.stringify(body);
  const headers: Record<string, string> = { "content-type": "application/json" };
  const token = opts.token ?? TOKEN;
  if (token) headers["x-sitesnsign-token"] = token;
  const signature = opts.signature ?? sign(raw);
  if (signature) headers["x-sitesnsign-signature"] = signature;
  return new NextRequest("http://localhost/api/webhooks/sitesnsign/lead-intake", {
    method: "POST",
    headers,
    body: raw,
  });
}

beforeAll(async () => {
  process.env.PROVIDER_CONFIG_ENCRYPTION_KEY ??= "test-only-encryption-key-do-not-use-in-prod";
  admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  const suffix = randomUUID().slice(0, 8);
  const orgRow = await admin.query("INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id", [
    `Sitesnsign Test Org ${suffix}`,
    `sitesnsign-test-org-${suffix}`,
  ]);
  orgId = orgRow.rows[0].id;
  await admin.query(
    `INSERT INTO tenant_provider_config (org_id, layer, provider_key, is_default, priority, config)
     VALUES ($1, 'telephony', 'mock', true, 1, '{}'::jsonb)`,
    [orgId]
  );
  const enc = encryptSitesnsignSecret(SECRET);
  await admin.query(
    `INSERT INTO sitesnsign_webhook_tokens (org_id, token_hash, hmac_secret_enc) VALUES ($1, $2, $3)`,
    [orgId, hashSitesnsignToken(TOKEN), JSON.stringify(enc)]
  );
});

afterAll(async () => {
  await admin.query("DELETE FROM organizations WHERE id = $1", [orgId]);
  await admin.end();
});

describe("POST /api/webhooks/sitesnsign/lead-intake", () => {
  it("rejects a request with an unknown token", async () => {
    const res = await leadIntake(req({ externalLeadId: "L1", phone: "+919812300000" }, { token: "bogus" }));
    expect(res.status).toBe(401);
  });

  it("rejects a request with a bad HMAC signature (valid token, tampered body)", async () => {
    const res = await leadIntake(
      req({ externalLeadId: "L2", phone: "+919812300001" }, { signature: "sha256=deadbeef" })
    );
    expect(res.status).toBe(401);
  });

  it("creates a correctly-mapped lead on valid input and triggers a compliance-gated call", async () => {
    const externalLeadId = `ext-${randomUUID()}`;
    const res = await leadIntake(
      req({
        externalLeadId,
        buyerName: "Ramesh Kumar",
        phone: "+919812300002",
        source: "sitesnsign_website",
        stage: "new",
        broker: "Broker A",
        listingId: "LST-42",
        requirement: "3BHK in Patna",
        triggerCall: true,
      })
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.lead.id).toBeTruthy();
    expect(body.call).toBeTruthy();

    const { rows } = await admin.query(
      "SELECT org_id, full_name, phone_number, custom_fields FROM leads WHERE id = $1",
      [body.lead.id]
    );
    expect(rows[0].org_id).toBe(orgId);
    expect(rows[0].full_name).toBe("Ramesh Kumar");
    expect(rows[0].phone_number).toBe("+919812300002");
    expect(rows[0].custom_fields.sitesnsign_external_lead_id).toBe(externalLeadId);
    expect(rows[0].custom_fields.listing_id).toBe("LST-42");

    const compliance = await admin.query("SELECT consent_source, consent_status FROM lead_compliance WHERE lead_id = $1", [
      body.lead.id,
    ]);
    expect(compliance.rows[0].consent_source).toBe("sitesnsign_crm");
    expect(compliance.rows[0].consent_status).toBe("granted");
  });

  it("is idempotent on a retried delivery of the same externalLeadId (no duplicate lead/call)", async () => {
    const externalLeadId = `ext-${randomUUID()}`;
    const payload = { externalLeadId, phone: "+919812300003", triggerCall: false };
    const res1 = await leadIntake(req(payload));
    const res2 = await leadIntake(req(payload));
    expect(res1.status).toBe(201);
    expect(res2.status).toBe(200);
    const body1 = await res1.json();
    const body2 = await res2.json();
    expect(body2.lead.id).toBe(body1.lead.id);
    expect(body2.alreadyExisted).toBe(true);

    const { rows } = await admin.query(
      "SELECT count(*)::int AS c FROM leads WHERE org_id = $1 AND custom_fields->>'sitesnsign_external_lead_id' = $2",
      [orgId, externalLeadId]
    );
    expect(rows[0].c).toBe(1);
  });

  it("blocks the call the same way as any other call when compliance fails (opted-out number), but still creates the lead", async () => {
    const externalLeadId = `ext-${randomUUID()}`;
    const phone = "+919812399999";

    // Pre-seed an opted-out record for this phone under this org so the
    // gate blocks it — same technique as
    // apps/web/tests/compliance/gate.test.ts's opt-out proof.
    const { rows: existingLead } = await admin.query(
      `INSERT INTO leads (org_id, phone_number) VALUES ($1, $2) RETURNING id`,
      [orgId, phone]
    );
    await admin.query(
      `INSERT INTO lead_compliance (org_id, lead_id, consent_status, opted_out, opted_out_at)
       VALUES ($1, $2, 'revoked', true, now())`,
      [orgId, existingLead[0].id]
    );

    const res = await leadIntake(req({ externalLeadId, phone, triggerCall: true }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.lead).toBeTruthy();
    expect(body.callBlocked).toBeTruthy();
    expect(body.call).toBeUndefined();
  });
});
