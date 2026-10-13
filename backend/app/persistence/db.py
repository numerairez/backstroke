from __future__ import annotations

import json
import os
import re
from pathlib import Path

from sqlalchemy import Engine, create_engine, event, text
from sqlalchemy.orm import DeclarativeBase, sessionmaker

DEFAULT_DB_PATH = Path(__file__).resolve().parents[2] / "tracker.db"


class Base(DeclarativeBase):
    pass


# History is append-only (AC-03): the database itself refuses edits to commits and events,
# and to the register's item history.
APPEND_ONLY_TRIGGERS = [
    f"""CREATE TRIGGER IF NOT EXISTS {table}_no_{op.lower()}
        BEFORE {op} ON {table}
        BEGIN SELECT RAISE(ABORT, '{table} are append-only'); END"""
    for table in ("commits", "events", "register_events")
    for op in ("UPDATE", "DELETE")
]


def database_url() -> str:
    return os.environ.get("TRACKER_DB_URL", f"sqlite:///{DEFAULT_DB_PATH}")


def make_engine(url: str) -> Engine:
    engine = create_engine(url, connect_args={"check_same_thread": False, "timeout": 15})

    @event.listens_for(engine, "connect")
    def _on_connect(dbapi_connection, _record):
        # Take over transaction control from pysqlite so BEGIN IMMEDIATE below is honoured.
        dbapi_connection.isolation_level = None
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.execute("PRAGMA journal_mode=WAL")
        cursor.close()

    @event.listens_for(engine, "begin")
    def _on_begin(connection):
        # Serialize writers so the base-version check and the new commit are atomic.
        connection.exec_driver_sql("BEGIN IMMEDIATE")

    return engine


def init_db(engine: Engine) -> None:
    from ..domain import models  # noqa: F401  (register tables)

    Base.metadata.create_all(engine)
    with engine.begin() as conn:
        # Databases from before phases, progress and JIRA links need the projection columns added.
        columns = {row[1] for row in conn.exec_driver_sql("PRAGMA table_info(project_deliverable_state)")}
        if "phases" not in columns:
            conn.exec_driver_sql("ALTER TABLE project_deliverable_state ADD COLUMN phases JSON")
        if "finished_on" not in columns:
            conn.exec_driver_sql("ALTER TABLE project_deliverable_state ADD COLUMN finished_on VARCHAR")
        if "jira_url" not in columns:
            conn.exec_driver_sql("ALTER TABLE project_deliverable_state ADD COLUMN jira_url VARCHAR")
        _move_people_to_the_organisation(conn)
        _members_to_teams(conn)
        _sign_in_by_username(conn)
        # Display settings kept outside the plan's history.
        columns = {row[1] for row in conn.exec_driver_sql("PRAGMA table_info(projects)")}
        for column in ("lane_order", "row_order"):
            if column not in columns:
                conn.exec_driver_sql(f"ALTER TABLE projects ADD COLUMN {column} JSON")
        # Databases from before closure reasons: actions closed as "done", decisions superseded.
        columns = {row[1] for row in conn.exec_driver_sql("PRAGMA table_info(register_items)")}
        if "outcome" not in columns:
            conn.exec_driver_sql("ALTER TABLE register_items ADD COLUMN outcome VARCHAR")
            conn.exec_driver_sql("UPDATE register_items SET status = 'closed', outcome = 'done' WHERE kind = 'action' AND status = 'done'")
            conn.exec_driver_sql("UPDATE register_items SET outcome = 'superseded' WHERE kind = 'decision' AND status = 'superseded'")
        # Decisions close like everything else; superseded or withdrawn is their outcome.
        conn.exec_driver_sql("UPDATE register_items SET status = 'closed' WHERE kind = 'decision' AND status = 'superseded'")
        _backfill_register_history(conn)
        for ddl in APPEND_ONLY_TRIGGERS:
            conn.execute(text(ddl))


def _move_people_to_the_organisation(conn) -> None:
    """Databases from when each project kept its own people and groups.

    Everyone moves into one organisation list, merged by name ignoring case (the first spelling
    wins and their groups are combined), and stays a member of the projects they were listed on.
    Groups merge the same way. The old per-project tables are then dropped.
    """
    tables = {row[0] for row in conn.exec_driver_sql("SELECT name FROM sqlite_master WHERE type = 'table'")}
    if "project_people" not in tables:
        return
    columns = {row[1] for row in conn.exec_driver_sql("PRAGMA table_info(project_people)")}
    groups_sql = "groups" if "groups" in columns else """json_array("group")""" if "group" in columns else "'[]'"
    rows = conn.exec_driver_sql(
        f"""SELECT pp.project_id, pp.name, {groups_sql} FROM project_people pp JOIN projects p ON p.id = pp.project_id
            ORDER BY p.created_at, p.name, pp.position"""
    ).all()
    listed_groups = (
        conn.exec_driver_sql(
            "SELECT g.name FROM project_groups g JOIN projects p ON p.id = g.project_id ORDER BY p.created_at, p.name, g.position"
        ).all()
        if "project_groups" in tables
        else []
    )

    groups: dict[str, str] = {}  # lower name -> spelling, in order
    for (name,) in listed_groups:
        if name and name.strip():
            groups.setdefault(name.strip().lower(), name.strip())
    people: dict[str, dict] = {}
    for project_id, name, raw_groups in rows:
        if not name or not name.strip():
            continue
        person = people.setdefault(name.strip().lower(), {"name": name.strip(), "groups": [], "projects": []})
        for g in json.loads(raw_groups or "[]"):
            if g and g.strip():
                spelling = groups.setdefault(g.strip().lower(), g.strip())
                if spelling not in person["groups"]:
                    person["groups"].append(spelling)
        if project_id not in person["projects"]:
            person["projects"].append(project_id)

    # Who was on which project is turned into groups by _members_to_teams.
    conn.exec_driver_sql("CREATE TABLE IF NOT EXISTS project_members (project_id VARCHAR, person_id INTEGER, PRIMARY KEY (project_id, person_id))")
    existing = {name.lower(): pid for pid, name in conn.exec_driver_sql("SELECT id, name FROM people")}
    position = conn.exec_driver_sql("SELECT COALESCE(MAX(position) + 1, 0) FROM people").scalar()
    for key, person in people.items():
        if key not in existing:
            conn.exec_driver_sql("INSERT INTO people (name, groups, position) VALUES (?, ?, ?)", (person["name"], json.dumps(person["groups"]), position))
            position += 1
            existing[key] = conn.exec_driver_sql("SELECT last_insert_rowid()").scalar()
        for project_id in person["projects"]:
            conn.exec_driver_sql("INSERT OR IGNORE INTO project_members (project_id, person_id) VALUES (?, ?)", (project_id, existing[key]))
    known = {name.lower() for (name,) in conn.exec_driver_sql("SELECT name FROM person_groups")}
    position = conn.exec_driver_sql("SELECT COALESCE(MAX(position) + 1, 0) FROM person_groups").scalar()
    for key, name in groups.items():
        if key not in known:
            conn.exec_driver_sql("INSERT INTO person_groups (name, position) VALUES (?, ?)", (name, position))
            position += 1
    conn.exec_driver_sql("DROP TABLE project_people")
    if "project_groups" in tables:
        conn.exec_driver_sql("DROP TABLE project_groups")


def _members_to_teams(conn) -> None:
    """Databases from when people were put on projects one by one: projects now take groups.

    Each project's members become a group named after it ("Example Program team"), which the
    project takes, so everyone stays on the projects they were on.
    """
    tables = {row[0] for row in conn.exec_driver_sql("SELECT name FROM sqlite_master WHERE type = 'table'")}
    if "project_members" not in tables:
        return
    rows = conn.exec_driver_sql(
        """SELECT p.id, p.name, m.person_id FROM project_members m JOIN projects p ON p.id = m.project_id
           JOIN people pe ON pe.id = m.person_id ORDER BY p.created_at, p.name, pe.position"""
    ).all()
    taken = {name.lower() for (name,) in conn.exec_driver_sql("SELECT name FROM person_groups UNION SELECT name FROM people")}
    position = conn.exec_driver_sql("SELECT COALESCE(MAX(position) + 1, 0) FROM person_groups").scalar()
    teams: dict[str, tuple[str, list[int]]] = {}
    for project_id, project_name, person_id in rows:
        teams.setdefault(project_id, (project_name, []))[1].append(person_id)
    for project_id, (project_name, person_ids) in teams.items():
        name, n = f"{project_name} team", 2
        while name.lower() in taken:
            name, n = f"{project_name} team {n}", n + 1
        taken.add(name.lower())
        conn.exec_driver_sql("INSERT INTO person_groups (name, position) VALUES (?, ?)", (name, position))
        position += 1
        group_id = conn.exec_driver_sql("SELECT last_insert_rowid()").scalar()
        conn.exec_driver_sql("INSERT INTO project_teams (project_id, group_id) VALUES (?, ?)", (project_id, group_id))
        for person_id in person_ids:
            groups = json.loads(conn.exec_driver_sql("SELECT groups FROM people WHERE id = ?", (person_id,)).scalar() or "[]")
            conn.exec_driver_sql("UPDATE people SET groups = ? WHERE id = ?", (json.dumps([*groups, name]), person_id))
    conn.exec_driver_sql("DROP TABLE project_members")


def _sign_in_by_username(conn) -> None:
    """Databases from when accounts signed in by email: people now carry a username and email.

    Each account's email moves to its person, and the part before the @ becomes their username
    (made unique), so everyone can still sign in. Sign-in sessions survive the move.
    """
    columns = {row[1] for row in conn.exec_driver_sql("PRAGMA table_info(people)")}
    if "username" not in columns:
        conn.exec_driver_sql("ALTER TABLE people ADD COLUMN username VARCHAR")
        conn.exec_driver_sql("ALTER TABLE people ADD COLUMN email VARCHAR")
        conn.exec_driver_sql("CREATE UNIQUE INDEX IF NOT EXISTS ix_people_username ON people (username)")
        conn.exec_driver_sql("CREATE UNIQUE INDEX IF NOT EXISTS ix_people_email ON people (email)")
    if "email" not in {row[1] for row in conn.exec_driver_sql("PRAGMA table_info(accounts)")}:
        return
    taken = {u for (u,) in conn.exec_driver_sql("SELECT username FROM people WHERE username IS NOT NULL")}
    for person_id, email in conn.exec_driver_sql("SELECT person_id, email FROM accounts ORDER BY id").all():
        base = re.sub(r"[^a-z0-9._-]", "", email.split("@")[0].lower()) or "user"
        username, n = base, 2
        while username in taken:
            username, n = f"{base}{n}", n + 1
        taken.add(username)
        conn.exec_driver_sql("UPDATE people SET username = COALESCE(username, ?), email = COALESCE(email, ?) WHERE id = ?", (username, email, person_id))
    sessions = conn.exec_driver_sql("SELECT token_hash, account_id, created_at, expires_at FROM login_sessions").all()
    conn.exec_driver_sql(
        """CREATE TABLE accounts_new (
            id INTEGER NOT NULL, person_id INTEGER NOT NULL, password_hash VARCHAR NOT NULL, is_admin BOOLEAN NOT NULL, created_at VARCHAR NOT NULL,
            PRIMARY KEY (id), UNIQUE (person_id), FOREIGN KEY(person_id) REFERENCES people (id) ON DELETE CASCADE)"""
    )
    conn.exec_driver_sql("INSERT INTO accounts_new SELECT id, person_id, password_hash, is_admin, created_at FROM accounts")
    conn.exec_driver_sql("DROP TABLE accounts")  # cascades to login_sessions, put back below
    conn.exec_driver_sql("ALTER TABLE accounts_new RENAME TO accounts")
    for row in sessions:
        conn.exec_driver_sql("INSERT INTO login_sessions (token_hash, account_id, created_at, expires_at) VALUES (?, ?, ?, ?)", tuple(row))


def _backfill_register_history(conn) -> None:
    """Items from before item history get a "raised" event, and a "closed" one if they're closed."""
    rows = conn.exec_driver_sql(
        """SELECT r.id, r.project_id, r.kind, r.text, r.owner, r.due_on, r.deliverable_ids, r.meeting_id,
                  r.status, r.outcome, r.closed_on, r.created_at, r.updated_at, s.kind, s.number
           FROM register_items r LEFT JOIN register_items s ON s.id = r.superseded_by_id
           WHERE NOT EXISTS (SELECT 1 FROM register_events e WHERE e.item_id = r.id)"""
    ).all()
    from ..domain.meetings import STATUSES, item_ref

    insert = "INSERT INTO register_events (project_id, item_id, type, changes, meeting_id, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    for iid, pid, kind, text_, owner, due_on, deliverables, meeting_id, status, outcome, closed_on, created, updated, lkind, lnum in rows:
        open_status = STATUSES[kind][0]
        raised = {"text": [None, text_], "owner": [None, owner], "due_on": [None, due_on], "deliverable_ids": [None, json.loads(deliverables or "[]")], "status": [None, open_status]}
        conn.exec_driver_sql(insert, (pid, iid, "raised", json.dumps({k: v for k, v in raised.items() if v[1] not in (None, [])}), meeting_id, created))
        if status != open_status:
            closed = {"status": [open_status, status], "outcome": [None, outcome], "closed_on": [None, closed_on], "link": [None, item_ref(lkind, lnum) if lkind else None]}
            conn.exec_driver_sql(insert, (pid, iid, "closed", json.dumps({k: v for k, v in closed.items() if v[1] is not None}), None, updated))


def make_sessionmaker(engine: Engine) -> sessionmaker:
    return sessionmaker(bind=engine, expire_on_commit=False)
