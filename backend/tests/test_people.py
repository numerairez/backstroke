"""The project's people and groups: a saved-whole roster where a person can be in many groups."""

import sqlite3

from app.main import create_app


def roster(client, pid):
    res = client.get(f"/api/projects/{pid}/people")
    assert res.status_code == 200
    return res.json()


def save(client, pid, people, groups=None, expect=200):
    res = client.put(f"/api/projects/{pid}/people", json={"people": people, "groups": groups or []})
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


def test_save_keeps_order_trims_and_merges_group_spelling(client, pid):
    saved = save(
        client,
        pid,
        [{"name": " Zoe ", "groups": ["Data", "Ops"]}, {"name": "Amir", "groups": ["data ", "DATA"]}, {"name": "Kim", "groups": [" "]}, {"name": "  "}],
    )
    assert saved["people"] == [{"name": "Zoe", "groups": ["Data", "Ops"]}, {"name": "Amir", "groups": ["Data"]}, {"name": "Kim", "groups": []}]
    assert saved["groups"] == ["Data", "Ops"]
    assert roster(client, pid) == saved


def test_groups_keep_their_order_and_can_be_empty(client, pid):
    saved = save(client, pid, [{"name": "Zoe", "groups": ["data"]}], groups=["Steering", "Data"])
    assert saved["groups"] == ["Steering", "Data"]
    assert saved["people"] == [{"name": "Zoe", "groups": ["Data"]}]


def test_names_are_unique_ignoring_case(client, pid):
    before = roster(client, pid)
    res = client.put(f"/api/projects/{pid}/people", json={"people": [{"name": "Ravi"}, {"name": "ravi"}]})
    assert res.status_code == 422
    assert res.json()["errors"][0]["code"] == "duplicate_person"
    assert roster(client, pid) == before


def test_a_group_cannot_share_a_persons_name(client, pid):
    res = client.put(f"/api/projects/{pid}/people", json={"people": [{"name": "Data"}], "groups": ["data"]})
    assert res.status_code == 422
    assert res.json()["errors"][0]["code"] == "group_is_person"


def test_people_are_per_project(client, pid):
    other = client.post("/api/projects", json={"name": "Other"}).json()["id"]
    assert roster(client, other) == {"people": [], "groups": []}
    save(client, other, [{"name": "Sam"}])
    assert all(p["name"] != "Sam" for p in roster(client, pid)["people"])


def test_removing_someone_leaves_meetings_and_register_alone(client, pid):
    owners = {i["ref"]: i["owner"] for i in client.get(f"/api/projects/{pid}/register").json()}
    save(client, pid, [])
    assert {i["ref"]: i["owner"] for i in client.get(f"/api/projects/{pid}/register").json()} == owners
    assert "Ravi" in [a["name"] for a in client.get(f"/api/projects/{pid}/meetings").json()[0]["attendees"]]


def test_knowledge_export_lists_people_by_group(client, pid):
    md = client.get(f"/api/projects/{pid}/export/knowledge").text
    assert "## People" in md
    assert "- Business: Dana, Lena" in md
    assert "- Steering: Priya, Dana" in md
    assert client.get(f"/api/projects/{pid}/export").json()["people"]["people"][0] == {"name": "Priya", "groups": ["PMO", "Steering"]}


def test_a_database_with_one_group_per_person_is_migrated(tmp_path):
    path = tmp_path / "old.db"
    db = sqlite3.connect(path)
    db.executescript(
        """
        CREATE TABLE projects (id VARCHAR PRIMARY KEY, name VARCHAR, description TEXT, created_at VARCHAR);
        CREATE TABLE project_people (id INTEGER PRIMARY KEY, project_id VARCHAR, name VARCHAR, "group" VARCHAR, position INTEGER, UNIQUE (project_id, name));
        INSERT INTO projects VALUES ('p', 'Old', NULL, '2026-01-01T00:00:00Z');
        INSERT INTO project_people (project_id, name, "group", position) VALUES ('p', 'Ann', 'Data', 0), ('p', 'Bo', NULL, 1), ('p', 'Cy', 'Data', 2);
        """
    )
    db.commit()
    db.close()
    from fastapi.testclient import TestClient

    with TestClient(create_app(f"sqlite:///{path}", seed=False)) as c:
        assert roster(c, "p") == {"people": [{"name": "Ann", "groups": ["Data"]}, {"name": "Bo", "groups": []}, {"name": "Cy", "groups": ["Data"]}], "groups": ["Data"]}
