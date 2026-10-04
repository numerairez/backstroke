"""Where a deliverable stands as of a day. Mirrors frontend/src/state/status.ts.

Status is never stored: it comes from the planned dates, the finish dates and "today".
"""

from __future__ import annotations

from datetime import date
from typing import Any

from .phases import phase_spans


def _days(a: str, b: str) -> int:
    return (date.fromisoformat(b) - date.fromisoformat(a)).days


def span_status(start: str, end: str, finished_on: str | None, today: str) -> dict[str, Any]:
    if finished_on and finished_on <= today:
        return {"kind": "done", "delta": _days(end, finished_on), "finished_on": finished_on}
    if today < start:
        return {"kind": "todo"}
    if today > end:
        return {"kind": "overdue", "days": _days(end, today)}
    return {"kind": "progress", "left": _days(today, end)}


def deliverable_status(d: dict[str, Any], today: str) -> dict[str, Any] | None:
    """None for a milestone. A phased deliverable is "behind" when a phase is past its end
    and not done while the deliverable's own end date is still ahead."""
    if d["type"] == "milestone":
        return None
    if not d.get("phases"):
        return span_status(d["start_date"], d["end_date"], d.get("finished_on"), today)
    spans = phase_spans(d)
    statuses = [span_status(s["start_date"], s["end_date"], p.get("finished_on"), today) for s, p in zip(spans, d["phases"])]
    if statuses[-1]["kind"] == "done":
        return {**statuses[-1], "delta": _days(d["end_date"], statuses[-1]["finished_on"])}
    i = next(i for i, s in enumerate(statuses) if s["kind"] != "done")
    current = spans[i]["name"]
    if today > d["end_date"]:
        return {"kind": "overdue", "days": _days(d["end_date"], today), "current": current}
    if statuses[i]["kind"] == "overdue":
        return {"kind": "behind", "days": statuses[i]["days"], "current": current}
    if today < d["start_date"]:
        return {"kind": "todo"}
    return {"kind": "progress", "left": _days(today, d["end_date"]), "current": current}


def _plural(n: int, word: str) -> str:
    return f"{n} {word}{'' if n == 1 else 's'}"


def status_label(s: dict[str, Any]) -> str:
    kind = s["kind"]
    if kind == "done":
        delta = s.get("delta", 0)
        when = "on time" if delta == 0 else f"{_plural(delta, 'day')} late" if delta > 0 else f"{_plural(-delta, 'day')} early"
        return f"Done {s['finished_on']} ({when})"
    if kind == "overdue":
        return f"Overdue by {_plural(s['days'], 'day')}" + (f" (in {s['current']})" if s.get("current") else "")
    if kind == "behind":
        return f"Behind: {s['current']} is {_plural(s['days'], 'day')} late"
    if kind == "progress":
        left = "due today" if s["left"] == 0 else f"{_plural(s['left'], 'day')} left"
        return f"In progress, {left}" + (f" (in {s['current']})" if s.get("current") else "")
    return "Not started"
