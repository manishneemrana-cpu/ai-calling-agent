import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Client } from "pg";
import { randomUUID } from "crypto";
import { assertCallIsCompliant, ComplianceBlockedError } from "@/lib/compliance/gate";
import { createOutboundCall } from "@/lib/calls/createCall";
import { processCampaignDialJob } from "@/lib/campaigns/dialer";
import { withTenant } from "@/lib/db/tenant";

/**
 * The compliance gate proof suite: every known call-creation path in this
 * codebase — (1) the direct/manual `createOutboundCall()` that
 * `POST /api/calls` wraps, and (2) the campaign dialer's job handler — is
 * blocked by the SAME gate when consent/DND/opt-out/hours/limits say it
 * should be. There is no third path: nothing else in this codebase inserts
 * into `calls` or calls a telephony provider's createCall().
 */

const ADMIN_URL =
  process.env.DATABASE_URL_MIGRATE ?? "postgresql://postgres:postgres@localhost:5432/ai_calling_agent";

let admin: Client;
let orgId: string;
let leadId: string;

beforeAll(async () => {
  process.env.PROVIDER_CONFIG_ENCRYPTION_KEY ??= "test-only-encryption-key-do-not-use-in-prod";
  admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();

  const suffix = randomUUID().slice(0, 8);
  const orgRow = await admin.query("INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id", [
    `Compliance Test Org ${suffix}`,
    `compliance-test-org-${suffix}`,
  ]);
  orgId = orgRow.rows[0].id;

  await admin.query(
    `INSERT INTO tenant_provider_config (org_id, layer, provider_key, is_default, priority, config)
     VALUES ($1, 'telephony', 'mock', true, 1, '{}'::jsonb)`,
    [orgId]
  );
});

afterAll(async () => {
  await admin.query("DELETE FROM organizations WHERE id = $1", [orgId]);
  await admin.end();
});

beforeEach(async () => {
  await admin.query("DELETE FROM leads WHERE org_id = $1", [orgId]);
  const leadRow = await admin.query(
    "INSERT INTO leads (org_id, full_name, phone_number) VALUES ($1, 'Gate Test Lead', '+919000000000') RETURNING id",
    [orgId]
  );
  leadId = leadRow.rows[0].id;
});

async function setCompliance(fields: Partial<{ consent_status: string; is_dnd: boolean; opted_out: boolean; consent_expires_at: Date | null }>) {
  await admin.query("DELETE FROM lead_compliance WHERE lead_id = $1", [leadId]);
  await admin.query(
    `INSERT INTO lead_compliance (org_id, lead_id, consent_status, is_dnd, opted_out, consent_expires_at, consent_captured_at)
     VALUES ($1, $2, $3, $4, $5, $6, now())`,
    [
      orgId,
      leadId,
      fields.consent_status ?? "granted",
      fields.is_dnd ?? false,
      fields.opted_out ?? false,
      fields.consent_expires_at ?? null,
    ]
  );
}

describe("Compliance gate — direct unit checks", () => {
  it("blocks when there is no lead_compliance record at all", async () => {
    await withTenant(orgId, null, async (client) => {
      await expect(
        assertCallIsCompliant(client, { orgId, leadId, toNumber: "+919000000000" })
      ).rejects.toBeInstanceOf(ComplianceBlockedError);
    });
  });

  it("blocks an opted-out lead even with granted consent", async () => {
    await setCompliance({ consent_status: "granted", opted_out: true });
    await withTenant(orgId, null, async (client) => {
      await expect(assertCallIsCompliant(client, { orgId, leadId, toNumber: "+919000000000" })).rejects.toThrow(
        /opted out/
      );
    });
  });

  it("blocks a DND number without granted consent", async () => {
    await setCompliance({ consent_status: "unknown", is_dnd: true });
    await withTenant(orgId, null, async (client) => {
      await expect(assertCallIsCompliant(client, { orgId, leadId, toNumber: "+919000000000" })).rejects.toThrow(
        /DND/
      );
    });
  });

  it("blocks expired consent (7-day TRAI rule)", async () => {
    await setCompliance({ consent_status: "granted", consent_expires_at: new Date(Date.now() - 1000) });
    await withTenant(orgId, null, async (client) => {
      await expect(assertCallIsCompliant(client, { orgId, leadId, toNumber: "+919000000000" })).rejects.toThrow(
        /expired/
      );
    });
  });

  it("allows a call when consent is granted, not expired, not DND, not opted out", async () => {
    await setCompliance({ consent_status: "granted" });
    await withTenant(orgId, null, async (client) => {
      await expect(
        assertCallIsCompliant(client, { orgId, leadId, toNumber: "+919000000000" })
      ).resolves.toBeUndefined();
    });
  });
});

describe("Compliance gate — PROOF every call-creation path is blocked", () => {
  it("PATH 1 (direct/manual createOutboundCall, what POST /api/calls wraps): blocked, and never reaches the telephony provider", async () => {
    // No lead_compliance row at all for this lead — must block.
    const { rows: callsBefore } = await admin.query("SELECT count(*)::int AS c FROM calls WHERE lead_id = $1", [
      leadId,
    ]);
    await expect(
      createOutboundCall({
        orgId,
        userId: null,
        toNumber: "+919000000000",
        fromNumber: "+919999999999",
        leadId,
      })
    ).rejects.toBeInstanceOf(ComplianceBlockedError);

    const { rows: callsAfter } = await admin.query("SELECT count(*)::int AS c FROM calls WHERE lead_id = $1", [
      leadId,
    ]);
    expect(callsAfter[0].c).toBe(callsBefore[0].c); // no `calls` row was ever inserted
  });

  it("PATH 1 continued: opted-out lead is blocked even with a provider configured and valid phone number", async () => {
    await setCompliance({ consent_status: "granted", opted_out: true });
    await expect(
      createOutboundCall({ orgId, userId: null, toNumber: "+919000000000", fromNumber: "+919999999999", leadId })
    ).rejects.toBeInstanceOf(ComplianceBlockedError);
  });

  it("PATH 2 (campaign dialer job handler): blocked the same way, and marks the campaign_leads row 'blocked' instead of retrying forever", async () => {
    const campaignRow = await admin.query(
      `INSERT INTO campaigns (org_id, name, status) VALUES ($1, 'Gate Test Campaign', 'active') RETURNING id`,
      [orgId]
    );
    const campaignId = campaignRow.rows[0].id;
    await admin.query(
      `INSERT INTO campaign_leads (org_id, campaign_id, lead_id, status) VALUES ($1, $2, $3, 'pending')`,
      [orgId, campaignId, leadId]
    );

    // No lead_compliance row — the dialer's own createOutboundCall() call
    // must be blocked, exactly like PATH 1, with zero special-casing.
    await processCampaignDialJob({ orgId, campaignId, leadId });

    const { rows } = await admin.query(
      `SELECT status, blocked_reason FROM campaign_leads WHERE org_id = $1 AND campaign_id = $2 AND lead_id = $3`,
      [orgId, campaignId, leadId]
    );
    expect(rows[0].status).toBe("blocked");
    expect(rows[0].blocked_reason).toMatch(/consent/);

    const { rows: calls } = await admin.query("SELECT count(*)::int AS c FROM calls WHERE lead_id = $1", [leadId]);
    expect(calls[0].c).toBe(0); // the dialer never placed a call either

    await admin.query("DELETE FROM campaign_leads WHERE campaign_id = $1", [campaignId]);
    await admin.query("DELETE FROM campaigns WHERE id = $1", [campaignId]);
  });

  it("PATH 2 continued: campaign outside its configured calling-hour window is blocked even with granted consent", async () => {
    await setCompliance({ consent_status: "granted" });
    const campaignRow = await admin.query(
      `INSERT INTO campaigns (org_id, name, status, calling_hour_start, calling_hour_end, timezone)
       VALUES ($1, 'Hours Test Campaign', 'active', 9, 10, 'Asia/Kolkata') RETURNING id`,
      [orgId]
    );
    const campaignId = campaignRow.rows[0].id;

    await withTenant(orgId, null, async (client) => {
      // 3 AM IST is well outside a 09:00-10:00 window, any day.
      const threeAmIst = new Date("2026-01-05T21:30:00.000Z"); // 03:00 IST next day
      await expect(
        assertCallIsCompliant(client, { orgId, leadId, toNumber: "+919000000000", campaignId, now: threeAmIst })
      ).rejects.toThrow(/calling-hour/);
    });

    await admin.query("DELETE FROM campaigns WHERE id = $1", [campaignId]);
  });

  it("PATH 2 continued: an inactive (draft/paused) campaign is blocked outright", async () => {
    await setCompliance({ consent_status: "granted" });
    const campaignRow = await admin.query(
      `INSERT INTO campaigns (org_id, name, status) VALUES ($1, 'Draft Campaign', 'draft') RETURNING id`,
      [orgId]
    );
    const campaignId = campaignRow.rows[0].id;

    await withTenant(orgId, null, async (client) => {
      await expect(
        assertCallIsCompliant(client, { orgId, leadId, toNumber: "+919000000000", campaignId })
      ).rejects.toThrow(/not active/);
    });

    await admin.query("DELETE FROM campaigns WHERE id = $1", [campaignId]);
  });
});
