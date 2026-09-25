import { createHash, createHmac, timingSafeEqual } from "crypto";
import { NextRequest } from "next/server";
import { withoutTenant } from "@/lib/db/tenant";
import { checkRateLimit, RateLimitExceededError } from "@/lib/security/rateLimit";
import { decryptProviderConfig, encryptProviderConfig, isEncryptedConfig, type EncryptedConfig } from "@/lib/providers/crypto";

/**
 * Auth for the INBOUND sitesnsign.com -> ai-calling-agent lead-intake
 * webhook (POST /api/webhooks/sitesnsign/lead-intake — see
 * docs/SITESNSIGN_INTEGRATION.md). Two checks, both required:
 *
 *  1. `x-sitesnsign-token` — a per-tenant opaque token (same
 *     hash-lookup-resolves-the-org discipline as
 *     lib/webhooks/n8n-auth.ts's `assertValidN8nRequest()` — only the
 *     SHA-256 hash is ever stored, and the trusted org is ALWAYS the one
 *     this resolves, never a caller-supplied org id in the body).
 *  2. `x-sitesnsign-signature: sha256=<hex>` — an HMAC-SHA256 of the RAW
 *     request body, keyed by that same org's signing secret (the same
 *     "createHmac + timingSafeEqual" pattern already used for provider
 *     webhooks — see providers/telephony/adapters/frejun-teler.ts and
 *     providers/payment_gateway/adapters/razorpay.ts).
 *
 * Why both, when n8n's webhooks only do (1)? n8n instances are each
 * provisioned/operated by this platform (Phase 6); sitesnsign.com's NestJS
 * backend is a wholly separate codebase/team the founder does not
 * personally operate day-to-day, crossing a real trust boundary — a
 * signed body means a copied/leaked token alone (e.g. from a log line)
 * cannot be replayed with an ARBITRARY payload, only with a payload that
 * codebase itself actually signed.
 */
export class SitesnsignAuthError extends Error {
  constructor(message = "Invalid or missing sitesnsign webhook credentials") {
    super(message);
    this.name = "SitesnsignAuthError";
  }
}

export function hashSitesnsignToken(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("hex");
}

export function encryptSitesnsignSecret(rawSecret: string): EncryptedConfig {
  return encryptProviderConfig({ secret: rawSecret });
}

function decryptSitesnsignSecret(enc: unknown): string {
  if (!isEncryptedConfig(enc)) {
    throw new SitesnsignAuthError("Malformed stored signing secret");
  }
  const { secret } = decryptProviderConfig(enc);
  if (typeof secret !== "string") {
    throw new SitesnsignAuthError("Malformed stored signing secret");
  }
  return secret;
}

function computeSignature(rawBody: string, secret: string): string {
  return createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
}

function timingSafeEqualHex(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Verifies both the per-tenant token and the body's HMAC signature, and
 * returns the resolved (trusted) org id. Throws SitesnsignAuthError for
 * ANY failure (missing headers, unknown token, bad signature) — the route
 * must treat all of these identically (401), never leak which check
 * failed.
 */
export async function assertValidSitesnsignRequest(req: NextRequest, rawBody: string): Promise<string> {
  const token = req.headers.get("x-sitesnsign-token");
  const signatureHeader = req.headers.get("x-sitesnsign-signature");
  if (!token || !signatureHeader) {
    throw new SitesnsignAuthError();
  }

  const tokenHash = hashSitesnsignToken(token);
  const { orgId, secretEnc } = await withoutTenant(async (client) => {
    const { rows } = await client.query<{ org_id: string | null; secret_enc: unknown }>(
      `SELECT resolve_org_by_sitesnsign_token($1) AS org_id, resolve_sitesnsign_secret($1) AS secret_enc`,
      [tokenHash]
    );
    return { orgId: rows[0]?.org_id ?? null, secretEnc: rows[0]?.secret_enc ?? null };
  });
  if (!orgId || !secretEnc) {
    throw new SitesnsignAuthError();
  }

  const secret = decryptSitesnsignSecret(secretEnc);
  const expected = computeSignature(rawBody, secret);
  const provided = signatureHeader.startsWith("sha256=") ? signatureHeader.slice("sha256=".length) : signatureHeader;
  if (!timingSafeEqualHex(provided, expected)) {
    throw new SitesnsignAuthError();
  }

  try {
    await checkRateLimit(`sitesnsign-webhook:${orgId}`, 60, 60);
  } catch (err) {
    if (err instanceof RateLimitExceededError) {
      throw new SitesnsignAuthError("Rate limit exceeded — too many requests from this source.");
    }
    throw err;
  }

  return orgId;
}
