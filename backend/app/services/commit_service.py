"""The only write path for plan state: validate a change set, append a commit, update the projection."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..domain.commands import Change, DomainError, build_events
from ..domain.events import ENTITY_COLLECTIONS, Event, serialize_state
from ..domain.models import IDENTITY_MODELS, Commit, Project
from ..domain.models import Event as EventRow
from ..domain.validators import CATEGORY_CODES
from . import dependency_service, projection_service, version_service


class VersionConflict(Exception):
    def __init__(self, base_version: int, current_version: int):
        super().__init__(f"base version {base_version} is stale; current version is {current_version}")
        self.base_version = base_version
        self.current_version = current_version


class NotFound(Exception):
    pass


def utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def require_project(session: Session, project_id: str) -> Project:
    project = session.get(Project, project_id)
    if project is None:
        raise NotFound(f"project {project_id} not found")
    return project


def preview(session: Session, project_id: str, changes: list[Change]) -> dict[str, Any]:
    """Dry-run a change set: normalized events, errors, conflicts and suggestions. Nothing is written."""
    require_project(session, project_id)
    before = projection_service.load_state(session, project_id)
    plan = build_events(before, changes)
    after = plan.state
    return {
        "base_version": version_service.current_version(session, project_id),
        "valid": not plan.errors and bool(plan.events),
        "errors": plan.errors,
        "events": [e.to_dict() for e in plan.events],
        "conflicts": dependency_service.dependency_conflicts(after) if not plan.errors else [],
        "suggestions": dependency_service.suggest_downstream(before, after) if not plan.errors else [],
    }


def create_commit(
    session: Session,
    project_id: str,
    *,
    reason: str,
    author: str,
    base_version: int,
    changes: list[Change],
    category: str | None = None,
    reference: str | None = None,
    created_at: str | None = None,
) -> tuple[Commit, list[Event]]:
    """Append one commit. Call inside a transaction; it either fully applies or raises."""
    require_project(session, project_id)

    errors = []
    if not reason or not reason.strip():
        errors.append({"change_index": None, "code": "reason_required", "message": "A commit reason is required"})
    if not author or not author.strip():
        errors.append({"change_index": None, "code": "author_required", "message": "An author is required"})
    if category is not None and category not in CATEGORY_CODES:
        errors.append({"change_index": None, "code": "invalid_category", "message": f"Unknown category {category!r}"})
    if errors:
        raise DomainError(errors)

    current = version_service.current_version(session, project_id)
    if base_version != current:
        raise VersionConflict(base_version, current)

    state = projection_service.load_state(session, project_id)
    plan = build_events(state, changes)
    if plan.errors:
        raise DomainError(plan.errors)
    if not plan.events:
        raise DomainError([{"change_index": None, "code": "no_changes", "message": "The change set does not change anything"}])

    commit = Commit(
        project_id=project_id,
        seq_no=current + 1,
        author=author.strip(),
        reason=reason.strip(),
        category=category,
        reference=(reference or "").strip() or None,
        created_at=created_at or utc_now(),
    )
    session.add(commit)
    session.flush()

    for ordinal, event in enumerate(plan.events):
        session.add(
            EventRow(
                commit_id=commit.id,
                ordinal=ordinal,
                entity_type=event.entity_type,
                entity_id=event.entity_id,
                operation=event.operation,
                field_name=event.field_name,
                old_value_json=None if event.old_value is None else json.dumps(event.old_value),
                new_value_json=None if event.new_value is None else json.dumps(event.new_value),
            )
        )
        if event.operation == "create":
            model = IDENTITY_MODELS[event.entity_type]
            if session.get(model, (project_id, event.entity_id)) is None:
                extra = {"type": event.new_value["type"]} if event.entity_type == "deliverable" else {}
                session.add(model(project_id=project_id, id=event.entity_id, created_commit_id=commit.id, **extra))
    session.flush()

    projection_service.apply_to_projection(session, project_id, plan.events)
    return commit, plan.events


def commit_result(session: Session, project_id: str, commit: Commit, events: list[Event]) -> dict[str, Any]:
    state = projection_service.load_state(session, project_id)
    return {
        "version": commit.seq_no,
        "commit": commit_to_dict(commit, events),
        "state": serialize_state(state),
    }


def commit_to_dict(commit: Commit, events: list[Event] | None = None) -> dict[str, Any]:
    out = {
        "seq": commit.seq_no,
        "author": commit.author,
        "reason": commit.reason,
        "category": commit.category,
        "reference": commit.reference,
        "created_at": commit.created_at,
    }
    if events is not None:
        out["events"] = [e.to_dict() for e in events]
    return out


def inverse_changes(session: Session, project_id: str, seq: int) -> list[Change]:
    """Changes that undo commit `seq`, provided later commits have not touched the same values."""
    commit = session.scalar(select(Commit).where(Commit.project_id == project_id, Commit.seq_no == seq))
    if commit is None:
        raise NotFound(f"commit #{seq} not found")
    events = [
        version_service.row_to_event(r)
        for r in session.scalars(select(EventRow).where(EventRow.commit_id == commit.id).order_by(EventRow.ordinal))
    ]
    state = projection_service.load_state(session, project_id)
    changes: list[Change] = []
    errors = []
    for event in reversed(events):
        current = state[ENTITY_COLLECTIONS[event.entity_type]].get(event.entity_id)
        label = f"{event.entity_type} {current['name'] if current and 'name' in current else event.entity_id}"
        if event.operation == "update":
            if current is None or current.get(event.field_name) != event.new_value:
                errors.append({"change_index": None, "code": "revert_conflict", "message": f"{label}: {event.field_name} was changed again after #{seq}"})
                continue
            changes.append(Change(entity_type=event.entity_type, entity_id=event.entity_id, operation="update", fields={event.field_name: event.old_value}))
        elif event.operation == "create":
            if current is None:
                continue  # already gone; nothing to undo
            changes.append(Change(entity_type=event.entity_type, entity_id=event.entity_id, operation="delete"))
        elif event.operation == "delete":
            if current is not None:
                errors.append({"change_index": None, "code": "revert_conflict", "message": f"{label} was re-created after #{seq}"})
                continue
            changes.append(Change(entity_type=event.entity_type, entity_id=event.entity_id, operation="create", fields=event.old_value))
    if errors:
        raise DomainError(errors)
    return changes


def revert_commit(
    session: Session, project_id: str, seq: int, *, author: str, base_version: int, reason: str | None, category: str | None
) -> tuple[Commit, list[Event]]:
    original = session.scalar(select(Commit).where(Commit.project_id == project_id, Commit.seq_no == seq))
    if original is None:
        raise NotFound(f"commit #{seq} not found")
    changes = inverse_changes(session, project_id, seq)
    return create_commit(
        session,
        project_id,
        reason=reason or f"Revert #{seq}: {original.reason}",
        author=author,
        base_version=base_version,
        changes=changes,
        category=category,
        reference=f"revert:#{seq}",
    )
