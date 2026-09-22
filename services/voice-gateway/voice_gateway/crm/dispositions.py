"""Rule-based call-disposition auto-classifier. See docs/CRM_LOGIC.md
"Disposition auto-classification" for the full documented ruleset — this
module is a straight implementation of it, deliberately simple (a plain
rule chain, no ML), and a pure function so it's testable with fixtures and
no live call/DB required.

`classify_disposition` NEVER hardcodes a disposition tied to one vertical:
it produces a `disposition_key` string and looks that key up against the
tenant's OWN configured `dispositions` rows (passed in as
`available_dispositions`), falling back to the closest available category
rather than raising if a tenant's set doesn't include that exact key.
"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class CallOutcomeSignals:
    """Everything the classifier needs, pre-computed by whatever holds the
    call's lifecycle state (telephony status, STT/LLM tool-call signals) —
    this module never reaches into a live call/DB itself."""

    telephony_status: str  # "answered" | "no_answer" | "busy" | "failed"
    duration_seconds: int = 0
    had_transcript: bool = False
    tool_signals: frozenset[str] = field(default_factory=frozenset)
    wrong_number_flag: bool = False


@dataclass(frozen=True)
class DispositionOption:
    """One row of a tenant's `dispositions` table, as read from the DB."""

    id: str
    disposition_key: str
    category: str | None = None


# telephony_status -> disposition_key, when the call was never answered.
_TELEPHONY_STATUS_MAP = {
    "no_answer": "no_answer",
    "busy": "busy",
    "failed": "failed",
}

# tool_signal -> disposition_key, checked in this fixed priority order.
_TOOL_SIGNAL_PRIORITY: list[tuple[str, str]] = [
    ("request_dnd", "dnd_request"),
    ("transfer_to_human", "transferred"),
    ("schedule_callback", "callback"),
    ("site_visit_booked", "site_visit"),  # generic "booked/scheduled" signal — see docs/CRM_LOGIC.md
    ("qualified", "qualified"),
    ("not_interested", "not_interested"),
]

# When the ideal key isn't in a tenant's configured set, try these
# categories next, in order, before giving up.
_CATEGORY_FALLBACKS: dict[str, list[str]] = {
    "dnd_request": ["compliance", "no_contact"],
    "transferred": ["transfer", "qualification"],
    "callback": ["follow_up", "no_contact"],
    "site_visit": ["qualification"],
    "qualified": ["qualification"],
    "not_interested": ["interest"],
    "connected": ["connected"],
}


def _find_by_key(key: str, options: list[DispositionOption]) -> DispositionOption | None:
    for opt in options:
        if opt.disposition_key == key:
            return opt
    return None


def _find_by_category(categories: list[str], options: list[DispositionOption]) -> DispositionOption | None:
    for category in categories:
        for opt in options:
            if opt.category == category:
                return opt
    return None


def _resolve(key: str, options: list[DispositionOption]) -> DispositionOption | None:
    exact = _find_by_key(key, options)
    if exact is not None:
        return exact
    return _find_by_category(_CATEGORY_FALLBACKS.get(key, []), options)


def classify_disposition(
    signals: CallOutcomeSignals,
    available_dispositions: list[DispositionOption],
) -> DispositionOption | None:
    """Returns the best-matching `DispositionOption` for this tenant's
    configured set, or `None` if nothing in `available_dispositions`
    matches even a fallback category (never raises)."""

    # 1. Never-answered outcomes map directly off telephony status.
    if signals.telephony_status != "answered":
        key = _TELEPHONY_STATUS_MAP.get(signals.telephony_status, "failed")
        resolved = _resolve(key, available_dispositions)
        if resolved is not None:
            return resolved
        return _find_by_category(["failed"], available_dispositions)

    # 2. Wrong number, explicitly flagged.
    if signals.wrong_number_flag:
        resolved = _resolve("wrong_number", available_dispositions)
        if resolved is not None:
            return resolved

    # 3-8. Tool-call signals, in priority order.
    for signal_name, disposition_key in _TOOL_SIGNAL_PRIORITY:
        if signal_name in signals.tool_signals:
            resolved = _resolve(disposition_key, available_dispositions)
            if resolved is not None:
                return resolved

    # 9. Answered, produced a real transcript -> plain "connected".
    if signals.had_transcript and signals.duration_seconds > 0:
        resolved = _resolve("connected", available_dispositions)
        if resolved is not None:
            return resolved

    # 10. Answered but nothing usable happened -> fall back to "failed".
    return _find_by_category(["failed"], available_dispositions)
