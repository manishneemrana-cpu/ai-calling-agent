import { getSession } from "@/lib/auth";
import { readDraft, generateAction, clarifyAction, commitAction, resetAction } from "./actions";

/**
 * /dashboard/agents/new — the Prompt-to-Agent Builder (gap-closing pass:
 * this was designed since Phase 0, docs/PROMPT_TO_AGENT_BUILDER.md, but
 * never implemented in code through Phase 1-10). Plumbing-proof only, per
 * this task's scope — the professional UI/UX pass is a separate, later
 * task.
 *
 * Three states, driven by the `agent_builder_draft` cookie (see
 * ./actions.ts): (1) plain description form, (2) clarification questions
 * (when the LLM's own structured output says the description was too
 * vague), (3) generated-config review + confirm.
 */
export default async function NewAgentPage() {
  const session = await getSession();
  if (!session) return null;

  const draft = await readDraft();
  const showClarify = !!draft?.clarificationQuestions?.length && !draft?.config;
  const showReview = !!draft?.config;
  const showDescribe = !showClarify && !showReview;

  return (
    <div className="card">
      <h1>Prompt-to-Agent Builder</h1>
      <p className="empty-state" style={{ marginBottom: "1rem" }}>
        Describe your business and what you want an AI calling agent to do, in plain language. One LLM call
        (docs/PROMPT_TO_AGENT_BUILDER.md) generates a persona, greeting script, qualification questions, objection
        handling, a suggested CRM pipeline, dispositions, and lead-scoring criteria — nothing goes live until you
        review and confirm below.
      </p>

      {draft?.error && (
        <p className="error" style={{ marginBottom: "1rem" }}>
          {draft.error}
        </p>
      )}

      {showDescribe && (
        <form action={generateAction}>
          <label>
            Business / use-case description
            <textarea
              name="description"
              rows={5}
              maxLength={4000}
              required
              defaultValue={draft?.description ?? ""}
              placeholder="e.g. I run a diagnostic lab chain. I want to remind patients when their test reports are ready and also suggest relevant health checkup packages based on their test history."
            />
          </label>
          <button type="submit">Generate agent</button>
        </form>
      )}

      {showClarify && (
        <div>
          <h2>A couple of quick questions first</h2>
          <p className="empty-state">
            The description didn&apos;t give enough signal to generate a confident config — answer these and we&apos;ll
            finish generating.
          </p>
          <ul>{draft!.clarificationQuestions!.map((q) => <li key={q}>{q}</li>)}</ul>
          <form action={clarifyAction}>
            <input type="hidden" name="description" value={draft!.description} />
            <label>
              Your answers
              <textarea name="answers" rows={4} maxLength={2000} required />
            </label>
            <button type="submit">Continue</button>
          </form>
        </div>
      )}

      {showReview && (
        <div>
          <h2>Review the generated agent</h2>
          {draft!.config!.needs_review && (
            <p className="error">
              The generated output was incomplete or malformed and has been flagged for review — you cannot
              confirm this config as-is. Try regenerating with a more detailed description.
              {draft!.config!.raw_llm_output && (
                <>
                  <br />
                  <strong>Raw output:</strong> <code>{draft!.config!.raw_llm_output}</code>
                </>
              )}
            </p>
          )}

          <table>
            <tbody>
              <tr>
                <th>Inferred vertical</th>
                <td>
                  {draft!.config!.inferred_vertical ?? "—"} ({draft!.config!.inferred_vertical_confidence ?? "—"}{" "}
                  confidence)
                </td>
              </tr>
              <tr>
                <th>Persona</th>
                <td>
                  {draft!.config!.agent_persona?.name ?? "—"} — {draft!.config!.agent_persona?.tone ?? "—"} (
                  {draft!.config!.agent_persona?.language_style ?? "—"})
                </td>
              </tr>
              <tr>
                <th>Greeting script</th>
                <td>{draft!.config!.greeting_script ?? "—"}</td>
              </tr>
            </tbody>
          </table>

          <h3>Qualification questions</h3>
          <ul>
            {draft!.config!.qualification_questions.map((q, i) => (
              <li key={i}>
                {q.question} {q.maps_to_field && <em>→ {q.maps_to_field}</em>}
              </li>
            ))}
          </ul>

          <h3>Objection handling</h3>
          <ul>
            {draft!.config!.objection_handling.map((o, i) => (
              <li key={i}>
                <strong>{o.objection}:</strong> {o.response_stub}
              </li>
            ))}
          </ul>

          <h3>Tools needed</h3>
          <ul>
            {draft!.config!.tools_needed.map((t, i) => (
              <li key={i}>
                <code>{t.tool_name}</code> — {t.description}
              </li>
            ))}
          </ul>

          <h3>Suggested CRM pipeline stages</h3>
          <p>{draft!.config!.suggested_pipeline_stages.join(" → ") || "—"}</p>

          <h3>Suggested dispositions</h3>
          <p>{draft!.config!.suggested_dispositions.join(", ") || "—"}</p>

          <h3>Suggested lead-scoring criteria</h3>
          <ul>
            {draft!.config!.suggested_lead_scoring_criteria.map((c, i) => (
              <li key={i}>
                {c.criterion} ({c.weight_hint ?? "medium"})
              </li>
            ))}
          </ul>

          {draft!.config!.compliance_flags.length > 0 && (
            <>
              <h3>Compliance flags (review before going live)</h3>
              <ul>
                {draft!.config!.compliance_flags.map((f, i) => (
                  <li key={i} className="error">
                    {f}
                  </li>
                ))}
              </ul>
            </>
          )}

          <form action={commitAction} style={{ marginTop: "1.5rem" }}>
            <input type="hidden" name="description" value={draft!.description} />
            <input type="hidden" name="config" value={JSON.stringify(draft!.config)} />
            <label>
              Agent name
              <input type="text" name="agentName" required maxLength={200} />
            </label>
            <button type="submit" disabled={draft!.config!.needs_review}>
              Confirm &amp; create agent
            </button>
          </form>
        </div>
      )}

      <form action={resetAction} style={{ marginTop: "1rem" }}>
        <button type="submit">Start over</button>
      </form>
    </div>
  );
}
