"""Finish-to-start schedule conflicts and suggested downstream movement."""

from __future__ import annotations

import copy
from datetime import timedelta
from typing import Any

from ..domain.events import State
from ..domain.validators import parse_date


def days_between(a: str, b: str) -> int:
    """b - a in days."""
    return (parse_date(b) - parse_date(a)).days


def shift_date(value: str, days: int) -> str:
    return (parse_date(value) + timedelta(days=days)).isoformat()


def _required_start_gap(pred: dict[str, Any], succ: dict[str, Any]) -> int:
    # A task must start the day after its predecessor finishes. Milestones are
    # instants, so a milestone may fall on the same day as its neighbour.
    return 0 if "milestone" in (pred["type"], succ["type"]) else 1


def dependency_conflicts(state: State) -> list[dict[str, Any]]:
    deliverables = state["deliverables"]
    conflicts = []
    for dep in sorted(state["dependencies"].values(), key=lambda d: d["id"]):
        pred = deliverables.get(dep["predecessor_id"])
        succ = deliverables.get(dep["successor_id"])
        if not pred or not succ:
            continue
        earliest = shift_date(pred["end_date"], _required_start_gap(pred, succ))
        if succ["start_date"] < earliest:
            conflicts.append(
                {
                    "dependency_id": dep["id"],
                    "predecessor_id": pred["id"],
                    "successor_id": succ["id"],
                    "overlap_days": days_between(succ["start_date"], earliest),
                    "message": f"“{succ['name']}” starts before “{pred['name']}” finishes",
                }
            )
    return conflicts


def _topological_order(state: State) -> list[str]:
    incoming = {d: 0 for d in state["deliverables"]}
    outgoing: dict[str, list[str]] = {}
    for dep in state["dependencies"].values():
        if dep["predecessor_id"] in incoming and dep["successor_id"] in incoming:
            incoming[dep["successor_id"]] += 1
            outgoing.setdefault(dep["predecessor_id"], []).append(dep["successor_id"])
    ready = sorted(d for d, n in incoming.items() if n == 0)
    order = []
    while ready:
        node = ready.pop(0)
        order.append(node)
        for nxt in sorted(outgoing.get(node, [])):
            incoming[nxt] -= 1
            if incoming[nxt] == 0:
                ready.append(nxt)
        ready.sort()
    return order


def suggest_downstream(before: State, after: State) -> list[dict[str, Any]]:
    """Moves that would clear every FS conflict in `after`, walking downstream.

    A successor pushed by a predecessor that slipped by N days is moved by N
    days (keeping the slack the plan had), or by the minimum needed to clear
    the overlap if that is larger. Successors are never moved earlier.
    """
    tentative = copy.deepcopy(after)
    deliverables = tentative["deliverables"]
    slipped: dict[str, int] = {}
    for d_id, d in after["deliverables"].items():
        prior = before["deliverables"].get(d_id)
        if prior:
            slipped[d_id] = max(0, days_between(prior["end_date"], d["end_date"]))

    preds_of: dict[str, list[str]] = {}
    for dep in tentative["dependencies"].values():
        preds_of.setdefault(dep["successor_id"], []).append(dep["predecessor_id"])

    suggestions: dict[str, dict[str, Any]] = {}
    for node in _topological_order(tentative):
        succ = deliverables[node]
        shift = 0
        causes = []
        for pred_id in sorted(preds_of.get(node, [])):
            pred = deliverables.get(pred_id)
            if not pred:
                continue
            earliest = shift_date(pred["end_date"], _required_start_gap(pred, succ))
            if succ["start_date"] < earliest:
                needed = days_between(succ["start_date"], earliest)
                shift = max(shift, needed, slipped.get(pred_id, 0))
                causes.append(pred_id)
        if shift > 0:
            succ["start_date"] = shift_date(succ["start_date"], shift)
            succ["end_date"] = shift_date(succ["end_date"], shift)
            slipped[node] = slipped.get(node, 0) + shift
            original = after["deliverables"][node]
            suggestions[node] = {
                "deliverable_id": node,
                "shift_days": days_between(original["start_date"], succ["start_date"]),
                "start_date": succ["start_date"],
                "end_date": succ["end_date"],
                "because_of": causes,
            }
    return list(suggestions.values())
