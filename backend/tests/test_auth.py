"""Sign-in: only listed people register, the first account is an admin, and projects are hidden from non-members."""

import sqlite3

from fastapi.testclient import TestClient

from app.main import create_app
from app.seed import CHECKOUT_ID

from .conftest import PASSWORD, sign_up


def login(client, email, password=PASSWORD):
    return client.post("/api/auth/login", json={"email": email, "password": password})


def test_everything_needs_a_sign_in(app):
    with TestClient(app) as c:
        assert c.get("/api/projects").status_code == 401
        assert c.get("/api/projects/example-program/state").json()["code"] == "UNAUTHORIZED"
        assert c.get("/api/auth/me").json() == {"account": None, "needs_setup": True}


def test_the_first_account_is_an_admin_and_can_set_up_a_fresh_install(tmp_path):
    with TestClient(create_app(f"sqlite:///{tmp_path / 'fresh.db'}", seed=False)) as c:
        me = sign_up(c, "Kim")["account"]
        assert me["name"] == "Kim" and me["is_admin"] and me["email"] == "kim@example.com"
        assert [p["name"] for p in c.get("/api/people").json()["people"]] == ["Kim"]  # added to People
        assert c.get("/api/auth/me").json()["needs_setup"] is False


def test_only_listed_people_can_register(client, app):
    with TestClient(app) as other:
        res = sign_up(other, "Stranger", expect=422)
        assert res["errors"][0]["code"] == "not_listed"
        ravi = sign_up(other, "ravi", email=" Ravi@Example.com ")["account"]
        assert ravi["name"] == "Ravi" and not ravi["is_admin"] and ravi["email"] == "ravi@example.com"
    with TestClient(app) as again:
        assert sign_up(again, "Ravi", email="ravi2@example.com", expect=422)["errors"][0]["code"] == "already_registered"
        assert sign_up(again, "Dana", email="ravi@example.com", expect=422)["errors"][0]["code"] == "email_taken"
        assert sign_up(again, "Dana", password="short", expect=422)["errors"][0]["code"] == "password_too_short"
        assert sign_up(again, "Dana", email="not-an-email", expect=422)["errors"][0]["code"] == "invalid_email"


def test_sign_in_and_out(client, app):
    with TestClient(app) as c:
        assert login(c, "priya@example.com", "wrong password").json()["errors"][0]["code"] == "wrong_credentials"
        assert login(c, "nobody@example.com").json()["errors"][0]["code"] == "wrong_credentials"
        assert login(c, " PRIYA@example.com").json()["account"]["name"] == "Priya"
        assert c.get("/api/projects").status_code == 200
        assert c.post("/api/auth/logout").status_code == 204
        assert c.get("/api/projects").status_code == 401


def test_passwords_and_session_tokens_are_not_stored(client, app):
    db = app.state.engine.url.database
    token = client.cookies.get("backstroke_session")
    with sqlite3.connect(db) as conn:
        assert conn.execute("SELECT password_hash FROM accounts").fetchone()[0].startswith("scrypt$")
        assert conn.execute("SELECT COUNT(*) FROM login_sessions WHERE token_hash = ?", (token,)).fetchone()[0] == 0


def test_members_see_only_their_projects(client, app, pid):
    with TestClient(app) as ravi:
        sign_up(ravi, "Ravi")  # Data works on Example Program only
        assert [p["id"] for p in ravi.get("/api/projects").json()] == [pid]
        assert ravi.get(f"/api/projects/{pid}/state").status_code == 200
        hidden = ravi.get(f"/api/projects/{CHECKOUT_ID}/state")
        assert hidden.status_code == 404 and hidden.json()["code"] == "NOT_FOUND"
        assert ravi.get(f"/api/projects/{CHECKOUT_ID}/export/knowledge").status_code == 404
        # Putting Data on the project shows it to him.
        client.put(f"/api/projects/{CHECKOUT_ID}/groups", json={"groups": ["PMO", "Data"]})
        assert ravi.get(f"/api/projects/{CHECKOUT_ID}/state").status_code == 200
    # An admin sees every project.
    assert [p["id"] for p in client.get("/api/projects").json()] == [pid, CHECKOUT_ID]


def test_only_admins_change_settings(client, app, pid):
    with TestClient(app) as ravi:
        sign_up(ravi, "Ravi")
        people = ravi.get("/api/people").json()  # read-only is fine, without the projects he can't see
        assert {p["name"]: p["projects"] for p in people["people"]}["Priya"] == ["example-program"]
        assert CHECKOUT_ID not in str(people["projects_by_group"])
        for res in (
            ravi.put("/api/people", json={"people": [{"name": "Ravi"}]}),
            ravi.post("/api/projects", json={"name": "Mine"}),
            ravi.patch(f"/api/projects/{pid}", json={"name": "Mine"}),
            ravi.put(f"/api/projects/{pid}/groups", json={"groups": []}),
            ravi.get("/api/auth/accounts"),
        ):
            assert res.status_code == 403 and res.json()["code"] == "FORBIDDEN"
        # Members still plan, take notes and keep the register.
        item = ravi.post(f"/api/projects/{pid}/register", json={"kind": "action", "text": "Check the schema", "author": "Someone else"}).json()
        history = ravi.get(f"/api/projects/{pid}/register/{item['id']}/history").json()
        assert history[0]["author"] == "Ravi"


def test_admins_grant_admin_and_revoke_accounts(client, app):
    with TestClient(app) as ravi:
        account = sign_up(ravi, "Ravi")["account"]
        me = client.get("/api/auth/me").json()["account"]
        assert client.patch(f"/api/auth/accounts/{me['id']}", json={"is_admin": False}).json()["errors"][0]["code"] == "cannot_demote_yourself"
        assert client.patch(f"/api/auth/accounts/{account['id']}", json={"is_admin": True}).json()["is_admin"]
        assert ravi.get("/api/auth/accounts").status_code == 200
        assert [a["name"] for a in client.get("/api/auth/accounts").json()] == ["Priya", "Ravi"]
        # Revoking signs him out and lets him register again, e.g. after forgetting his password.
        assert client.delete(f"/api/auth/accounts/{account['id']}").status_code == 204
        assert ravi.get("/api/projects").status_code == 401
        assert sign_up(ravi, "Ravi", password="another password")["account"]["is_admin"] is False
        assert client.delete(f"/api/auth/accounts/{me['id']}").json()["errors"][0]["code"] == "cannot_remove_yourself"


def test_removing_someone_from_people_removes_their_account(client, app):
    with TestClient(app) as ravi:
        sign_up(ravi, "Ravi")
        everyone = client.get("/api/people").json()
        client.put("/api/people", json={"people": [p for p in everyone["people"] if p["name"] != "Ravi"], "groups": everyone["groups"]})
        assert ravi.get("/api/projects").status_code == 401
        assert [a["name"] for a in client.get("/api/auth/accounts").json()] == ["Priya"]
