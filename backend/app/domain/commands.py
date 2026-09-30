"""Commands (staged changes) and their translation into validated events."""

from __future__ import annotations

import copy
import uuid
from dataclasses import dataclass, field
from typing import Any, Literal

from pydantic import BaseModel, Field

from .events import ENTITY_COLLECTIONS, Event, State, apply_event
from .validators import FIELD_DEFAULTS, FIELD_SPECS, FieldError, normalize_field, validate_state

EntityType = Literal["workstream", "deliverable", "dependency"]
Operation = Literal["create", "update", "delete"]


class Change(BaseModel):
    entity_type: EntityType
    entity_id: str | None = None
    operation: Operation
    fields: dict[str, Any] = Field(default_factory=dict)


class CommitRequest(BaseModel):
    reason: str
    category: str | None = None
    reference: str | None = None
    author: str
    base_version: int
    changes: list[Change]


class PreviewRequest(BaseModel):
    changes: list[Change]


class RevertRequest(BaseModel):
    author: str
    base_version: int
    reason: str | None = None
    category: str | None = "correction"


class BaselineRequest(BaseModel):
    name: str
    version: int


class ProjectCreateRequest(BaseModel):
    name: str
    description: str = ""


class DomainError(Exception):
    def __init__(self, errors: list[dict[str, Any]]):
        super().__init__("; ".join(e["message"] for e in errors))
        self.errors = errors


@dataclass
class ChangePlan:
    events: list[Event] = field(default_factory=list)
    state: State | None = None
    errors: list[dict[str, Any]] = field(default_factory=list)


def new_entity_id(entity_type: str) -> str:
    prefix = {"workstream": "ws", "deliverable": "dl", "dependency": "dep"}[entity_type]
    return f"{prefix}-{uuid.uuid4().hex[:10]}"


def build_events(state: State, changes: list[Change]) -> ChangePlan:
    """Validate `changes` against `state` and produce the ordered events.

    Old values always come from `state`, never from the client. Changes are
    applied in order, so later changes see earlier ones (e.g. create a
    deliverable, then a dependency on it). Integrity rules are checked on the
    final state, so a change set may pass through intermediate states that
    would be invalid on their own (delete a lane after moving its items out).
    """
    working = copy.deepcopy(state)
    plan = ChangePlan()

    def err(index: int, code: str, message: str) -> None:
        plan.errors.append({"change_index": index, "code": code, "message": message})

    def emit(event: Event) -> None:
        apply_event(working, event)
        plan.events.append(event)

    for index, change in enumerate(changes):
        collection = working[ENTITY_COLLECTIONS[change.entity_type]]
        spec = FIELD_SPECS[change.entity_type]

        normalized: dict[str, Any] = {}
        field_error = False
        for name, value in change.fields.items():
            if name == "id":
                continue
            try:
                normalized[name] = normalize_field(change.entity_type, name, value)
            except FieldError as exc:
                err(index, "invalid_field", str(exc))
                field_error = True
        if field_error:
            continue

        if change.operation == "create":
            entity_id = change.entity_id or new_entity_id(change.entity_type)
            if entity_id in collection:
                err(index, "already_exists", f"{change.entity_type} {entity_id} already exists")
                continue
            values = {**FIELD_DEFAULTS[change.entity_type], **normalized}
            if change.entity_type == "workstream" and "order_index" not in values:
                values["order_index"] = max((w["order_index"] for w in collection.values()), default=-1) + 1
            missing = [name for name in spec if name not in values]
            if missing:
                err(index, "missing_fields", f"{change.entity_type} requires {', '.join(missing)}")
                continue
            emit(Event(change.entity_type, entity_id, "create", new_value={k: values[k] for k in spec}))

        elif change.operation == "update":
            entity_id = change.entity_id
            if not entity_id or entity_id not in collection:
                err(index, "not_found", f"{change.entity_type} {entity_id} does not exist")
                continue
            current = collection[entity_id]
            for name in spec:
                if name in normalized and normalized[name] != current[name]:
                    emit(Event(change.entity_type, entity_id, "update", name, current[name], normalized[name]))

        elif change.operation == "delete":
            entity_id = change.entity_id
            if not entity_id or entity_id not in collection:
                err(index, "not_found", f"{change.entity_type} {entity_id} does not exist")
                continue
            if change.entity_type == "deliverable":
                # Dependencies cannot outlive their endpoints; remove them in the same commit.
                for dep in sorted(working["dependencies"].values(), key=lambda d: d["id"]):
                    if entity_id in (dep["predecessor_id"], dep["successor_id"]):
                        emit(Event("dependency", dep["id"], "delete", old_value=_without_id(dep)))
            emit(Event(change.entity_type, entity_id, "delete", old_value=_without_id(collection[entity_id])))

    if not plan.errors:
        plan.errors.extend({"change_index": None, **e} for e in validate_state(working))
    plan.state = working
    return plan


def _without_id(entity: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in entity.items() if k != "id"}
