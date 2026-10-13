"""Relational schema: identity tables, append-only history, and read projections."""

from __future__ import annotations

from sqlalchemy import JSON, Boolean, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from ..persistence.db import Base


class Project(Base):
    __tablename__ = "projects"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    name: Mapped[str] = mapped_column(String)
    description: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[str] = mapped_column(String)


# --- Identity: an entity exists (or once existed) with this id --------------------------


class WorkstreamIdentity(Base):
    __tablename__ = "workstreams"

    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id"), primary_key=True)
    id: Mapped[str] = mapped_column(String, primary_key=True)
    created_commit_id: Mapped[int] = mapped_column(ForeignKey("commits.id"))


class DeliverableIdentity(Base):
    __tablename__ = "deliverables"

    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id"), primary_key=True)
    id: Mapped[str] = mapped_column(String, primary_key=True)
    type: Mapped[str] = mapped_column(String)
    created_commit_id: Mapped[int] = mapped_column(ForeignKey("commits.id"))


class DependencyIdentity(Base):
    __tablename__ = "dependencies"

    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id"), primary_key=True)
    id: Mapped[str] = mapped_column(String, primary_key=True)
    created_commit_id: Mapped[int] = mapped_column(ForeignKey("commits.id"))


# --- History: the source of truth ------------------------------------------------------


class Commit(Base):
    __tablename__ = "commits"
    __table_args__ = (UniqueConstraint("project_id", "seq_no"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id"), index=True)
    seq_no: Mapped[int] = mapped_column(Integer)
    author: Mapped[str] = mapped_column(String)
    reason: Mapped[str] = mapped_column(Text)
    category: Mapped[str | None] = mapped_column(String, nullable=True)
    reference: Mapped[str | None] = mapped_column(String, nullable=True)
    created_at: Mapped[str] = mapped_column(String)


class Event(Base):
    __tablename__ = "events"
    __table_args__ = (UniqueConstraint("commit_id", "ordinal"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    commit_id: Mapped[int] = mapped_column(ForeignKey("commits.id"), index=True)
    ordinal: Mapped[int] = mapped_column(Integer)
    entity_type: Mapped[str] = mapped_column(String)
    entity_id: Mapped[str] = mapped_column(String)
    operation: Mapped[str] = mapped_column(String)
    field_name: Mapped[str | None] = mapped_column(String, nullable=True)
    old_value_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    new_value_json: Mapped[str | None] = mapped_column(Text, nullable=True)


class Baseline(Base):
    __tablename__ = "baselines"
    __table_args__ = (UniqueConstraint("project_id", "name"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id"), index=True)
    name: Mapped[str] = mapped_column(String)
    commit_id: Mapped[int] = mapped_column(ForeignKey("commits.id"))
    created_at: Mapped[str] = mapped_column(String)


# --- Read-optimized projection of the latest version -----------------------------------


class WorkstreamState(Base):
    __tablename__ = "project_workstream_state"

    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id"), primary_key=True)
    id: Mapped[str] = mapped_column(String, primary_key=True)
    name: Mapped[str] = mapped_column(String)
    order_index: Mapped[int] = mapped_column(Integer)


class DeliverableState(Base):
    __tablename__ = "project_deliverable_state"

    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id"), primary_key=True)
    id: Mapped[str] = mapped_column(String, primary_key=True)
    workstream_id: Mapped[str] = mapped_column(String)
    type: Mapped[str] = mapped_column(String)
    name: Mapped[str] = mapped_column(String)
    start_date: Mapped[str] = mapped_column(String)
    end_date: Mapped[str] = mapped_column(String)
    phases: Mapped[list | None] = mapped_column(JSON(none_as_null=True), nullable=True)
    finished_on: Mapped[str | None] = mapped_column(String, nullable=True)
    jira_url: Mapped[str | None] = mapped_column(String, nullable=True)


class DependencyState(Base):
    __tablename__ = "project_dependency_state"

    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id"), primary_key=True)
    id: Mapped[str] = mapped_column(String, primary_key=True)
    predecessor_id: Mapped[str] = mapped_column(String)
    successor_id: Mapped[str] = mapped_column(String)
    type: Mapped[str] = mapped_column(String)


PROJECTION_MODELS = {
    "workstream": WorkstreamState,
    "deliverable": DeliverableState,
    "dependency": DependencyState,
}
IDENTITY_MODELS = {
    "workstream": WorkstreamIdentity,
    "deliverable": DeliverableIdentity,
    "dependency": DependencyIdentity,
}


# --- Meetings and the register: editable records outside the plan history ----------------
# Notes stay editable after a meeting. The plan changes a meeting agrees go through a normal
# commit, linked here rather than on the append-only commits table.


class Meeting(Base):
    __tablename__ = "meetings"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id"), index=True)
    title: Mapped[str] = mapped_column(String)
    held_on: Mapped[str] = mapped_column(String)
    attendees: Mapped[list] = mapped_column(JSON, default=list)  # [{"name": ..., "present": bool}]
    notes: Mapped[str] = mapped_column(Text, default="")
    finished_at: Mapped[str | None] = mapped_column(String, nullable=True)
    commit_id: Mapped[int | None] = mapped_column(ForeignKey("commits.id"), nullable=True)
    plan_version: Mapped[int | None] = mapped_column(Integer, nullable=True)  # plan version when it finished
    created_at: Mapped[str] = mapped_column(String)
    updated_at: Mapped[str] = mapped_column(String)


class RegisterItem(Base):
    """An action, risk, issue or decision. Numbered per project and kind: A-7, R-3, I-2, D-12."""

    __tablename__ = "register_items"
    __table_args__ = (UniqueConstraint("project_id", "kind", "number"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id"), index=True)
    kind: Mapped[str] = mapped_column(String)
    number: Mapped[int] = mapped_column(Integer)
    text: Mapped[str] = mapped_column(Text)
    owner: Mapped[str | None] = mapped_column(String, nullable=True)
    due_on: Mapped[str | None] = mapped_column(String, nullable=True)
    deliverable_ids: Mapped[list] = mapped_column(JSON, default=list)  # empty = programme-level
    meeting_id: Mapped[int | None] = mapped_column(ForeignKey("meetings.id"), nullable=True)
    status: Mapped[str] = mapped_column(String)
    outcome: Mapped[str | None] = mapped_column(String, nullable=True)  # why it closed: done, mitigated, happened...
    closed_on: Mapped[str | None] = mapped_column(String, nullable=True)
    # The item that followed this one: the decision that superseded it, or the issue a risk became.
    superseded_by_id: Mapped[int | None] = mapped_column(ForeignKey("register_items.id"), nullable=True)
    created_at: Mapped[str] = mapped_column(String)
    updated_at: Mapped[str] = mapped_column(String)


class RegisterEvent(Base):
    """One change to a register item, kept forever: raised, edited, closed or reopened.

    `changes` maps each changed field to [old, new]; see HISTORY_FIELDS in domain/meetings.py.
    """

    __tablename__ = "register_events"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id"), index=True)
    item_id: Mapped[int] = mapped_column(ForeignKey("register_items.id"), index=True)
    type: Mapped[str] = mapped_column(String)
    changes: Mapped[dict] = mapped_column(JSON, default=dict)
    meeting_id: Mapped[int | None] = mapped_column(ForeignKey("meetings.id"), nullable=True)
    author: Mapped[str | None] = mapped_column(String, nullable=True)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[str] = mapped_column(String)


# --- The organisation: people and teams, shared by every project -------------------------


class Person(Base):
    """Someone in the organisation. `groups` names the teams they're in, such as "Data"."""

    __tablename__ = "people"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String, unique=True)
    groups: Mapped[list] = mapped_column(JSON, default=list)
    position: Mapped[int] = mapped_column(Integer)


class PersonGroup(Base):
    """A team. People join any number of them; a group can be empty."""

    __tablename__ = "person_groups"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String, unique=True)
    position: Mapped[int] = mapped_column(Integer)


class ProjectTeam(Base):
    """A group working on a project. Everyone in it is a member: offered as an attendee or owner
    there, and shown the project in their sidebar."""

    __tablename__ = "project_teams"

    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id"), primary_key=True)
    group_id: Mapped[int] = mapped_column(ForeignKey("person_groups.id", ondelete="CASCADE"), primary_key=True)


# --- Sign-in: accounts belong to people in the organisation ---------------------------


class Account(Base):
    """A person's sign-in. Only someone already listed in People can register one; the first is an admin."""

    __tablename__ = "accounts"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    person_id: Mapped[int] = mapped_column(ForeignKey("people.id", ondelete="CASCADE"), unique=True)
    email: Mapped[str] = mapped_column(String, unique=True)
    password_hash: Mapped[str] = mapped_column(String)
    is_admin: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[str] = mapped_column(String)


class LoginSession(Base):
    """A signed-in browser. Only a hash of the cookie's token is stored."""

    __tablename__ = "login_sessions"

    token_hash: Mapped[str] = mapped_column(String, primary_key=True)
    account_id: Mapped[int] = mapped_column(ForeignKey("accounts.id", ondelete="CASCADE"), index=True)
    created_at: Mapped[str] = mapped_column(String)
    expires_at: Mapped[str] = mapped_column(String)
