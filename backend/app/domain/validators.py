"""Field normalization and whole-state integrity rules."""

from __future__ import annotations

from datetime import date
from typing import Any

from .events import State
from .phases import MIN_PHASES, fixed_days

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
        "phases": "phases",
        "finished_on": "optional_date",
    },
    "dependency": {"predecessor_id": "ref", "successor_id": "ref", "type": "dependency_type"},
}
FIELD_DEFAULTS: dict[str, dict[str, Any]] = {
    "workstream": {},
    "deliverable": {"type": "task", "phases": None, "finished_on": None},
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
    # Recorded by Mark done / Reopen, never chosen in the commit dialog.
    {"code": "progress", "label": "Progress", "description": "Work marked done or reopened.", "selectable": False},
]
CATEGORY_CODES = {c["code"] for c in REASON_CATEGORIES}
PROGRESS_CATEGORY = "progress"


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
        return normalize_field_date(field, value)
    if kind == "phases":
        return normalize_phases(value)
    if kind == "optional_date":
        return None if value is None else normalize_field_date(field, value)
    if kind == "deliverable_type":
        if value not in DELIVERABLE_TYPES:
            raise FieldError(f"type must be one of {', '.join(DELIVERABLE_TYPES)}")
        return value
    if kind == "dependency_type":
        if value not in DEPENDENCY_TYPES:
            raise FieldError(f"dependency type must be one of {', '.join(DEPENDENCY_TYPES)}")
        return value
    raise AssertionError(kind)


def normalize_field_date(field: str, value: Any) -> str:
    if not isinstance(value, str) or len(value) != 10:
        raise FieldError(f"{field} must be a YYYY-MM-DD date")
    try:
        return parse_date(value).isoformat()
    except ValueError:
        raise FieldError(f"{field} must be a YYYY-MM-DD date") from None


def normalize_phases(value: Any) -> list[dict[str, Any]] | None:
    if value is None:
        return None
    if not isinstance(value, list) or len(value) < MIN_PHASES:
        raise FieldError(f"phases must be null or a list of at least {MIN_PHASES} phases")
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for i, phase in enumerate(value):
        if not isinstance(phase, dict) or set(phase) - {"name", "days", "gap", "finished_on"}:
            raise FieldError("each phase must be an object with a name, days (except the last), and an optional gap and finished_on")
        name = phase.get("name")
        if not isinstance(name, str) or not name.strip():
            raise FieldError("every phase needs a name")
        name = name.strip()
        if name.casefold() in seen:
            raise FieldError(f"phase names must be unique; “{name}” appears twice")
        seen.add(name.casefold())
        out_phase: dict[str, Any] = {"name": name}
        days = phase.get("days")
        if i == len(value) - 1:
            if days is not None:
                raise FieldError(f"the last phase (“{name}”) runs to the end date, so it takes no days")
        else:
            if isinstance(days, bool) or not isinstance(days, int) or days < 1:
                raise FieldError(f"phase “{name}” needs a whole number of days, at least 1")
            out_phase["days"] = days
        gap = phase.get("gap", 0)
        if isinstance(gap, bool) or not isinstance(gap, int) or gap < 0:
            raise FieldError(f"the gap before “{name}” must be a whole number of days, 0 or more")
        if gap and i == 0:
            raise FieldError(f"the first phase (“{name}”) starts with the deliverable, so it can't have a gap")
        if gap:
            out_phase["gap"] = gap  # 0 is the default and is left out, so there is one way to write each plan
        if phase.get("finished_on") is not None:
            out_phase["finished_on"] = normalize_field_date(f"finish date of “{name}”", phase["finished_on"])
        out.append(out_phase)
    return out


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
        if d.get("phases"):
            if d["type"] == "milestone":
                err("invalid_phases", f"Milestone “{d['name']}” can't have phases", "deliverable", d["id"])
            elif d["start_date"] <= d["end_date"]:
                duration = (parse_date(d["end_date"]) - parse_date(d["start_date"])).days + 1
                needed = fixed_days(d["phases"]) + 1
                if duration < needed:
                    err("phases_do_not_fit", f"The phases of “{d['name']}” need at least {needed} days, but it lasts {duration}", "deliverable", d["id"])
            # Phases finish in order.
            previous: dict[str, Any] | None = None
            for phase in d["phases"]:
                if phase.get("finished_on") and previous is not None:
                    if not previous.get("finished_on"):
                        err("phase_order", f"“{previous['name']}” of “{d['name']}” must be done before “{phase['name']}”", "deliverable", d["id"])
                    elif phase["finished_on"] < previous["finished_on"]:
                        err("phase_order", f"“{phase['name']}” of “{d['name']}” can't finish before “{previous['name']}”", "deliverable", d["id"])
                previous = phase
        if d.get("finished_on"):
            if d["type"] == "milestone":
                err("invalid_finish", f"Milestone “{d['name']}” can't be marked done", "deliverable", d["id"])
            elif d.get("phases"):
                err("invalid_finish", f"“{d['name']}” has phases; mark its phases done instead", "deliverable", d["id"])

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
