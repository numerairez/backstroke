"""Reconstruct plan state at any commit by replaying history."""

from __future__ import annotations

import copy
import json

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..domain.events import Event, State, apply_event, empty_state
from ..domain.models import Commit
from ..domain.models import Event as EventRow


def current_version(session: Session, project_id: str) -> int:
    return session.scalar(select(func.coalesce(func.max(Commit.seq_no), 0)).where(Commit.project_id == project_id))


def row_to_event(row: EventRow) -> Event:
    return Event(
        entity_type=row.entity_type,
        entity_id=row.entity_id,
        operation=row.operation,
        field_name=row.field_name,
        old_value=json.loads(row.old_value_json) if row.old_value_json is not None else None,
        new_value=json.loads(row.new_value_json) if row.new_value_json is not None else None,
    )


def events_through(session: Session, project_id: str, version: int) -> list[tuple[int, Event]]:
    rows = session.execute(
        select(Commit.seq_no, EventRow)
        .join(EventRow, EventRow.commit_id == Commit.id)
        .where(Commit.project_id == project_id, Commit.seq_no <= version)
        .order_by(Commit.seq_no, EventRow.ordinal)
    ).all()
    return [(seq, row_to_event(row)) for seq, row in rows]


def state_at(session: Session, project_id: str, version: int) -> State:
    state = empty_state()
    for _seq, event in events_through(session, project_id, version):
        apply_event(state, event)
    return state


def states_through(session: Session, project_id: str, version: int) -> dict[int, State]:
    """State after every commit 0..version in a single replay (for playback and metrics)."""
    states = {0: empty_state()}
    state = empty_state()
    by_seq: dict[int, list[Event]] = {}
    for seq, event in events_through(session, project_id, version):
        by_seq.setdefault(seq, []).append(event)
    for seq in range(1, version + 1):
        for event in by_seq.get(seq, []):
            apply_event(state, event)
        states[seq] = copy.deepcopy(state)
    return states
