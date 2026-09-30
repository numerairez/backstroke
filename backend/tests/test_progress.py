"""Progress: finish dates recorded with Mark done / Reopen, kept apart from plan changes."""

from app.seed import CHECKOUT_ID

from .conftest import commit, move

PHASES = [{"name": "Dev", "days": 3}, {"name": "Review", "days": 1}, {"name": "UAT"}]


def progress(client, pid, deliverable_id, finished_on, phase=None, expect=201):
    base = client.get(f"/api/projects/{pid}/state").json()["version"]
    res = client.post(
        f"/api/projects/{pid}/progress",
        json={"author": "tester", "base_version": base, "deliverable_id": deliverable_id, "phase": phase, "finished_on": finished_on},
    )
    assert res.status_code == expect, res.json()
    return res.json()


def deliverable(client, pid, did, version=None):
    path = f"/api/projects/{pid}/versions/{version}" if version is not None else f"/api/projects/{pid}/state"
    return next(d for d in client.get(path).json()["state"]["deliverables"] if d["id"] == did)


def test_mark_done_is_a_progress_commit_with_an_automatic_reason(client, pid):
    result = progress(client, pid, "data-model", "2026-09-24")
    assert result["commit"]["category"] == "progress"
    assert result["commit"]["reason"] == "Data Model: done 24 Sep"
    assert result["commit"]["events"] == [
        {"entity_type": "deliverable", "entity_id": "data-model", "operation": "update", "field_name": "finished_on", "old_value": None, "new_value": "2026-09-24"}
    ]
    assert deliverable(client, pid, "data-model")["finished_on"] == "2026-09-24"
    # Reopen clears it again.
    assert progress(client, pid, "data-model", None)["commit"]["reason"] == "Data Model: reopened"
    assert deliverable(client, pid, "data-model")["finished_on"] is None


def test_phases_finish_in_order(client, pid):
    commit(client, pid, [move("uat", phases=PHASES)])
    res = progress(client, pid, "uat", "2026-10-15", phase=1, expect=422)
    assert "Mark “Dev” done first" in res["errors"][0]["message"]
    progress(client, pid, "uat", "2026-10-14", phase=0)
    progress(client, pid, "uat", "2026-10-15", phase=1)
    phases = deliverable(client, pid, "uat")["phases"]
    assert [p.get("finished_on") for p in phases] == ["2026-10-14", "2026-10-15", None]


def test_reopening_a_phase_reopens_the_later_ones(client, pid):
    commit(client, pid, [move("uat", phases=PHASES)])
    for i, day in enumerate(["2026-10-14", "2026-10-15", "2026-10-16"]):
        progress(client, pid, "uat", day, phase=i)
    result = progress(client, pid, "uat", None, phase=1)
    assert result["commit"]["reason"] == "UAT: Review, UAT reopened"
    assert [p.get("finished_on") for p in deliverable(client, pid, "uat")["phases"]] == ["2026-10-14", None, None]


def test_plan_changes_cannot_set_finish_dates(client, pid):
    res = commit(client, pid, [move("data-model", finished_on="2026-09-24")], expect=422)
    assert res["errors"][0]["code"] == "progress_field"
    res = commit(client, pid, [move("data-model")], category="progress", expect=422)
    assert res["errors"][0]["code"] == "invalid_category"


def test_plan_edits_keep_finish_dates(client, pid):
    # A phases edit staged before Mark done, then committed after it, must not wipe the finish.
    commit(client, pid, [move("uat", phases=PHASES)])
    progress(client, pid, "uat", "2026-10-14", phase=0)
    stale = [{"name": "Dev", "days": 2}, {"name": "Review", "days": 2}, {"name": "UAT"}]
    commit(client, pid, [move("uat", phases=stale)])
    phases = deliverable(client, pid, "uat")["phases"]
    assert phases[0] == {"name": "Dev", "days": 2, "finished_on": "2026-10-14"}
    # A rename in place keeps it too.
    commit(client, pid, [move("uat", phases=[{"name": "Build", "days": 2}, {"name": "Review", "days": 2}, {"name": "UAT"}])])
    assert deliverable(client, pid, "uat")["phases"][0]["finished_on"] == "2026-10-14"


def test_finish_moves_between_bar_and_phases(client, pid):
    progress(client, pid, "data-model", "2026-09-24")
    commit(client, pid, [move("data-model", phases=PHASES)])
    d = deliverable(client, pid, "data-model")
    assert d["finished_on"] is None
    assert all(p["finished_on"] == "2026-09-24" for p in d["phases"])
    commit(client, pid, [move("data-model", phases=None)])
    assert deliverable(client, pid, "data-model")["finished_on"] == "2026-09-24"


def test_milestones_cannot_be_marked_done(client, pid):
    res = progress(client, pid, "go-live", "2026-10-30", expect=422)
    assert res["errors"][0]["code"] == "invalid_progress"


def test_undo_of_mark_done(client, pid):
    seq = progress(client, pid, "data-model", "2026-09-24")["version"]
    res = client.post(f"/api/projects/{pid}/commits/{seq}/revert", json={"author": "tester", "base_version": seq})
    assert res.status_code == 201, res.json()
    assert res.json()["commit"]["category"] == "progress"
    assert deliverable(client, pid, "data-model")["finished_on"] is None


def test_history_shows_what_was_done_at_each_version(client, pid):
    before = progress(client, pid, "data-model", "2026-09-24")["version"] - 1
    assert deliverable(client, pid, "data-model", version=before)["finished_on"] is None


def test_progress_is_not_churn(client, pid):
    before = client.get(f"/api/projects/{pid}/metrics").json()["summary"]
    progress(client, pid, "data-model", "2026-09-24")
    after = client.get(f"/api/projects/{pid}/metrics").json()["summary"]
    assert after["gross_churn_days"] == before["gross_churn_days"]
    assert after["commits"] == before["commits"]


def test_finishes_are_measured_against_the_plan_when_marked_done(client):
    m = client.get(f"/api/projects/{CHECKOUT_ID}/metrics").json()["finishes"]
    rows = {(r["deliverable_id"], r["phase"]): r for r in m["rows"]}
    assert rows[("prototype", None)]["delta_days"] == 5
    assert rows[("vendor", None)]["delta_days"] == -1
    assert rows[("pay-142", "Dev")]["planned_end"] == "2026-09-22"
    assert rows[("pay-142", "Dev")]["delta_days"] == 1
    # Against the Sprint plan, PAY-142 Dev was due 17 Sep.
    assert rows[("pay-142", "Dev")]["baseline_delta_days"] == 6
    assert (m["on_time"], m["total"]) == (2, 5)


def test_diff_lists_progress(client):
    state = client.get(f"/api/projects/{CHECKOUT_ID}/state").json()
    diff = client.get(f"/api/projects/{CHECKOUT_ID}/diff", params={"from": 6, "to": state["version"]}).json()
    pay = next(d for d in diff["deliverables"] if d["id"] == "pay-142")
    assert pay["progress"] == [
        {"phase": "Dev", "before": None, "after": "2026-09-23"},
        {"phase": "Review", "before": None, "after": "2026-09-29"},
    ]
