"""Example project with a short, realistic history.

The Appendix A scenario (Data Mapping slipping a week) is left for you to
perform live: drag Data Mapping +7d and the UI will offer the downstream moves.

    python -m app.seed          # seed if the database has no projects
    python -m app.seed --reset  # delete the database file and reseed
"""

from __future__ import annotations

import sys

from sqlalchemy import select
from sqlalchemy.orm import Session

from .domain.commands import Change
from .domain.models import Project
from .services import commit_service, project_service

PROJECT_ID = "example-program"
AUTHOR = "Priya (PMO)"


def ws(id: str, name: str, order: int) -> Change:
    return Change(entity_type="workstream", entity_id=id, operation="create", fields={"name": name, "order_index": order})


def task(id: str, lane: str, name: str, start: str, end: str, type: str = "task") -> Change:
    return Change(
        entity_type="deliverable",
        entity_id=id,
        operation="create",
        fields={"workstream_id": lane, "name": name, "type": type, "start_date": start, "end_date": end},
    )


def milestone(id: str, lane: str, name: str, on: str) -> Change:
    return task(id, lane, name, on, on, type="milestone")


def dep(id: str, pred: str, succ: str) -> Change:
    return Change(entity_type="dependency", entity_id=id, operation="create", fields={"predecessor_id": pred, "successor_id": succ})


def move(id: str, **fields: str) -> Change:
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
