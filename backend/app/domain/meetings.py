"""Requests and rules for meetings and the register (actions, risks, issues, decisions)."""

from __future__ import annotations

from datetime import date
from typing import Any, Literal

from pydantic import BaseModel, Field

from .commands import Change

ItemKind = Literal["action", "risk", "issue", "decision"]

PREFIX = {"action": "A", "risk": "R", "issue": "I", "decision": "D"}
# The first status is the open one. Decisions are never edited, only superseded by a later one.
STATUSES = {"action": ("open", "closed"), "risk": ("open", "closed"), "issue": ("open", "closed"), "decision": ("active", "superseded")}
# Why an item closed. A risk that happened links to the issue it became.
OUTCOMES = {
    "action": ("done", "dropped"),
    "risk": ("mitigated", "passed", "accepted", "happened"),
    "issue": ("resolved", "accepted"),
    "decision": ("superseded",),
}
MAX_TEXT = 2000
MAX_NAME = 80


class Attendee(BaseModel):
    name: str
    present: bool = True


class PersonInput(BaseModel):
    name: str
    groups: list[str] = []


class PeopleRequest(BaseModel):
    people: list[PersonInput]
    groups: list[str] = []  # their order; groups people are in but not listed here go after


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


class ItemCreateRequest(ItemInput):
    author: str | None = None  # recorded in the item's history


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
    outcome: str | None = None  # why it closed, one of OUTCOMES; given alone, it closes the item
    closed_on: str | None = None
    superseded_by: str | None = None  # a decision's ref, e.g. "D-9"
    became: str | None = None  # the issue a risk that happened became, e.g. "I-2"; omitted, a new issue is raised
    # Recorded in the item's history.
    note: str | None = None
    author: str | None = None
    meeting_id: int | None = None


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


# --- Item history -----------------------------------------------------------------------
# Every change to a register item is kept as an event: {field: [old, new]} for the fields
# below. "raised" has every field from None; the others hold only what changed.

HISTORY_FIELDS = ("text", "owner", "due_on", "deliverable_ids", "status", "outcome", "closed_on", "link")


def describe_item_event(ref: str, event_type: str, changes: dict[str, Any], deliverable_name=lambda did: did) -> str:
    """One line for an item's history, e.g. "A-7: due 2026-10-14 → 2026-10-21" or "R-2: happened, became I-1"."""
    if event_type == "raised":
        return f"{ref}: raised"
    if event_type == "closed":
        outcome = (changes.get("outcome") or [None, None])[1]
        link = (changes.get("link") or [None, None])[1]
        if outcome == "superseded":
            return f"{ref}: superseded by {link}"
        if outcome == "happened":
            return f"{ref}: happened, became {link}"
        return f"{ref}: closed as {outcome}" if outcome else f"{ref}: closed"
    if event_type == "reopened":
        return f"{ref}: reopened"
    parts = []
    for field, (old, new) in changes.items():
        if field == "text":
            parts.append(f"reworded from “{old}”")
        elif field == "owner":
            parts.append(f"owner {old or 'none'} → {new or 'none'}")
        elif field == "due_on":
            parts.append(f"due {old or 'none'} → {new or 'none'}")
        elif field == "deliverable_ids":
            added = [deliverable_name(d) for d in new or [] if d not in (old or [])]
            removed = [deliverable_name(d) for d in old or [] if d not in (new or [])]
            if added:
                parts.append(f"linked to {', '.join(added)}")
            if removed:
                parts.append(f"unlinked from {', '.join(removed)}")
    return f"{ref}: " + "; ".join(parts) if parts else f"{ref}: edited"
