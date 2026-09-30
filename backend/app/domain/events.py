"""Events and the pure state they fold into.

A project's plan state is a plain dict:

    {"workstreams": {id: {...}}, "deliverables": {id: {...}}, "dependencies": {id: {...}}}

`apply_event` is the single definition of how an event changes that state. The
materialized projection, historical reconstruction, previews and tests all go
through it, which is what makes "replay equals projection" hold by construction.
"""

from __future__ import annotations

import copy
from dataclasses import dataclass
from typing import Any, Iterable

ENTITY_COLLECTIONS = {
    "workstream": "workstreams",
    "deliverable": "deliverables",
    "dependency": "dependencies",
}
OPERATIONS = ("create", "update", "delete")

State = dict[str, dict[str, dict[str, Any]]]


class ReplayError(Exception):
    """An event cannot be applied to the state it was replayed onto."""


@dataclass(frozen=True)
class Event:
    entity_type: str
    entity_id: str
    operation: str
    field_name: str | None = None
    old_value: Any = None
    new_value: Any = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "entity_type": self.entity_type,
            "entity_id": self.entity_id,
            "operation": self.operation,
            "field_name": self.field_name,
            "old_value": self.old_value,
            "new_value": self.new_value,
        }


def empty_state() -> State:
    return {name: {} for name in ENTITY_COLLECTIONS.values()}


def apply_event(state: State, event: Event) -> None:
    """Apply one event to `state` in place."""
    collection = state[ENTITY_COLLECTIONS[event.entity_type]]
    entity_id = event.entity_id

    if event.operation == "create":
        if entity_id in collection:
            raise ReplayError(f"{event.entity_type} {entity_id} already exists")
        collection[entity_id] = {"id": entity_id, **copy.deepcopy(event.new_value)}
    elif event.operation == "update":
        if entity_id not in collection:
            raise ReplayError(f"{event.entity_type} {entity_id} does not exist")
        collection[entity_id][event.field_name] = copy.deepcopy(event.new_value)
    elif event.operation == "delete":
        if entity_id not in collection:
            raise ReplayError(f"{event.entity_type} {entity_id} does not exist")
        del collection[entity_id]
    else:
        raise ReplayError(f"unknown operation {event.operation!r}")


def apply_events(state: State, events: Iterable[Event]) -> State:
    """Return a new state with `events` applied in order."""
    result = copy.deepcopy(state)
    for event in events:
        apply_event(result, event)
    return result


def serialize_state(state: State) -> dict[str, list[dict[str, Any]]]:
    """Stable list form for API responses and equality checks."""
    workstreams = sorted(state["workstreams"].values(), key=lambda w: (w["order_index"], w["id"]))
    deliverables = sorted(
        state["deliverables"].values(), key=lambda d: (d["start_date"], d["end_date"], d["id"])
    )
    dependencies = sorted(state["dependencies"].values(), key=lambda d: d["id"])
    return {
        "workstreams": [dict(w) for w in workstreams],
        "deliverables": [dict(d) for d in deliverables],
        "dependencies": [dict(d) for d in dependencies],
    }
