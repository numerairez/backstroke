import os
import tempfile

# Keep the module-level app in app.main away from the developer database.
os.environ.setdefault("TRACKER_DB_URL", f"sqlite:///{tempfile.mkdtemp()}/import.db")
os.environ.setdefault("TRACKER_SEED", "0")

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.seed import PROJECT_ID


@pytest.fixture
def app(tmp_path):
    return create_app(f"sqlite:///{tmp_path / 'test.db'}", seed=True)


PASSWORD = "correct horse"


def sign_up(client, username, password=PASSWORD, expect=201, **first):
    """Register by username (seeded people's usernames are their names in lower case). `first` takes the first account's name and email."""
    res = client.post("/api/auth/register", json={"username": username, "password": password, **first})
    assert res.status_code == expect, res.json()
    return res.json()


@pytest.fixture
def client(app):
    """Signed in as Priya, the first account and so an admin."""
    with TestClient(app) as c:
        sign_up(c, "priya")
        yield c


@pytest.fixture
def session(app):
    with app.state.sessionmaker() as s:
        yield s


@pytest.fixture
def pid():
    return PROJECT_ID


def commit(client, pid, changes, reason="test change", base=None, category=None, expect=201):
    if base is None:
        base = client.get(f"/api/projects/{pid}/state").json()["version"]
    res = client.post(
        f"/api/projects/{pid}/commits",
        json={"reason": reason, "author": "tester", "base_version": base, "category": category, "changes": changes},
    )
    assert res.status_code == expect, res.json()
    return res.json()


def move(entity_id, **fields):
    return {"entity_type": "deliverable", "entity_id": entity_id, "operation": "update", "fields": fields}
