"""Optional phases inside a deliverable.

A deliverable's `phases` is either None (a plain bar) or an ordered list such as

    [{"name": "Dev", "days": 12}, {"name": "Review", "days": 3, "gap": 2}, {"name": "UAT"}]

By default a phase starts the day after the previous one ends. An optional `gap`
leaves that many days free before it (the team is on something else). The first
phase starts with the deliverable. Every phase but the last has a fixed length in
days, and the last runs to the deliverable's end date. Storing lengths rather than
dates means that moving a deliverable, or pushing it downstream, never has to touch
its phases.
"""

from __future__ import annotations

from datetime import date, timedelta
from typing import Any

MIN_PHASES = 2


def fixed_days(phases: list[dict[str, Any]]) -> int:
    """Days taken by every phase except the last, plus every gap."""
    return sum(p["days"] for p in phases[:-1]) + sum(p.get("gap", 0) for p in phases)


def phase_spans(deliverable: dict[str, Any]) -> list[dict[str, Any]]:
    """Each phase with its dates and length. Empty for a deliverable without phases."""
    phases = deliverable.get("phases") or []
    start = date.fromisoformat(deliverable["start_date"])
    end = date.fromisoformat(deliverable["end_date"])
    spans = []
    for i, phase in enumerate(phases):
        start += timedelta(days=phase.get("gap", 0))
        last = i == len(phases) - 1
        phase_end = end if last else start + timedelta(days=phase["days"] - 1)
        spans.append(
            {
                "name": phase["name"],
                "gap": phase.get("gap", 0),
                "start_date": start.isoformat(),
                "end_date": phase_end.isoformat(),
                "days": (phase_end - start).days + 1,
            }
        )
        start = phase_end + timedelta(days=1)
    return spans


def carry_progress(current: list[dict[str, Any]] | None, new: list[dict[str, Any]] | None) -> list[dict[str, Any]] | None:
    """Copy finish dates from the current phases onto an edited list.

    Plan edits never change progress. A phase keeps its finish date when its name is
    unchanged, or, when the number of phases is the same, when it was renamed in place.
    """
    if new is None:
        return None
    old = current or []
    by_name = {p["name"].casefold(): p for p in old}
    out = []
    for i, phase in enumerate(new):
        kept = {k: v for k, v in phase.items() if k != "finished_on"}
        source = by_name.get(phase["name"].casefold())
        if source is None and len(old) == len(new):
            source = old[i]
        if source and source.get("finished_on"):
            kept["finished_on"] = source["finished_on"]
        out.append(kept)
    return out


def finish_of(deliverable: dict[str, Any]) -> str | None:
    """When the deliverable was finished: its own date, or its last phase's."""
    if deliverable.get("phases"):
        return deliverable["phases"][-1].get("finished_on")
    return deliverable.get("finished_on")


def phase_names(deliverable: dict[str, Any] | None) -> list[str] | None:
    if not deliverable or not deliverable.get("phases"):
        return None
    return [p["name"] for p in deliverable["phases"]]


def phase_deltas(before: dict[str, Any] | None, after: dict[str, Any] | None) -> list[dict[str, Any]] | None:
    """Per-phase change between two versions of a deliverable.

    Only defined when both versions have the same phases in the same order;
    otherwise the phases are not comparable and callers fall back to whole-bar dates.
    """
    names = phase_names(before)
    if names is None or names != phase_names(after):
        return None
    out = []
    for a, b in zip(phase_spans(before), phase_spans(after)):
        out.append(
            {
                "name": a["name"],
                "before_days": a["days"],
                "after_days": b["days"],
                "delta_days": b["days"] - a["days"],
                "before_gap_days": a["gap"],
                "after_gap_days": b["gap"],
                "start_delta_days": (date.fromisoformat(b["start_date"]) - date.fromisoformat(a["start_date"])).days,
                "end_delta_days": (date.fromisoformat(b["end_date"]) - date.fromisoformat(a["end_date"])).days,
            }
        )
    return out
