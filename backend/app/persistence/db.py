from __future__ import annotations

import os
from pathlib import Path

from sqlalchemy import Engine, create_engine, event, text
from sqlalchemy.orm import DeclarativeBase, sessionmaker

DEFAULT_DB_PATH = Path(__file__).resolve().parents[2] / "tracker.db"


class Base(DeclarativeBase):
    pass


# History is append-only (AC-03): the database itself refuses edits to commits and events.
APPEND_ONLY_TRIGGERS = [
    f"""CREATE TRIGGER IF NOT EXISTS {table}_no_{op.lower()}
        BEFORE {op} ON {table}
        BEGIN SELECT RAISE(ABORT, '{table} are append-only'); END"""
    for table in ("commits", "events")
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
        for ddl in APPEND_ONLY_TRIGGERS:
            conn.execute(text(ddl))


def make_sessionmaker(engine: Engine) -> sessionmaker:
    return sessionmaker(bind=engine, expire_on_commit=False)
