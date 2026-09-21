"""Proves the deterministic prompt-construction scaffolding around
grounding — NOT real LLM behavior (untestable without a live key, per the
task's own scoping) — specifically that:
  1. when retrieval found relevant chunks, they're injected into the system
     prompt as the sole source of business facts, and
  2. when retrieval found nothing, the "don't invent, deflect" instruction
     (the spec's own example line) is present in the constructed prompt
     instead — i.e. the deflect path is actually triggered by empty
     retrieval, not just documented in a comment.
"""

from __future__ import annotations

from voice_gateway.knowledge.grounding import (
    DEFLECTION_INSTRUCTION_HI,
    build_grounded_system_prompt,
    is_grounded_in_knowledge_base,
)
from voice_gateway.knowledge.retrieval import RetrievedChunk


def test_prompt_includes_retrieved_chunks_when_present():
    chunks = [
        RetrievedChunk(
            content="Returns are accepted within 7 days.", similarity=0.9, knowledge_document_id="d1"
        ),
        RetrievedChunk(content="Refunds take 3-5 business days.", similarity=0.8, knowledge_document_id="d1"),
    ]
    prompt = build_grounded_system_prompt("You are a friendly support agent.", chunks)

    assert "You are a friendly support agent." in prompt
    assert "Returns are accepted within 7 days." in prompt
    assert "Refunds take 3-5 business days." in prompt
    assert is_grounded_in_knowledge_base(prompt) is True
    assert DEFLECTION_INSTRUCTION_HI not in prompt


def test_prompt_deflects_when_retrieval_is_empty():
    prompt = build_grounded_system_prompt("You are a friendly support agent.", [])

    assert "You are a friendly support agent." in prompt
    assert DEFLECTION_INSTRUCTION_HI in prompt
    assert "Main galat jaankari nahi dena chahta" in prompt
    assert is_grounded_in_knowledge_base(prompt) is False


def test_prompt_never_omits_the_never_invent_rule_either_way():
    grounded = build_grounded_system_prompt("persona", [RetrievedChunk("x", 0.9, "d1")])
    deflecting = build_grounded_system_prompt("persona", [])
    for prompt in (grounded, deflecting):
        assert "Never invent, assume, or guess a business fact" in prompt
