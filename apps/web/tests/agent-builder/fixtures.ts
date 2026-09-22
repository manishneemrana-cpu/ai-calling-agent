import type { GeneratedAgentConfig } from "@/lib/voice-gateway/client";

/**
 * Mocked LLM-shaped responses matching docs/PROMPT_TO_AGENT_BUILDER.md §5's
 * three worked examples (real estate, diagnostics lab, saree D2C), in the
 * exact shape `voice_gateway/agent_builder/parser.py`'s
 * `GeneratedAgentConfig` (via `dataclasses.asdict()`) produces — kept in
 * sync manually with `services/voice-gateway/tests/agent_builder/fixtures.py`.
 */

export const REAL_ESTATE_CONFIG: GeneratedAgentConfig = {
  clarification_needed: false,
  clarification_questions: [],
  inferred_vertical: "real_estate",
  inferred_vertical_confidence: "high",
  agent_persona: { name: "Priya", tone: "warm, consultative", language_style: "Hinglish" },
  greeting_script: "Namaste, main Priya bol rahi hoon...",
  qualification_questions: [
    { question: "What is your budget range?", purpose: "budget", maps_to_field: "budget" },
    { question: "Which locality do you prefer?", purpose: "location", maps_to_field: "location" },
  ],
  objection_handling: [{ objection: "price too high", response_stub: "offer comparable options" }],
  tools_needed: [
    { tool_name: "check_availability", description: "unit/plot inventory", example_use: "check inventory" },
    { tool_name: "book_appointment", description: "site visit", example_use: "book a site visit" },
  ],
  knowledge_base_suggested_categories: ["property catalog", "pricing/FAQs"],
  knowledge_base_seed_faqs: [{ question: "Possession date?", answer_stub: "see project docs" }],
  suggested_pipeline_stages: ["New", "Contacted", "Qualified", "Site Visit Booked", "Won", "Lost"],
  suggested_dispositions: ["Interested-Hot", "Not Interested", "Wrong Number"],
  suggested_lead_scoring_criteria: [
    { criterion: "budget confirmed", weight_hint: "high" },
    { criterion: "financing pre-approved", weight_hint: "medium" },
  ],
  compliance_flags: [],
  needs_review: false,
  raw_llm_output: null,
};

export const DIAGNOSTICS_CONFIG: GeneratedAgentConfig = {
  clarification_needed: false,
  clarification_questions: [],
  inferred_vertical: "healthcare_diagnostics",
  inferred_vertical_confidence: "high",
  agent_persona: { name: "Anaya", tone: "empathetic, reassuring", language_style: "clear English/Hindi" },
  greeting_script: "Namaste, main Anaya bol rahi hoon, aapki report ready ho gayi hai...",
  qualification_questions: [
    { question: "How would you like to receive your report?", purpose: "delivery", maps_to_field: "channel" },
  ],
  objection_handling: [{ objection: "why are you calling me", response_stub: "clarify it's a courtesy call" }],
  tools_needed: [
    { tool_name: "lookup_order_status", description: "report status", example_use: "check report status" },
    { tool_name: "escalate_to_human", description: "clinical questions", example_use: "escalate" },
  ],
  knowledge_base_suggested_categories: ["checkup packages"],
  knowledge_base_seed_faqs: [],
  suggested_pipeline_stages: ["Report Ready", "Notified", "Booked", "Declined"],
  suggested_dispositions: ["Report Collected", "Package Booked", "Escalated to Doctor"],
  suggested_lead_scoring_criteria: [{ criterion: "has abnormal-flagged test", weight_hint: "high" }],
  compliance_flags: [
    "healthcare: agent must never state or imply a diagnosis; any clinical question escalates to a human",
  ],
  needs_review: false,
  raw_llm_output: null,
};

export const ECOMMERCE_D2C_CONFIG: GeneratedAgentConfig = {
  clarification_needed: false,
  clarification_questions: [],
  inferred_vertical: "ecommerce_d2c",
  inferred_vertical_confidence: "high",
  agent_persona: { name: "Meera", tone: "friendly, upbeat", language_style: "casual Hindi/English" },
  greeting_script: "Hii, main Meera bol rahi hoon, maine dekha aapne kuch sarees cart mein daale the...",
  qualification_questions: [
    { question: "What stopped you from completing checkout?", purpose: "reason", maps_to_field: "abandonment_reason" },
  ],
  objection_handling: [{ objection: "too expensive", response_stub: "offer the pre-approved discount code once" }],
  tools_needed: [
    { tool_name: "lookup_order_status", description: "cart contents", example_use: "check cart" },
    { tool_name: "apply_discount_code", description: "bounded, pre-approved codes only", example_use: "apply SAVE10" },
  ],
  knowledge_base_suggested_categories: ["product catalog"],
  knowledge_base_seed_faqs: [],
  suggested_pipeline_stages: ["Cart Abandoned", "Contacted", "Converted", "Not Converted"],
  suggested_dispositions: ["Purchased After Call", "Declined Discount", "Opted Out of Marketing Calls"],
  suggested_lead_scoring_criteria: [
    { criterion: "cart value above threshold", weight_hint: "high" },
    { criterion: "repeat customer", weight_hint: "medium" },
  ],
  compliance_flags: [],
  needs_review: false,
  raw_llm_output: null,
};

export const CLARIFICATION_CONFIG: GeneratedAgentConfig = {
  clarification_needed: true,
  clarification_questions: [
    "What kind of clinic is this (dental, diagnostics, general physician)?",
    "What is the main goal of these calls?",
  ],
  inferred_vertical: null,
  inferred_vertical_confidence: null,
  agent_persona: null,
  greeting_script: null,
  qualification_questions: [],
  objection_handling: [],
  tools_needed: [],
  knowledge_base_suggested_categories: [],
  knowledge_base_seed_faqs: [],
  suggested_pipeline_stages: [],
  suggested_dispositions: [],
  suggested_lead_scoring_criteria: [],
  compliance_flags: [],
  needs_review: false,
  raw_llm_output: null,
};

export const NEEDS_REVIEW_CONFIG: GeneratedAgentConfig = {
  ...REAL_ESTATE_CONFIG,
  needs_review: true,
  raw_llm_output: "malformed output preserved for review",
};
