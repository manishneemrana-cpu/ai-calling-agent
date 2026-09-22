"""Phase 5 CRM logic: disposition auto-classification, lead scoring, call
summary generation, and human handoff. See docs/CRM_LOGIC.md for the
documented ruleset behind each module — none of it branches on industry
vertical; every rule operates on tenant-configured rows
(`dispositions`, `lead_scoring_criteria`) or generic signals.
"""
