"""Meetings and the register they feed. Notes stay editable; plan changes still go through a commit."""

from __future__ import annotations

from datetime import date
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..domain.commands import DomainError
from ..domain.meetings import (
    HISTORY_FIELDS,
    MAX_NAME,
    MAX_TEXT,
    OUTCOMES,
    PREFIX,
    STATUSES,
    Attendee,
    FinishMeetingRequest,
    ItemInput,
    ItemUpdateRequest,
    MeetingUpdateRequest,
    describe_item_event,
    is_date,
    item_errors,
    item_ref,
    meeting_reference,
)
from ..domain.models import Commit, Meeting, RegisterEvent, RegisterItem
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
    if session.scalar(select(RegisterEvent.id).where(RegisterEvent.meeting_id == meeting.id).limit(1)):
        raise fail("meeting_in_history", "Register items were updated in this meeting, and their history names it")
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

    items = [_add_item(session, project_id, item, meeting.id, finished_at, author=body.author.strip()) for item in body.items]
    meeting.finished_at = finished_at or utc_now()
    meeting.plan_version = version_service.current_version(session, project_id)
    meeting.updated_at = meeting.finished_at
    session.flush()
    return {"meeting": meeting_to_dict(session, meeting, items), "commit": commit_result}


# --- Register ---------------------------------------------------------------------------


def _ref(item: RegisterItem | None) -> str | None:
    return item_ref(item.kind, item.number) if item else None


def item_to_dict(session: Session, item: RegisterItem, meeting: Meeting | None = None) -> dict[str, Any]:
    if meeting is None and item.meeting_id:
        meeting = session.get(Meeting, item.meeting_id)
    following = session.get(RegisterItem, item.superseded_by_id) if item.superseded_by_id else None
    # An issue lists the risks that became it.
    sources = (
        session.scalars(select(RegisterItem).where(RegisterItem.superseded_by_id == item.id, RegisterItem.kind == "risk").order_by(RegisterItem.number)).all()
        if item.kind == "issue"
        else []
    )
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
        "outcome": item.outcome,
        "closed_on": item.closed_on,
        "superseded_by": _ref(following) if item.kind == "decision" else None,
        "became": _ref(following) if item.kind == "risk" else None,
        "raised_from": [_ref(r) for r in sources],
        "created_at": item.created_at,
    }


def list_items(session: Session, project_id: str) -> list[dict[str, Any]]:
    require_project(session, project_id)
    items = session.scalars(select(RegisterItem).where(RegisterItem.project_id == project_id).order_by(RegisterItem.id)).all()
    meetings = {m.id: m for m in session.scalars(select(Meeting).where(Meeting.project_id == project_id))}
    return [item_to_dict(session, i, meetings.get(i.meeting_id)) for i in items]


# --- Item history -------------------------------------------------------------------------


def _snapshot(session: Session, item: RegisterItem) -> dict[str, Any]:
    following = session.get(RegisterItem, item.superseded_by_id) if item.superseded_by_id else None
    return {
        "text": item.text,
        "owner": item.owner,
        "due_on": item.due_on,
        "deliverable_ids": list(item.deliverable_ids or []),
        "status": item.status,
        "outcome": item.outcome,
        "closed_on": item.closed_on,
        "link": _ref(following),
    }


def _record(
    session: Session,
    item: RegisterItem,
    before: dict[str, Any] | None,
    *,
    meeting_id: int | None = None,
    author: str | None = None,
    note: str | None = None,
    at: str | None = None,
) -> RegisterEvent | None:
    """Keep what changed on `item` since `before` (None: it was just raised). Nothing changed, nothing kept."""
    after = _snapshot(session, item)
    if before is None:
        changes = {f: [None, after[f]] for f in HISTORY_FIELDS if after[f] not in (None, [])}
        kind = "raised"
    else:
        changes = {f: [before[f], after[f]] for f in HISTORY_FIELDS if before[f] != after[f]}
        if not changes:
            return None
        kind = ("reopened" if after["status"] == STATUSES[item.kind][0] else "closed") if "status" in changes else "edited"
    event = RegisterEvent(
        project_id=item.project_id,
        item_id=item.id,
        type=kind,
        changes=changes,
        meeting_id=meeting_id,
        author=(author or "").strip() or None,
        note=(note or "").strip() or None,
        created_at=at or utc_now(),
    )
    session.add(event)
    session.flush()
    return event


def event_to_dict(event: RegisterEvent, ref: str, meetings: dict[int, Meeting], deliverable_name=lambda did: did) -> dict[str, Any]:
    meeting = meetings.get(event.meeting_id) if event.meeting_id else None
    closed_on = (event.changes.get("closed_on") or [None, None])[1] if event.type == "closed" else None
    return {
        "id": event.id,
        "type": event.type,
        "at": event.created_at,
        # The day it happened: a closure can be recorded after the day it closed.
        "on": closed_on or (meeting.held_on if meeting else event.created_at[:10]),
        "changes": event.changes,
        "line": describe_item_event(ref, event.type, event.changes, deliverable_name),
        "author": event.author,
        "note": event.note,
        "meeting": {"id": meeting.id, "title": meeting.title, "held_on": meeting.held_on} if meeting else None,
    }


def item_history(session: Session, project_id: str, item_id: int) -> list[dict[str, Any]]:
    """Everything that happened to one item, oldest first."""
    item = _require_item(session, project_id, item_id)
    events = session.scalars(select(RegisterEvent).where(RegisterEvent.item_id == item.id).order_by(RegisterEvent.id)).all()
    meetings = {m.id: m for m in session.scalars(select(Meeting).where(Meeting.project_id == project_id))}
    plan = projection_service.load_state(session, project_id)["deliverables"]
    name = lambda did: plan[did]["name"] if did in plan else "a removed deliverable"  # noqa: E731
    return [event_to_dict(e, item_ref(item.kind, item.number), meetings, name) for e in events]


def register_history(session: Session, project_id: str) -> list[dict[str, Any]]:
    """Every item event in the project, oldest first, each with its item's ref, kind and deliverables."""
    items = {i.id: i for i in session.scalars(select(RegisterItem).where(RegisterItem.project_id == project_id))}
    events = session.scalars(select(RegisterEvent).where(RegisterEvent.project_id == project_id).order_by(RegisterEvent.id)).all()
    meetings = {m.id: m for m in session.scalars(select(Meeting).where(Meeting.project_id == project_id))}
    plan = projection_service.load_state(session, project_id)["deliverables"]
    name = lambda did: plan[did]["name"] if did in plan else "a removed deliverable"  # noqa: E731
    out = []
    for e in events:
        item = items[e.item_id]
        ref = item_ref(item.kind, item.number)
        out.append({**event_to_dict(e, ref, meetings, name), "item_id": item.id, "ref": ref, "kind": item.kind, "deliverable_ids": item.deliverable_ids or []})
    return out


def _add_item(
    session: Session,
    project_id: str,
    item: ItemInput,
    meeting_id: int | None,
    created_at: str | None,
    author: str | None = None,
    note: str | None = None,
) -> RegisterItem:
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
    _record(session, row, None, meeting_id=meeting_id, author=author, note=note, at=now)
    return row


def create_item(session: Session, project_id: str, item: ItemInput, created_at: str | None = None, author: str | None = None) -> RegisterItem:
    """An item raised outside a meeting, e.g. a programme-level action."""
    require_project(session, project_id)
    existing = set(projection_service.load_state(session, project_id)["deliverables"])
    errors = item_errors(item, existing)
    if errors:
        raise DomainError(errors)
    return _add_item(session, project_id, item, None, created_at, author=author)


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


def _link(session: Session, project_id: str, item: RegisterItem, outcome: str, body: ItemUpdateRequest, at: str) -> RegisterItem | None:
    """The item that follows one closing as `outcome`: the newer decision, or the issue a risk became."""
    ref = item_ref(item.kind, item.number)
    if outcome == "superseded":
        replacement = _find_by_ref(session, project_id, body.superseded_by or "")
        if replacement is None or replacement.kind != "decision" or replacement.id == item.id:
            raise fail("superseded_by_required", "Name the decision that supersedes this one, e.g. D-9")
        if replacement.status != "active":
            raise fail("superseded_by_inactive", f"{_ref(replacement)} is no longer active")
        return replacement
    if outcome == "happened":
        if body.became:
            issue = _find_by_ref(session, project_id, body.became)
            if issue is None or issue.kind != "issue":
                raise fail("became_not_an_issue", f"A risk that happened becomes an issue; {body.became!r} isn't one, e.g. I-2")
            return issue
        # No issue named: raise one that carries the risk over.
        issue = ItemInput(kind="issue", text=item.text, owner=item.owner, deliverable_ids=item.deliverable_ids or [])
        return _add_item(session, project_id, issue, body.meeting_id, at, author=body.author, note=f"Raised when {ref} happened")
    return None


def update_item(session: Session, project_id: str, item_id: int, body: ItemUpdateRequest, today: str | None = None) -> RegisterItem:
    item = _require_item(session, project_id, item_id)
    ref = item_ref(item.kind, item.number)
    before = _snapshot(session, item)
    now = utc_now()
    if body.meeting_id is not None:
        require_meeting(session, project_id, body.meeting_id)
    if body.note is not None and len(body.note) > MAX_TEXT:
        raise fail("note_too_long", f"The note is longer than {MAX_TEXT} characters")
    edits = {k: v for k, v in body.model_dump(exclude_unset=True).items() if k in ("text", "owner", "due_on", "deliverable_ids")}

    if item.kind == "decision" and edits:
        raise fail("decision_locked", f"{ref} is a decision; record a new decision that supersedes it instead")
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

    open_status, closed_status = STATUSES[item.kind]
    status = body.status if body.status is not None else (closed_status if body.outcome else None)
    if status is not None and status != item.status:
        if status not in (open_status, closed_status):
            raise fail("invalid_status", f"A {item.kind} is {open_status} or {closed_status}, not {status!r}")
        if body.closed_on is not None and not is_date(body.closed_on):
            raise fail("invalid_date", f"{body.closed_on!r} is not a YYYY-MM-DD date")
        if status == open_status:
            if item.kind == "decision":
                raise fail("decision_locked", "A closed decision stays closed; record a new decision instead")
            item.outcome, item.superseded_by_id, item.closed_on = None, None, None
        else:
            outcome = body.outcome or ("superseded" if item.kind == "decision" else None)
            if outcome not in OUTCOMES[item.kind]:
                choices = ", ".join(OUTCOMES[item.kind])
                raise fail("outcome_required", f"Say why {ref} is closing: {choices}")
            following = _link(session, project_id, item, outcome, body, now)
            item.outcome = outcome
            item.superseded_by_id = following.id if following else None
            item.closed_on = body.closed_on or today or date.today().isoformat()
        item.status = status

    item.updated_at = now
    session.flush()
    _record(session, item, before, meeting_id=body.meeting_id, author=body.author, note=body.note, at=now)
    return item
