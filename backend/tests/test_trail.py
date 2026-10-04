"""Trail, surprise index and pre-read: was a date move raised before it was committed?"""

from app.services.trail_service import mentions

from .conftest import commit, move


def surprises(client, pid):
    return client.get(f"/api/projects/{pid}/surprises").json()


def test_seed_moves_are_agreed_foreseen_or_surprises(client, pid):
    data = surprises(client, pid)
    assert [(c["seq"], c["kind"], c["by"]) for c in data["commits"]] == [
        (3, "foreseen", "Steering committee 2026-09-10"),  # the meeting that day discussed the prototype
        (4, "surprise", None),  # Prod UI +5d for leave: nobody raised it
        (5, "agreed", "Steering committee 2026-09-24"),  # the meeting's own commit
    ]
    assert (data["total"], data["agreed"], data["foreseen"], data["surprise"]) == (3, 1, 1, 1)


def test_an_open_risk_on_a_deliverable_makes_its_move_foreseen(client, pid):
    commit(client, pid, [move("data-mapping", end_date="2026-10-16")])
    last = surprises(client, pid)["commits"][-1]
    assert (last["kind"], last["by"]) == ("foreseen", "A-1")


def test_a_move_nobody_raised_is_a_surprise(client, pid):
    # UAT came up at the 24 Sep meeting; Security Review never did.
    commit(client, pid, [move("security-review", start_date="2026-10-06")])
    assert surprises(client, pid)["commits"][-1]["kind"] == "surprise"


def test_new_work_and_progress_are_not_counted(client, pid):
    before = surprises(client, pid)["total"]
    commit(client, pid, [{"entity_type": "deliverable", "entity_id": "docs", "operation": "create", "fields": {"workstream_id": "ui", "name": "Docs", "start_date": "2026-10-12", "end_date": "2026-10-16"}}])
    base = client.get(f"/api/projects/{pid}/state").json()["version"]
    client.post(f"/api/projects/{pid}/progress", json={"author": "t", "base_version": base, "deliverable_id": "prototype", "phase": None, "finished_on": "2026-09-18"})
    assert surprises(client, pid)["total"] == before


def test_mentions():
    assert mentions("hit @DataMapping soon", "Data Mapping")
    assert mentions("=decision slip @[Data Mapping]", "Data Mapping")
    assert mentions("data mapping is late", "Data Mapping")
    assert not mentions("Data Mappings review", "Data Mapping")
    assert not mentions("@DataMappingTeam", "Data Mapping")


def test_trail_of_a_deliverable(client, pid):
    trail = client.get(f"/api/projects/{pid}/deliverables/prod-ui/trail").json()
    entries = [(e["type"], e["date"]) for e in trail["entries"]]
    assert entries == [("meeting", "2026-08-24"), ("commit", "2026-08-24"), ("commit", "2026-09-10"), ("commit", "2026-09-16")]
    created, earlier, later = trail["entries"][1:]
    assert created["lines"] == ["Added Prod UI, 2026-10-05 to 2026-10-23", "Added dependency Prototype → Prod UI", "Added dependency Prod UI → Go-Live"]
    assert earlier["lines"] == ["Prod UI: start 2026-10-05 → 2026-09-28 (-7d)"]  # only Prod UI's line, not Prototype's
    assert later["signal"]["kind"] == "surprise"
    assert trail["entries"][0]["notes"] == ["Scope: data platform plus the customer service agent; Prod UI follows the prototype."]


def test_trail_lists_register_items_from_meetings(client, pid):
    trail = client.get(f"/api/projects/{pid}/deliverables/data-mapping/trail").json()
    meetings = [e for e in trail["entries"] if e["type"] == "meeting"]
    assert [[i["ref"] for i in m["items"]] for m in meetings] == [["R-1"], ["A-1"]]


def test_preread_covers_changes_since_the_series_last_met(client, pid):
    m = client.post(f"/api/projects/{pid}/meetings", json={"title": "Steering committee", "held_on": "2026-10-08"}).json()
    commit(client, pid, [move("data-model", end_date="2026-09-29"), move("data-mapping", start_date="2026-09-30")], reason="Vendor files late")
    pre = client.get(f"/api/projects/{pid}/meetings/{m['id']}/preread").json()
    assert pre["since"] == {"meeting": "Steering committee 2026-09-24", "date": "2026-09-24", "version": 5}
    assert [c["seq"] for c in pre["commits"]] == [6]
    assert pre["commits"][0]["lines"] == ["Data Model: end 2026-09-25 → 2026-09-29 (+4d)", "Data Mapping: start 2026-09-28 → 2026-09-30 (+2d)"]
    assert [a["ref"] for a in pre["actions"]] == ["A-1"] and pre["actions"][0]["overdue"]
    assert {"date": "2026-10-09", "id": "data-ready", "text": "Data Ready due"} in pre["coming_up"]
    assert pre["agenda"][0] == "Open actions: 1, overdue A-1"
    assert "Data Ready is due 2026-10-09: on track?" in pre["agenda"]


def test_preread_flags_surprises_and_skips_the_meetings_own_commit(client, pid):
    m = client.post(f"/api/projects/{pid}/meetings", json={"title": "Steering committee", "held_on": "2026-10-08"}).json()
    commit(client, pid, [move("security-review", start_date="2026-10-06")], reason="Reviewer away Monday")
    pre = client.get(f"/api/projects/{pid}/meetings/{m['id']}/preread").json()
    assert "Commit #6 moved Security Review without being raised first: Reviewer away Monday" in pre["agenda"]
    base = client.get(f"/api/projects/{pid}/state").json()["version"]
    client.post(
        f"/api/projects/{pid}/meetings/{m['id']}/finish",
        json={"author": "t", "commit": {"reason": "Hold UAT", "base_version": base, "changes": [move("uat", start_date="2026-10-12")]}},
    )
    pre = client.get(f"/api/projects/{pid}/meetings/{m['id']}/preread").json()
    assert [c["seq"] for c in pre["commits"]] == [6]


def test_first_meeting_of_a_series_looks_back_at_the_last_meeting_of_any_kind(client, pid):
    m = client.post(f"/api/projects/{pid}/meetings", json={"title": "Data stand-up", "held_on": "2026-10-05"}).json()
    assert client.get(f"/api/projects/{pid}/meetings/{m['id']}/preread").json()["since"]["meeting"] == "Steering committee 2026-09-24"
