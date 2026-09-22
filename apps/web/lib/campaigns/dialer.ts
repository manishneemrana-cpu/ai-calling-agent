import { withTenant } from "../db/tenant";
import { createOutboundCall, ComplianceBlockedError, ProviderNotConfiguredError } from "../calls/createCall";
import { getJobQueue } from "../queue";

/**
 * Campaign dialer + smart retry — Phase 6. Runs entirely off the job
 * queue (lib/queue) so it never blocks the main API request path (per the
 * spec's "queue-based dialer that never blocks the main API" rule).
 *
 * Smart retry: the schedule lives on `campaigns.retry_schedule`
 * (tenant-configurable jsonb, default matches the spec's example — attempt
 * 1 immediate, 2 after 30min, 3 after 4h, 4 next day), keyed by attempt
 * number, and `campaigns.max_attempts` is a hard cap independent of the
 * schedule's own length. Every attempt — first or retry — goes through
 * `createOutboundCall()`, so the compliance gate always runs, never just
 * on the first attempt.
 *
 * Every read/write here against a tenant-scoped, RLS-enforced table
 * (leads, campaigns, campaign_leads) goes through `withTenant()` — using
 * the shared pool directly against those tables would silently see/affect
 * ZERO rows (FORCE ROW LEVEL SECURITY with no `app.current_org_id` set),
 * not an error, which is exactly the kind of silent-no-op bug
 * apps/web/tests/compliance/gate.test.ts's dialer path is written to catch.
 * `job_queue` (via lib/queue) is the one table intentionally queried
 * without tenant context — see its migration comment for why.
 */

const DIAL_QUEUE = "campaign-dial";

export type CampaignDialJob = {
  orgId: string;
  campaignId: string;
  leadId: string;
};

/** Enqueues one dial attempt job. Called by the campaign-tick scheduler
 * (enqueueDueCampaignLeads) and, after a disposition comes back, by
 * scheduleNextAttempt() below — never invoked from an HTTP request handler
 * directly placing a call. */
export async function enqueueCampaignDial(job: CampaignDialJob): Promise<string> {
  return getJobQueue().enqueue(DIAL_QUEUE, job, { orgId: job.orgId });
}

/** Scans `campaign_leads` for rows due now and enqueues a dial job for
 * each, across all active campaigns for `orgId`. Meant to be called on a
 * short interval by the worker process, once per known org (the worker
 * loop iterates orgs — see docs/N8N_WORKFLOWS.md / Phase 6 report for the
 * "iterate all orgs" cron wiring left as a documented follow-up), never
 * inline in a request. */
export async function enqueueDueCampaignLeads(orgId: string): Promise<number> {
  return withTenant(orgId, null, async (client) => {
    const { rows } = await client.query(
      `SELECT cl.org_id, cl.campaign_id, cl.lead_id
         FROM campaign_leads cl
         JOIN campaigns c ON c.id = cl.campaign_id
        WHERE c.org_id = $1 AND c.status = 'active'
          AND cl.status = 'pending'
          AND cl.next_attempt_at <= now()
          AND cl.attempts < c.max_attempts
        LIMIT 200`,
      [orgId]
    );
    for (const row of rows) {
      await enqueueCampaignDial({ orgId: row.org_id, campaignId: row.campaign_id, leadId: row.lead_id });
    }
    return rows.length;
  });
}

/** The job-queue handler: processes one dial attempt. Registered by the
 * worker process via `getJobQueue().startWorker(DIAL_QUEUE, processCampaignDialJob)`. */
export async function processCampaignDialJob(job: CampaignDialJob): Promise<void> {
  const { toNumber, agentId, fromNumber } = await withTenant(job.orgId, null, async (client) => {
    const { rows: leadRows } = await client.query(`SELECT phone_number FROM leads WHERE id = $1 AND org_id = $2`, [
      job.leadId,
      job.orgId,
    ]);
    const { rows: campaignRows } = await client.query(
      `SELECT c.agent_id, a.telephony_provider_key
         FROM campaigns c LEFT JOIN agents a ON a.id = c.agent_id
        WHERE c.id = $1 AND c.org_id = $2`,
      [job.campaignId, job.orgId]
    );
    return {
      toNumber: leadRows[0]?.phone_number as string | undefined,
      agentId: (campaignRows[0]?.agent_id as string | null) ?? null,
      // The campaign's agent owns the calling number config in this
      // Phase 6 minimal model; a dedicated per-campaign caller-ID field is
      // a documented follow-up (see Phase 6 report).
      fromNumber: (campaignRows[0]?.telephony_provider_key as string | null) ?? "campaign-default",
    };
  });

  if (!toNumber) {
    await markCampaignLeadOutcome(job, "blocked", "lead has no phone_number on file");
    return;
  }

  try {
    await createOutboundCall({
      orgId: job.orgId,
      userId: null,
      toNumber,
      fromNumber,
      agentId,
      leadId: job.leadId,
      campaignId: job.campaignId,
    });
    // The call itself is now in flight; its disposition arrives later via
    // the telephony webhook / CRM disposition update, which is what
    // scheduleNextAttempt() below reacts to — this job's own job succeeds
    // once the call is *placed*, not once it's answered.
  } catch (err) {
    if (err instanceof ComplianceBlockedError) {
      await markCampaignLeadOutcome(job, "blocked", err.message);
      return; // compliance blocks are terminal for this lead, never retried
    }
    if (err instanceof ProviderNotConfiguredError) {
      throw err; // a config problem — let the queue's own retry/backoff handle it
    }
    throw err;
  }
}

async function markCampaignLeadOutcome(job: CampaignDialJob, status: "blocked", reason: string): Promise<void> {
  await withTenant(job.orgId, null, async (client) => {
    await client.query(
      `UPDATE campaign_leads SET status = $3, blocked_reason = $4, updated_at = now()
        WHERE org_id = $1 AND campaign_id = $2 AND lead_id = $5`,
      [job.orgId, job.campaignId, status, reason, job.leadId]
    );
  });
}

/**
 * Given a campaign's retry_schedule and a just-recorded disposition, sets
 * `campaign_leads.next_attempt_at` for the next attempt (or marks the lead
 * 'exhausted' if max_attempts is reached, or 'completed' if the
 * disposition is a terminal/successful one). Called from wherever a call's
 * final disposition is recorded (Phase 5 CRM disposition update path).
 */
export async function scheduleNextAttempt(params: {
  orgId: string;
  campaignId: string;
  leadId: string;
  disposition: string;
  terminalDispositions?: string[];
}): Promise<void> {
  await withTenant(params.orgId, null, async (client) => {
    const { rows: campaignRows } = await client.query(
      `SELECT retry_schedule, max_attempts FROM campaigns WHERE id = $1 AND org_id = $2`,
      [params.campaignId, params.orgId]
    );
    const campaign = campaignRows[0];
    if (!campaign) return;

    const terminal = params.terminalDispositions ?? ["connected", "converted", "not_interested", "dnd_request"];
    const { rows: clRows } = await client.query(
      `SELECT attempts FROM campaign_leads WHERE org_id = $1 AND campaign_id = $2 AND lead_id = $3`,
      [params.orgId, params.campaignId, params.leadId]
    );
    const attempts = clRows[0]?.attempts ?? 0;

    if (terminal.includes(params.disposition) || attempts >= campaign.max_attempts) {
      await client.query(
        `UPDATE campaign_leads SET status = $4, last_disposition = $5, updated_at = now()
          WHERE org_id = $1 AND campaign_id = $2 AND lead_id = $3`,
        [
          params.orgId,
          params.campaignId,
          params.leadId,
          attempts >= campaign.max_attempts ? "exhausted" : "completed",
          params.disposition,
        ]
      );
      return;
    }

    const schedule = campaign.retry_schedule as Array<{ attempt: number; delay_minutes: number }>;
    const nextAttemptNumber = attempts + 1;
    const step = schedule.find((s) => s.attempt === nextAttemptNumber) ?? schedule[schedule.length - 1];
    const delayMinutes = step?.delay_minutes ?? 0;
    const nextAttemptAt = new Date(Date.now() + delayMinutes * 60_000);

    await client.query(
      `UPDATE campaign_leads
          SET status = 'pending', last_disposition = $4, next_attempt_at = $5, updated_at = now()
        WHERE org_id = $1 AND campaign_id = $2 AND lead_id = $3`,
      [params.orgId, params.campaignId, params.leadId, params.disposition, nextAttemptAt]
    );
  });
}
