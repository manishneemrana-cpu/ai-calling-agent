from __future__ import annotations

from voice_gateway.knowledge.chunking import chunk_text


def test_chunk_text_empty_input_returns_no_chunks():
    assert chunk_text("") == []
    assert chunk_text("   \n\t  ") == []


def test_chunk_text_short_text_is_a_single_chunk():
    assert chunk_text("Hello world", max_chars=500) == ["Hello world"]


def test_chunk_text_splits_on_whitespace_never_mid_word():
    text = " ".join(f"word{i}" for i in range(50))  # long text, short words
    chunks = chunk_text(text, max_chars=30, overlap_chars=5)
    assert len(chunks) > 1
    for chunk in chunks:
        assert len(chunk) <= 30
        # No chunk starts or ends mid-word (every chunk is whole "wordN" tokens).
        for token in chunk.split():
            assert token.startswith("word")


def test_chunk_text_overlap_repeats_trailing_context():
    text = " ".join(f"w{i}" for i in range(20))
    chunks = chunk_text(text, max_chars=20, overlap_chars=8)
    assert len(chunks) >= 2
    # Some suffix of chunk[0] should reappear as a prefix of chunk[1].
    assert chunks[0][-5:] in chunks[1] or chunks[1].startswith(chunks[0].split()[-1])


def test_chunk_text_rejects_invalid_sizes():
    import pytest

    with pytest.raises(ValueError):
        chunk_text("x", max_chars=0)
    with pytest.raises(ValueError):
        chunk_text("x", max_chars=10, overlap_chars=10)
