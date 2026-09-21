"""Grounding: wires knowledge-base retrieval into the LLM adapter layer
(voice_gateway/llm/) as an optional step, per the spec's non-negotiable
rule that the AI must never invent business-specific facts.

`build_grounded_system_prompt()` is the actual, testable prompt-construction
function — not just a comment — that `ConversationOrchestrator` (or
whatever assembles a turn's `Message` list before calling
`LLMProvider.stream_chat()`) calls once per turn:
  - retrieved chunks (if any) are injected into the system prompt as the
    ONLY source of business facts the LLM may use;
  - if retrieval finds nothing relevant, the system prompt instead
    instructs the LLM to say it doesn't want to give incorrect information
    (the spec's own example line, in Hindi) rather than guessing.

Kept deliberately separate from the LLM call itself: this function's output
is a `str` (the system prompt text), so it is fully testable without any
live LLM — see tests/knowledge/test_grounding_prompt.py, which asserts on
the constructed prompt text, not on real LLM behavior (which needs a live
key this codebase never has).
"""

from __future__ import annotations

from .retrieval import RetrievedChunk

# The spec's own example deflection line (Hindi/Hinglish, matching the
# founder's target market and the task's explicit wording) — used verbatim
# so the LLM has a concrete, on-brand sentence to reach for instead of
# improvising its own (an improvised deflection could itself drift into
# sounding like an invented answer).
DEFLECTION_INSTRUCTION_HI = (
    'Agar upar diye gaye "Knowledge base" section mein iska jawaab nahi mila, '
    "to guess ya andaza mat lagao. Is jaisa kuch bolo: "
    '"Main galat jaankari nahi dena chahta, main is baare mein sahi jaankari '
    'confirm karke aapko bataunga." Kabhi bhi price, availability, ya policy '
    "jaise business facts mat banao."
)

BASE_GROUNDING_RULE = (
    "You are a business voice agent. You must answer business-specific "
    "questions (price, availability, policy, product/service details) "
    "ONLY using the 'Knowledge base' section below, if present. Never "
    "invent, assume, or guess a business fact that is not explicitly "
    "stated there."
)


def build_grounded_system_prompt(
    base_persona_prompt: str,
    retrieved_chunks: list[RetrievedChunk],
) -> str:
    """Builds the full system prompt for one turn: the tenant's own
    persona/instructions (`base_persona_prompt`, from that agent's
    `agent_prompts` config — untouched by this function), followed by the
    grounding rule, followed by either the retrieved knowledge-base
    excerpts or the deflection instruction when `retrieved_chunks` is
    empty."""
    sections = [base_persona_prompt.strip(), BASE_GROUNDING_RULE]

    if retrieved_chunks:
        excerpts = "\n".join(f"- {chunk.content}" for chunk in retrieved_chunks)
        sections.append(f"Knowledge base (use ONLY this for business facts):\n{excerpts}")
    else:
        sections.append(
            "Knowledge base: no relevant information was found for this question. "
            + DEFLECTION_INSTRUCTION_HI
        )

    return "\n\n".join(sections)


def is_grounded_in_knowledge_base(system_prompt: str) -> bool:
    """True if `system_prompt` was built with at least one retrieved
    chunk (i.e. NOT the deflection path) — a small helper so callers/tests
    can assert which branch a given prompt took without string-matching the
    whole deflection sentence themselves."""
    return "Knowledge base (use ONLY this for business facts):" in system_prompt
