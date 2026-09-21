"""Envelope decryption for `tenant_provider_config.config`.

Mirrors apps/web/lib/providers/crypto.ts byte-for-byte (same algorithm, same
key derivation, same envelope shape) so a config row encrypted by the
Next.js app can be decrypted here, and vice versa — this is the one place
the two runtimes must agree on a wire format, since they share the same
Postgres row. See docs/PROVIDER_REGISTRY.md "Secrets".

Envelope shape (JSON, as stored in the `config` jsonb column):
    {"iv": "<base64, 12 bytes>", "tag": "<base64, 16 bytes>", "ciphertext": "<base64>"}

Algorithm: AES-256-GCM. Key: SHA-256 of the UTF-8 PROVIDER_CONFIG_ENCRYPTION_KEY
env var (accepts any-length passphrase for dev ergonomics, exactly like the
TS side's `createHash("sha256").update(raw, "utf8").digest()`).

TODO(infra, same note as crypto.ts): single symmetric key from an env var is
the Phase 2/3 minimum bar, not the final design — replace with a real
secrets manager/KMS before onboarding real tenant secrets.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
from typing import Any

from cryptography.hazmat.primitives.ciphers.aead import AESGCM


class EncryptionKeyMissingError(RuntimeError):
    pass


def _get_key() -> bytes:
    raw = os.environ.get("PROVIDER_CONFIG_ENCRYPTION_KEY")
    if not raw:
        raise EncryptionKeyMissingError(
            "PROVIDER_CONFIG_ENCRYPTION_KEY is not set. Required to decrypt "
            "tenant_provider_config.config. See .env.example."
        )
    return hashlib.sha256(raw.encode("utf-8")).digest()


def is_encrypted_config(value: Any) -> bool:
    return (
        isinstance(value, dict)
        and isinstance(value.get("iv"), str)
        and isinstance(value.get("tag"), str)
        and isinstance(value.get("ciphertext"), str)
    )


def decrypt_provider_config(encrypted: dict[str, str]) -> dict[str, Any]:
    key = _get_key()
    iv = base64.b64decode(encrypted["iv"])
    tag = base64.b64decode(encrypted["tag"])
    ciphertext = base64.b64decode(encrypted["ciphertext"])
    aesgcm = AESGCM(key)
    # AESGCM expects ciphertext+tag concatenated (cryptography's API differs
    # from Node's split ciphertext/authTag — reassemble to match).
    plaintext = aesgcm.decrypt(iv, ciphertext + tag, None)
    return json.loads(plaintext.decode("utf-8"))


def encrypt_provider_config(plaintext: dict[str, Any]) -> dict[str, str]:
    """Provided for symmetry/tests; the Python side is a reader in
    production (tenant config is written via apps/web's admin tooling), but
    tests need to produce a valid envelope without a live Node process."""
    key = _get_key()
    iv = os.urandom(12)
    aesgcm = AESGCM(key)
    raw = aesgcm.encrypt(iv, json.dumps(plaintext).encode("utf-8"), None)
    ciphertext, tag = raw[:-16], raw[-16:]
    return {
        "iv": base64.b64encode(iv).decode(),
        "tag": base64.b64encode(tag).decode(),
        "ciphertext": base64.b64encode(ciphertext).decode(),
    }
