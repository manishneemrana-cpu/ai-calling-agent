import { createCipheriv, createDecipheriv, randomBytes, createHash } from "crypto";

/**
 * Application-level envelope encryption for `tenant_provider_config.config`
 * (and, in Phase 3, any other per-tenant provider secret column). See
 * docs/PROVIDER_REGISTRY.md "Secrets" — the DB never stores plaintext
 * credentials; encryption/decryption happens here, in the app process,
 * keyed by PROVIDER_CONFIG_ENCRYPTION_KEY (an env var, never in the DB).
 *
 * TODO(infra, before real tenant secrets go live): replace this
 * single-symmetric-key-from-env approach with a real secrets manager/KMS
 * (per-tenant data keys, rotation, audit log of decrypt calls). This is
 * intentionally the minimum viable "never plaintext in Postgres" bar for
 * Phase 2, not the final design.
 */

const ALGORITHM = "aes-256-gcm";

export type EncryptedConfig = {
  iv: string;
  tag: string;
  ciphertext: string;
};

function getKey(): Buffer {
  const raw = process.env.PROVIDER_CONFIG_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      "PROVIDER_CONFIG_ENCRYPTION_KEY is not set. Required to encrypt/decrypt tenant_provider_config.config. " +
        "See .env.example."
    );
  }
  // Accept any-length passphrase for dev ergonomics; derive a stable 32-byte
  // key via SHA-256 rather than requiring an exact 32-byte hex/base64 value.
  return createHash("sha256").update(raw, "utf8").digest();
}

export function encryptProviderConfig(plaintext: Record<string, unknown>): EncryptedConfig {
  const key = getKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const json = Buffer.from(JSON.stringify(plaintext), "utf8");
  const ciphertext = Buffer.concat([cipher.update(json), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

export function decryptProviderConfig(encrypted: EncryptedConfig): Record<string, unknown> {
  const key = getKey();
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(encrypted.iv, "base64"));
  decipher.setAuthTag(Buffer.from(encrypted.tag, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(encrypted.ciphertext, "base64")),
    decipher.final(),
  ]);
  return JSON.parse(plaintext.toString("utf8"));
}

export function isEncryptedConfig(value: unknown): value is EncryptedConfig {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as EncryptedConfig).iv === "string" &&
    typeof (value as EncryptedConfig).tag === "string" &&
    typeof (value as EncryptedConfig).ciphertext === "string"
  );
}
