"""People and groups belong to the organisation; projects take groups.

The organisation roster is saved whole, and a person can be in many groups. A project's members
are everyone in the groups working on it.
"""

import sqlite3

from fastapi.testclient import TestClient

from app.main import create_app
from app.seed import CHECKOUT_ID

from .conftest import sign_up

# Whoever saves the roster (Priya, the signed-in admin) can't take themselves out of it.
ME = {"name": "Priya"}


def plain(people):
    """People without their ids and sign-in details, which these tests don't pin down (see test_auth)."""
    return [{k: v for k, v in p.items() if k not in ("id", "username", "email")} for p in people]


def org(client):
    res = client.get("/api/people")
    assert res.status_code == 200
    return res.json()


def roster(client, pid):
    res = client.get(f"/api/projects/{pid}/people")
    assert res.status_code == 200
    return res.json()


def save(client, people, groups=None, expect=200, **extra):
    res = client.put("/api/people", json={"people": [ME, *people], "groups": groups or [], **extra})
    assert res.status_code == expect, res.json()
    return res.json()


def test_seed_lists_the_programme_people_in_groups(client, pid):
    r = roster(client, pid)
    assert r["people"][:3] == [
        {"name": "Priya", "groups": ["PMO", "Steering"]},
        {"name": "Dana", "groups": ["Business", "Steering"]},
        {"name": "Ravi", "groups": ["Data"]},
    ]
    assert r["groups"] == ["PMO", "Steering", "Business", "Data", "AI agent"]


def test_projects_take_groups_and_their_people_are_its_members(client, pid):
    everyone = {p["name"]: p for p in org(client)["people"]}
    assert everyone["Priya"]["projects"] == [pid, CHECKOUT_ID]  # through PMO
    assert everyone["Ravi"]["projects"] == [pid]
    assert everyone["Sam"]["projects"] == [CHECKOUT_ID]
    assert org(client)["projects_by_group"]["PMO"] == [pid, CHECKOUT_ID]
    # Each project offers only its members, and the groups they're in.
    checkout = roster(client, CHECKOUT_ID)
    assert [p["name"] for p in checkout["people"]] == ["Priya", "Sam", "Noor", "Theo", "Mei"]
    assert checkout["groups"] == ["PMO", "Steering", "Delivery", "Engineering", "QA"]
    projects = {p["id"]: p for p in client.get("/api/projects").json()}
    assert projects[CHECKOUT_ID]["groups"] == ["PMO", "Delivery", "Engineering", "QA"]
    assert projects[CHECKOUT_ID]["members"] == ["Priya", "Sam", "Noor", "Theo", "Mei"]


def test_save_keeps_order_trims_and_merges_group_spelling(client, pid):
    saved = save(
        client,
        [{"name": " Zoe ", "groups": ["Data", "Ops"]}, {"name": "Amir", "groups": ["data ", "DATA"]}, {"name": "Kim", "groups": [" "]}, {"name": "  "}],
    )
    assert plain(saved["people"][1:]) == [
        {"name": "Zoe", "groups": ["Data", "Ops"], "projects": [pid]},
        {"name": "Amir", "groups": ["Data"], "projects": [pid]},
        {"name": "Kim", "groups": [], "projects": []},
    ]
    assert saved["groups"] == ["Data", "Ops"]
    assert saved["projects_by_group"] == {"Data": [pid]}  # Data keeps its project
    assert org(client) == saved
    assert roster(client, pid) == {"people": [{"name": "Zoe", "groups": ["Data", "Ops"]}, {"name": "Amir", "groups": ["Data"]}], "groups": ["Data", "Ops"]}


def test_a_renamed_group_is_sent_with_its_projects(client, pid):
    current = org(client)
    people = [{"name": p["name"], "groups": ["Platform" if g == "Data" else g for g in p["groups"]]} for p in current["people"]]
    groups = ["Platform" if g == "Data" else g for g in current["groups"]]
    teams = {("Platform" if g == "Data" else g): ps for g, ps in current["projects_by_group"].items()}
    saved = client.put("/api/people", json={"people": people, "groups": groups, "projects_by_group": teams}).json()
    assert saved["projects_by_group"]["Platform"] == [pid]
    assert "Ravi" in [p["name"] for p in roster(client, pid)["people"]]


def test_groups_keep_their_order_and_can_be_empty(client):
    saved = save(client, [{"name": "Zoe", "groups": ["data"]}], groups=["Steering", "Data"])
    assert saved["groups"] == ["Steering", "Data"]
    assert saved["people"][1]["groups"] == ["Data"]


def test_names_are_unique_ignoring_case(client):
    before = org(client)
    res = client.put("/api/people", json={"people": [{"name": "Ravi"}, {"name": "ravi"}]})
    assert res.status_code == 422
    assert res.json()["errors"][0]["code"] == "duplicate_person"
    assert org(client) == before


def test_a_group_cannot_share_a_persons_name(client):
    res = save(client, [{"name": "Data"}], groups=["data"], expect=422)
    assert res["errors"][0]["code"] == "group_is_person"


def test_projects_must_exist(client):
    res = save(client, [], groups=["Ops"], projects_by_group={"Ops": ["nope"]}, expect=422)
    assert res["errors"][0]["code"] == "unknown_project"


def test_a_rename_keeps_the_person_and_their_account(client):
    people = org(client)["people"]
    ids = [p["id"] for p in people]
    # Priya and Dana swap names; ids follow the people, not the names.
    people[0]["name"], people[1]["name"] = "Dana", "Priya"
    saved = client.put("/api/people", json={"people": people, "groups": org(client)["groups"]}).json()
    assert [p["id"] for p in saved["people"]] == ids
    assert client.get("/api/auth/me").json()["account"]["name"] == "Dana"


def test_you_cant_take_yourself_out(client):
    res = client.put("/api/people", json={"people": [{"name": "Ravi"}]})
    assert res.json()["errors"][0]["code"] == "cannot_remove_yourself"


def test_a_projects_groups_are_set_by_name(client, pid):
    res = client.put(f"/api/projects/{CHECKOUT_ID}/groups", json={"groups": ["qa", "Data", "QA"]})
    assert res.status_code == 200
    assert res.json() == {"people": [{"name": "Ravi", "groups": ["Data"]}, {"name": "Mei", "groups": ["QA"]}], "groups": ["Data", "QA"]}
    assert {p["name"]: p["projects"] for p in org(client)["people"]}["Ravi"] == [pid, CHECKOUT_ID]
    assert {p["name"]: p["projects"] for p in org(client)["people"]}["Priya"] == [pid]
    res = client.put(f"/api/projects/{pid}/groups", json={"groups": ["Nobody"]})
    assert res.status_code == 422 and res.json()["errors"][0]["code"] == "unknown_group"


def test_a_new_project_can_start_with_groups(client):
    created = client.post("/api/projects", json={"name": "Other", "groups": ["Data"]}).json()
    assert created["groups"] == ["Data"] and created["members"] == ["Ravi"]
    empty = client.post("/api/projects", json={"name": "Empty"}).json()
    assert roster(client, empty["id"]) == {"people": [], "groups": []}


def test_a_project_can_be_renamed_and_described(client, pid):
    res = client.patch(f"/api/projects/{pid}", json={"name": " Data Platform ", "description": "Phase 1"})
    assert res.status_code == 200 and res.json()["name"] == "Data Platform" and res.json()["description"] == "Phase 1"
    res = client.patch(f"/api/projects/{pid}", json={"name": " "})
    assert res.json()["errors"][0]["code"] == "name_required"


def test_removing_someone_leaves_meetings_and_register_alone(client, pid):
    owners = {i["ref"]: i["owner"] for i in client.get(f"/api/projects/{pid}/register").json()}
    save(client, [])
    assert {i["ref"]: i["owner"] for i in client.get(f"/api/projects/{pid}/register").json()} == owners
    assert "Ravi" in [a["name"] for a in client.get(f"/api/projects/{pid}/meetings").json()[0]["attendees"]]
    assert roster(client, pid) == {"people": [], "groups": []}


def test_knowledge_export_lists_people_by_group(client, pid):
    md = client.get(f"/api/projects/{pid}/export/knowledge").text
    assert "## People" in md
    assert "- Business: Dana, Lena" in md
    assert "- Steering: Priya, Dana" in md
    assert "Sam" not in md.split("## People")[1].split("##")[0]
    assert client.get(f"/api/projects/{pid}/export").json()["people"]["people"][0] == {"name": "Priya", "groups": ["PMO", "Steering"]}


def _old_db(path, sql):
    db = sqlite3.connect(path)
    db.executescript("CREATE TABLE projects (id VARCHAR PRIMARY KEY, name VARCHAR, description TEXT, created_at VARCHAR);" + sql)
    db.commit()
    db.close()


def test_a_database_with_one_group_per_person_is_migrated(tmp_path):
    path = tmp_path / "old.db"
    _old_db(
        path,
        """
        CREATE TABLE project_people (id INTEGER PRIMARY KEY, project_id VARCHAR, name VARCHAR, "group" VARCHAR, position INTEGER, UNIQUE (project_id, name));
        INSERT INTO projects VALUES ('p', 'Old', NULL, '2026-01-01T00:00:00Z');
        INSERT INTO project_people (project_id, name, "group", position) VALUES ('p', 'Ann', 'Data', 0), ('p', 'Bo', NULL, 1), ('p', 'Cy', 'Data', 2);
        """,
    )
    with TestClient(create_app(f"sqlite:///{path}", seed=False)) as c:
        sign_up(c, "ann", name="Ann")
        assert roster(c, "p") == {
            "people": [{"name": "Ann", "groups": ["Data", "Old team"]}, {"name": "Bo", "groups": ["Old team"]}, {"name": "Cy", "groups": ["Data", "Old team"]}],
            "groups": ["Data", "Old team"],
        }


def test_per_project_rosters_merge_into_the_organisation(tmp_path):
    path = tmp_path / "old.db"
    _old_db(
        path,
        """
        CREATE TABLE project_people (id INTEGER PRIMARY KEY, project_id VARCHAR, name VARCHAR, groups JSON, position INTEGER, UNIQUE (project_id, name));
        CREATE TABLE project_groups (id INTEGER PRIMARY KEY, project_id VARCHAR, name VARCHAR, position INTEGER, UNIQUE (project_id, name));
        INSERT INTO projects VALUES ('a', 'First', '', '2026-01-01T00:00:00Z'), ('b', 'Second', '', '2026-02-01T00:00:00Z');
        INSERT INTO project_people (project_id, name, groups, position) VALUES
            ('a', 'Ann', '["Data"]', 0), ('a', 'Bo', '[]', 1),
            ('b', 'ann', '["Ops"]', 0), ('b', 'Di', '["data"]', 1);
        INSERT INTO project_groups (project_id, name, position) VALUES ('a', 'Data', 0), ('a', 'Steering', 1), ('b', 'Ops', 0), ('b', 'data', 1);
        """,
    )
    with TestClient(create_app(f"sqlite:///{path}", seed=False)) as c:
        sign_up(c, "ann", name="Ann")
        # Who was on each project becomes a group the project takes, so no one drops off.
        everyone = org(c)
        assert {**everyone, "people": plain(everyone["people"])} == {
            "people": [
                {"name": "Ann", "groups": ["Data", "Ops", "First team", "Second team"], "projects": ["a", "b"]},
                {"name": "Bo", "groups": ["First team"], "projects": ["a"]},
                {"name": "Di", "groups": ["Data", "Second team"], "projects": ["b"]},
            ],
            "groups": ["Data", "Steering", "Ops", "First team", "Second team"],
            "projects_by_group": {"First team": ["a"], "Second team": ["b"]},
        }
    tables = {r[0] for r in sqlite3.connect(path).execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
    assert not tables & {"project_people", "project_groups", "project_members"}
