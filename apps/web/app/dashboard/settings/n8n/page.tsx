import { getSession } from "@/lib/auth";
import { hasN8nWebhookToken } from "@/lib/webhooks/n8nToken";
import { rotateTokenAction, readAndClearNewToken } from "./actions";

/**
 * /dashboard/settings/n8n — where a tenant generates/rotates their
 * per-tenant n8n webhook token (gap-closing pass — see
 * db/migrations/016_gap_closing_pass.sql and
 * apps/web/lib/webhooks/n8n-auth.ts's doc comment for why this replaced
 * Phase 6's single shared secret). Plumbing-proof only, same austerity
 * level as every other Phase 1-10 settings-style page.
 */
export default async function N8nSettingsPage() {
  const session = await getSession();
  if (!session) return null;

  const [hasToken, newToken] = await Promise.all([
    hasN8nWebhookToken(session.orgId, session.userId),
    readAndClearNewToken(),
  ]);

  return (
    <div className="card">
      <h1>n8n Integration</h1>
      <p className="empty-state" style={{ marginBottom: "1rem" }}>
        Set this as your n8n instance&apos;s <code>N8N_WEBHOOK_SHARED_SECRET</code> environment variable — it is
        sent as the <code>x-n8n-webhook-token</code> header on every request to this app&apos;s{" "}
        <code>/api/webhooks/n8n/*</code> endpoints (see docs/N8N_WORKFLOWS.md). This token is specific to YOUR
        org — it cannot be used to address any other tenant&apos;s data, and a body/query <code>orgId</code> in a
        request is never trusted for tenant selection, only this token is.
      </p>

      {newToken && (
        <p className="error" style={{ marginBottom: "1rem" }}>
          <strong>New token (shown once — copy it now, it cannot be shown again):</strong>
          <br />
          <code>{newToken}</code>
        </p>
      )}

      <p>Status: {hasToken ? "A token is configured." : "No token configured yet."}</p>

      <form action={rotateTokenAction}>
        <button type="submit">{hasToken ? "Rotate token (invalidates the old one immediately)" : "Generate token"}</button>
      </form>
    </div>
  );
}
