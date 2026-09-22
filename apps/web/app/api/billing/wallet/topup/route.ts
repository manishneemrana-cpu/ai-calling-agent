import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSession, requireRole, InsufficientRoleError } from "@/lib/auth";
import { createWalletTopupOrder } from "@/lib/billing/paymentOrders";

/**
 * POST /api/billing/wallet/topup — creates a payment-gateway order/link
 * for a wallet top-up. The wallet is NEVER credited from this route —
 * only the verified webhook (POST /api/billing/webhook/[gatewayKey]) via
 * `credit_wallet_from_payment` does that, so a client can never credit its
 * own wallet just by hitting this endpoint.
 */
const topupSchema = z.object({
  amount: z.number().positive(),
  currency: z.string().optional(),
  gatewayProviderKey: z.string().optional(),
  callbackUrl: z.string().optional(),
});

export async function POST(req: NextRequest): Promise<NextResponse> {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  // Phase 10: initiating a real-money payment order is a billing action —
  // gate it at `admin`+ same as the reseller pricing/branding actions,
  // rather than "any authenticated org member" as before this phase.
  try {
    requireRole(session, "admin");
  } catch (err) {
    if (err instanceof InsufficientRoleError) {
      return NextResponse.json({ error: err.message }, { status: 403 });
    }
    throw err;
  }

  const json = await req.json().catch(() => null);
  const parsed = topupSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid input" }, { status: 400 });
  }

  try {
    const order = await createWalletTopupOrder({
      orgId: session.orgId,
      userId: session.userId,
      ...parsed.data,
    });
    return NextResponse.json(order, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to create top-up order";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
