"""Pure text chunking — no I/O, no provider calls. Deliberately simple
(fixed-size, word-boundary-respecting, overlapping windows) rather than a
semantic/sentence-aware chunker: good enough for a first RAG pass over
short FAQ/policy documents, and easy to replace later without touching
`ingest.py`'s call site (`chunk_text()` is the only function it calls)."""

from __future__ import annotations


def chunk_text(text: str, *, max_chars: int = 500, overlap_chars: int = 50) -> list[str]:
    """Splits `text` into chunks of at most `max_chars` characters, breaking
    on whitespace (never mid-word) where possible, with `overlap_chars` of
    trailing context repeated at the start of the next chunk (so a fact
    split across a chunk boundary is still findable via either chunk).
    Returns an empty list for blank/whitespace-only input."""
    if max_chars <= 0:
        raise ValueError("max_chars must be positive")
    if overlap_chars < 0 or overlap_chars >= max_chars:
        raise ValueError("overlap_chars must be >= 0 and < max_chars")

    normalized = " ".join(text.split())
    if not normalized:
        return []

    chunks: list[str] = []
    start = 0
    n = len(normalized)
    while start < n:
        end = min(start + max_chars, n)
        if end < n:
            # Prefer breaking at the last whitespace before `end` so we
            # never cut a word in half.
            last_space = normalized.rfind(" ", start, end)
            if last_space > start:
                end = last_space
        chunk = normalized[start:end].strip()
        if chunk:
            chunks.append(chunk)
        if end >= n:
            break

        # Next chunk's start = `overlap_chars` back from `end`, snapped
        # FORWARD to the next word boundary (never mid-word) — always
        # strictly after the current `start` so the loop makes progress.
        next_start = max(end - overlap_chars, start + 1)
        space_at_or_after = normalized.find(" ", next_start, end)
        start = (space_at_or_after + 1) if space_at_or_after != -1 else end
    return chunks
