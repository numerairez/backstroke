"""Why the plan is where it is: date moves, the meetings and register items around them,
and whether each move was raised before it was committed.

A commit that moves dates is one of:
  agreed     - committed from a meeting (the meeting's own plan commit)
  foreseen   - an open risk or action was on a moved deliverable, or a meeting discussed one
               of them in the RECENT_DAYS before
  surprise   - neither: nobody raised it before the plan changed
"""

from __future__ import annotations

import re
from datetime import date, timedelta
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..domain.events import Event, State
from ..domain.meetings import STATUSES, item_ref
from ..domain.models import Commit, Meeting, RegisterItem
from ..domain.validators import PROGRESS_CATEGORY
from . import history_service, version_service
from .commit_service import require_project
from .knowledge_service import describe_events

RECENT_DAYS = 21


def _day(ts: str) -> str:
    return ts[:10]


def mentions(notes: str, name: str) -> bool:
    """Whether meeting notes talk about a deliverable: @[Name], @NameWithoutSpaces or the plain name."""
    if not name.strip():
        return False
    compact = re.sub(r"[^a-z0-9]", "", name.lower())
    if any(re.sub(r"[^a-z0-9]", "", token.lower()) == compact for token in re.findall(r"@([A-Za-z][\w-]*)", notes)):
        return True
    # Also matches @[Name], since brackets aren't word characters.
    return re.search(rf"(?<![\w-]){re.escape(name.strip())}(?![\w-])", notes, re.IGNORECASE) is not None


def _moves(before: State, events: list[Event]) -> dict[str, dict[str, Any]]:
    """Date changes to deliverables that existed before the commit: id -> {field: (old, new)}."""
    out: dict[str, dict[str, Any]] = {}
    for e in events:
        if e.entity_type == "deliverable" and e.operation == "update" and e.field_name in ("start_date", "end_date") and e.entity_id in before["deliverables"]:
            out.setdefault(e.entity_id, {})[e.field_name] = (e.old_value, e.new_value)
    return out


class Trail:
    """History, meetings and register for one project, loaded once."""

    def __init__(self, session: Session, project_id: str):
        require_project(session, project_id)
        self.version = version_service.current_version(session, project_id)
        self.commits = history_service.list_commits(session, project_id, include_events=True)
        self.states = version_service.states_through(session, project_id, self.version)
        self.meetings = list(session.scalars(select(Meeting).where(Meeting.project_id == project_id).order_by(Meeting.held_on, Meeting.id)))
        self.items = list(session.scalars(select(RegisterItem).where(RegisterItem.project_id == project_id).order_by(RegisterItem.id)))
        seq_of = dict(session.execute(select(Commit.id, Commit.seq_no).where(Commit.project_id == project_id)).all())
        self.meeting_of_commit = {seq_of[m.commit_id]: m for m in self.meetings if m.commit_id}
        self.meeting_by_id = {m.id: m for m in self.meetings}

    def name(self, did: str, seq: int | None = None) -> str:
        for state in ([self.states[seq]] if seq is not None else []) + [self.states[self.version]] + list(reversed(list(self.states.values()))):
            if did in state["deliverables"]:
                return state["deliverables"][did]["name"]
        return did

    def _item_raised(self, item: RegisterItem) -> str:
        m = self.meeting_by_id.get(item.meeting_id) if item.meeting_id else None
        return m.held_on if m else _day(item.created_at)

    def signals_before(self, did: str, day: str) -> list[dict[str, Any]]:
        """What had raised deliverable `did` by `day`: open risks and actions on it, recent meetings that discussed it."""
        out = []
        for i in self.items:
            if i.kind == "decision" or did not in (i.deliverable_ids or []):
                continue
            raised = self._item_raised(i)
            still_open = i.status == STATUSES[i.kind][0] or (i.closed_on or "9999") >= day
            if raised <= day and still_open:
                out.append({"type": "item", "ref": item_ref(i.kind, i.number), "date": raised})
        since = (date.fromisoformat(day) - timedelta(days=RECENT_DAYS)).isoformat()
        name = self.name(did)
        for m in self.meetings:
            if since <= m.held_on <= day and mentions(m.notes, name):
                out.append({"type": "meeting", "ref": f"{m.title} {m.held_on}", "date": m.held_on})
        return out

    def classify(self, commit: dict[str, Any]) -> dict[str, Any] | None:
        """None for a commit that moves no existing dates (new work, progress, edits)."""
        if commit["category"] == PROGRESS_CATEGORY:
            return None
        events = [Event(e["entity_type"], e["entity_id"], e["operation"], e["field_name"], e["old_value"], e["new_value"]) for e in commit["events"]]
        moved = _moves(self.states[commit["seq"] - 1], events)
        if not moved:
            return None
        day = _day(commit["created_at"])
        meeting = self.meeting_of_commit.get(commit["seq"])
        if meeting:
            return {"kind": "agreed", "by": f"{meeting.title} {meeting.held_on}", "moved": list(moved)}
        signals = [s for did in moved for s in self.signals_before(did, day)]
        if signals:
            latest = max(signals, key=lambda s: s["date"])
            return {"kind": "foreseen", "by": latest["ref"], "moved": list(moved)}
        return {"kind": "surprise", "by": None, "moved": list(moved)}

    def commit_entry(self, commit: dict[str, Any]) -> dict[str, Any]:
        events = [Event(e["entity_type"], e["entity_id"], e["operation"], e["field_name"], e["old_value"], e["new_value"]) for e in commit["events"]]
        meeting = self.meeting_of_commit.get(commit["seq"])
        return {
            "seq": commit["seq"],
            "date": _day(commit["created_at"]),
            "author": commit["author"],
            "reason": commit["reason"],
            "category": commit["category"],
            "reference": commit["reference"],
            "meeting": f"{meeting.title} {meeting.held_on}" if meeting else None,
            "lines": describe_events(self.states[commit["seq"] - 1], events),
            "signal": self.classify(commit),
        }


def surprises(session: Session, project_id: str) -> dict[str, Any]:
    trail = Trail(session, project_id)
    rows = []
    for c in trail.commits:
        signal = trail.classify(c)
        if signal:
            rows.append({"seq": c["seq"], "date": _day(c["created_at"]), "reason": c["reason"], "deliverables": [trail.name(d, c["seq"]) for d in signal["moved"]], **signal})
    counts = {k: sum(1 for r in rows if r["kind"] == k) for k in ("agreed", "foreseen", "surprise")}
    return {"recent_days": RECENT_DAYS, "total": len(rows), **counts, "commits": rows}


def deliverable_trail(session: Session, project_id: str, deliverable_id: str) -> dict[str, Any]:
    """Everything that explains where one deliverable is: its commits, meetings and register items, oldest first."""
    trail = Trail(session, project_id)
    name = trail.name(deliverable_id)
    entries: list[dict[str, Any]] = []
    for c in trail.commits:
        if deliverable_id not in c["affected"].get("deliverable", []):
            continue
        entry = trail.commit_entry(c)
        events = [Event(e["entity_type"], e["entity_id"], e["operation"], e["field_name"], e["old_value"], e["new_value"]) for e in c["events"]]
        mine = {
            i
            for i, e in enumerate(events)
            if (e.entity_type == "deliverable" and e.entity_id == deliverable_id)
            or (e.entity_type == "dependency" and deliverable_id in ((e.new_value or e.old_value or {}).get("predecessor_id"), (e.new_value or e.old_value or {}).get("successor_id")))
        }
        entry["lines"] = describe_events(trail.states[c["seq"] - 1], events, only=mine)
        entries.append({"type": "commit", **entry})
    for m in trail.meetings:
        items = [i for i in trail.items if i.meeting_id == m.id and deliverable_id in (i.deliverable_ids or [])]
        if items or mentions(m.notes, name):
            entries.append(
                {
                    "type": "meeting",
                    "date": m.held_on,
                    "meeting": f"{m.title} {m.held_on}",
                    "meeting_id": m.id,
                    "items": [{"ref": item_ref(i.kind, i.number), "kind": i.kind, "text": i.text} for i in items],
                    "notes": [line.strip() for line in m.notes.splitlines() if mentions(line, name)],
                }
            )
    for i in trail.items:
        if i.meeting_id is None and deliverable_id in (i.deliverable_ids or []):
            entries.append({"type": "item", "date": _day(i.created_at), "items": [{"ref": item_ref(i.kind, i.number), "kind": i.kind, "text": i.text}]})
    # Same day: meetings first, so a commit agreed at a meeting follows it.
    order = {"meeting": 0, "item": 1, "commit": 2}
    entries.sort(key=lambda e: (e["date"], order[e["type"]], e.get("seq", 0)))
    return {"deliverable_id": deliverable_id, "name": name, "recent_days": RECENT_DAYS, "entries": entries}


# --- Pre-read ---------------------------------------------------------------------------

LOOKAHEAD_DAYS = 14


def _previous_meeting(trail: Trail, meeting: Meeting) -> Meeting | None:
    """The last finished meeting before this one, preferring the same series (title)."""
    earlier = [m for m in trail.meetings if m.finished_at and m.id != meeting.id and (m.held_on, m.id) < (meeting.held_on, meeting.id)]
    same = [m for m in earlier if m.title.casefold() == meeting.title.casefold()]
    pool = same or earlier
    return pool[-1] if pool else None


def preread(session: Session, project_id: str, meeting_id: int) -> dict[str, Any]:
    """What a meeting should know: changes since the series last met, what needs attention, what's next."""
    from ..domain.status import deliverable_status, status_label
    from .meeting_service import require_meeting

    meeting = require_meeting(session, project_id, meeting_id)
    trail = Trail(session, project_id)
    day = meeting.held_on
    previous = _previous_meeting(trail, meeting)
    since_version = previous.plan_version if previous and previous.plan_version is not None else None
    since_day = previous.held_on if previous else (date.fromisoformat(day) - timedelta(days=LOOKAHEAD_DAYS)).isoformat()

    def after_previous(c: dict[str, Any]) -> bool:
        return c["seq"] > since_version if since_version is not None else _day(c["created_at"]) > since_day

    own_commit = next((seq for seq, m in trail.meeting_of_commit.items() if m.id == meeting.id), None)
    changed = [c for c in trail.commits if after_previous(c) and c["seq"] != own_commit]
    commits = [trail.commit_entry(c) for c in changed if c["category"] != PROGRESS_CATEGORY]
    finished = [line for c in changed if c["category"] == PROGRESS_CATEGORY for line in trail.commit_entry(c)["lines"]]

    plan = trail.states[trail.version]["deliverables"]
    attention = []
    for d in sorted(plan.values(), key=lambda d: d["end_date"]):
        s = deliverable_status(d, day)
        if s and s["kind"] in ("behind", "overdue"):
            risks = [item_ref(i.kind, i.number) for i in trail.items if i.kind == "risk" and i.status == "open" and d["id"] in (i.deliverable_ids or [])]
            attention.append({"id": d["id"], "name": d["name"], "kind": s["kind"], "status": status_label(s), "risks": risks})

    horizon = (date.fromisoformat(day) + timedelta(days=LOOKAHEAD_DAYS)).isoformat()
    coming = []
    for d in plan.values():
        if d["type"] == "milestone":
            if day <= d["start_date"] <= horizon:
                coming.append({"date": d["start_date"], "id": d["id"], "text": f"{d['name']} due"})
            continue
        if day <= d["start_date"] <= horizon:
            coming.append({"date": d["start_date"], "id": d["id"], "text": f"{d['name']} starts"})
        done = (deliverable_status(d, day) or {}).get("kind") == "done"
        if day <= d["end_date"] <= horizon and not done:
            coming.append({"date": d["end_date"], "id": d["id"], "text": f"{d['name']} ends"})
    coming.sort(key=lambda x: (x["date"], x["text"]))

    def item_dict(i: RegisterItem) -> dict[str, Any]:
        return {
            "ref": item_ref(i.kind, i.number),
            "kind": i.kind,
            "text": i.text,
            "owner": i.owner,
            "due_on": i.due_on,
            "overdue": bool(i.kind == "action" and i.due_on and i.due_on < day),
            "deliverables": [trail.name(x) for x in i.deliverable_ids or []],
        }

    others = [i for i in trail.items if i.meeting_id != meeting.id]
    actions = sorted((item_dict(i) for i in others if i.kind == "action" and i.status == "open"), key=lambda a: (not a["overdue"], a["due_on"] or "9999"))
    risks = [item_dict(i) for i in others if i.kind == "risk" and i.status == "open"]
    decisions = [item_dict(i) for i in others if i.kind == "decision" and previous and trail._item_raised(i) > previous.held_on]

    agenda = []
    if actions:
        late = [a["ref"] for a in actions if a["overdue"]]
        agenda.append(f"Open actions: {len(actions)}" + (f", overdue {', '.join(late)}" if late else ""))
    for c in commits:
        if c["signal"] and c["signal"]["kind"] == "surprise":
            names = ", ".join(trail.name(d) for d in c["signal"]["moved"])
            agenda.append(f"Commit #{c['seq']} moved {names} without being raised first: {c['reason']}")
    for a in attention[:4]:
        agenda.append(f"{a['name']}: {a['status'].lower()}" + (f" (open risk {', '.join(a['risks'])})" if a["risks"] else ""))
    for x in coming:
        if x["text"].endswith(" due"):
            agenda.append(f"{x['text'][:-4]} is due {x['date']}: on track?")
    covered = {r for a in attention for r in a["risks"]}
    rest = [r["ref"] for r in risks if r["ref"] not in covered]
    if rest:
        agenda.append(f"Open risks: {', '.join(rest)}")

    return {
        "as_of": day,
        "since": {"meeting": f"{previous.title} {previous.held_on}" if previous else None, "date": since_day, "version": since_version},
        "version": trail.version,
        "commits": commits,
        "finished": finished,
        "attention": attention,
        "coming_up": coming,
        "lookahead_days": LOOKAHEAD_DAYS,
        "actions": actions,
        "risks": risks,
        "decisions": decisions,
        "agenda": agenda,
    }
