"""The project's people: who can be picked as an attendee or owner, grouped into teams.

The list is saved whole. Attendees and owners stay plain names, so renaming or removing someone
here never rewrites a meeting or the register.
"""

from __future__ import annotations

from typing import Any

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from ..domain.meetings import MAX_NAME, PersonInput
from ..domain.models import Person
from .commit_service import require_project
from .meeting_service import fail


def list_people(session: Session, project_id: str) -> list[dict[str, Any]]:
    require_project(session, project_id)
    people = session.scalars(select(Person).where(Person.project_id == project_id).order_by(Person.position))
    return [{"name": p.name, "group": p.group} for p in people]


def replace_people(session: Session, project_id: str, people: list[PersonInput]) -> list[dict[str, Any]]:
    require_project(session, project_id)
    rows: list[Person] = []
    seen: set[str] = set()
    groups: dict[str, str] = {}  # one spelling per group: "data" joins "Data"
    for p in people:
        name = p.name.strip()
        if not name:
            continue
        if name.lower() in seen:
            raise fail("duplicate_person", f"{name} is listed twice")
        group = (p.group or "").strip() or None
        for value in (name, group or ""):
            if len(value) > MAX_NAME:
                raise fail("name_too_long", f"{value[:20]}… is longer than {MAX_NAME} characters")
        if group:
            group = groups.setdefault(group.lower(), group)
        seen.add(name.lower())
        rows.append(Person(project_id=project_id, name=name, group=group, position=len(rows)))
    session.execute(delete(Person).where(Person.project_id == project_id))
    session.add_all(rows)
    session.flush()
    return [{"name": r.name, "group": r.group} for r in rows]
