import Link from "next/link";
import { getSession } from "@/lib/auth";
import { listAgentPrompts } from "@/lib/data/agent-prompts";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState } from "@/components/ui/EmptyState";
import { Badge } from "@/components/ui/Badge";

export default async function AgentsPage() {
  const session = await getSession();
  if (!session) return null;

  const prompts = await listAgentPrompts(session.orgId, session.userId);

  return (
    <div>
      <PageHeader
        title="Agents"
        description="AI calling agents built for your organization."
        actions={
          <Link className="btn btn-primary" href="/dashboard/agents/new">
            + Build a new agent
          </Link>
        }
      />
      <div className="card">
        {prompts.length === 0 ? (
          <EmptyState
            title="No agents yet"
            description="Use the Prompt-to-Agent Builder to describe your business and generate your first agent in minutes."
            action={
              <Link className="btn btn-primary" href="/dashboard/agents/new">
                + Build a new agent from a description
              </Link>
            }
          />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Agent</th>
                  <th>Vertical</th>
                  <th>Source</th>
                  <th>Version</th>
                  <th>Active</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {prompts.map((p) => (
                  <tr key={p.id}>
                    <td>{p.agent_name}</td>
                    <td>{p.inferred_vertical ?? "—"}</td>
                    <td>
                      <Badge tone="neutral">{p.source}</Badge>
                    </td>
                    <td>{p.version}</td>
                    <td>
                      <Badge tone={p.is_active ? "success" : "neutral"}>{p.is_active ? "Active" : "Inactive"}</Badge>
                    </td>
                    <td>{new Date(p.created_at).toLocaleDateString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
