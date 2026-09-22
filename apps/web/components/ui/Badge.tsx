export type BadgeTone = "neutral" | "success" | "warning" | "danger" | "info" | "accent";

/**
 * Status/enum badge — lead score (HOT/WARM/COLD), call disposition,
 * invoice status, campaign status, org_role, pipeline stage, etc. Tone is
 * chosen by the caller from data, never a hardcoded brand color.
 */
export function Badge({ children, tone = "neutral" }: { children: React.ReactNode; tone?: BadgeTone }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

/** Best-effort tone inference for common enum-like values across the app. */
export function toneForStatus(value: string | null | undefined): BadgeTone {
  if (!value) return "neutral";
  const v = value.toLowerCase();
  if (["hot", "won", "paid", "success", "active", "confirmed", "completed", "connected"].includes(v)) return "success";
  if (["warm", "pending", "in_progress", "scheduled", "trialing", "queued"].includes(v)) return "warning";
  if (["cold", "lost", "failed", "overdue", "cancelled", "canceled", "no_show", "churned"].includes(v)) return "danger";
  if (["new", "draft", "open"].includes(v)) return "info";
  if (["platform", "reseller"].includes(v)) return "accent";
  return "neutral";
}
