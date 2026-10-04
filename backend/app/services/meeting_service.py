"""Meetings and the register they feed. Notes stay editable; plan changes still go through a commit."""

from __future__ import annotations

from datetime import date
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..domain.commands import DomainError
from ..domain.meetings import (
    MAX_NAME,
    PREFIX,
    STATUSES,
    Attendee,
    FinishMeetingRequest,
    ItemInput,
    ItemUpdateRequest,
    MeetingUpdateRequest,
    is_date,
    item_errors,
    item_ref,
    meeting_reference,
)
from ..domain.models import Commit, Meeting, RegisterItem
from . import commit_service, projection_service, version_service
from .commit_service import NotFound, require_project, utc_now


def fail(code: str, message: str) -> DomainError:
    return DomainError([{"change_index": None, "code": code, "message": message}])


# --- Meetings ---------------------------------------------------------------------------


def require_meeting(session: Session, project_id: str, meeting_id: int) -> Meeting:
    meeting = session.get(Meeting, meeting_id)
    if meeting is None or meeting.project_id != project_id:
        raise NotFound(f"meeting {meeting_id} not found")
    return meeting


def meeting_to_dict(session: Session, meeting: Meeting, items: list[RegisterItem] | None = None) -> dict[str, Any]:
    if items is None:
        items = list(session.scalars(select(RegisterItem).where(RegisterItem.meeting_id == meeting.id).order_by(RegisterItem.id)))
    commit_seq = session.scalar(select(Commit.seq_no).where(Commit.id == meeting.commit_id)) if meeting.commit_id else None
    return {
        "id": meeting.id,
        "title": meeting.title,
        "held_on": meeting.held_on,
        "attendees": meeting.attendees or [],
        "notes": meeting.notes,
        "finished_at": meeting.finished_at,
        "commit_seq": commit_seq,
        "plan_version": meeting.plan_version,
        "reference": meeting_reference(meeting.title, meeting.held_on),
        "items": [item_to_dict(session, i, meeting) for i in items],
        "created_at": meeting.created_at,
        "updated_at": meeting.updated_at,
    }


def list_meetings(session: Session, project_id: str) -> list[dict[str, Any]]:
    require_project(session, project_id)
    meetings = session.scalars(
        select(Meeting).where(Meeting.project_id == project_id).order_by(Meeting.held_on.desc(), Meeting.id.desc())
    ).all()
    return [meeting_to_dict(session, m) for m in meetings]


def _clean_attendees(attendees: list[Attendee]) -> list[dict[str, Any]]:
    out, seen = [], set()
    for a in attendees:
        name = a.name.strip()
        if not name or name.lower() in seen:
            continue
        if len(name) > MAX_NAME:
            raise fail("name_too_long", f"Attendee name is longer than {MAX_NAME} characters")
        seen.add(name.lower())
        out.append({"name": name, "present": a.present})
    return out


def _check_title_and_date(title: str | None, held_on: str | None) -> None:
    if title is not None and not title.strip():
        raise fail("title_required", "A meeting title is required")
    if held_on is not None and not is_date(held_on):
        raise fail("invalid_date", f"Meeting date {held_on!r} is not a YYYY-MM-DD date")


def create_meeting(
    session: Session,
    project_id: str,
    title: str,
    held_on: str,
    attendees: list[Attendee] | None = None,
    notes: str = "",
    created_at: str | None = None,
) -> Meeting:
    require_project(session, project_id)
    _check_title_and_date(title, held_on)
    if attendees is None:
        # A series keeps its people: start from the last meeting with the same title, everyone present.
        last = session.scalar(
            select(Meeting)
            .where(Meeting.project_id == project_id, func.lower(Meeting.title) == title.strip().lower())
            .order_by(Meeting.held_on.desc(), Meeting.id.desc())
        )
        attendees = [Attendee(name=a["name"]) for a in (last.attendees if last else [])]
    now = created_at or utc_now()
    meeting = Meeting(
        project_id=project_id,
        title=title.strip(),
        held_on=held_on,
        attendees=_clean_attendees(attendees),
        notes=notes,
        created_at=now,
        updated_at=now,
    )
    session.add(meeting)
    session.flush()
    return meeting


def update_meeting(session: Session, project_id: str, meeting_id: int, body: MeetingUpdateRequest) -> Meeting:
    meeting = require_meeting(session, project_id, meeting_id)
    _check_title_and_date(body.title, body.held_on)
    if meeting.finished_at and (body.title is not None or body.held_on is not None):
        if (body.title or meeting.title).strip() != meeting.title or (body.held_on or meeting.held_on) != meeting.held_on:
            raise fail("meeting_finished", "A finished meeting keeps its title and date; its commit refers to them")
    if body.title is not None:
        meeting.title = body.title.strip()
    if body.held_on is not None:
        meeting.held_on = body.held_on
    if body.attendees is not None:
        meeting.attendees = _clean_attendees(body.attendees)
    if body.notes is not None:
        meeting.notes = body.notes
    meeting.updated_at = utc_now()
    session.flush()
    return meeting


def delete_meeting(session: Session, project_id: str, meeting_id: int) -> None:
    meeting = require_meeting(session, project_id, meeting_id)
    if meeting.finished_at:
        raise fail("meeting_finished", "A finished meeting can't be deleted; its items are in the register")
    session.delete(meeting)
    session.flush()


def finish_meeting(
    session: Session, project_id: str, meeting_id: int, body: FinishMeetingRequest, finished_at: str | None = None
) -> dict[str, Any]:
    """Record the meeting's items and, optionally, one plan commit. All or nothing.

    The caller commits the transaction; any error raised here leaves nothing written.
    """
    meeting = require_meeting(session, project_id, meeting_id)
    if meeting.finished_at:
        raise fail("meeting_finished", "This meeting is already finished")
    if not body.author.strip():
        raise fail("author_required", "An author is required")

    commit_result = None
    if body.commit is not None:
        commit, events = commit_service.create_commit(
            session,
            project_id,
            reason=body.commit.reason,
            author=body.author,
            base_version=body.commit.base_version,
            changes=body.commit.changes,
            category=body.commit.category,
            reference=meeting_reference(meeting.title, meeting.held_on),
            created_at=finished_at,
        )
        meeting.commit_id = commit.id
        commit_result = commit_service.commit_result(session, project_id, commit, events)

    # Items are checked after the commit, so they may name a deliverable it creates.
    existing = set(projection_service.load_state(session, project_id)["deliverables"])
    errors = [e for i, item in enumerate(body.items) for e in item_errors(item, existing, i)]
    if errors:
        raise DomainError(errors)

    items = [_add_item(session, project_id, item, meeting.id, finished_at) for item in body.items]
    meeting.finished_at = finished_at or utc_now()
    meeting.plan_version = version_service.current_version(session, project_id)
    meeting.updated_at = meeting.finished_at
    session.flush()
    return {"meeting": meeting_to_dict(session, meeting, items), "commit": commit_result}


# --- Register ---------------------------------------------------------------------------


def item_to_dict(session: Session, item: RegisterItem, meeting: Meeting | None = None) -> dict[str, Any]:
    if meeting is None and item.meeting_id:
        meeting = session.get(Meeting, item.meeting_id)
    superseded_by = session.get(RegisterItem, item.superseded_by_id) if item.superseded_by_id else None
    return {
        "id": item.id,
        "ref": item_ref(item.kind, item.number),
        "kind": item.kind,
        "text": item.text,
        "owner": item.owner,
        "due_on": item.due_on,
        "deliverable_ids": item.deliverable_ids or [],
        "meeting": {"id": meeting.id, "title": meeting.title, "held_on": meeting.held_on} if meeting else None,
        "status": item.status,
        "open": item.status == STATUSES[item.kind][0],
        "closed_on": item.closed_on,
        "superseded_by": item_ref(superseded_by.kind, superseded_by.number) if superseded_by else None,
        "created_at": item.created_at,
    }


def list_items(session: Session, project_id: str) -> list[dict[str, Any]]:
    require_project(session, project_id)
    items = session.scalars(select(RegisterItem).where(RegisterItem.project_id == project_id).order_by(RegisterItem.id)).all()
    meetings = {m.id: m for m in session.scalars(select(Meeting).where(Meeting.project_id == project_id))}
    return [item_to_dict(session, i, meetings.get(i.meeting_id)) for i in items]


def _add_item(session: Session, project_id: str, item: ItemInput, meeting_id: int | None, created_at: str | None) -> RegisterItem:
    number = (
        session.scalar(
            select(func.max(RegisterItem.number)).where(RegisterItem.project_id == project_id, RegisterItem.kind == item.kind)
        )
        or 0
    ) + 1
    now = created_at or utc_now()
    row = RegisterItem(
        project_id=project_id,
        kind=item.kind,
        number=number,
        text=item.text.strip(),
        owner=(item.owner or "").strip() or None,
        due_on=item.due_on or None,
        deliverable_ids=list(dict.fromkeys(item.deliverable_ids)),
        meeting_id=meeting_id,
        status=STATUSES[item.kind][0],
        created_at=now,
        updated_at=now,
    )
    session.add(row)
    session.flush()
    return row


def create_item(session: Session, project_id: str, item: ItemInput, created_at: str | None = None) -> RegisterItem:
    """An item raised outside a meeting, e.g. a programme-level action."""
    require_project(session, project_id)
    existing = set(projection_service.load_state(session, project_id)["deliverables"])
    errors = item_errors(item, existing)
    if errors:
        raise DomainError(errors)
    return _add_item(session, project_id, item, None, created_at)


def _require_item(session: Session, project_id: str, item_id: int) -> RegisterItem:
    item = session.get(RegisterItem, item_id)
    if item is None or item.project_id != project_id:
        raise NotFound(f"register item {item_id} not found")
    return item


def _find_by_ref(session: Session, project_id: str, ref: str) -> RegisterItem | None:
    kind = next((k for k, p in PREFIX.items() if ref.upper().startswith(p + "-")), None)
    number = ref.split("-", 1)[1] if "-" in ref else ""
    if kind is None or not number.isdigit():
        return None
    return session.scalar(
        select(RegisterItem).where(RegisterItem.project_id == project_id, RegisterItem.kind == kind, RegisterItem.number == int(number))
    )


def update_item(session: Session, project_id: str, item_id: int, body: ItemUpdateRequest, today: str | None = None) -> RegisterItem:
    item = _require_item(session, project_id, item_id)
    edits = {k: v for k, v in body.model_dump(exclude_unset=True).items() if k in ("text", "owner", "due_on", "deliverable_ids")}

    if item.kind == "decision" and edits:
        raise fail("decision_locked", f"{item_ref(item.kind, item.number)} is a decision; record a new decision that supersedes it instead")
    if edits:
        merged = ItemInput(
            kind=item.kind,
            text=edits.get("text", item.text),
            owner=edits.get("owner", item.owner),
            due_on=edits.get("due_on", item.due_on),
            deliverable_ids=edits.get("deliverable_ids", item.deliverable_ids or []),
        )
        existing = set(projection_service.load_state(session, project_id)["deliverables"])
        # Links to deliverables deleted since are kept; only new links must exist.
        errors = item_errors(merged, existing | set(item.deliverable_ids or []))
        if errors:
            raise DomainError(errors)
        item.text = merged.text.strip()
        item.owner = (merged.owner or "").strip() or None
        item.due_on = merged.due_on or None
        item.deliverable_ids = list(dict.fromkeys(merged.deliverable_ids))

    if body.status is not None and body.status != item.status:
        open_status, closed_status = STATUSES[item.kind]
        if body.status not in (open_status, closed_status):
            raise fail("invalid_status", f"A {item.kind} is {open_status} or {closed_status}, not {body.status!r}")
        if body.closed_on is not None and not is_date(body.closed_on):
            raise fail("invalid_date", f"{body.closed_on!r} is not a YYYY-MM-DD date")
        if item.kind == "decision":
            if body.status == "active":
                raise fail("decision_locked", "A superseded decision stays superseded; record a new decision instead")
            replacement = _find_by_ref(session, project_id, body.superseded_by or "")
            if replacement is None or replacement.kind != "decision" or replacement.id == item.id:
                raise fail("superseded_by_required", "Name the decision that supersedes this one, e.g. D-9")
            if replacement.status != "active":
                raise fail("superseded_by_inactive", f"{item_ref('decision', replacement.number)} is itself superseded")
            item.superseded_by_id = replacement.id
        item.status = body.status
        item.closed_on = None if body.status == open_status else (body.closed_on or today or date.today().isoformat())

    item.updated_at = utc_now()
    session.flush()
    return item
