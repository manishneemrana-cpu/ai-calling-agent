from __future__ import annotations

from voice_gateway.crm.scoring import ScoreBand, ScoringCriterion, score_lead

CRITERIA = [
    ScoringCriterion(criterion_key="budget_confirmed", weight=3),
    ScoringCriterion(criterion_key="timeline_lt_3_months", weight=3),
    ScoringCriterion(criterion_key="financing_preapproved", weight=2),
    ScoringCriterion(criterion_key="just_browsing", weight=1),
]


def test_all_criteria_satisfied_is_hot():
    result = score_lead(
        CRITERIA, {"budget_confirmed", "timeline_lt_3_months", "financing_preapproved", "just_browsing"}
    )
    assert result.band == ScoreBand.HOT
    assert result.score == 9
    assert result.max_possible_score == 9
    assert result.used_default is False


def test_high_weight_criteria_satisfied_is_hot():
    # 3 + 3 = 6 out of 9 -> ratio 0.666... -> HOT (>= 0.66 threshold)
    result = score_lead(CRITERIA, {"budget_confirmed", "timeline_lt_3_months"})
    assert result.band == ScoreBand.HOT
    assert result.score == 6


def test_partial_criteria_is_warm():
    # 3 out of 9 -> ratio 0.333 -> WARM (>= 0.33 threshold)
    result = score_lead(CRITERIA, {"budget_confirmed"})
    assert result.band == ScoreBand.WARM
    assert result.score == 3


def test_no_criteria_satisfied_is_cold():
    result = score_lead(CRITERIA, set())
    assert result.band == ScoreBand.COLD
    assert result.score == 0


def test_inactive_criteria_are_excluded_from_max_and_score():
    criteria = [
        ScoringCriterion(criterion_key="budget_confirmed", weight=3, is_active=True),
        ScoringCriterion(criterion_key="disabled_one", weight=100, is_active=False),
    ]
    result = score_lead(criteria, {"budget_confirmed", "disabled_one"})
    assert result.max_possible_score == 3
    assert result.score == 3
    assert result.band == ScoreBand.HOT


def test_zero_active_criteria_uses_documented_default_band():
    result = score_lead([], set())
    assert result.used_default is True
    assert result.band == ScoreBand.WARM
    assert result.score == 0
    assert result.max_possible_score == 0


def test_unsatisfied_key_not_in_criteria_is_ignored():
    result = score_lead(CRITERIA, {"budget_confirmed", "some_unknown_key"})
    assert result.score == 3
