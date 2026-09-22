"""Phase 9: provider failover — the SAME conceptual pattern as
apps/web/lib/providers/failover.ts, applied to this runtime's registry
(voice_gateway/registry.py) for the stt/tts/llm/embedding layers.

Design: `tenant_provider_config.priority` (Phase 2) already ranks every
configured provider for a (org_id, layer). Failover just walks that ranked
list, instantiating and invoking each candidate in turn via a caller-supplied
`operation(provider) -> Awaitable[T]`, until one succeeds. Any exception OR a
timeout (wrapped in `asyncio.wait_for`) from `operation` counts as that
candidate failing — logs a `provider_failover_events` row (Phase 9's new
ledger) and moves on to the next-priority provider. Retries are capped at
`max_attempts` (default: every configured candidate, but never unbounded —
see FailoverExhaustedError) so a persistently-broken provider list fails
loudly instead of hanging or cascading forever.

This is deliberately generic over what `operation` does — it might be "make
one STT transcription call", "synthesize one TTS utterance", or (for a test)
just "prove this candidate was reached" — the wrapper never knows or cares
about STT/TTS/LLM specifics, exactly like `registry.get_provider` doesn't.
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from typing import Any, TypeVar

import asyncpg

from ..adapter_map import resolve_adapter_factory
from ..billing.failover_writer import write_failover_event
from ..crypto import decrypt_provider_config, is_encrypted_config
from ..db import with_tenant

T = TypeVar("T")

DEFAULT_TIMEOUT_S = 10.0
DEFAULT_MAX_ATTEMPTS = 3


class NoProvidersConfiguredError(Exception):
    def __init__(self, org_id: str, layer: str):
        super().__init__(f"No providers configured for org {org_id} at layer {layer}")


class AllProvidersFailedError(Exception):
    """Every configured provider for this (org_id, layer) failed (raised an
    exception or timed out). Callers must surface this clearly — never
    silently hang or crash uncontrolled."""

    def __init__(self, org_id: str, layer: str, attempts: list[tuple[str, str]]):
        self.attempts = attempts  # [(provider_key, failure_reason), ...]
        detail = "; ".join(f"{key}: {reason}" for key, reason in attempts)
        super().__init__(
            f"All {len(attempts)} configured provider(s) for org {org_id} layer {layer} failed: {detail}"
        )


async def call_with_failover(
    layer: str,
    org_id: str,
    user_id: str | None,
    operation: Callable[[Any], Awaitable[T]],
    *,
    call_id: str | None = None,
    timeout_s: float = DEFAULT_TIMEOUT_S,
    max_attempts: int = DEFAULT_MAX_ATTEMPTS,
) -> tuple[T, str]:
    """Runs `operation(provider_instance)` against the tenant's
    highest-priority configured provider for `layer`; on exception/timeout,
    logs a failover event and retries against the next-priority provider, up
    to `max_attempts` candidates. Returns (result, provider_key_used) on
    success. Raises NoProvidersConfiguredError if nothing is configured at
    all, or AllProvidersFailedError if every attempted candidate failed."""

    async def _load_candidates(conn: asyncpg.Connection) -> list[asyncpg.Record]:
        return await conn.fetch(
            """
            SELECT tpc.provider_key, tpc.config, p.adapter_class_identifier
              FROM tenant_provider_config tpc
              JOIN providers p ON p.layer = tpc.layer AND p.provider_key = tpc.provider_key
             WHERE tpc.org_id = $1 AND tpc.layer = $2
             ORDER BY tpc.is_default DESC, tpc.priority ASC
            """,
            org_id,
            layer,
        )

    candidates = await with_tenant(org_id, user_id, _load_candidates)
    if not candidates:
        raise NoProvidersConfiguredError(org_id, layer)

    attempts: list[tuple[str, str]] = []
    for candidate in candidates[:max_attempts]:
        provider_key = candidate["provider_key"]
        try:
            factory = resolve_adapter_factory(candidate["adapter_class_identifier"])
            if factory is None:
                raise RuntimeError(
                    f'No adapter registered for identifier "{candidate["adapter_class_identifier"]}"'
                )
            config = candidate["config"]
            if isinstance(config, str):
                import json

                config = json.loads(config)
            if is_encrypted_config(config):
                config = decrypt_provider_config(config)
            provider = factory(config or {})

            result = await asyncio.wait_for(operation(provider), timeout=timeout_s)
            return result, provider_key
        except TimeoutError:
            reason = f"timeout after {timeout_s}s"
        except Exception as exc:  # noqa: BLE001 - deliberately broad: any adapter failure triggers failover
            reason = f"exception: {exc}"

        attempts.append((provider_key, reason))
        next_candidate = candidates[len(attempts)] if len(attempts) < len(candidates[:max_attempts]) else None
        if next_candidate is not None:
            await write_failover_event(
                org_id,
                layer,
                provider_key,
                next_candidate["provider_key"],
                reason,
                call_id,
            )

    # Every attempted candidate failed — log a terminal exhaustion event
    # (from_provider = last attempted, to_provider = itself, reason spells
    # out total exhaustion) so the Provider Scoreboard can also see "this
    # layer went down entirely for this tenant", then raise loudly.
    last_provider_key, last_reason = attempts[-1]
    exhaustion_reason = f"all_providers_exhausted: {last_reason}"
    await write_failover_event(
        org_id, layer, last_provider_key, last_provider_key, exhaustion_reason, call_id
    )
    raise AllProvidersFailedError(org_id, layer, attempts)
