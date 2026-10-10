"""Meetings and the register: notes stay editable, items are numbered, plan changes go through one commit."""

from .conftest import move


def new_meeting(client, pid, title="Steering committee", held_on="2026-10-08", **extra):
    res = client.post(f"/api/projects/{pid}/meetings", json={"title": title, "held_on": held_on, **extra})
    assert res.status_code == 201, res.json()
    return res.json()


def finish(client, pid, mid, items=(), commit=None, expect=201):
    body = {"author": "tester", "items": list(items)}
    if commit is not None:
        body["commit"] = commit
    res = client.post(f"/api/projects/{pid}/meetings/{mid}/finish", json=body)
    assert res.status_code == expect, res.json()
    return res.json()


def version(client, pid):
    return client.get(f"/api/projects/{pid}/state").json()["version"]


def register(client, pid):
    return {i["ref"]: i for i in client.get(f"/api/projects/{pid}/register").json()}


def test_seed_has_meetings_and_a_register(client, pid):
    meetings = client.get(f"/api/projects/{pid}/meetings").json()
    assert [(m["title"], m["held_on"], m["commit_seq"]) for m in meetings] == [
        ("Steering committee", "2026-09-24", 5),
        ("Steering committee", "2026-09-10", None),
        ("Kickoff", "2026-08-24", 1),
    ]
    items = register(client, pid)
    assert sorted(items) == ["A-1", "A-2", "D-1", "D-2", "R-1", "R-2"]
    assert items["A-2"]["status"] == "closed" and items["A-2"]["outcome"] == "done" and items["A-2"]["closed_on"] == "2026-09-30"
    assert items["A-1"]["open"] and items["A-1"]["meeting"]["held_on"] == "2026-09-24"


def test_a_new_meeting_in_a_series_starts_with_its_people(client, pid):
    m = new_meeting(client, pid)
    assert [a["name"] for a in m["attendees"]] == ["Priya", "Dana", "Ravi", "Marco", "Jo", "Lena"]
    assert all(a["present"] for a in m["attendees"])
    assert new_meeting(client, pid, title="Data stand-up")["attendees"] == []


def test_notes_save_without_touching_the_plan(client, pid):
    before = version(client, pid)
    m = new_meeting(client, pid)
    res = client.patch(f"/api/projects/{pid}/meetings/{m['id']}", json={"notes": "!action @Ravi chase the vendor"})
    assert res.status_code == 200
    assert res.json()["notes"] == "!action @Ravi chase the vendor"
    assert version(client, pid) == before


def test_finish_records_items_and_one_commit_referencing_the_meeting(client, pid):
    m = new_meeting(client, pid)
    base = version(client, pid)
    result = finish(
        client,
        pid,
        m["id"],
        items=[
            {"kind": "decision", "text": "Accept a 1-week slip on Data Mapping", "deliverable_ids": ["data-mapping"]},
            {"kind": "action", "text": "Freeze schema v3", "owner": "Ravi", "due_on": "2026-10-09", "deliverable_ids": ["data-mapping"]},
            {"kind": "action", "text": "Book the go-live comms slot", "owner": "Priya"},
        ],
        commit={"reason": "Accept a 1-week slip on Data Mapping", "category": "risk", "base_version": base, "changes": [move("data-mapping", end_date="2026-10-16")]},
    )
    assert result["commit"]["commit"]["reference"] == "Steering committee 2026-10-08"
    assert result["commit"]["version"] == base + 1
    meeting = result["meeting"]
    assert meeting["finished_at"] and meeting["commit_seq"] == base + 1 and meeting["plan_version"] == base + 1
    # Numbering continues from the seeded register, per kind.
    assert [i["ref"] for i in meeting["items"]] == ["D-3", "A-3", "A-4"]
    assert register(client, pid)["A-4"]["deliverable_ids"] == []  # programme-level


def test_finish_without_plan_changes_records_only_items(client, pid):
    m = new_meeting(client, pid)
    base = version(client, pid)
    result = finish(client, pid, m["id"], items=[{"kind": "risk", "text": "Vendor may miss the freeze", "owner": "Ravi"}])
    assert result["commit"] is None and result["meeting"]["commit_seq"] is None
    assert version(client, pid) == base


def test_finish_is_all_or_nothing(client, pid):
    m = new_meeting(client, pid)
    base = version(client, pid)
    # A bad item rolls back a valid commit.
    res = finish(
        client,
        pid,
        m["id"],
        items=[{"kind": "action", "text": "Chase", "deliverable_ids": ["nope"]}],
        commit={"reason": "slip", "base_version": base, "changes": [move("data-mapping", end_date="2026-10-16")]},
        expect=422,
    )
    assert res["errors"][0]["code"] == "unknown_deliverable"
    assert version(client, pid) == base
    assert sorted(register(client, pid)) == ["A-1", "A-2", "D-1", "D-2", "R-1", "R-2"]
    # A stale base version records nothing either.
    res = finish(
        client,
        pid,
        m["id"],
        items=[{"kind": "action", "text": "Chase"}],
        commit={"reason": "slip", "base_version": base - 1, "changes": [move("data-mapping", end_date="2026-10-16")]},
        expect=409,
    )
    assert "A-3" not in register(client, pid)
    assert client.get(f"/api/projects/{pid}/meetings/{m['id']}").json()["finished_at"] is None


def test_a_meeting_finishes_once_and_then_keeps_its_title_and_date(client, pid):
    m = new_meeting(client, pid)
    finish(client, pid, m["id"])
    assert finish(client, pid, m["id"], expect=422)["errors"][0]["code"] == "meeting_finished"
    res = client.patch(f"/api/projects/{pid}/meetings/{m['id']}", json={"held_on": "2026-10-09"})
    assert res.status_code == 422
    # Notes and attendance can still be corrected.
    res = client.patch(f"/api/projects/{pid}/meetings/{m['id']}", json={"notes": "typo fixed", "attendees": [{"name": "Priya", "present": True}]})
    assert res.status_code == 200
    assert client.delete(f"/api/projects/{pid}/meetings/{m['id']}").status_code == 422


def test_an_unfinished_meeting_can_be_deleted(client, pid):
    m = new_meeting(client, pid)
    assert client.delete(f"/api/projects/{pid}/meetings/{m['id']}").status_code == 204
    assert client.get(f"/api/projects/{pid}/meetings/{m['id']}").status_code == 404


def test_item_validation(client, pid):
    res = client.post(f"/api/projects/{pid}/register", json={"kind": "risk", "text": "x", "due_on": "2026-10-09"})
    assert res.json()["errors"][0]["code"] == "due_on_actions_only"
    res = client.post(f"/api/projects/{pid}/register", json={"kind": "action", "text": "  "})
    assert res.json()["errors"][0]["code"] == "text_required"
    res = client.post(f"/api/projects/{pid}/register", json={"kind": "action", "text": "x", "due_on": "Friday"})
    assert res.json()["errors"][0]["code"] == "invalid_date"


def test_actions_close_and_reopen(client, pid):
    item = client.post(f"/api/projects/{pid}/register", json={"kind": "action", "text": "Book the comms slot", "owner": "Priya"}).json()
    assert item["ref"] == "A-3" and item["meeting"] is None
    done = client.patch(f"/api/projects/{pid}/register/{item['id']}", json={"outcome": "done", "closed_on": "2026-10-10"}).json()
    assert done["status"] == "closed" and done["outcome"] == "done" and done["closed_on"] == "2026-10-10" and not done["open"]
    reopened = client.patch(f"/api/projects/{pid}/register/{item['id']}", json={"status": "open"}).json()
    assert reopened["open"] and reopened["closed_on"] is None and reopened["outcome"] is None
    res = client.patch(f"/api/projects/{pid}/register/{item['id']}", json={"status": "done"})
    assert res.json()["errors"][0]["code"] == "invalid_status"
    # Closing needs a reason, and it has to be one an action can have.
    res = client.patch(f"/api/projects/{pid}/register/{item['id']}", json={"status": "closed"})
    assert res.json()["errors"][0]["code"] == "outcome_required"
    res = client.patch(f"/api/projects/{pid}/register/{item['id']}", json={"outcome": "mitigated"})
    assert res.json()["errors"][0]["code"] == "outcome_required"
    dropped = client.patch(f"/api/projects/{pid}/register/{item['id']}", json={"outcome": "dropped", "note": "Comms moved to email"}).json()
    assert dropped["outcome"] == "dropped"


def test_decisions_are_never_edited_only_superseded(client, pid):
    items = register(client, pid)
    d1 = items["D-1"]
    res = client.patch(f"/api/projects/{pid}/register/{d1['id']}", json={"text": "Go-Live on 6 Nov"})
    assert res.json()["errors"][0]["code"] == "decision_locked"
    res = client.patch(f"/api/projects/{pid}/register/{d1['id']}", json={"status": "superseded"})
    assert res.json()["errors"][0]["code"] == "superseded_by_required"
    res = client.patch(f"/api/projects/{pid}/register/{d1['id']}", json={"status": "superseded", "superseded_by": "D-2"}).json()
    assert res["status"] == "superseded" and res["superseded_by"] == "D-2"
    res = client.patch(f"/api/projects/{pid}/register/{d1['id']}", json={"status": "active"})
    assert res.json()["errors"][0]["code"] == "decision_locked"
    # A superseded decision can't supersede another.
    res = client.patch(f"/api/projects/{pid}/register/{items['D-2']['id']}", json={"status": "superseded", "superseded_by": "D-1"})
    assert res.json()["errors"][0]["code"] == "superseded_by_inactive"


def test_export_includes_meetings_and_register(client, pid):
    data = client.get(f"/api/projects/{pid}/export").json()
    assert len(data["meetings"]) == 3 and len(data["register"]) == 6
