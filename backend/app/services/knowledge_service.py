"""A project as one Markdown file, written for pasting into an LLM.

Everything comes from stored records: the plan and its commit history, baselines,
meetings and the register. Nothing is generated or summarised by a model.
"""

from __future__ import annotations

from datetime import date
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..domain.events import Event, State, apply_event, empty_state, serialize_state
from ..domain.meetings import STATUSES
from ..domain.models import Commit, Meeting
from ..domain.phases import phase_spans
from ..domain.status import deliverable_status, status_label
from ..domain.validators import REASON_CATEGORIES
from . import history_service, meeting_service, people_service, project_service, projection_service, version_service
from .commit_service import require_project

CATEGORY_LABELS = {c["code"]: c["label"] for c in REASON_CATEGORIES}
# A commit that creates more than this many things is summarised by count (an initial plan).
SUMMARISE_CREATES_OVER = 10


def cell(value: Any) -> str:
    """Safe inside a Markdown table cell."""
    return str(value if value is not None else "").replace("|", "\\|").replace("\n", " ").strip()


def _days(a: str, b: str) -> int:
    return (date.fromisoformat(b) - date.fromisoformat(a)).days


def plural(n: int, word: str, many: str | None = None) -> str:
    return f"{n} {word if n == 1 else many or word + 's'}"


def _signed(n: int) -> str:
    return f"+{n}d" if n > 0 else f"{n}d"


# --- Commit history in words -------------------------------------------------------------


def _name(state: State, entity_type: str, entity_id: str) -> str:
    collection = {"workstream": "workstreams", "deliverable": "deliverables", "dependency": "dependencies"}[entity_type]
    entity = state[collection].get(entity_id)
    return entity.get("name", entity_id) if entity else entity_id


def _phases_text(phases: list[dict[str, Any]] | None) -> str:
    if not phases:
        return "no phases"
    return ", ".join(f"{p['name']}" + (f" {p['days']}d" if "days" in p else "") + (f" after a {p['gap']}d gap" if p.get("gap") else "") for p in phases)


def _progress_lines(name: str, old: list[dict] | None, new: list[dict] | None) -> list[str]:
    lines = []
    for a, b in zip(old or [], new or []):
        if a.get("finished_on") != b.get("finished_on"):
            lines.append(f"{name}: {b['name']} " + (f"marked done {b['finished_on']}" if b.get("finished_on") else "reopened"))
    return lines


def describe_events(before: State, events: list[Event], only: set[int] | None = None) -> list[str]:
    """Plain-language lines for one commit's events, read against the state before it.

    `only` limits the lines to those event indices; every event is still applied, so names
    of things created in the same commit resolve.
    """
    state = {k: {i: dict(v) for i, v in c.items()} for k, c in before.items()}
    creates = [e for e in events if e.operation == "create"]
    if only is None and len(creates) > SUMMARISE_CREATES_OVER:
        counts: dict[str, int] = {}
        for e in creates:
            counts[e.entity_type] = counts.get(e.entity_type, 0) + 1
        parts = [plural(n, t, "dependencies" if t == "dependency" else None) for t, n in counts.items()]
        lines = [f"Created {', '.join(parts)} (see the current plan for what remains)"]
        for e in events:
            apply_event(state, e)
        return lines

    lines: list[str] = []
    for index, e in enumerate(events):
        if only is not None and index not in only:
            apply_event(state, e)
            continue
        if e.entity_type == "deliverable":
            name = _name(state, "deliverable", e.entity_id)
            if e.operation == "create":
                v = e.new_value
                when = f"on {v['start_date']}" if v["type"] == "milestone" else f"{v['start_date']} to {v['end_date']}"
                lines.append(f"Added {'milestone ' if v['type'] == 'milestone' else ''}{v['name']}, {when}")
            elif e.operation == "delete":
                lines.append(f"Removed {name}")
            elif e.field_name in ("start_date", "end_date"):
                field = "date" if state["deliverables"][e.entity_id]["type"] == "milestone" else e.field_name.split("_")[0]
                if field == "date" and e.field_name == "end_date":
                    pass  # a milestone moves both dates; report it once
                else:
                    lines.append(f"{name}: {field} {e.old_value} → {e.new_value} ({_signed(_days(e.old_value, e.new_value))})")
            elif e.field_name == "finished_on":
                lines.append(f"{name}: " + (f"marked done {e.new_value}" if e.new_value else "reopened"))
            elif e.field_name == "phases":
                progress = _progress_lines(name, e.old_value, e.new_value)
                old_shape = [{k: v for k, v in p.items() if k != "finished_on"} for p in e.old_value or []]
                new_shape = [{k: v for k, v in p.items() if k != "finished_on"} for p in e.new_value or []]
                if old_shape != new_shape:
                    if not e.old_value:
                        lines.append(f"{name}: split into phases {_phases_text(e.new_value)}")
                    elif not e.new_value:
                        lines.append(f"{name}: phases removed (were {_phases_text(e.old_value)})")
                    else:
                        lines.append(f"{name}: phases {_phases_text(e.old_value)} → {_phases_text(e.new_value)}")
                lines.extend(progress)
            elif e.field_name == "name":
                lines.append(f"Renamed {e.old_value} to {e.new_value}")
            elif e.field_name == "workstream_id":
                lines.append(f"{name}: moved from {_name(state, 'workstream', e.old_value)} to {_name(state, 'workstream', e.new_value)}")
            elif e.field_name == "type":
                lines.append(f"{name}: now a {e.new_value}")
        elif e.entity_type == "workstream":
            if e.operation == "create":
                lines.append(f"Added workstream {e.new_value['name']}")
            elif e.operation == "delete":
                lines.append(f"Removed workstream {_name(state, 'workstream', e.entity_id)}")
            elif e.field_name == "name":
                lines.append(f"Renamed workstream {e.old_value} to {e.new_value}")
        elif e.entity_type == "dependency":
            dep = e.new_value if e.operation == "create" else state["dependencies"].get(e.entity_id, {})
            if dep:
                pair = f"{_name(state, 'deliverable', dep['predecessor_id'])} → {_name(state, 'deliverable', dep['successor_id'])}"
                if e.operation == "create":
                    lines.append(f"Added dependency {pair}")
                elif e.operation == "delete":
                    lines.append(f"Removed dependency {pair}")
        apply_event(state, e)
    return lines


# --- The file ---------------------------------------------------------------------------


def build_markdown(
    session: Session,
    project_id: str,
    *,
    today: str | None = None,
    include_history: bool = True,
    include_notes: bool = True,
    include_closed: bool = True,
) -> str:
    project = require_project(session, project_id)
    today = today or date.today().isoformat()
    version = version_service.current_version(session, project_id)
    plan = serialize_state(projection_service.load_state(session, project_id))
    deliverables = {d["id"]: d for d in plan["deliverables"]}
    workstreams = {w["id"]: w for w in plan["workstreams"]}
    baselines = project_service.list_baselines(session, project_id)
    meetings = meeting_service.list_meetings(session, project_id)
    people = people_service.list_people(session, project_id)
    register = meeting_service.list_items(session, project_id)
    meeting_by_commit = {
        seq: f"{title} {held_on}"
        for seq, title, held_on in session.execute(
            select(Commit.seq_no, Meeting.title, Meeting.held_on).join(Meeting, Meeting.commit_id == Commit.id).where(Meeting.project_id == project_id)
        )
    }

    def dname(did: str) -> str:
        return deliverables[did]["name"] if did in deliverables else f"(removed: {did})"

    out: list[str] = []
    add = out.append

    add(f"# {project.name}: project knowledge base")
    add("")
    add(f"Exported from Backstroke on {today}. Plan version #{version}.")
    if project.description:
        add("")
        add(project.description)
    add("")
    add("## How to read this file")
    add("")
    add("- Dates are ISO (YYYY-MM-DD). End dates are inclusive.")
    add("- Deliverables sit in workstreams. A milestone has one date. Some deliverables are split into phases that run in order.")
    add("- Every change to the plan is a numbered commit with a reason. Commit #1 is the original plan. Commits are never edited.")
    add(f"- Status is as of {today}. \"Behind\" means a phase has passed its end date while the deliverable's own end is still ahead.")
    add("- Register IDs: A = action, R = risk, D = decision. A decision is never edited; a later decision supersedes it.")
    add("- An action or risk with no deliverable is programme-level.")
    add("- This file is the record. If it doesn't answer a question, say so rather than guessing.")
    add("")

    # Summary
    statuses = {did: deliverable_status(d, today) for did, d in deliverables.items()}
    counts: dict[str, int] = {}
    for s in statuses.values():
        if s:
            counts[s["kind"]] = counts.get(s["kind"], 0) + 1
    open_actions = [i for i in register if i["kind"] == "action" and i["open"]]
    overdue = [i for i in open_actions if i["due_on"] and i["due_on"] < today]
    milestones = sorted((d for d in deliverables.values() if d["type"] == "milestone"), key=lambda d: d["start_date"])
    upcoming = [m for m in milestones if m["start_date"] >= today]
    add("## Summary")
    add("")
    add(f"- {len(deliverables)} deliverables in {len(workstreams)} workstreams: " + ", ".join(
        f"{counts[k]} {label}" for k, label in [("done", "done"), ("progress", "in progress"), ("behind", "behind"), ("overdue", "overdue"), ("todo", "not started")] if counts.get(k)
    ) + ".")
    if upcoming:
        add("- Next milestones: " + ", ".join(f"{m['name']} {m['start_date']}" for m in upcoming[:4]) + ".")
    open_risks = sum(1 for i in register if i["kind"] == "risk" and i["open"])
    active = sum(1 for i in register if i["kind"] == "decision" and i["open"])
    add(f"- Register: {plural(len(open_actions), 'open action')} ({len(overdue)} overdue), {plural(open_risks, 'open risk')}, {plural(active, 'active decision')}.")
    if meetings:
        add(f"- {plural(len(meetings), 'meeting')} recorded; the latest is {meetings[0]['title']} on {meetings[0]['held_on']}.")
    add("")

    # Plan
    add(f"## Current plan (version #{version})")
    for w in plan["workstreams"]:
        rows = [d for d in plan["deliverables"] if d["workstream_id"] == w["id"]]
        add("")
        add(f"### {w['name']}")
        add("")
        if not rows:
            add("No deliverables.")
            continue
        add("| Deliverable | Start | End | Status | Phases |")
        add("|---|---|---|---|---|")
        for d in rows:
            s = statuses[d["id"]]
            phases = "; ".join(
                f"{sp['name']} {sp['start_date']} to {sp['end_date']}" + (f" (done {p['finished_on']})" if p.get("finished_on") else "")
                for sp, p in zip(phase_spans(d), d.get("phases") or [])
            )
            if d["type"] == "milestone":
                add(f"| {cell(d['name'])} (milestone) | {d['start_date']} | | | |")
            else:
                add(f"| {cell(d['name'])} | {d['start_date']} | {d['end_date']} | {cell(status_label(s))} | {cell(phases)} |")
    add("")
    add("## Dependencies")
    add("")
    if plan["dependencies"]:
        for dep in plan["dependencies"]:
            succ = deliverables.get(dep["successor_id"])
            when = "is due" if succ and succ["type"] == "milestone" else "starts"
            add(f"- {dname(dep['predecessor_id'])} must finish before {dname(dep['successor_id'])} {when}")
    else:
        add("None.")
    add("")

    if baselines:
        add("## Baselines")
        add("")
        for b in baselines:
            add(f"- {b['name']}: version #{b['version']}, saved {b['created_at'][:10]}")
        add("")

    if include_history:
        add("## Change history")
        add("")
        add("Oldest first. Progress commits record work marked done or reopened; they don't move the plan.")
        commits = history_service.list_commits(session, project_id, include_events=True)
        states = version_service.states_through(session, project_id, version)
        for c in commits:
            add("")
            category = CATEGORY_LABELS.get(c["category"], c["category"]) if c["category"] else None
            add(f"### #{c['seq']} · {c['created_at'][:10]}" + (f" · {category}" if category else "") + f" · {c['author']}")
            add(f"Reason: {c['reason']}")
            if c["seq"] in meeting_by_commit:
                add(f"Agreed at: {meeting_by_commit[c['seq']]}")
            elif c["reference"]:
                add(f"Reference: {c['reference']}")
            if c["baselines"]:
                add(f"Baseline: {', '.join(c['baselines'])}")
            events = [Event(e["entity_type"], e["entity_id"], e["operation"], e["field_name"], e["old_value"], e["new_value"]) for e in c["events"]]
            for line in describe_events(states.get(c["seq"] - 1, empty_state()), events):
                add(f"- {line}")
        add("")

    if people:
        add("## People")
        add("")
        teams: dict[str, list[str]] = {}
        for person in people:
            teams.setdefault(person["group"] or "", []).append(person["name"])
        for team, names in sorted(teams.items(), key=lambda t: (t[0] == "", t[0].lower())):
            add(f"- {team or 'No group'}: {', '.join(names)}")
        add("")

    add("## Meetings")
    add("")
    if not meetings:
        add("None recorded.")
        add("")
    for m in meetings:
        add(f"### {m['title']} · {m['held_on']}")
        present = [a["name"] for a in m["attendees"] if a["present"]]
        absent = [a["name"] for a in m["attendees"] if not a["present"]]
        if present:
            add(f"Present: {', '.join(present)}")
        if absent:
            add(f"Absent: {', '.join(absent)}")
        if not m["finished_at"]:
            add("Status: in progress. Its items are not in the register yet.")
        if m["commit_seq"] is not None:
            add(f"Plan commit: #{m['commit_seq']}")
        if m["items"]:
            add("Recorded: " + ", ".join(f"{i['ref']} ({i['kind']})" for i in m["items"]))
        if include_notes and m["notes"].strip():
            add("Notes:")
            add("")
            for line in m["notes"].strip().splitlines():
                add(f"> {line}" if line.strip() else ">")
        add("")

    add("## Register")
    for kind, title in [("action", "Actions"), ("risk", "Risks"), ("decision", "Decisions")]:
        items = [i for i in register if i["kind"] == kind and (include_closed or i["open"])]
        items.sort(key=lambda i: (not i["open"], i["id"]))
        add("")
        add(f"### {title}")
        add("")
        if not items:
            add("None.")
            continue
        due_col = kind == "action"
        add("| ID | Item | Owner | Deliverables | Raised at |" + (" Due |" if due_col else "") + " Status |")
        add("|---|---|---|---|---|" + ("---|" if due_col else "") + "---|")
        for i in items:
            where = f"{i['meeting']['title']} {i['meeting']['held_on']}" if i["meeting"] else f"register {i['created_at'][:10]}"
            if i["status"] == "superseded":
                status = f"superseded by {i['superseded_by']}"
            elif not i["open"]:
                status = f"{i['status']} {i['closed_on'] or ''}".strip()
            elif due_col and i["due_on"] and i["due_on"] < today:
                status = "open, overdue"
            else:
                status = STATUSES[kind][0]
            add(
                f"| {i['ref']} | {cell(i['text'])} | {cell(i['owner'] or '')} | "
                f"{cell(', '.join(dname(x) for x in i['deliverable_ids']) or 'programme')} | {cell(where)} |"
                + (f" {i['due_on'] or ''} |" if due_col else "")
                + f" {status} |"
            )
    add("")
    return "\n".join(out)
