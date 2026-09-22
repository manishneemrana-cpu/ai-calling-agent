import { getSession } from "@/lib/auth";
import { readDraft, generateAction, clarifyAction, commitAction, resetAction } from "./actions";
import { PageHeader } from "@/components/ui/PageHeader";

/**
 * /dashboard/agents/new — the Prompt-to-Agent Builder (flagship feature,
 * docs/PROMPT_TO_AGENT_BUILDER.md). Given a polished multi-step feel for
 * the UI/UX pass: a step tracker (describe → clarify → review → confirm)
 * plus review-table/badge treatment, on top of the same three-cookie-state
 * flow and server actions as before — no business logic changed here.
 */
export default async function NewAgentPage() {
  const session = await getSession();
  if (!session) return null;

  const draft = await readDraft();
  const showClarify = !!draft?.clarificationQuestions?.length && !draft?.config;
  const showReview = !!draft?.config;
  const showDescribe = !showClarify && !showReview;

  const step = showDescribe ? 1 : showClarify ? 2 : 3;

  return (
    <div>
      <PageHeader
        title="Prompt-to-Agent Builder"
        description="Describe your business in plain language — one LLM call generates a persona, greeting script, qualification questions, objection handling, a suggested CRM pipeline, dispositions, and lead-scoring criteria. Nothing goes live until you review and confirm."
      />

      <div className="wizard-steps">
        <span className={`wizard-step ${step === 1 ? "active" : step > 1 ? "done" : ""}`}>
          <span className="wizard-step-num">1</span> Describe
        </span>
        <span className={`wizard-step ${step === 2 ? "active" : step > 2 ? "done" : ""}`}>
          <span className="wizard-step-num">2</span> Clarify
        </span>
        <span className={`wizard-step ${step === 3 ? "active" : ""}`}>
          <span className="wizard-step-num">3</span> Review &amp; confirm
        </span>
      </div>

      <div className="card">
        {draft?.error && <p className="error">{draft.error}</p>}

        {showDescribe && (
          <form action={generateAction}>
            <div className="field">
              <label htmlFor="description">Business / use-case description</label>
              <textarea
                id="description"
                name="description"
                rows={6}
                maxLength={4000}
                required
                defaultValue={draft?.description ?? ""}
                placeholder="e.g. I run a diagnostic lab chain. I want to remind patients when their test reports are ready and also suggest relevant health checkup packages based on their test history."
              />
              <p className="field-hint">The more specific you are, the fewer clarifying questions we&apos;ll need to ask.</p>
            </div>
            <button type="submit" className="btn-primary">Generate agent</button>
          </form>
        )}

        {showClarify && (
          <div>
            <h2>A couple of quick questions first</h2>
            <p className="text-muted">
              The description didn&apos;t give enough signal to generate a confident config — answer these and
              we&apos;ll finish generating.
            </p>
            <ul>{draft!.clarificationQuestions!.map((q) => <li key={q}>{q}</li>)}</ul>
            <form action={clarifyAction}>
              <input type="hidden" name="description" value={draft!.description} />
              <div className="field">
                <label htmlFor="answers">Your answers</label>
                <textarea id="answers" name="answers" rows={4} maxLength={2000} required />
              </div>
              <button type="submit" className="btn-primary">Continue</button>
            </form>
          </div>
        )}

        {showReview && (
          <div>
            <h2>Review the generated agent</h2>
            {draft!.config!.needs_review && (
              <div className="alert alert-danger">
                The generated output was incomplete or malformed and has been flagged for review — you cannot
                confirm this config as-is. Try regenerating with a more detailed description.
                {draft!.config!.raw_llm_output && (
                  <>
                    <br />
                    <strong>Raw output:</strong> <code>{draft!.config!.raw_llm_output}</code>
                  </>
                )}
              </div>
            )}

            <div className="table-wrap">
              <table className="kv-table">
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
            </div>

            <h3 className="section-title">Qualification questions</h3>
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
                    <li key={i} className="error" style={{ display: "block" }}>
                      {f}
                    </li>
                  ))}
                </ul>
              </>
            )}

            <form action={commitAction} style={{ marginTop: "1.5rem" }}>
              <input type="hidden" name="description" value={draft!.description} />
              <input type="hidden" name="config" value={JSON.stringify(draft!.config)} />
              <div className="field">
                <label htmlFor="agentName">Agent name</label>
                <input id="agentName" type="text" name="agentName" required maxLength={200} />
              </div>
              <button type="submit" className="btn-primary" disabled={draft!.config!.needs_review}>
                Confirm &amp; create agent
              </button>
            </form>
          </div>
        )}

        <form action={resetAction} style={{ marginTop: "1rem" }}>
          <button type="submit" className="btn-ghost">Start over</button>
        </form>
      </div>
    </div>
  );
}
