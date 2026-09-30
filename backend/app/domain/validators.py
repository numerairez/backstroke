"""Field normalization and whole-state integrity rules."""

from __future__ import annotations

from datetime import date
from typing import Any

from .events import State

DELIVERABLE_TYPES = ("task", "milestone")
DEPENDENCY_TYPES = ("FS",)

# entity_type -> field -> kind. Every field is required on create unless it has a default.
FIELD_SPECS: dict[str, dict[str, str]] = {
    "workstream": {"name": "name", "order_index": "int"},
    "deliverable": {
        "workstream_id": "ref",
        "type": "deliverable_type",
        "name": "name",
        "start_date": "date",
        "end_date": "date",
    },
    "dependency": {"predecessor_id": "ref", "successor_id": "ref", "type": "dependency_type"},
}
FIELD_DEFAULTS: dict[str, dict[str, Any]] = {
    "workstream": {},
    "deliverable": {"type": "task"},
    "dependency": {"type": "FS"},
}

REASON_CATEGORIES = [
    {"code": "dependency", "label": "Dependency", "description": "Upstream deliverable, system, vendor, or prerequisite moved."},
    {"code": "scope", "label": "Scope", "description": "Requirement added, removed, expanded, or deferred."},
    {"code": "resource", "label": "Resource", "description": "Availability or capacity changed."},
    {"code": "estimate", "label": "Estimate", "description": "Team revised expected duration based on new evidence."},
    {"code": "priority", "label": "Priority", "description": "Sequence changed due to business prioritization."},
    {"code": "risk", "label": "Risk", "description": "Mitigation or control work inserted."},
    {"code": "approval", "label": "Approval", "description": "Waiting for review, sign-off, or governance."},
    {"code": "external", "label": "External", "description": "Regulatory, vendor, infrastructure, or other outside factor."},
    {"code": "correction", "label": "Correction", "description": "Previous plan entry was incorrect."},
    {"code": "other", "label": "Other", "description": "Free-form explanation when no category applies."},
]
CATEGORY_CODES = {c["code"] for c in REASON_CATEGORIES}


class FieldError(ValueError):
    pass


def parse_date(value: str) -> date:
    return date.fromisoformat(value)


def normalize_field(entity_type: str, field: str, value: Any) -> Any:
    kind = FIELD_SPECS[entity_type].get(field)
    if kind is None:
        raise FieldError(f"unknown field {field!r} for {entity_type}")

    if kind == "name":
        if not isinstance(value, str) or not value.strip():
            raise FieldError(f"{field} must be a non-empty string")
        return value.strip()
    if kind == "ref":
        if not isinstance(value, str) or not value:
            raise FieldError(f"{field} must be an id")
        return value
    if kind == "int":
        if isinstance(value, bool) or not isinstance(value, int):
            raise FieldError(f"{field} must be an integer")
        return value
    if kind == "date":
        if not isinstance(value, str) or len(value) != 10:
            raise FieldError(f"{field} must be a YYYY-MM-DD date")
        try:
            return parse_date(value).isoformat()
        except ValueError:
            raise FieldError(f"{field} must be a YYYY-MM-DD date") from None
    if kind == "deliverable_type":
        if value not in DELIVERABLE_TYPES:
            raise FieldError(f"type must be one of {', '.join(DELIVERABLE_TYPES)}")
        return value
    if kind == "dependency_type":
        if value not in DEPENDENCY_TYPES:
            raise FieldError(f"dependency type must be one of {', '.join(DEPENDENCY_TYPES)}")
        return value
    raise AssertionError(kind)


def validate_state(state: State) -> list[dict[str, Any]]:
    """Integrity rules that must hold for any committed plan state."""
    errors: list[dict[str, Any]] = []

    def err(code: str, message: str, entity_type: str, entity_id: str) -> None:
        errors.append({"code": code, "message": message, "entity_type": entity_type, "entity_id": entity_id})

    workstreams = state["workstreams"]
    deliverables = state["deliverables"]

    for d in deliverables.values():
        if d["workstream_id"] not in workstreams:
            err("missing_workstream", f"“{d['name']}” belongs to a workstream that does not exist", "deliverable", d["id"])
        if d["start_date"] > d["end_date"]:
            err("invalid_dates", f"“{d['name']}” ends before it starts", "deliverable", d["id"])
        if d["type"] == "milestone" and d["start_date"] != d["end_date"]:
            err("invalid_milestone", f"Milestone “{d['name']}” must start and end on the same date", "deliverable", d["id"])

    seen_pairs: set[tuple[str, str]] = set()
    for dep in state["dependencies"].values():
        pred, succ = dep["predecessor_id"], dep["successor_id"]
        if pred not in deliverables or succ not in deliverables:
            err("missing_endpoint", "Dependency references a deliverable that does not exist", "dependency", dep["id"])
            continue
        if pred == succ:
            err("self_dependency", "A deliverable cannot depend on itself", "dependency", dep["id"])
        if (pred, succ) in seen_pairs:
            err("duplicate_dependency", f"“{deliverables[pred]['name']}” → “{deliverables[succ]['name']}” already exists", "dependency", dep["id"])
        seen_pairs.add((pred, succ))

    cycle = find_cycle(state)
    if cycle:
        names = " → ".join(deliverables[i]["name"] for i in cycle)
        err("dependency_cycle", f"Dependencies form a cycle: {names}", "dependency", "")

    return errors


def find_cycle(state: State) -> list[str] | None:
    graph: dict[str, list[str]] = {}
    for dep in state["dependencies"].values():
        if dep["predecessor_id"] in state["deliverables"] and dep["successor_id"] in state["deliverables"]:
            graph.setdefault(dep["predecessor_id"], []).append(dep["successor_id"])

    WHITE, GREY, BLACK = 0, 1, 2
    color: dict[str, int] = {}
    stack: list[str] = []

    def visit(node: str) -> list[str] | None:
        color[node] = GREY
        stack.append(node)
        for nxt in graph.get(node, []):
            c = color.get(nxt, WHITE)
            if c == GREY:
                return stack[stack.index(nxt):] + [nxt]
            if c == WHITE:
                found = visit(nxt)
                if found:
                    return found
        stack.pop()
        color[node] = BLACK
        return None

    for node in sorted(graph):
        if color.get(node, WHITE) == WHITE:
            found = visit(node)
            if found:
                return found
    return None
