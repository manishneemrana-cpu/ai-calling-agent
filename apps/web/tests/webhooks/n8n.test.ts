import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { Client } from "pg";
import { randomUUID } from "crypto";
import { POST as leadIntake } from "@/app/api/webhooks/n8n/lead-intake/route";
import { POST as crmLeadCall } from "@/app/api/webhooks/n8n/crm-lead-call/route";
import { POST as qualifiedLeadWhatsapp } from "@/app/api/webhooks/n8n/qualified-lead-whatsapp/route";
import { GET as dueAppointments } from "@/app/api/webhooks/n8n/due-appointments/route";
import { GET as dailySummary } from "@/app/api/webhooks/n8n/daily-summary/route";
import { MockWhatsAppProvider } from "@/lib/providers/whatsapp/adapters/mock";
import { hashN8nToken } from "@/lib/webhooks/n8n-auth";

const ADMIN_URL =
  process.env.DATABASE_URL_MIGRATE ?? "postgresql://postgres:postgres@localhost:5432/ai_calling_agent";
// This org's own per-tenant token (db/migrations/016_gap_closing_pass.sql)
// — gap-closing pass: no more platform-wide shared secret. A second org's
// token is set up separately below to prove cross-tenant isolation.
const SECRET = "test-n8n-per-tenant-token";
const OTHER_ORG_SECRET = "test-n8n-per-tenant-token-other-org";

let admin: Client;
let orgId: string;
let otherOrgId: string;

beforeAll(async () => {
  process.env.PROVIDER_CONFIG_ENCRYPTION_KEY ??= "test-only-encryption-key-do-not-use-in-prod";
  admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  const suffix = randomUUID().slice(0, 8);
  const orgRow = await admin.query("INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id", [
    `n8n Webhook Test Org ${suffix}`,
    `n8n-webhook-test-org-${suffix}`,
  ]);
  orgId = orgRow.rows[0].id;
  await admin.query(
    `INSERT INTO tenant_provider_config (org_id, layer, provider_key, is_default, priority, config) VALUES
      ($1, 'telephony', 'mock', true, 1, '{}'::jsonb),
      ($1, 'whatsapp', 'mock', true, 1, '{}'::jsonb)`,
    [orgId]
  );
  await admin.query("INSERT INTO n8n_webhook_tokens (org_id, token_hash) VALUES ($1, $2)", [
    orgId,
    hashN8nToken(SECRET),
  ]);

  const otherOrgRow = await admin.query("INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id", [
    `n8n Webhook Test Other Org ${suffix}`,
    `n8n-webhook-test-other-org-${suffix}`,
  ]);
  otherOrgId = otherOrgRow.rows[0].id;
  await admin.query("INSERT INTO n8n_webhook_tokens (org_id, token_hash) VALUES ($1, $2)", [
    otherOrgId,
    hashN8nToken(OTHER_ORG_SECRET),
  ]);
});

afterAll(async () => {
  await admin.query("DELETE FROM organizations WHERE id = $1", [orgId]);
  await admin.query("DELETE FROM organizations WHERE id = $1", [otherOrgId]);
  await admin.end();
});

beforeEach(() => {
  MockWhatsAppProvider._resetForTests();
});

function req(url: string, body?: unknown, token = SECRET): NextRequest {
  return new NextRequest(url, {
    method: body === undefined ? "GET" : "POST",
    headers: token ? { "x-n8n-webhook-token": token, "content-type": "application/json" } : {},
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("n8n control-plane webhooks", () => {
  it("rejects every endpoint without a valid per-tenant token", async () => {
    const badReq = req("http://localhost/api/webhooks/n8n/lead-intake", { orgId, phoneNumber: "+91" }, "wrong");
    const res = await leadIntake(badReq);
    expect(res.status).toBe(401);
  });

  it(
    "gap-closing fix: a caller-supplied orgId in the body is IGNORED — the org is always the one " +
      "the token resolves to, so a leaked/guessed orgId cannot redirect a request to another tenant",
    async () => {
      const res = await leadIntake(
        req(
          "http://localhost/api/webhooks/n8n/lead-intake",
          { orgId: otherOrgId, fullName: "Spoofed Org Lead", phoneNumber: "+919812355555", triggerCall: false },
          SECRET // this org's own token, but claiming to act as `otherOrgId` in the body
        )
      );
      expect(res.status).toBe(201);
      const body = await res.json();

      const { rows } = await admin.query("SELECT org_id FROM leads WHERE id = $1", [body.lead.id]);
      expect(rows[0].org_id).toBe(orgId); // created under the TOKEN's org, never the spoofed body orgId
      expect(rows[0].org_id).not.toBe(otherOrgId);
    }
  );

  it("one org's token cannot be used to address another org's per-tenant-token-resolved data at all", async () => {
    const res = await leadIntake(
      req(
        "http://localhost/api/webhooks/n8n/lead-intake",
        { fullName: "Other Org Lead", phoneNumber: "+919812366666", triggerCall: false },
        OTHER_ORG_SECRET
      )
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    const { rows } = await admin.query("SELECT org_id FROM leads WHERE id = $1", [body.lead.id]);
    expect(rows[0].org_id).toBe(otherOrgId);
  });

  it("lead-intake creates a lead with 7-day web_form consent and places a call through the compliance-gated path", async () => {
    const res = await leadIntake(
      req("http://localhost/api/webhooks/n8n/lead-intake", {
        orgId,
        fullName: "Website Lead",
        phoneNumber: "+919812300000",
        fromNumber: "+919999999999",
      })
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.lead.id).toBeTruthy();
    expect(body.call).toBeTruthy();

    const { rows } = await admin.query(
      "SELECT consent_status, consent_source FROM lead_compliance WHERE lead_id = $1",
      [body.lead.id]
    );
    expect(rows[0]).toMatchObject({ consent_status: "granted", consent_source: "web_form" });
  });

  it("crm-lead-call is blocked by the compliance gate for a lead with no consent on file", async () => {
    const leadRow = await admin.query(
      "INSERT INTO leads (org_id, full_name, phone_number) VALUES ($1, 'No Consent Lead', '+919812399999') RETURNING id",
      [orgId]
    );
    const res = await crmLeadCall(
      req("http://localhost/api/webhooks/n8n/crm-lead-call", {
        orgId,
        leadId: leadRow.rows[0].id,
        toNumber: "+919812399999",
        fromNumber: "+919999999999",
      })
    );
    expect(res.status).toBe(403);
  });

  it("qualified-lead-whatsapp sends via the WhatsApp registry and logs to whatsapp_messages", async () => {
    const leadRow = await admin.query("INSERT INTO leads (org_id, full_name) VALUES ($1, 'Qualified Lead') RETURNING id", [
      orgId,
    ]);
    const res = await qualifiedLeadWhatsapp(
      req("http://localhost/api/webhooks/n8n/qualified-lead-whatsapp", {
        orgId,
        leadId: leadRow.rows[0].id,
        toNumber: "+919812311111",
      })
    );
    expect(res.status).toBe(201);
    expect(MockWhatsAppProvider._sentForTests()).toHaveLength(1);

    const { rows } = await admin.query("SELECT count(*)::int AS c FROM whatsapp_messages WHERE lead_id = $1", [
      leadRow.rows[0].id,
    ]);
    expect(rows[0].c).toBe(1);
  });

  it("due-appointments lists only appointments within the window with no reminder sent yet", async () => {
    const leadRow = await admin.query("INSERT INTO leads (org_id, full_name) VALUES ($1, 'Appt Lead') RETURNING id", [
      orgId,
    ]);
    await admin.query(
      `INSERT INTO appointments (org_id, lead_id, type, scheduled_at) VALUES ($1, $2, 'demo', now() + interval '2 hours')`,
      [orgId, leadRow.rows[0].id]
    );
    const res = await dueAppointments(
      req(`http://localhost/api/webhooks/n8n/due-appointments?orgId=${orgId}&withinHours=24`)
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.appointments.length).toBeGreaterThanOrEqual(1);
  });

  it("daily-summary returns today's counts for the org", async () => {
    const res = await dailySummary(req(`http://localhost/api/webhooks/n8n/daily-summary?orgId=${orgId}`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.summary).toMatchObject({ date: expect.any(String) });
    expect(typeof body.summary.newLeadsToday).toBe("number");
  });
});
