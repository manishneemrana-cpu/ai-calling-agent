"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { withTenant } from "@/lib/db/tenant";
import { setResellerSellRate } from "@/lib/reseller/pricing";
import { upsertOwnBranding } from "@/lib/reseller/branding";
import { createStarterKitShare } from "@/lib/reseller/starterKit";

/**
 * These are plain `<form action={...}>` server actions (no client-side
 * `useActionState`/`useFormState` hook wraps these pages, matching the
 * rest of this codebase's plumbing-proof austerity), so each one must
 * return `void`/`Promise<void>` — errors surface via `redirect` back to
 * the same page rather than an inline returned error object. The
 * authorization check inside each one is a UX convenience; RLS is the
 * actual boundary (see the tables' own policies in
 * db/migrations/013_phase8_reseller_hierarchy.sql).
 */

export async function updateSellRateAction(formData: FormData): Promise<void> {
  const session = await getSession();
  if (!session || session.orgRole !== "reseller") {
    redirect("/dashboard");
  }
  const rate = Number(formData.get("sellPricePerMinuteUsd"));
  if (!Number.isFinite(rate) || rate < 0) {
    redirect("/dashboard/reseller/pricing?error=invalid_rate");
  }
  await withTenant(session.orgId, session.userId, async (client) => {
    await setResellerSellRate(client, session.orgId, rate);
  });
  revalidatePath("/dashboard/reseller/pricing");
  revalidatePath("/dashboard/reseller/margin");
  redirect("/dashboard/reseller/pricing");
}

export async function updateBrandingAction(formData: FormData): Promise<void> {
  const session = await getSession();
  if (!session || session.orgRole !== "reseller") {
    redirect("/dashboard");
  }
  await withTenant(session.orgId, session.userId, async (client) => {
    await upsertOwnBranding(client, session.orgId, {
      companyName: (formData.get("companyName") as string) || undefined,
      logoUrl: (formData.get("logoUrl") as string) || undefined,
      primaryColor: (formData.get("primaryColor") as string) || undefined,
      secondaryColor: (formData.get("secondaryColor") as string) || undefined,
      subdomain: (formData.get("subdomain") as string)?.toLowerCase() || undefined,
      supportEmail: (formData.get("supportEmail") as string) || undefined,
      supportPhone: (formData.get("supportPhone") as string) || undefined,
    });
  });
  revalidatePath("/dashboard/reseller/pricing");
  redirect("/dashboard/reseller/pricing");
}

export async function createStarterKitShareAction(formData: FormData): Promise<void> {
  const session = await getSession();
  if (!session || session.orgRole !== "reseller") {
    redirect("/dashboard");
  }
  const estimatedMinutes = Number(formData.get("estimatedMinutesPerMonth"));
  if (!Number.isFinite(estimatedMinutes) || estimatedMinutes <= 0) {
    redirect("/dashboard/reseller/starter-kit?error=invalid_minutes");
  }

  const result = await withTenant(session.orgId, session.userId, async (client) => {
    const { rows: buyRows } = await client.query(
      `SELECT buy_price_per_minute_usd FROM reseller_buy_rates WHERE org_id = $1`,
      [session.orgId]
    );
    const { rows: sellRows } = await client.query(
      `SELECT sell_price_per_minute_usd FROM reseller_sell_rates WHERE org_id = $1`,
      [session.orgId]
    );
    if (!buyRows[0] || !sellRows[0]) {
      return { error: "missing_rates" as const };
    }
    await createStarterKitShare(client, {
      resellerOrgId: session.orgId,
      prospectName: (formData.get("prospectName") as string) || undefined,
      planLabel: (formData.get("planLabel") as string) || undefined,
      estimatedMinutesPerMonth: estimatedMinutes,
      buyPricePerMinuteUsd: Number(buyRows[0].buy_price_per_minute_usd),
      sellPricePerMinuteUsd: Number(sellRows[0].sell_price_per_minute_usd),
    });
    return { error: null };
  });

  if (result.error) {
    redirect(`/dashboard/reseller/starter-kit?error=${result.error}`);
  }
  revalidatePath("/dashboard/reseller/starter-kit");
  redirect("/dashboard/reseller/starter-kit");
}
