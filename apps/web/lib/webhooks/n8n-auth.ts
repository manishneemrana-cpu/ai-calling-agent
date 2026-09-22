import { timingSafeEqual, createHash } from "crypto";
import { NextRequest } from "next/server";
import { checkRateLimit, clientIpFromHeaders, RateLimitExceededError } from "@/lib/security/rateLimit";

/**
 * Shared-secret auth for n8n -> apps/web control-plane webhooks (Phase 6).
 *
 * n8n is control-plane only and NEVER carries live call audio (an
 * established non-negotiable rule since Phase 0-4) — every workflow in
 * n8n/workflows/*.json only ever calls these lightweight JSON endpoints
 * (create a lead, trigger a call/WhatsApp send, read a small report), and
 * every actual telephony/WhatsApp action still goes through this app's own
 * Provider Registry + compliance gate, never through n8n directly.
 *
 * This is a Phase 6 MINIMUM: a single shared secret
 * (`N8N_WEBHOOK_SHARED_SECRET`) checked via the `x-n8n-webhook-token`
 * header, with the target org supplied in the request body/query as
 * `orgId`. A per-tenant token (so one tenant's n8n instance can't address
 * another tenant's endpoint even with a leaked shared secret) is a
 * documented follow-up — see the Phase 6 report's "deferred" list.
 *
 * Phase 10 hardening (two real gaps closed):
 * 1. The token comparison was `!==`, a plain string compare whose timing
 *    varies with how many leading bytes match — a textbook timing-attack
 *    surface for a shared-secret comparison. Now `timingSafeEqual` on
 *    fixed-length SHA-256 digests of both sides (hashing first avoids
 *    `timingSafeEqual`'s own requirement that both buffers be equal length,
 *    which a raw length mismatch would otherwise leak).
 * 2. No rate limiting existed on any of these 6 endpoints, all of which are
 *    reachable by anyone who can reach this app's public URL (n8n calls
 *    them over plain HTTP, not from a private network in this design) —
 *    see `lib/security/rateLimit.ts`. Rate-limited by source IP, generous
 *    enough for a legitimate n8n instance's polling/webhook traffic (the
 *    hourly/15-minute-interval workflows in docs/N8N_WORKFLOWS.md) while
 *    still stopping an unthrottled brute-force loop against the shared
 *    secret or a request flood against the compliance-gated call-creation
 *    path this token guards.
 */
export class N8nAuthError extends Error {
  constructor(message = "Invalid or missing n8n webhook token") {
    super(message);
    this.name = "N8nAuthError";
  }
}

function timingSafeStringEqual(a: string, b: string): boolean {
  const digestA = createHash("sha256").update(a).digest();
  const digestB = createHash("sha256").update(b).digest();
  return timingSafeEqual(digestA, digestB);
}

export async function assertValidN8nRequest(req: NextRequest): Promise<void> {
  const expected = process.env.N8N_WEBHOOK_SHARED_SECRET;
  if (!expected) {
    // Fail closed: an unconfigured secret must never mean "any request is
    // accepted" — see docs/N8N_WORKFLOWS.md's setup checklist.
    throw new N8nAuthError("N8N_WEBHOOK_SHARED_SECRET is not configured on this deployment");
  }
  const provided = req.headers.get("x-n8n-webhook-token");
  if (!provided || !timingSafeStringEqual(provided, expected)) {
    throw new N8nAuthError();
  }

  try {
    await checkRateLimit(`n8n-webhook:${clientIpFromHeaders(req.headers)}`, 120, 60);
  } catch (err) {
    if (err instanceof RateLimitExceededError) {
      throw new N8nAuthError("Rate limit exceeded — too many requests from this source.");
    }
    throw err;
  }
}
