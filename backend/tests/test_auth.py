"""Sign-in: people sign in with the username listed in People, the first account is an admin, and projects are hidden from non-members."""

import sqlite3

from fastapi.testclient import TestClient

from app.main import create_app
from app.seed import CHECKOUT_ID
from app.services.auth_service import hash_password

from .conftest import PASSWORD, sign_up


def login(client, username, password=PASSWORD):
    return client.post("/api/auth/login", json={"username": username, "password": password})


def test_everything_needs_a_sign_in(app):
    with TestClient(app) as c:
        assert c.get("/api/projects").status_code == 401
        assert c.get("/api/projects/example-program/state").json()["code"] == "UNAUTHORIZED"
        assert c.get("/api/auth/me").json() == {"account": None, "needs_setup": True}


def test_the_first_account_is_an_admin_and_can_set_up_a_fresh_install(tmp_path):
    with TestClient(create_app(f"sqlite:///{tmp_path / 'fresh.db'}", seed=False)) as c:
        assert sign_up(c, "kim", expect=422)["errors"][0]["code"] == "name_required"
        assert sign_up(c, "kim lee", name="Kim", expect=422)["errors"][0]["code"] == "invalid_username"
        me = sign_up(c, " CORP\\KLee ", name="Kim", email="Kim@Example.com")["account"]
        assert me["name"] == "Kim" and me["is_admin"] and me["username"] == "klee" and me["email"] == "kim@example.com"
        assert [(p["name"], p["username"]) for p in c.get("/api/people").json()["people"]] == [("Kim", "klee")]  # added to People
        assert c.get("/api/auth/me").json()["needs_setup"] is False


def test_only_people_with_a_username_can_register(client, app):
    with TestClient(app) as other:
        assert sign_up(other, "stranger", expect=422)["errors"][0]["code"] == "not_listed"
        assert sign_up(other, "", expect=422)["errors"][0]["code"] == "not_listed"
        # Registering is choosing a password; name and email come from People.
        ravi = sign_up(other, " RAVI ", name="Someone else", email="x@y.com")["account"]
        assert ravi["name"] == "Ravi" and not ravi["is_admin"] and ravi["username"] == "ravi" and ravi["email"] == "ravi@example.com"
    with TestClient(app) as again:
        assert sign_up(again, "ravi", expect=422)["errors"][0]["code"] == "already_registered"
        assert sign_up(again, "dana", password="short", expect=422)["errors"][0]["code"] == "password_too_short"


def test_sign_in_and_out(client, app):
    with TestClient(app) as c:
        assert login(c, "priya", "wrong password").json()["errors"][0]["code"] == "wrong_credentials"
        assert login(c, "nobody").json()["errors"][0]["code"] == "wrong_credentials"
        assert login(c, "dana").json()["errors"][0]["code"] == "wrong_credentials"  # listed, but no password yet
        assert login(c, " PRIYA").json()["account"]["name"] == "Priya"
        assert login(c, "CORP\\priya").json()["account"]["name"] == "Priya"  # a domain prefix is ignored
        assert login(c, "Priya@Example.com").json()["account"]["name"] == "Priya"  # an email still works
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


def test_admins_set_usernames_and_emails_in_people(client, app):
    everyone = client.get("/api/people").json()
    people = [{**p, "username": "rkumar", "email": "Ravi.Kumar@Example.com"} if p["name"] == "Ravi" else p for p in everyone["people"]]
    saved = client.put("/api/people", json={**everyone, "people": people}).json()
    assert {p["name"]: (p["username"], p["email"]) for p in saved["people"]}["Ravi"] == ("rkumar", "ravi.kumar@example.com")
    with TestClient(app) as ravi:
        assert sign_up(ravi, "ravi", expect=422)["errors"][0]["code"] == "not_listed"
        sign_up(ravi, "rkumar")
        # Left out of a save, a username and email are kept.
        client.put("/api/people", json={**everyone, "people": [{"id": p["id"], "name": p["name"], "groups": p["groups"]} for p in saved["people"]]})
        assert ravi.get("/api/auth/me").json()["account"]["username"] == "rkumar"
    swapped = [{**p, "username": {"priya": "dana", "dana": "priya"}.get(p["username"], p["username"])} for p in saved["people"]]
    assert {p["name"]: p["username"] for p in client.put("/api/people", json={**everyone, "people": swapped}).json()["people"]}["Priya"] == "dana"
    for change, code in (({"username": "dana"}, "duplicate_username"), ({"email": "dana@example.com"}, "duplicate_email"), ({"username": "r kumar"}, "invalid_username"), ({"email": "nope"}, "invalid_email")):
        people = [{**p, **change} if p["name"] == "Ravi" else p for p in swapped]
        assert client.put("/api/people", json={**everyone, "people": people}).json()["errors"][0]["code"] == code


def test_accounts_that_signed_in_by_email_get_a_username(tmp_path):
    path = tmp_path / "old.db"
    with TestClient(create_app(f"sqlite:///{path}", seed=False)) as c:
        sign_up(c, "ann", name="Ann")
        cookie = c.cookies.get("backstroke_session")
    # Put the database back how it was: emails on accounts, no usernames.
    with sqlite3.connect(path) as conn:
        conn.executescript(
            f"""
            PRAGMA foreign_keys = OFF;
            CREATE TABLE old_accounts (id INTEGER NOT NULL, person_id INTEGER NOT NULL, email VARCHAR NOT NULL, password_hash VARCHAR NOT NULL,
                is_admin BOOLEAN NOT NULL, created_at VARCHAR NOT NULL, PRIMARY KEY (id), UNIQUE (person_id), UNIQUE (email),
                FOREIGN KEY(person_id) REFERENCES people (id) ON DELETE CASCADE);
            INSERT INTO old_accounts SELECT id, person_id, 'ann.lee@example.com', password_hash, is_admin, created_at FROM accounts;
            DROP TABLE accounts;
            ALTER TABLE old_accounts RENAME TO accounts;
            DROP INDEX ix_people_username;
            DROP INDEX ix_people_email;
            ALTER TABLE people DROP COLUMN username;
            ALTER TABLE people DROP COLUMN email;
            INSERT INTO people (name, groups, position) VALUES ('Bo', '[]', 1);
            INSERT INTO accounts SELECT 2, id, 'ann+lee@other.com', '{hash_password(PASSWORD)}', 0, '2026-01-02' FROM people WHERE name = 'Bo';
            """
        )
    with TestClient(create_app(f"sqlite:///{path}", seed=False)) as c:
        c.cookies.set("backstroke_session", cookie)
        assert c.get("/api/auth/me").json()["account"]["username"] == "ann.lee"  # still signed in
        people = {p["name"]: (p["username"], p["email"]) for p in c.get("/api/people").json()["people"]}
        assert people == {"Ann": ("ann.lee", "ann.lee@example.com"), "Bo": ("annlee", "ann+lee@other.com")}
        assert login(c, "annlee").json()["account"]["name"] == "Bo"
    assert "email" not in {r[1] for r in sqlite3.connect(path).execute("PRAGMA table_info(accounts)")}
