"""The project's people and groups: who can be picked as an attendee or owner, and the teams they're in.

A person can be in any number of groups, and a group can be empty. The roster is saved whole.
Attendees and owners stay plain names, so renaming or removing someone here never rewrites a
meeting or the register.
"""

from __future__ import annotations

from typing import Any

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from ..domain.meetings import MAX_NAME, PersonInput
from ..domain.models import Person, PersonGroup
from .commit_service import require_project
from .meeting_service import fail


def list_people(session: Session, project_id: str) -> dict[str, Any]:
    require_project(session, project_id)
    people = session.scalars(select(Person).where(Person.project_id == project_id).order_by(Person.position))
    groups = session.scalars(select(PersonGroup.name).where(PersonGroup.project_id == project_id).order_by(PersonGroup.position))
    return {"people": [{"name": p.name, "groups": list(p.groups or [])} for p in people], "groups": list(groups)}


def _check_length(value: str) -> None:
    if len(value) > MAX_NAME:
        raise fail("name_too_long", f"{value[:20]}… is longer than {MAX_NAME} characters")


def replace_people(session: Session, project_id: str, people: list[PersonInput], groups: list[str] | None = None) -> dict[str, Any]:
    require_project(session, project_id)
    spelling: dict[str, str] = {}  # one spelling per group: "data" joins "Data"

    def group_name(raw: str) -> str | None:
        name = raw.strip()
        if not name:
            return None
        _check_length(name)
        return spelling.setdefault(name.lower(), name)

    for g in groups or []:
        group_name(g)

    rows: list[Person] = []
    seen: set[str] = set()
    for p in people:
        name = p.name.strip()
        if not name:
            continue
        if name.lower() in seen:
            raise fail("duplicate_person", f"{name} is listed twice")
        _check_length(name)
        member_of = list(dict.fromkeys(g for g in map(group_name, p.groups) if g))
        seen.add(name.lower())
        rows.append(Person(project_id=project_id, name=name, groups=member_of, position=len(rows)))

    clash = next((g for key, g in spelling.items() if key in seen), None)
    if clash:
        raise fail("group_is_person", f"{clash} is both a person and a group, so @{clash} would be ambiguous")

    session.execute(delete(Person).where(Person.project_id == project_id))
    session.execute(delete(PersonGroup).where(PersonGroup.project_id == project_id))
    session.flush()
    session.add_all(rows)
    session.add_all(PersonGroup(project_id=project_id, name=g, position=i) for i, g in enumerate(spelling.values()))
    session.flush()
    return {"people": [{"name": r.name, "groups": r.groups} for r in rows], "groups": list(spelling.values())}
