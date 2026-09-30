"""Structural and field-level differences between two plan states."""

from __future__ import annotations

from typing import Any

from ..domain.events import State
from ..domain.phases import phase_deltas
from ..domain.validators import FIELD_SPECS
from .dependency_service import days_between


def _duration(d: dict[str, Any]) -> int:
    return days_between(d["start_date"], d["end_date"]) + 1


def _entity_diffs(entity_type: str, old: dict[str, dict], new: dict[str, dict]) -> list[dict[str, Any]]:
    out = []
    for entity_id in sorted(set(old) | set(new)):
        a, b = old.get(entity_id), new.get(entity_id)
        if a == b:
            continue
        entry: dict[str, Any] = {"id": entity_id, "before": a, "after": b}
        if a is None:
            entry["status"] = "added"
        elif b is None:
            entry["status"] = "removed"
        else:
            entry["status"] = "changed"
            entry["changes"] = [
                {"field": f, "old": a[f], "new": b[f]} for f in FIELD_SPECS[entity_type] if a[f] != b[f]
            ]
        out.append(entry)
    return out


def _progress_changes(a: dict[str, Any], b: dict[str, Any]) -> list[dict[str, Any]]:
    """Finish dates set or cleared between two versions (phase None for the whole deliverable)."""
    out = []
    if a.get("finished_on") != b.get("finished_on"):
        out.append({"phase": None, "before": a.get("finished_on"), "after": b.get("finished_on")})
    before = {p["name"]: p.get("finished_on") for p in a.get("phases") or []}
    for p in b.get("phases") or []:
        if p["name"] in before and before[p["name"]] != p.get("finished_on"):
            out.append({"phase": p["name"], "before": before[p["name"]], "after": p.get("finished_on")})
    return out


def diff_states(old: State, new: State) -> dict[str, Any]:
    deliverables = _entity_diffs("deliverable", old["deliverables"], new["deliverables"])
    for entry in deliverables:
        if entry["status"] != "changed":
            continue
        a, b = entry["before"], entry["after"]
        entry["start_delta_days"] = days_between(a["start_date"], b["start_date"])
        entry["end_delta_days"] = days_between(a["end_date"], b["end_date"])
        entry["duration_delta_days"] = _duration(b) - _duration(a)
        if a["workstream_id"] != b["workstream_id"]:
            entry["lane_change"] = {"from": a["workstream_id"], "to": b["workstream_id"]}
        deltas = phase_deltas(a, b)
        if deltas is not None:
            entry["phase_deltas"] = deltas
        progress = _progress_changes(a, b)
        if progress:
            entry["progress"] = progress

    workstreams = _entity_diffs("workstream", old["workstreams"], new["workstreams"])
    dependencies = _entity_diffs("dependency", old["dependencies"], new["dependencies"])

    moved = [e for e in deliverables if e["status"] == "changed" and (e["start_delta_days"] or e["end_delta_days"])]
    return {
        "workstreams": workstreams,
        "deliverables": deliverables,
        "dependencies": dependencies,
        "summary": {
            "moved": len(moved),
            "added": sum(1 for e in deliverables if e["status"] == "added"),
            "removed": sum(1 for e in deliverables if e["status"] == "removed"),
            "changed": len(deliverables),
            "later": sum(1 for e in moved if e["end_delta_days"] > 0),
            "earlier": sum(1 for e in moved if e["end_delta_days"] < 0),
            "dependencies_added": sum(1 for e in dependencies if e["status"] == "added"),
            "dependencies_removed": sum(1 for e in dependencies if e["status"] == "removed"),
        },
    }
