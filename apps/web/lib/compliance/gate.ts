import type { PoolClient } from "pg";

/**
 * The mandatory pre-dial compliance gate — see docs/COMPLIANCE.md for the
 * TRAI/DLT/DND/TCCCPR findings this enforces, and the Phase 6 report for
 * the "every call-creation path is blocked" proof
 * (apps/web/tests/compliance/gate.test.ts).
 *
 * NON-NEGOTIABLE (per the founder's spec): this is a hard gate that cannot
 * be bypassed. It is made structurally impossible to skip by living
 * *inside* `createOutboundCall()` (lib/calls/createCall.ts) — the single
 * function every call-creation path (the direct/manual `/api/calls` route
 * from Phase 2, and the Phase 6 campaign dialer) is written to go through.
 * There is no second, gate-free way to insert a `calls` row and place a
 * provider call in this codebase; callers cannot "forget" to invoke this
 * because they never call the telephony provider directly.
 *
 * This module takes a `PoolClient` already inside a `withTenant()`
 * transaction (RLS-scoped to the calling org), so every query here is
 * naturally tenant-isolated the same way every other tenant read/write is.
 */

export class ComplianceBlockedError extends Error {
  constructor(public readonly reason: string) {
    super(`Outbound call blocked by compliance gate: ${reason}`);
    this.name = "ComplianceBlockedError";
  }
}

export type ComplianceCheckParams = {
  orgId: string;
  leadId: string | null;
  toNumber: string;
  /** When set, also enforces this campaign's calling-hours/day window and
   * per-hour call cap. Omitted for a direct/manual call (Phase 2 API),
   * which still gets consent/DND/opt-out checks. */
  campaignId?: string | null;
  /** Injectable for deterministic tests; defaults to the real clock. */
  now?: Date;
};

/**
 * Throws ComplianceBlockedError if the call must NOT be placed. Returns
 * silently (void) if it's clear to dial. Every check here is
 * tenant-configurable data (rows in lead_compliance / campaigns), never a
 * hardcoded assumption — but always enforced, per the spec.
 */
export async function assertCallIsCompliant(client: PoolClient, params: ComplianceCheckParams): Promise<void> {
  const now = params.now ?? new Date();

  if (params.leadId) {
    const { rows } = await client.query(
      `SELECT consent_status, consent_expires_at, is_dnd, opted_out
         FROM lead_compliance WHERE org_id = $1 AND lead_id = $2`,
      [params.orgId, params.leadId]
    );
    const compliance = rows[0];

    if (compliance?.opted_out) {
      throw new ComplianceBlockedError("lead has opted out / requested do-not-call");
    }
    if (compliance?.is_dnd && compliance.consent_status !== "granted") {
      throw new ComplianceBlockedError("number is DND-flagged and no valid consent is on file");
    }
    if (!compliance || compliance.consent_status !== "granted") {
      throw new ComplianceBlockedError("no granted consent on file for this lead");
    }
    if (compliance.consent_expires_at && new Date(compliance.consent_expires_at) < now) {
      throw new ComplianceBlockedError("consent has expired (see docs/COMPLIANCE.md 7-day explicit-consent rule)");
    }
  } else {
    // No lead on file at all for a number the platform is about to call is
    // itself a compliance-relevant unknown — refuse rather than assume
    // consent exists. A direct/manual call must attach a leadId with a
    // lead_compliance row (even a freshly-created 'granted' one) to dial.
    throw new ComplianceBlockedError("no lead/consent record associated with this call");
  }

  if (params.campaignId) {
    const { rows } = await client.query(
      `SELECT calling_days, calling_hour_start, calling_hour_end, timezone, max_calls_per_hour, status
         FROM campaigns WHERE org_id = $1 AND id = $2`,
      [params.orgId, params.campaignId]
    );
    const campaign = rows[0];
    if (!campaign) {
      throw new ComplianceBlockedError("referenced campaign does not exist for this org");
    }
    if (campaign.status !== "active") {
      throw new ComplianceBlockedError(`campaign is not active (status=${campaign.status})`);
    }

    const localHour = getLocalHour(now, campaign.timezone);
    const localIsoWeekday = getIsoWeekday(now, campaign.timezone);
    if (!campaign.calling_days.includes(localIsoWeekday)) {
      throw new ComplianceBlockedError("outside campaign's configured calling days");
    }
    if (localHour < campaign.calling_hour_start || localHour >= campaign.calling_hour_end) {
      throw new ComplianceBlockedError("outside campaign's configured calling-hour window");
    }

    const { rows: countRows } = await client.query(
      `SELECT count(*)::int AS c FROM calls
        WHERE org_id = $1 AND created_at >= now() - interval '1 hour'
          AND lead_id IN (SELECT lead_id FROM campaign_leads WHERE campaign_id = $2)`,
      [params.orgId, params.campaignId]
    );
    if (countRows[0].c >= campaign.max_calls_per_hour) {
      throw new ComplianceBlockedError("campaign's max_calls_per_hour limit reached");
    }
  }
}

function getLocalHour(date: Date, timeZone: string): number {
  const formatted = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", hourCycle: "h23" }).format(date);
  return Number(formatted);
}

function getIsoWeekday(date: Date, timeZone: string): number {
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" }).format(date);
  const map: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  return map[weekday] ?? 1;
}
