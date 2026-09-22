import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { withTenant } from "@/lib/db/tenant";
import {
  computeResellerStarterKitTable,
  DEFAULT_STARTER_KIT_TIERS_MINUTES,
  tableToCsv,
} from "@/lib/reseller/starterKit";

/**
 * GET /api/reseller/starter-kit/export?token=... — CSV export of one of the
 * calling reseller's own starter-kit shares. Authenticated (unlike the
 * public /starter-kit/[token] page) because the CSV includes the
 * reseller's own cost/margin lines, which are the reseller's business, not
 * a prospect's — see the note on app/starter-kit/[token]/page.tsx. Scoped
 * with `WHERE reseller_org_id = $2` inside `withTenant`, so RLS makes it
 * structurally impossible for one reseller to export another reseller's
 * share by guessing/enumerating tokens.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const session = await getSession();
  if (!session || session.orgRole !== "reseller") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const token = req.nextUrl.searchParams.get("token");
  if (!token) {
    return NextResponse.json({ error: "Missing token" }, { status: 400 });
  }

  const share = await withTenant(session.orgId, session.userId, async (client) => {
    const { rows } = await client.query(
      `SELECT plan_label, buy_price_per_minute_usd, sell_price_per_minute_usd, currency
         FROM reseller_starter_kit_shares WHERE share_token = $1 AND reseller_org_id = $2`,
      [token, session.orgId]
    );
    return rows[0] ?? null;
  });

  if (!share) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const rows = computeResellerStarterKitTable(
    DEFAULT_STARTER_KIT_TIERS_MINUTES,
    Number(share.buy_price_per_minute_usd),
    Number(share.sell_price_per_minute_usd)
  );
  const csv = tableToCsv(rows, share.currency);

  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="starter-kit-${token}.csv"`,
    },
  });
}
