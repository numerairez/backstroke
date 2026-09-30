"""Commit log, commit detail, affected entities."""

from __future__ import annotations

from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..domain.events import Event
from ..domain.models import Baseline, Commit
from ..domain.models import Event as EventRow
from .commit_service import NotFound, commit_to_dict
from .version_service import row_to_event


def _summarize(events: list[Event]) -> dict[str, Any]:
    affected: dict[str, set[str]] = {}
    for e in events:
        affected.setdefault(e.entity_type, set()).add(e.entity_id)
    return {
        "change_count": len(events),
        "deliverables_affected": len(affected.get("deliverable", ())),
        "affected": {k: sorted(v) for k, v in affected.items()},
    }


def _events_by_commit(session: Session, commit_ids: list[int]) -> dict[int, list[Event]]:
    out: dict[int, list[Event]] = {cid: [] for cid in commit_ids}
    if not commit_ids:
        return out
    for row in session.scalars(
        select(EventRow).where(EventRow.commit_id.in_(commit_ids)).order_by(EventRow.commit_id, EventRow.ordinal)
    ):
        out[row.commit_id].append(row_to_event(row))
    return out


def _baselines_by_commit(session: Session, project_id: str) -> dict[int, list[str]]:
    out: dict[int, list[str]] = {}
    for b in session.scalars(select(Baseline).where(Baseline.project_id == project_id).order_by(Baseline.id)):
        out.setdefault(b.commit_id, []).append(b.name)
    return out


def list_commits(session: Session, project_id: str, include_events: bool = False) -> list[dict[str, Any]]:
    commits = session.scalars(select(Commit).where(Commit.project_id == project_id).order_by(Commit.seq_no)).all()
    events = _events_by_commit(session, [c.id for c in commits])
    baselines = _baselines_by_commit(session, project_id)
    out = []
    for c in commits:
        entry = commit_to_dict(c, events[c.id] if include_events else None)
        entry.update(_summarize(events[c.id]))
        entry["baselines"] = baselines.get(c.id, [])
        out.append(entry)
    return out


def get_commit(session: Session, project_id: str, seq: int) -> dict[str, Any]:
    commit = session.scalar(select(Commit).where(Commit.project_id == project_id, Commit.seq_no == seq))
    if commit is None:
        raise NotFound(f"commit #{seq} not found")
    events = _events_by_commit(session, [commit.id])[commit.id]
    entry = commit_to_dict(commit, events)
    entry.update(_summarize(events))
    entry["baselines"] = _baselines_by_commit(session, project_id).get(commit.id, [])
    return entry
