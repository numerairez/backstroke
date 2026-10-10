"""The register keeps every item and its history: edits, closures with a reason, reopenings."""

import pytest
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError

from .conftest import commit, move


def register(client, pid):
    return {i["ref"]: i for i in client.get(f"/api/projects/{pid}/register").json()}


def history(client, pid, item_id):
    res = client.get(f"/api/projects/{pid}/register/{item_id}/history")
    assert res.status_code == 200, res.json()
    return res.json()


def patch(client, pid, item_id, expect=200, **body):
    res = client.patch(f"/api/projects/{pid}/register/{item_id}", json=body)
    assert res.status_code == expect, res.json()
    return res.json()


def test_seeded_items_have_history(client, pid):
    a2 = register(client, pid)["A-2"]
    events = history(client, pid, a2["id"])
    assert [e["type"] for e in events] == ["raised", "closed"]
    assert events[0]["meeting"]["held_on"] == "2026-09-24" and events[0]["author"] == "Priya (PMO)"
    assert events[1]["on"] == "2026-09-30" and events[1]["line"] == "A-2: closed as done"


def test_every_change_is_kept_with_who_and_why(client, pid):
    item = client.post(f"/api/projects/{pid}/register", json={"kind": "action", "text": "Book the comms slot", "owner": "Priya", "due_on": "2026-10-14", "author": "Dana"}).json()
    patch(client, pid, item["id"], due_on="2026-10-21", author="Dana", note="Comms team is away")
    patch(client, pid, item["id"], owner="Jo", deliverable_ids=["go-live"])
    patch(client, pid, item["id"], text="Book the comms slot")  # no change, nothing kept
    patch(client, pid, item["id"], outcome="done", closed_on="2026-10-20")
    patch(client, pid, item["id"], status="open", note="Slot got cancelled")
    events = history(client, pid, item["id"])
    assert [e["type"] for e in events] == ["raised", "edited", "edited", "closed", "reopened"]
    assert events[0]["author"] == "Dana"
    assert events[1]["line"] == "A-3: due 2026-10-14 → 2026-10-21" and events[1]["note"] == "Comms team is away"
    assert events[2]["line"] == "A-3: owner Priya → Jo; linked to Go-Live"
    assert events[3]["changes"]["outcome"] == [None, "done"] and events[3]["on"] == "2026-10-20"
    assert events[4]["line"] == "A-3: reopened" and events[4]["note"] == "Slot got cancelled"


def test_history_is_append_only(app):
    with app.state.engine.connect() as conn:
        for sql in ("UPDATE register_events SET note = 'rewritten'", "DELETE FROM register_events"):
            with pytest.raises(DBAPIError, match="append-only"):
                conn.execute(text(sql))
            conn.rollback()


def test_issues_are_their_own_kind(client, pid):
    issue = client.post(f"/api/projects/{pid}/register", json={"kind": "issue", "text": "Test env is down", "deliverable_ids": ["data-mapping"]}).json()
    assert issue["ref"] == "I-1" and issue["open"]
    res = client.patch(f"/api/projects/{pid}/register/{issue['id']}", json={"outcome": "done"})
    assert res.json()["errors"][0]["code"] == "outcome_required"
    assert patch(client, pid, issue["id"], outcome="resolved")["outcome"] == "resolved"


def test_a_risk_that_happens_becomes_an_issue(client, pid):
    r1 = register(client, pid)["R-1"]
    closed = patch(client, pid, r1["id"], outcome="happened", closed_on="2026-10-09", note="Vendor changed the schema")
    assert closed["status"] == "closed" and closed["became"] == "I-1"
    issue = register(client, pid)["I-1"]
    assert issue["open"] and issue["text"] == r1["text"] and issue["owner"] == "Ravi"
    assert issue["deliverable_ids"] == ["data-mapping"] and issue["raised_from"] == ["R-1"]
    assert history(client, pid, issue["id"])[0]["note"] == "Raised when R-1 happened"
    assert history(client, pid, r1["id"])[-1]["line"] == "R-1: happened, became I-1"


def test_a_risk_can_become_an_existing_issue(client, pid):
    issue = client.post(f"/api/projects/{pid}/register", json={"kind": "issue", "text": "Escalation API has no owner"}).json()
    r2 = register(client, pid)["R-2"]
    res = client.patch(f"/api/projects/{pid}/register/{r2['id']}", json={"outcome": "happened", "became": "A-1"})
    assert res.json()["errors"][0]["code"] == "became_not_an_issue"
    assert patch(client, pid, r2["id"], outcome="happened", became=issue["ref"])["became"] == "I-1"
    assert len([i for i in register(client, pid) if i.startswith("I-")]) == 1
    # Reopening the risk unlinks it; the issue stays.
    reopened = patch(client, pid, r2["id"], status="open")
    assert reopened["became"] is None and register(client, pid)["I-1"]["raised_from"] == []


def test_changes_made_in_a_meeting_name_it(client, pid):
    m = client.post(f"/api/projects/{pid}/meetings", json={"title": "Steering committee", "held_on": "2026-10-08"}).json()
    a1 = register(client, pid)["A-1"]
    patch(client, pid, a1["id"], outcome="done", closed_on="2026-10-08", meeting_id=m["id"])
    event = history(client, pid, a1["id"])[-1]
    assert event["meeting"]["id"] == m["id"] and event["on"] == "2026-10-08"
    # Its history names the meeting, so it can't be deleted.
    res = client.delete(f"/api/projects/{pid}/meetings/{m['id']}")
    assert res.json()["errors"][0]["code"] == "meeting_in_history"


def test_the_trail_shows_register_changes(client, pid):
    r1 = register(client, pid)["R-1"]
    patch(client, pid, r1["id"], outcome="happened", closed_on="2026-10-09")
    entries = client.get(f"/api/projects/{pid}/deliverables/data-mapping/trail").json()["entries"]
    lines = [e["line"] for e in entries if e["type"] == "register"]
    assert "R-1: happened, became I-1" in lines


def test_an_item_closed_before_a_move_does_not_foresee_it(client, pid):
    """Whether an item was open is read from its history, so a reopened risk counts again."""
    item = client.post(f"/api/projects/{pid}/register", json={"kind": "issue", "text": "Prod UI blocked on design", "deliverable_ids": ["prod-ui"]}).json()
    patch(client, pid, item["id"], outcome="resolved", closed_on="2026-01-01")
    seq = commit(client, pid, [move("prod-ui", end_date="2026-11-20")], reason="Design late")["version"]
    row = next(c for c in client.get(f"/api/projects/{pid}/surprises").json()["commits"] if c["seq"] == seq)
    assert row["by"] != item["ref"]
    # Reopened, it was open when the next move came.
    patch(client, pid, item["id"], status="open")
    seq = commit(client, pid, [move("prod-ui", end_date="2026-11-27")], reason="Design later still")["version"]
    row = next(c for c in client.get(f"/api/projects/{pid}/surprises").json()["commits"] if c["seq"] == seq)
    assert row["kind"] == "foreseen" and row["by"] == item["ref"]


def test_preread_lists_open_issues(client, pid):
    client.post(f"/api/projects/{pid}/register", json={"kind": "issue", "text": "Test env is down"})
    m = client.post(f"/api/projects/{pid}/meetings", json={"title": "Steering committee", "held_on": "2026-10-08"}).json()
    pre = client.get(f"/api/projects/{pid}/meetings/{m['id']}/preread").json()
    assert [i["ref"] for i in pre["issues"]] == ["I-1"]
    assert "Open issues: I-1" in pre["agenda"]
