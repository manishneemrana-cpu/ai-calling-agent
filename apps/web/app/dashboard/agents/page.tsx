import { getSession } from "@/lib/auth";
import { listAgentPrompts } from "@/lib/data/agent-prompts";

export default async function AgentsPage() {
  const session = await getSession();
  if (!session) return null;

  const prompts = await listAgentPrompts(session.orgId, session.userId);

  return (
    <div className="card">
      <h1>Agents</h1>
      {prompts.length === 0 ? (
        <p className="empty-state">
          No agents yet. The Prompt-to-Agent Builder (Phase 2+) will let you describe your
          business and generate one here.
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
