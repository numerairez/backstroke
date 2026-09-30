"""Materialized current-state projection, kept in step with each commit."""

from __future__ import annotations

from sqlalchemy import delete, insert, select, update
from sqlalchemy.orm import Session

from ..domain.events import ENTITY_COLLECTIONS, Event, State, empty_state
from ..domain.models import PROJECTION_MODELS
from ..domain.validators import FIELD_SPECS


def load_state(session: Session, project_id: str) -> State:
    state = empty_state()
    for entity_type, model in PROJECTION_MODELS.items():
        target = state[ENTITY_COLLECTIONS[entity_type]]
        for row in session.scalars(select(model).where(model.project_id == project_id)):
            target[row.id] = {"id": row.id, **{f: getattr(row, f) for f in FIELD_SPECS[entity_type]}}
    return state


def apply_to_projection(session: Session, project_id: str, events: list[Event]) -> None:
    """Apply events to projection tables in order, as individual statements."""
    for event in events:
        model = PROJECTION_MODELS[event.entity_type]
        key = (model.project_id == project_id) & (model.id == event.entity_id)
        if event.operation == "create":
            session.execute(insert(model).values(project_id=project_id, id=event.entity_id, **event.new_value))
        elif event.operation == "update":
            session.execute(update(model).where(key).values({event.field_name: event.new_value}))
        elif event.operation == "delete":
            session.execute(delete(model).where(key))


def rebuild_projection(session: Session, project_id: str, state: State) -> None:
    """Replace the projection wholesale (used by repair tooling and tests)."""
    for entity_type, model in PROJECTION_MODELS.items():
        session.execute(delete(model).where(model.project_id == project_id))
        for entity in state[ENTITY_COLLECTIONS[entity_type]].values():
            session.execute(insert(model).values(project_id=project_id, **entity))
