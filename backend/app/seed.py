"""Example projects with a short, realistic history.

Example Program: the Appendix A scenario (Data Mapping slipping a week) is left for
you to perform live: drag Data Mapping +7d and the UI will offer the downstream moves.
It also has three finished meetings whose actions, risks and decisions fill the register.

Checkout Revamp: Jira-style tickets broken into Dev / Review / UAT phases, mixed with
plain deliverables, and a history in which the phases move.

    python -m app.seed          # seed if the database has no projects
    python -m app.seed --reset  # delete the database file and reseed
"""

from __future__ import annotations

import sys

from sqlalchemy import select
from sqlalchemy.orm import Session

from .domain.commands import Change
from .domain.meetings import Attendee, FinishMeetingRequest, ItemInput, ItemUpdateRequest, PersonInput
from .domain.models import Commit, Project
from .services import commit_service, meeting_service, people_service, project_service

PROJECT_ID = "example-program"
AUTHOR = "Priya (PMO)"


def ws(id: str, name: str, order: int) -> Change:
    return Change(entity_type="workstream", entity_id=id, operation="create", fields={"name": name, "order_index": order})


def task(id: str, lane: str, name: str, start: str, end: str, type: str = "task", phases: list[dict] | None = None) -> Change:
    fields = {"workstream_id": lane, "name": name, "type": type, "start_date": start, "end_date": end}
    if phases:
        fields["phases"] = phases
    return Change(entity_type="deliverable", entity_id=id, operation="create", fields=fields)


def dev_review_uat(dev: int, review: int) -> list[dict]:
    return [{"name": "Dev", "days": dev}, {"name": "Review", "days": review}, {"name": "UAT"}]


def milestone(id: str, lane: str, name: str, on: str) -> Change:
    return task(id, lane, name, on, on, type="milestone")


def dep(id: str, pred: str, succ: str) -> Change:
    return Change(entity_type="dependency", entity_id=id, operation="create", fields={"predecessor_id": pred, "successor_id": succ})


def move(id: str, **fields) -> Change:
    return Change(entity_type="deliverable", entity_id=id, operation="update", fields=fields)


HISTORY = [
    dict(
        created_at="2026-08-24T09:30:00Z",
        category="other",
        reference="Kickoff 2026-08-24",
        reason="Initial plan agreed at programme kickoff",
        changes=[
            ws("data", "Data", 0),
            ws("ai", "AI", 1),
            ws("ui", "UI", 2),
            ws("testing", "Testing", 3),
            task("data-model", "data", "Data Model", "2026-09-07", "2026-09-25"),
            task("data-mapping", "data", "Data Mapping", "2026-09-28", "2026-10-09"),
            milestone("data-ready", "data", "Data Ready", "2026-10-09"),
            task("agent-build", "ai", "Agent Build", "2026-09-14", "2026-10-09"),
            task("prototype", "ui", "Prototype", "2026-09-07", "2026-09-25"),
            task("prod-ui", "ui", "Prod UI", "2026-10-05", "2026-10-23"),
            task("uat", "testing", "UAT", "2026-10-12", "2026-10-16"),
            milestone("go-live", "testing", "Go-Live", "2026-10-30"),
            dep("d1", "data-model", "data-mapping"),
            dep("d2", "data-mapping", "data-ready"),
            dep("d3", "data-ready", "uat"),
            dep("d4", "agent-build", "uat"),
            dep("d5", "prototype", "prod-ui"),
            dep("d6", "uat", "go-live"),
            dep("d7", "prod-ui", "go-live"),
        ],
    ),
    dict(
        created_at="2026-09-02T14:05:00Z",
        category="risk",
        reference="InfoSec review request #218",
        reason="Inserted a security review ahead of UAT at InfoSec's request",
        changes=[
            task("security-review", "testing", "Security Review", "2026-10-05", "2026-10-09"),
            dep("d8", "security-review", "uat"),
        ],
    ),
    dict(
        created_at="2026-09-10T11:20:00Z",
        category="estimate",
        reason="Prototype finished a week early by reusing the design-system shell; Prod UI can start sooner",
        changes=[
            move("prototype", end_date="2026-09-18"),
            move("prod-ui", start_date="2026-09-28"),
        ],
    ),
    dict(
        created_at="2026-09-16T16:45:00Z",
        category="resource",
        reason="Prod UI extended: front-end lead on leave for a week",
        changes=[move("prod-ui", end_date="2026-10-28")],
    ),
    dict(
        created_at="2026-09-24T10:10:00Z",
        category="scope",
        reference="Steering committee 2026-09-24",
        reason="Agent Build scope expanded to include the escalation tool; start pulled forward to hold the UAT date",
        changes=[move("agent-build", end_date="2026-10-09", start_date="2026-09-10")],
    ),
]

CHECKOUT_ID = "checkout-revamp"
CHECKOUT_AUTHOR = "Sam (Delivery lead)"

CHECKOUT_HISTORY = [
    dict(
        created_at="2026-09-01T09:00:00Z",
        category="other",
        reference="Sprint planning 2026-09-01",
        reason="Initial plan: Jira tickets broken into Dev, Review and UAT; vendor and design work tracked as plain deliverables",
        changes=[
            ws("pay", "Payments", 0),
            ws("acct", "Accounts", 1),
            ws("web", "Web", 2),
            task("vendor", "pay", "Vendor contract", "2026-08-24", "2026-09-04"),
            task("pay-142", "pay", "PAY-142 Card vault migration", "2026-09-07", "2026-10-02", phases=dev_review_uat(11, 5)),
            task("pay-151", "pay", "PAY-151 Refund rules engine", "2026-09-21", "2026-10-16", phases=dev_review_uat(14, 3)),
            milestone("pay-ready", "pay", "Payments ready", "2026-10-16"),
            task("security", "acct", "Security review", "2026-09-14", "2026-09-25"),
            task("acc-88", "acct", "ACC-88 Login with passkeys", "2026-09-14", "2026-10-16", phases=dev_review_uat(13, 5)),
            task("acc-93", "acct", "ACC-93 Account deletion flow", "2026-09-28", "2026-10-20", phases=dev_review_uat(12, 4)),
            task("prototype", "web", "Checkout prototype", "2026-08-31", "2026-09-04"),
            task("web-204", "web", "WEB-204 Checkout page", "2026-09-07", "2026-10-06", phases=dev_review_uat(19, 4)),
            task("web-219", "web", "WEB-219 Order history", "2026-10-05", "2026-10-30"),
            milestone("go-live", "web", "Go-Live", "2026-10-30"),
            dep("c1", "vendor", "pay-142"),
            dep("c2", "pay-151", "pay-ready"),
            dep("c3", "prototype", "web-204"),
            dep("c4", "pay-ready", "go-live"),
            dep("c5", "acc-93", "go-live"),
            dep("c6", "web-219", "go-live"),
        ],
    ),
    dict(
        created_at="2026-09-18T15:30:00Z",
        category="estimate",
        reference="PAY-142",
        reason="Vault API rate limits needed a batching layer: Dev +5d. UAT compressed by 2d to limit the slip",
        changes=[move("pay-142", end_date="2026-10-06", phases=dev_review_uat(16, 6))],
    ),
    dict(
        created_at="2026-09-22T10:00:00Z",
        category="dependency",
        reference="PAY-151",
        reason="Refund rules reuse the new vault batching layer, so PAY-151 Dev waits a week for PAY-142",
        changes=[
            move("pay-151", end_date="2026-10-23", phases=dev_review_uat(21, 3)),
            move("pay-ready", start_date="2026-10-23", end_date="2026-10-23"),
        ],
    ),
    dict(
        created_at="2026-09-25T14:10:00Z",
        category="approval",
        reference="A11y review WEB-204",
        reason="Accessibility sign-off added a day to Review; UAT extended to retest the fixes",
        changes=[move("web-204", end_date="2026-10-09", phases=dev_review_uat(19, 5))],
    ),
    dict(
        created_at="2026-09-29T11:45:00Z",
        category="scope",
        reference="WEB-219",
        reason="Order history gained a CSV export; broken into phases so the extra Dev and UAT are visible",
        changes=[move("web-219", phases=dev_review_uat(16, 3))],
    ),
    dict(
        created_at="2026-09-30T09:20:00Z",
        category="resource",
        reference="ACC-93",
        reason="Reviewers are on release duty for two days, so ACC-93 Review starts two days after Dev ends",
        changes=[
            move(
                "acc-93",
                end_date="2026-10-22",
                phases=[{"name": "Dev", "days": 12}, {"name": "Review", "days": 4, "gap": 2}, {"name": "UAT"}],
            )
        ],
    ),
]

# Status updates recorded with Mark done: (recorded at, deliverable, phase index or None, finished on).
CHECKOUT_PROGRESS = [
    ("2026-09-30T10:00:00Z", "vendor", None, "2026-09-03"),
    ("2026-09-30T10:01:00Z", "prototype", None, "2026-09-09"),
    ("2026-09-30T10:02:00Z", "pay-142", 0, "2026-09-23"),
    ("2026-09-30T10:03:00Z", "pay-142", 1, "2026-09-29"),
    ("2026-09-30T10:04:00Z", "web-204", 0, "2026-09-25"),
]


PEOPLE = ["Priya", "Dana", "Ravi", "Marco", "Jo", "Lena"]
# The Checkout Revamp team.
CHECKOUT_PEOPLE = [("Sam", ["Delivery"]), ("Noor", ["Engineering"]), ("Theo", ["Engineering"]), ("Mei", ["QA"])]
GROUPS = {"Priya": ["PMO", "Steering"], "Dana": ["Business", "Steering"], "Ravi": ["Data"], "Marco": ["AI agent"], "Jo": ["AI agent"], "Lena": ["Business"]}

# Meetings for the example program: (title, date, finished at, absent, notes, items, linked commit, items done later).
MEETINGS = [
    (
        "Kickoff",
        "2026-08-24",
        "2026-08-24T09:30:00Z",
        [],
        "Scope: data platform plus the customer service agent; Prod UI follows the prototype.\n"
        "=decision Plan baselined with @[Go-Live] on 30 Oct\n",
        [dict(kind="decision", text="Plan baselined with Go-Live on 30 Oct", deliverable_ids=["go-live"])],
        1,
        [],
    ),
    (
        "Steering committee",
        "2026-09-10",
        "2026-09-10T15:00:00Z",
        ["Lena"],
        "Prototype is ahead of plan; Jo expects to finish next week.\n"
        "?risk @Ravi vendor feed schema may change late in the build, which would hit @[Data Mapping]\n",
        [dict(kind="risk", text="Vendor feed schema may change late in the build, which would hit Data Mapping", owner="Ravi", deliverable_ids=["data-mapping"])],
        None,
        [],
    ),
    (
        "Steering committee",
        "2026-09-24",
        "2026-09-24T10:10:00Z",
        [],
        "Marco: the escalation tool belongs in @[Agent Build]; without it UAT can't test handover.\n"
        "=decision Expand @[Agent Build] to include the escalation tool and pull its start forward to hold UAT\n"
        "?risk @Marco escalation tool scope could keep growing\n"
        "!action @Ravi get the vendor to confirm feed schema v3 by 2 Oct\n"
        "!action @Marco name an owner for the escalation tool API by 1 Oct\n",
        [
            dict(kind="decision", text="Expand Agent Build to include the escalation tool and pull its start forward to hold UAT", deliverable_ids=["agent-build"]),
            dict(kind="risk", text="Escalation tool scope could keep growing", owner="Marco", deliverable_ids=["agent-build"]),
            dict(kind="action", text="Get the vendor to confirm feed schema v3 by 2 Oct", owner="Ravi", due_on="2026-10-02", deliverable_ids=["data-mapping"]),
            dict(kind="action", text="Name an owner for the escalation tool API by 1 Oct", owner="Marco", due_on="2026-10-01", deliverable_ids=["agent-build"]),
        ],
        5,
        [("A-2", "2026-09-30")],
    ),
]


def seed_people(session: Session) -> None:
    """One organisation list, each with a username (their name in lower case). Projects take groups; the PMO (Priya) works on both."""
    people_service.replace_org(
        session,
        [PersonInput(name=n, groups=g, username=n.lower(), email=f"{n.lower()}@example.com") for n, g in [(n, GROUPS[n]) for n in PEOPLE] + CHECKOUT_PEOPLE],
        projects_by_group={
            **{g: [PROJECT_ID] for g in ("Steering", "Business", "Data", "AI agent")},
            "PMO": [PROJECT_ID, CHECKOUT_ID],
            **{g: [CHECKOUT_ID] for g in ("Delivery", "Engineering", "QA")},
        },
    )


def seed_meetings(session: Session) -> None:
    for title, held_on, finished_at, absent, notes, items, seq, done in MEETINGS:
        attendees = [Attendee(name=n, present=n not in absent) for n in PEOPLE]
        meeting = meeting_service.create_meeting(session, PROJECT_ID, title, held_on, attendees, notes=notes, created_at=finished_at)
        meeting_service.finish_meeting(
            session, PROJECT_ID, meeting.id, FinishMeetingRequest(author=AUTHOR, items=[ItemInput(**i) for i in items]), finished_at=finished_at
        )
        if seq is not None:
            # The seeded history already holds the meeting's commit; link it.
            meeting.commit_id = session.scalar(select(Commit.id).where(Commit.project_id == PROJECT_ID, Commit.seq_no == seq))
            meeting.plan_version = seq
        for ref, closed_on in done:
            item = next(i for i in meeting_service.list_items(session, PROJECT_ID) if i["ref"] == ref)
            meeting_service.update_item(session, PROJECT_ID, item["id"], ItemUpdateRequest(outcome="done", closed_on=closed_on, author=AUTHOR))
    session.flush()


def seed(session: Session) -> bool:
    if session.scalar(select(Project).limit(1)) is not None:
        return False
    project_service.create_project(
        session,
        "Example Program",
        "Data platform + AI agent rollout. Seeded example with a short planning history.",
        project_id=PROJECT_ID,
        created_at="2026-08-24T09:00:00Z",
    )
    for version, commit in enumerate(HISTORY):
        commit_service.create_commit(session, PROJECT_ID, author=AUTHOR, base_version=version, **commit)
        if version == 0:
            project_service.create_baseline(session, PROJECT_ID, "v1.0 Kickoff baseline", 1, created_at="2026-08-24T10:00:00Z")
    seed_meetings(session)

    project_service.create_project(
        session,
        "Checkout Revamp",
        "Jira tickets with Dev / Review / UAT phases alongside plain deliverables.",
        project_id=CHECKOUT_ID,
        created_at="2026-09-01T08:30:00Z",
    )
    for version, commit in enumerate(CHECKOUT_HISTORY):
        commit_service.create_commit(session, CHECKOUT_ID, author=CHECKOUT_AUTHOR, base_version=version, **commit)
        if version == 0:
            project_service.create_baseline(session, CHECKOUT_ID, "Sprint plan", 1, created_at="2026-09-01T09:05:00Z")
    for offset, (created_at, deliverable_id, phase, finished_on) in enumerate(CHECKOUT_PROGRESS):
        commit_service.record_progress(
            session,
            CHECKOUT_ID,
            author=CHECKOUT_AUTHOR,
            base_version=len(CHECKOUT_HISTORY) + offset,
            deliverable_id=deliverable_id,
            phase=phase,
            finished_on=finished_on,
            created_at=created_at,
        )
    seed_people(session)
    return True


def main() -> None:
    from .persistence.db import DEFAULT_DB_PATH, database_url, init_db, make_engine, make_sessionmaker

    if "--reset" in sys.argv and database_url().endswith(str(DEFAULT_DB_PATH)):
        for suffix in ("", "-wal", "-shm"):
            path = DEFAULT_DB_PATH.with_name(DEFAULT_DB_PATH.name + suffix)
            path.unlink(missing_ok=True)
    engine = make_engine(database_url())
    init_db(engine)
    with make_sessionmaker(engine)() as session, session.begin():
        print("Seeded example project." if seed(session) else "Database already has projects; nothing to do.")


if __name__ == "__main__":
    main()
