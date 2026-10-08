"""The project's people: a saved-whole list of names in optional groups, offered when tagging."""


def people(client, pid):
    res = client.get(f"/api/projects/{pid}/people")
    assert res.status_code == 200
    return res.json()


def save(client, pid, rows, expect=200):
    res = client.put(f"/api/projects/{pid}/people", json={"people": rows})
    assert res.status_code == expect, res.json()
    return res.json()


def test_seed_lists_the_programme_people_in_groups(client, pid):
    assert people(client, pid)[:3] == [
        {"name": "Priya", "group": "PMO"},
        {"name": "Dana", "group": "Business"},
        {"name": "Ravi", "group": "Data"},
    ]


def test_save_keeps_order_trims_and_merges_group_spelling(client, pid):
    saved = save(client, pid, [{"name": " Zoe ", "group": "Data"}, {"name": "Amir", "group": "data "}, {"name": "Kim", "group": " "}, {"name": "  "}])
    assert saved == [{"name": "Zoe", "group": "Data"}, {"name": "Amir", "group": "Data"}, {"name": "Kim", "group": None}]
    assert people(client, pid) == saved


def test_names_are_unique_ignoring_case(client, pid):
    before = people(client, pid)
    res = client.put(f"/api/projects/{pid}/people", json={"people": [{"name": "Ravi"}, {"name": "ravi"}]})
    assert res.status_code == 422
    assert res.json()["errors"][0]["code"] == "duplicate_person"
    assert people(client, pid) == before


def test_people_are_per_project(client, pid):
    other = client.post("/api/projects", json={"name": "Other"}).json()["id"]
    assert people(client, other) == []
    save(client, other, [{"name": "Sam"}])
    assert all(p["name"] != "Sam" for p in people(client, pid))


def test_removing_someone_leaves_meetings_and_register_alone(client, pid):
    owners = {i["ref"]: i["owner"] for i in client.get(f"/api/projects/{pid}/register").json()}
    save(client, pid, [])
    assert {i["ref"]: i["owner"] for i in client.get(f"/api/projects/{pid}/register").json()} == owners
    assert "Ravi" in [a["name"] for a in client.get(f"/api/projects/{pid}/meetings").json()[0]["attendees"]]


def test_knowledge_export_lists_people_by_group(client, pid):
    md = client.get(f"/api/projects/{pid}/export/knowledge").text
    assert "## People" in md
    assert "- Business: Dana, Lena" in md
    assert client.get(f"/api/projects/{pid}/export").json()["people"][0] == {"name": "Priya", "group": "PMO"}
