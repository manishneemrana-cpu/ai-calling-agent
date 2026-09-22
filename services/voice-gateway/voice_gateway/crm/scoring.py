"""Tenant-configurable lead scoring: HOT / WARM / COLD. See
docs/CRM_LOGIC.md "Lead scoring" for the documented ruleset. A pure
function over a tenant's `lead_scoring_criteria` rows and a set of
"satisfied criterion keys" (determined elsewhere, typically from the call
summary/LLM) — no DB access, no vertical-specific branching.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum


class ScoreBand(str, Enum):  # noqa: UP042 — str mixin kept for easy DB/JSON serialization
    HOT = "hot"
    WARM = "warm"
    COLD = "cold"


@dataclass(frozen=True)
class ScoringCriterion:
    """One row of a tenant's `lead_scoring_criteria` table."""

    criterion_key: str
    weight: int
    is_active: bool = True


@dataclass(frozen=True)
class LeadScoreResult:
    score: int
    max_possible_score: int
    band: ScoreBand
    used_default: bool = False


# Proportional thresholds, applied against max_possible_score so tenants
# with different numbers/weights of criteria still get a meaningful split.
_HOT_THRESHOLD = 0.66
_WARM_THRESHOLD = 0.33

# Sensible default when a tenant has configured zero active criteria (never
# silently COLD or HOT for an unconfigured tenant) — see docs/CRM_LOGIC.md.
_DEFAULT_BAND_WHEN_UNCONFIGURED = ScoreBand.WARM


def score_lead(
    criteria: list[ScoringCriterion],
    satisfied_criterion_keys: set[str],
) -> LeadScoreResult:
    active = [c for c in criteria if c.is_active]

    if not active:
        return LeadScoreResult(
            score=0, max_possible_score=0, band=_DEFAULT_BAND_WHEN_UNCONFIGURED, used_default=True
        )

    max_possible_score = sum(c.weight for c in active)
    score = sum(c.weight for c in active if c.criterion_key in satisfied_criterion_keys)

    if max_possible_score == 0:
        # Every active criterion has weight 0 — degenerate config, same
        # "don't assert a band we have no evidence for" handling.
        return LeadScoreResult(
            score=0, max_possible_score=0, band=_DEFAULT_BAND_WHEN_UNCONFIGURED, used_default=True
        )

    ratio = score / max_possible_score
    if ratio >= _HOT_THRESHOLD:
        band = ScoreBand.HOT
    elif ratio >= _WARM_THRESHOLD:
        band = ScoreBand.WARM
    else:
        band = ScoreBand.COLD

    return LeadScoreResult(score=score, max_possible_score=max_possible_score, band=band, used_default=False)
