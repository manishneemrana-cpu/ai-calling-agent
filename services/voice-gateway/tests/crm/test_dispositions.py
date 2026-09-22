from __future__ import annotations

from voice_gateway.crm.dispositions import (
    CallOutcomeSignals,
    DispositionOption,
    classify_disposition,
)

DEFAULT_SET = [
    DispositionOption(id="1", disposition_key="connected", category="connected"),
    DispositionOption(id="2", disposition_key="no_answer", category="no_contact"),
    DispositionOption(id="3", disposition_key="busy", category="no_contact"),
    DispositionOption(id="4", disposition_key="wrong_number", category="no_contact"),
    DispositionOption(id="5", disposition_key="callback", category="follow_up"),
    DispositionOption(id="6", disposition_key="interested", category="interest"),
    DispositionOption(id="7", disposition_key="not_interested", category="interest"),
    DispositionOption(id="8", disposition_key="qualified", category="qualification"),
    DispositionOption(id="9", disposition_key="site_visit", category="qualification"),
    DispositionOption(id="10", disposition_key="transferred", category="transfer"),
    DispositionOption(id="11", disposition_key="dnd_request", category="compliance"),
    DispositionOption(id="12", disposition_key="failed", category="failed"),
]


def test_no_answer_maps_directly():
    signals = CallOutcomeSignals(telephony_status="no_answer")
    result = classify_disposition(signals, DEFAULT_SET)
    assert result.disposition_key == "no_answer"


def test_busy_maps_directly():
    signals = CallOutcomeSignals(telephony_status="busy")
    result = classify_disposition(signals, DEFAULT_SET)
    assert result.disposition_key == "busy"


def test_wrong_number_flag():
    signals = CallOutcomeSignals(telephony_status="answered", wrong_number_flag=True)
    result = classify_disposition(signals, DEFAULT_SET)
    assert result.disposition_key == "wrong_number"


def test_dnd_request_takes_priority_over_other_tool_signals():
    signals = CallOutcomeSignals(
        telephony_status="answered",
        had_transcript=True,
        duration_seconds=30,
        tool_signals=frozenset({"request_dnd", "qualified"}),
    )
    result = classify_disposition(signals, DEFAULT_SET)
    assert result.disposition_key == "dnd_request"


def test_transfer_to_human_signal():
    signals = CallOutcomeSignals(
        telephony_status="answered",
        had_transcript=True,
        duration_seconds=60,
        tool_signals=frozenset({"transfer_to_human"}),
    )
    result = classify_disposition(signals, DEFAULT_SET)
    assert result.disposition_key == "transferred"


def test_schedule_callback_signal():
    signals = CallOutcomeSignals(
        telephony_status="answered",
        had_transcript=True,
        duration_seconds=45,
        tool_signals=frozenset({"schedule_callback"}),
    )
    result = classify_disposition(signals, DEFAULT_SET)
    assert result.disposition_key == "callback"


def test_site_visit_booked_signal():
    signals = CallOutcomeSignals(
        telephony_status="answered",
        had_transcript=True,
        duration_seconds=120,
        tool_signals=frozenset({"site_visit_booked"}),
    )
    result = classify_disposition(signals, DEFAULT_SET)
    assert result.disposition_key == "site_visit"


def test_not_interested_signal():
    signals = CallOutcomeSignals(
        telephony_status="answered",
        had_transcript=True,
        duration_seconds=40,
        tool_signals=frozenset({"not_interested"}),
    )
    result = classify_disposition(signals, DEFAULT_SET)
    assert result.disposition_key == "not_interested"


def test_plain_connected_call_with_no_special_signals():
    signals = CallOutcomeSignals(telephony_status="answered", had_transcript=True, duration_seconds=90)
    result = classify_disposition(signals, DEFAULT_SET)
    assert result.disposition_key == "connected"


def test_answered_but_no_transcript_falls_back_to_failed():
    signals = CallOutcomeSignals(telephony_status="answered", had_transcript=False, duration_seconds=0)
    result = classify_disposition(signals, DEFAULT_SET)
    assert result.disposition_key == "failed"


def test_falls_back_to_category_when_exact_key_missing_from_tenant_set():
    # Tenant removed "dnd_request" entirely but kept a "compliance"-category row.
    tenant_set = [
        DispositionOption(id="1", disposition_key="connected", category="connected"),
        DispositionOption(id="2", disposition_key="custom_dnc", category="compliance"),
    ]
    signals = CallOutcomeSignals(
        telephony_status="answered",
        had_transcript=True,
        duration_seconds=30,
        tool_signals=frozenset({"request_dnd"}),
    )
    result = classify_disposition(signals, tenant_set)
    assert result.disposition_key == "custom_dnc"


def test_returns_none_when_nothing_matches_at_all():
    signals = CallOutcomeSignals(telephony_status="no_answer")
    result = classify_disposition(signals, [])
    assert result is None
