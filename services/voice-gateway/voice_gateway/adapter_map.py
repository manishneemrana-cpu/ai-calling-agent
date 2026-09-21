"""The Python side of the self-registration adapter map.

Same contract as apps/web/lib/providers/adapter-map.ts: each adapter module
calls `register_adapter(identifier, factory)` at import time; `registry.py`
imports every built-in adapter module once (for that side effect) and then
does a single dict lookup on `providers.adapter_class_identifier` — never a
branch on provider identity. See docs/PROVIDER_REGISTRY.md.

Identifiers are the SAME namespaced strings ("stt.sarvam", "tts.cartesia",
"llm.gemini_flash", ...) written into the shared `providers` table by
db/migrations/008_stt_tts_llm_providers.sql — the TS and Python runtimes
both resolve against the identical catalog rows, they just each keep their
own in-process registration map (a Python dict here, a TS Map there).
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

AdapterFactory = Callable[[dict[str, Any]], Any]

_registry: dict[str, AdapterFactory] = {}


def register_adapter(identifier: str, factory: AdapterFactory) -> None:
    # Re-registration is harmless (repeated test imports of the same
    # module, module reload) — last write wins, matching adapter-map.ts.
    _registry[identifier] = factory


def resolve_adapter_factory(identifier: str) -> AdapterFactory | None:
    return _registry.get(identifier)


def list_registered_adapter_identifiers() -> list[str]:
    return list(_registry.keys())


def _unregister_adapter_for_tests(identifier: str) -> None:
    _registry.pop(identifier, None)
