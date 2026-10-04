"""Requests and rules for meetings and the register (actions, risks, decisions)."""

from __future__ import annotations

from datetime import date
from typing import Any, Literal

from pydantic import BaseModel, Field

from .commands import Change

ItemKind = Literal["action", "risk", "decision"]

PREFIX = {"action": "A", "risk": "R", "decision": "D"}
# The first status is the open one. Decisions are never edited, only superseded by a later one.
STATUSES = {"action": ("open", "done"), "risk": ("open", "closed"), "decision": ("active", "superseded")}
MAX_TEXT = 2000
MAX_NAME = 80


class Attendee(BaseModel):
    name: str
    present: bool = True


class MeetingCreateRequest(BaseModel):
    title: str
    held_on: str
    attendees: list[Attendee] | None = None  # None copies the last meeting with the same title


class MeetingUpdateRequest(BaseModel):
    title: str | None = None
    held_on: str | None = None
    attendees: list[Attendee] | None = None
    notes: str | None = None


class ItemInput(BaseModel):
    kind: ItemKind
    text: str
    owner: str | None = None
    due_on: str | None = None
    deliverable_ids: list[str] = Field(default_factory=list)


class MeetingCommit(BaseModel):
    reason: str
    category: str | None = None
    base_version: int
    changes: list[Change]


class FinishMeetingRequest(BaseModel):
    author: str
    items: list[ItemInput] = Field(default_factory=list)
    commit: MeetingCommit | None = None


class ItemUpdateRequest(BaseModel):
    text: str | None = None
    owner: str | None = None
    due_on: str | None = None
    deliverable_ids: list[str] | None = None
    status: str | None = None
    closed_on: str | None = None
    superseded_by: str | None = None  # a decision's ref, e.g. "D-9"


def item_ref(kind: str, number: int) -> str:
    return f"{PREFIX[kind]}-{number}"


def meeting_reference(title: str, held_on: str) -> str:
    """The commit reference for a meeting's plan changes, e.g. "Steering committee 2026-10-08"."""
    return f"{title} {held_on}"


def is_date(value: Any) -> bool:
    try:
        date.fromisoformat(value)
        return True
    except (TypeError, ValueError):
        return False


def item_errors(item: ItemInput, deliverable_ids: set[str], index: int | None = None) -> list[dict[str, Any]]:
    """Problems with one register item, checked against the deliverables that exist."""
    errors = []
    label = f"Item {index + 1}: " if index is not None else ""

    def err(code: str, message: str) -> None:
        errors.append({"change_index": None, "item_index": index, "code": code, "message": label + message})

    if not item.text.strip():
        err("text_required", "text is required")
    elif len(item.text) > MAX_TEXT:
        err("text_too_long", f"text is longer than {MAX_TEXT} characters")
    if item.owner is not None and len(item.owner) > MAX_NAME:
        err("owner_too_long", f"owner is longer than {MAX_NAME} characters")
    if item.due_on is not None and not is_date(item.due_on):
        err("invalid_date", f"due date {item.due_on!r} is not a YYYY-MM-DD date")
    if item.due_on and item.kind != "action":
        err("due_on_actions_only", "only actions have a due date")
    for did in item.deliverable_ids:
        if did not in deliverable_ids:
            err("unknown_deliverable", f"deliverable {did} does not exist")
    return errors
