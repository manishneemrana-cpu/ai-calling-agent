"""Mocked LLM responses shaped exactly like docs/PROMPT_TO_AGENT_BUILDER.md
§5's three worked examples (real estate, diagnostics lab, saree D2C) —
used by test_parser.py and test_commit-shaped tests on the apps/web side
(kept in sync manually since they cross the two runtimes)."""

from __future__ import annotations

import json

REAL_ESTATE_RESPONSE: dict = {
    "clarification_needed": False,
    "clarification_questions": [],
    "inferred_vertical": "real_estate",
    "inferred_vertical_confidence": "high",
    "agent_persona": {
        "name": "Priya",
        "tone": "warm, consultative, patient with price-sensitive buyers",
        "language_style": "Hindi/English code-switching (Hinglish)",
    },
    "greeting_script": (
        "Namaste, main Priya bol rahi hoon [Broker name] ki taraf se... aapne "
        "hamari website par property inquiry ki thi... [consent disclosure placeholder]"
    ),
    "qualification_questions": [
        {"question": "What is your budget range?", "purpose": "budget qualification", "maps_to_field": "budget"},
        {"question": "Which locality do you prefer?", "purpose": "location fit", "maps_to_field": "location"},
        {"question": "2BHK, 3BHK, or a plot?", "purpose": "product type", "maps_to_field": "product_type"},
        {"question": "What is your purchase timeline?", "purpose": "urgency", "maps_to_field": "timeline"},
        {"question": "Do you already have financing arranged?", "purpose": "financing readiness", "maps_to_field": "financing_status"},
    ],
    "objection_handling": [
        {"objection": "price too high", "response_stub": "offer nearby comparable options"},
        {"objection": "just browsing", "response_stub": "offer to send brochure/WhatsApp catalog and soft-close for a callback"},
    ],
    "tools_needed": [
        {"tool_name": "check_availability", "description": "unit/plot inventory", "example_use": "check if a 2BHK is available"},
        {"tool_name": "book_appointment", "description": "site visit", "example_use": "book a site visit slot"},
        {"tool_name": "check_eligibility", "description": "EMI/loan pre-check", "example_use": "estimate loan eligibility"},
    ],
    "knowledge_base_scaffold": {
        "suggested_categories": ["property catalog", "pricing/FAQs", "policy documents"],
        "seed_faqs": [{"question": "What is the possession date?", "answer_stub": "see project-specific documents"}],
    },
    "suggested_pipeline_stages": [
        "New", "Contacted", "Qualified", "Site Visit Booked", "Negotiation", "Won", "Lost",
    ],
    "suggested_dispositions": [
        "Interested-Hot", "Interested-Nurture", "Budget Mismatch", "Not Interested",
        "Wrong Number", "Callback Requested",
    ],
    "suggested_lead_scoring_criteria": [
        {"criterion": "budget confirmed", "weight_hint": "high"},
        {"criterion": "timeline under 3 months", "weight_hint": "high"},
        {"criterion": "financing pre-approved", "weight_hint": "medium"},
    ],
    "compliance_flags": [],
}

DIAGNOSTICS_RESPONSE: dict = {
    "clarification_needed": False,
    "clarification_questions": [],
    "inferred_vertical": "healthcare_diagnostics",
    "inferred_vertical_confidence": "high",
    "agent_persona": {
        "name": "Anaya",
        "tone": "empathetic, reassuring, non-alarmist",
        "language_style": "clear English/Hindi, avoids medical jargon",
    },
    "greeting_script": "Namaste, main Anaya bol rahi hoon [Lab name] se, aapki report ready ho gayi hai...",
    "qualification_questions": [
        {"question": "How would you like to receive your report?", "purpose": "delivery preference", "maps_to_field": "report_delivery_channel"},
        {"question": "Would you like a follow-up consultation?", "purpose": "upsell/consult interest", "maps_to_field": "wants_consultation"},
        {"question": "Any symptoms since the test?", "purpose": "escalation trigger, never diagnosed by the agent", "maps_to_field": "symptom_flag"},
    ],
    "objection_handling": [
        {"objection": "why are you calling me", "response_stub": "clarify this is a report-ready courtesy call, not a sales call, before any upsell"},
        {"objection": "not interested in packages", "response_stub": "thank and close politely, no repeated pressure"},
    ],
    "tools_needed": [
        {"tool_name": "lookup_order_status", "description": "report status", "example_use": "check if the report is ready"},
        {"tool_name": "check_availability", "description": "checkup package slots", "example_use": "find an open slot"},
        {"tool_name": "escalate_to_human", "description": "any clinical question", "example_use": "caller asks about a specific result"},
    ],
    "knowledge_base_scaffold": {
        "suggested_categories": ["checkup packages", "pricing/FAQs"],
        "seed_faqs": [{"question": "How do I collect my report?", "answer_stub": "app/email/pickup options"}],
    },
    "suggested_pipeline_stages": ["Report Ready", "Notified", "Package Offered", "Booked", "Declined"],
    "suggested_dispositions": [
        "Report Collected", "Package Booked", "Not Interested", "Escalated to Doctor", "Unreachable",
    ],
    "suggested_lead_scoring_criteria": [
        {"criterion": "has abnormal-flagged test", "weight_hint": "high"},
        {"criterion": "package interest expressed", "weight_hint": "medium"},
    ],
    "compliance_flags": [
        "healthcare: agent must never state or imply a diagnosis; any clinical question escalates to a human",
        "health data: report-status calls carry PHI-like sensitivity — treat consent/DND rules as elevated",
    ],
}

ECOMMERCE_D2C_RESPONSE: dict = {
    "clarification_needed": False,
    "clarification_questions": [],
    "inferred_vertical": "ecommerce_d2c",
    "inferred_vertical_confidence": "high",
    "agent_persona": {
        "name": "Meera",
        "tone": "friendly, upbeat, light sales pressure",
        "language_style": "casual Hindi/English",
    },
    "greeting_script": "Hii, main Meera bol rahi hoon [Store name] se, maine dekha aapne kuch sundar sarees cart mein daale the...",
    "qualification_questions": [
        {"question": "What stopped you from completing checkout?", "purpose": "abandonment reason", "maps_to_field": "abandonment_reason"},
        {"question": "Still interested in the same item, or alternatives?", "purpose": "intent check", "maps_to_field": "item_interest"},
        {"question": "COD or prepaid preferred?", "purpose": "payment friction", "maps_to_field": "payment_preference"},
    ],
    "objection_handling": [
        {"objection": "too expensive", "response_stub": "offer the pre-approved discount code once, don't stack further discounts"},
        {"objection": "changed my mind", "response_stub": "thank and ask permission to notify about future sales instead of pushing"},
    ],
    "tools_needed": [
        {"tool_name": "lookup_order_status", "description": "cart contents", "example_use": "check what's in the abandoned cart"},
        {"tool_name": "check_availability", "description": "stock/size", "example_use": "confirm size is in stock"},
        {"tool_name": "apply_discount_code", "description": "bounded, pre-approved codes only", "example_use": "apply SAVE10"},
    ],
    "knowledge_base_scaffold": {
        "suggested_categories": ["product catalog", "shipping/returns policy"],
        "seed_faqs": [{"question": "What is the return window?", "answer_stub": "see store policy"}],
    },
    "suggested_pipeline_stages": ["Cart Abandoned", "Contacted", "Discount Offered", "Converted", "Not Converted"],
    "suggested_dispositions": [
        "Purchased After Call", "Declined Discount", "Wrong Number", "Opted Out of Marketing Calls", "Unreachable",
    ],
    "suggested_lead_scoring_criteria": [
        {"criterion": "cart value above threshold", "weight_hint": "high"},
        {"criterion": "repeat customer", "weight_hint": "medium"},
        {"criterion": "responded positively to discount", "weight_hint": "high"},
    ],
    "compliance_flags": [],
}

VAGUE_DESCRIPTION = "I run a clinic and want to call people about my business."

CLARIFICATION_RESPONSE: dict = {
    "clarification_needed": True,
    "clarification_questions": [
        "What kind of clinic is this (e.g. dental, diagnostics, general physician)?",
        "What is the main goal of these calls — bookings, reminders, follow-ups, or something else?",
        "Who are you calling — new inquiries, existing patients, or both?",
    ],
}

MALFORMED_RESPONSE_TEXT = "Sure! Here's your agent config: {not valid json at all!!"


def raw(payload: dict) -> str:
    return json.dumps(payload)
