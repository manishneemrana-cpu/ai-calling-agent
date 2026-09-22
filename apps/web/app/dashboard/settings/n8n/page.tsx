import { getSession } from "@/lib/auth";
import { hasN8nWebhookToken } from "@/lib/webhooks/n8nToken";
import { rotateTokenAction, readAndClearNewToken } from "./actions";
import { PageHeader } from "@/components/ui/PageHeader";
import { Badge } from "@/components/ui/Badge";

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
    <div>
      <PageHeader
        title="n8n Integration"
        description="Set this as your n8n instance's N8N_WEBHOOK_SHARED_SECRET — sent as the x-n8n-webhook-token header on every request to this app's webhook endpoints. Specific to your org only."
      />

      <div className="card">
        {newToken && (
          <div className="alert alert-danger">
            <div>
              <strong>New token (shown once — copy it now, it cannot be shown again):</strong>
              <br />
              <code>{newToken}</code>
            </div>
          </div>
        )}

        <p>
          Status: <Badge tone={hasToken ? "success" : "neutral"}>{hasToken ? "Configured" : "Not configured"}</Badge>
        </p>

        <form action={rotateTokenAction}>
          <button type="submit" className="btn-secondary">
            {hasToken ? "Rotate token (invalidates the old one immediately)" : "Generate token"}
          </button>
        </form>
      </div>
    </div>
  );
}
