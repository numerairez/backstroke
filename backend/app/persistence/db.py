from __future__ import annotations

import json
import os
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
        # Databases from before phases and progress need the projection columns added.
        columns = {row[1] for row in conn.exec_driver_sql("PRAGMA table_info(project_deliverable_state)")}
        if "phases" not in columns:
            conn.exec_driver_sql("ALTER TABLE project_deliverable_state ADD COLUMN phases JSON")
        if "finished_on" not in columns:
            conn.exec_driver_sql("ALTER TABLE project_deliverable_state ADD COLUMN finished_on VARCHAR")
        # Databases from when a person had one group: move it into their list and the project's groups.
        columns = {row[1] for row in conn.exec_driver_sql("PRAGMA table_info(project_people)")}
        if "groups" not in columns:
            conn.exec_driver_sql("ALTER TABLE project_people ADD COLUMN groups JSON NOT NULL DEFAULT '[]'")
            if "group" in columns:
                conn.exec_driver_sql("""UPDATE project_people SET groups = json_array("group") WHERE "group" IS NOT NULL""")
                conn.exec_driver_sql(
                    """INSERT INTO project_groups (project_id, name, position)
                       SELECT project_id, "group", MIN(position) FROM project_people WHERE "group" IS NOT NULL GROUP BY project_id, "group" """
                )
        # Databases from before closure reasons: actions closed as "done", decisions superseded.
        columns = {row[1] for row in conn.exec_driver_sql("PRAGMA table_info(register_items)")}
        if "outcome" not in columns:
            conn.exec_driver_sql("ALTER TABLE register_items ADD COLUMN outcome VARCHAR")
            conn.exec_driver_sql("UPDATE register_items SET status = 'closed', outcome = 'done' WHERE kind = 'action' AND status = 'done'")
            conn.exec_driver_sql("UPDATE register_items SET outcome = 'superseded' WHERE kind = 'decision' AND status = 'superseded'")
        _backfill_register_history(conn)
        for ddl in APPEND_ONLY_TRIGGERS:
            conn.execute(text(ddl))


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
