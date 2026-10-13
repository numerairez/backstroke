from __future__ import annotations

from typing import Iterator

from fastapi import Request
from sqlalchemy.orm import Session


def get_session(request: Request) -> Iterator[Session]:
    # Write routes commit explicitly before returning; anything uncommitted is rolled back on close.
    with request.app.state.sessionmaker() as session:
        yield session
