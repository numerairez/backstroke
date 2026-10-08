"""Relational schema: identity tables, append-only history, and read projections."""

from __future__ import annotations

from sqlalchemy import JSON, ForeignKey, Integer, String, Text, UniqueConstraint
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
    """An action, risk or decision. Numbered per project and kind: A-7, R-3, D-12."""

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
    closed_on: Mapped[str | None] = mapped_column(String, nullable=True)
    superseded_by_id: Mapped[int | None] = mapped_column(ForeignKey("register_items.id"), nullable=True)
    created_at: Mapped[str] = mapped_column(String)
    updated_at: Mapped[str] = mapped_column(String)


class Person(Base):
    """Someone on the project, for picking attendees and owners. `group` is a team such as "Data"."""

    __tablename__ = "project_people"
    __table_args__ = (UniqueConstraint("project_id", "name"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id"), index=True)
    name: Mapped[str] = mapped_column(String)
    group: Mapped[str | None] = mapped_column(String, nullable=True)
    position: Mapped[int] = mapped_column(Integer)
