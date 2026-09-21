"""Shared pgvector wire-format helper — see ingest.py's module docstring for
why this exists (asyncpg has no built-in `vector` type codec)."""

from __future__ import annotations


def vector_literal(values: list[float]) -> str:
    return "[" + ",".join(repr(float(v)) for v in values) + "]"
