import { getSession } from "@/lib/auth";
import { listAgentPrompts } from "@/lib/data/agent-prompts";

export default async function AgentsPage() {
  const session = await getSession();
  if (!session) return null;

  const prompts = await listAgentPrompts(session.orgId, session.userId);

  return (
    <div className="card">
      <h1>Agents</h1>
      <p style={{ marginBottom: "1rem" }}>
        <a href="/dashboard/agents/new">+ Build a new agent from a description</a>
      </p>
      {prompts.length === 0 ? (
        <p className="empty-state">
          No agents yet — use the Prompt-to-Agent Builder above to describe your business and generate one.
        </p>
      ) : (
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
                <td>{p.source}</td>
                <td>{p.version}</td>
                <td>{p.is_active ? "Yes" : "No"}</td>
                <td>{new Date(p.created_at).toLocaleDateString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
