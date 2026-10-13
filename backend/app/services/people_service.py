"""The organisation's people and groups, and which groups work on which project.

People and groups belong to the organisation, not to a project: someone is listed once, in any
number of groups (teams such as "Data"). A project takes groups, and its members are everyone in
them, which is who it offers as attendees and owners. The organisation roster is saved whole.

Attendees and owners stay plain names, so renaming or removing someone here never rewrites a
meeting or the register. Each person can also have a username (what they sign in with, usually
their Windows login) and an email; both are unique, ignoring case.
"""

from __future__ import annotations

import re
from typing import Any

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from ..domain.meetings import MAX_NAME, PersonInput
from ..domain.models import Person, PersonGroup, Project, ProjectTeam
from .commit_service import require_project
from .meeting_service import fail

EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
# A Windows login (%USERNAME%): letters, digits, dots, dashes and underscores.
USERNAME = re.compile(r"^[a-z0-9._-]{1,64}$")


def clean_username(raw: str | None) -> str | None:
    """A username as stored: trimmed, lower case, without a DOMAIN\\ prefix. Blank is None."""
    value = (raw or "").strip().lower().rsplit("\\", 1)[-1]
    return value or None


def clean_email(raw: str | None) -> str | None:
    value = (raw or "").strip().lower()
    return value or None


def _people(session: Session) -> list[Person]:
    return list(session.scalars(select(Person).order_by(Person.position)))


def _group_names(session: Session) -> list[str]:
    return list(session.scalars(select(PersonGroup.name).order_by(PersonGroup.position)))


def _projects_by_group(session: Session) -> dict[str, list[str]]:
    """Group name -> the projects it works on, oldest project first."""
    out: dict[str, list[str]] = {}
    rows = session.execute(
        select(PersonGroup.name, ProjectTeam.project_id)
        .join(ProjectTeam, ProjectTeam.group_id == PersonGroup.id)
        .join(Project, Project.id == ProjectTeam.project_id)
        .order_by(Project.created_at, Project.name)
    )
    for group, project_id in rows:
        out.setdefault(group, []).append(project_id)
    return out


def project_groups(session: Session, project_id: str) -> list[str]:
    """The groups working on a project, in the organisation's order."""
    on = {g for g, projects in _projects_by_group(session).items() if project_id in projects}
    return [g for g in _group_names(session) if g in on]


def list_org(session: Session) -> dict[str, Any]:
    """Everyone with their groups and (through them) projects, the groups in order, and each group's projects."""
    by_group = _projects_by_group(session)
    order = [p for (p,) in session.execute(select(Project.id).order_by(Project.created_at, Project.name))]

    def projects_of(groups: list[str]) -> list[str]:
        on = {pid for g in groups for pid in by_group.get(g, [])}
        return [pid for pid in order if pid in on]

    return {
        "people": [
            {"id": p.id, "name": p.name, "username": p.username or "", "email": p.email or "", "groups": list(p.groups or []), "projects": projects_of(p.groups or [])}
            for p in _people(session)
        ],
        "groups": _group_names(session),
        "projects_by_group": by_group,
    }


def list_people(session: Session, project_id: str) -> dict[str, Any]:
    """The project's roster: everyone in its groups, and the groups at least one of them is in."""
    require_project(session, project_id)
    teams = set(project_groups(session, project_id))
    members = [p for p in _people(session) if teams.intersection(p.groups or [])]
    used = {g for p in members for g in p.groups or []}
    return {"people": [{"name": p.name, "groups": list(p.groups or [])} for p in members], "groups": [g for g in _group_names(session) if g in used]}


def member_names(session: Session, project_id: str) -> list[str]:
    return [p["name"] for p in list_people(session, project_id)["people"]]


def _check_length(value: str) -> None:
    if len(value) > MAX_NAME:
        raise fail("name_too_long", f"{value[:20]}… is longer than {MAX_NAME} characters")


def replace_org(
    session: Session,
    people: list[PersonInput],
    groups: list[str] | None = None,
    projects_by_group: dict[str, list[str]] | None = None,
    keep_person_id: int | None = None,
) -> dict[str, Any]:
    """Save the whole organisation roster.

    A person sent with their `id` keeps it, so a rename keeps their account; without one, they're
    matched by name. Anyone left out is removed, with their account. `keep_person_id` (whoever is
    saving) can't be removed. `projects_by_group` maps a group to the projects it works on; left
    out, each group keeps its projects (matched by name, so a renamed group must be sent with them).
    """
    spelling: dict[str, str] = {}  # one spelling per group: "data" joins "Data"

    def group_name(raw: str) -> str | None:
        name = raw.strip()
        if not name:
            return None
        _check_length(name)
        return spelling.setdefault(name.lower(), name)

    for g in groups or []:
        group_name(g)

    current = _people(session)
    by_id = {p.id: p for p in current}
    by_name = {p.name.lower(): p for p in current}
    rows: list[tuple[Person | None, str, list[str], str | None, str | None]] = []  # (existing row or None, name, groups, username, email)
    seen: set[str] = set()
    kept: set[int] = set()
    usernames: dict[str, str] = {}  # username -> who has it
    emails: dict[str, str] = {}
    for p in people:
        name = p.name.strip()
        if not name:
            continue
        if name.lower() in seen:
            raise fail("duplicate_person", f"{name} is listed twice")
        _check_length(name)
        if p.id is not None and p.id not in by_id:
            raise fail("unknown_person", f"{name} was removed by someone else; reload and try again")
        if p.id is not None:
            if p.id in kept:
                raise fail("duplicate_person", f"{name} is listed twice")
            row = by_id[p.id]
        else:
            row = by_name.get(name.lower())
            if row is not None and row.id in kept:
                row = None
        member_of = list(dict.fromkeys(g for g in map(group_name, p.groups) if g))
        username = clean_username(p.username) if p.username is not None else (row.username if row else None)
        email = clean_email(p.email) if p.email is not None else (row.email if row else None)
        if username:
            if not USERNAME.match(username):
                raise fail("invalid_username", f"{name}'s username {username} can only use letters, digits, dots, dashes and underscores")
            if username in usernames:
                raise fail("duplicate_username", f"{usernames[username]} and {name} both have the username {username}")
            usernames[username] = name
        if email:
            if not EMAIL.match(email):
                raise fail("invalid_email", f"{name}'s email {email} doesn't look like an email address")
            if email in emails:
                raise fail("duplicate_email", f"{emails[email]} and {name} both have the email {email}")
            emails[email] = name
        seen.add(name.lower())
        if row is not None:
            kept.add(row.id)
        rows.append((row, name, member_of, username, email))
    if keep_person_id is not None and keep_person_id not in kept:
        raise fail("cannot_remove_yourself", "You can't take yourself out of People")

    clash = next((g for key, g in spelling.items() if key in seen), None)
    if clash:
        raise fail("group_is_person", f"{clash} is both a person and a group, so @{clash} would be ambiguous")

    project_ids = set(session.scalars(select(Project.id)))
    if projects_by_group is None:
        teams = {name.lower(): projects for name, projects in _projects_by_group(session).items()}
    else:
        teams = {}
        for raw, projects in projects_by_group.items():
            unknown = next((x for x in projects if x not in project_ids), None)
            if unknown:
                raise fail("unknown_project", f"There's no project {unknown}")
            if raw.strip():
                teams.setdefault(raw.strip().lower(), []).extend(projects)

    session.execute(delete(ProjectTeam))
    session.execute(delete(PersonGroup))
    # Removing someone also removes their account (the database cascades it).
    session.execute(delete(Person).where(Person.id.not_in(kept)))
    # Park kept names first, so two people can swap names (or usernames) without tripping the unique indexes.
    for row, *_ in rows:
        if row is not None:
            row.name, row.username, row.email = f"__renaming__{row.id}", None, None
    session.flush()
    for position, (row, name, member_of, username, email) in enumerate(rows):
        if row is None:
            session.add(Person(name=name, groups=member_of, position=position, username=username, email=email))
        else:
            row.name, row.groups, row.position, row.username, row.email = name, member_of, position, username, email
    added = [PersonGroup(name=g, position=i) for i, g in enumerate(spelling.values())]
    session.add_all(added)
    session.flush()
    session.add_all(ProjectTeam(project_id=pid, group_id=g.id) for g in added for pid in dict.fromkeys(teams.get(g.name.lower(), [])))
    session.flush()
    return list_org(session)


def set_groups(session: Session, project_id: str, names: list[str]) -> dict[str, Any]:
    """Make exactly these groups the ones working on the project. Returns its roster."""
    require_project(session, project_id)
    by_name = {g.name.lower(): g for g in session.scalars(select(PersonGroup))}
    chosen: dict[int, PersonGroup] = {}
    for raw in names:
        if not raw.strip():
            continue
        group = by_name.get(raw.strip().lower())
        if group is None:
            raise fail("unknown_group", f"There's no group called {raw.strip()}; add it under Settings → People first")
        chosen[group.id] = group
    session.execute(delete(ProjectTeam).where(ProjectTeam.project_id == project_id))
    session.flush()
    session.add_all(ProjectTeam(project_id=project_id, group_id=gid) for gid in chosen)
    session.flush()
    return list_people(session, project_id)
