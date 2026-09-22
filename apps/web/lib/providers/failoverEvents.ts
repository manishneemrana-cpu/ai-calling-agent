import { withTenant } from "../db/tenant";
import { withoutTenant } from "../db/tenant";

/**
 * Durable sink for Phase 9 provider-failover events, into
 * `provider_failover_events` (db/migrations/014_phase9_observability_failover.sql).
 * Mirrors the Python side's `voice_gateway/billing/failover_writer.py`
 * exactly — same table, same shape, same "org_id may be null" allowance.
 */
export async function writeFailoverEvent(params: {
  orgId: string | null;
  layer: string;
  fromProvider: string;
  toProvider: string;
  reason: string;
  callId?: string | null;
}): Promise<string> {
  const insert = async (client: { query: (text: string, values?: unknown[]) => Promise<{ rows: { id: string }[] }> }) => {
    const { rows } = await client.query(
      `INSERT INTO provider_failover_events (org_id, layer, from_provider, to_provider, reason, call_id)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [params.orgId, params.layer, params.fromProvider, params.toProvider, params.reason, params.callId ?? null]
    );
    return rows[0].id as string;
  };

  if (params.orgId === null) {
    return withoutTenant(insert);
  }
  return withTenant(params.orgId, null, insert);
}
