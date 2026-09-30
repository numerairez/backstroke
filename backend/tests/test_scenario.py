"""Appendix A end-to-end scenario, plus diff, baselines, and metrics."""

from .conftest import commit, move


def preview(client, pid, changes):
    res = client.post(f"/api/projects/{pid}/preview", json={"changes": changes})
    assert res.status_code == 200, res.json()
    return res.json()


def test_appendix_a_data_mapping_slip(client, pid):
    base = client.get(f"/api/projects/{pid}/state").json()["version"]

    # 2-3. Data Mapping moves to 16 Oct; the preview warns and suggests downstream moves.
    staged = [move("data-mapping", end_date="2026-10-16")]
    p = preview(client, pid, staged)
    assert p["valid"]
    assert {c["successor_id"] for c in p["conflicts"]} == {"data-ready"}
    suggestions = {s["deliverable_id"]: s for s in p["suggestions"]}
    assert suggestions["data-ready"]["shift_days"] == 7
    assert suggestions["uat"]["shift_days"] == 7
    assert (suggestions["uat"]["start_date"], suggestions["uat"]["end_date"]) == ("2026-10-19", "2026-10-23")
    assert "go-live" not in suggestions

    # 4-5. Accept suggestions and move Go-Live manually.
    for s in p["suggestions"]:
        staged.append(move(s["deliverable_id"], start_date=s["start_date"], end_date=s["end_date"]))
    staged.append(move("go-live", start_date="2026-11-06", end_date="2026-11-06"))
    p = preview(client, pid, staged)
    assert p["valid"] and p["conflicts"] == [] and p["suggestions"] == []

    # 6-8. One commit with all events.
    result = commit(client, pid, staged, reason="Data mapping completion moved one week after source-system access delay.", category="dependency")
    assert result["version"] == base + 1
    assert len(result["commit"]["events"]) == 7  # mapping end, data-ready start+end, uat start+end, go-live start+end

    # Baseline v1 is unchanged.
    v1 = client.get(f"/api/projects/{pid}/versions/1").json()["state"]
    assert next(d for d in v1["deliverables"] if d["id"] == "go-live")["end_date"] == "2026-10-30"

    # 9. Compare the previous version to current.
    diff = client.get(f"/api/projects/{pid}/diff", params={"from": base, "to": base + 1}).json()
    moved = {d["id"]: d for d in diff["deliverables"]}
    assert set(moved) == {"data-mapping", "data-ready", "uat", "go-live"}
    assert moved["go-live"]["end_delta_days"] == 7
    assert moved["data-mapping"]["duration_delta_days"] == 7
    assert diff["summary"]["later"] == 4

    # Metrics see the movement, attributed to the dependency category.
    m = client.get(f"/api/projects/{pid}/metrics").json()
    go_live = next(x for x in m["milestones"] if x["id"] == "go-live")
    assert go_live["net_movement_days"] == 7
    dep = next(c for c in m["by_category"] if c["category"] == "dependency")
    assert dep["later_days"] == 28
    assert {(p["predecessor_id"], p["successor_id"]) for p in m["propagation"]} >= {("data-mapping", "data-ready"), ("uat", "go-live")}


def test_preview_does_not_persist(client, pid):
    before = client.get(f"/api/projects/{pid}/state").json()
    preview(client, pid, [move("uat", end_date="2026-10-30")])
    assert client.get(f"/api/projects/{pid}/state").json() == before


def test_preview_reports_errors(client, pid):
    p = preview(client, pid, [move("uat", start_date="2026-11-30")])
    assert not p["valid"]
    assert p["errors"][0]["code"] == "invalid_dates"


def test_diff_lane_change_creation_deletion_and_dependencies(client, pid):
    base = client.get(f"/api/projects/{pid}/state").json()["version"]
    commit(
        client,
        pid,
        [
            move("prototype", workstream_id="ai"),
            move("data-model", name="Data Model v2"),
            {"entity_type": "deliverable", "entity_id": "security-review", "operation": "delete"},
            {"entity_type": "deliverable", "entity_id": "docs", "operation": "create", "fields": {"workstream_id": "ui", "name": "Docs", "start_date": "2026-10-19", "end_date": "2026-10-23"}},
        ],
    )
    diff = client.get(f"/api/projects/{pid}/diff", params={"from": base}).json()
    by_id = {d["id"]: d for d in diff["deliverables"]}
    assert by_id["prototype"]["lane_change"] == {"from": "ui", "to": "ai"}
    assert by_id["security-review"]["status"] == "removed"
    assert by_id["docs"]["status"] == "added"
    assert by_id["data-model"]["changes"] == [{"field": "name", "old": "Data Model", "new": "Data Model v2"}]
    assert [d["status"] for d in diff["dependencies"]] == ["removed"]


def test_baselines(client, pid):
    res = client.post(f"/api/projects/{pid}/baselines", json={"name": "Sept re-plan", "version": 4})
    assert res.status_code == 201
    assert res.json()["version"] == 4
    dup = client.post(f"/api/projects/{pid}/baselines", json={"name": "Sept re-plan", "version": 5})
    assert dup.status_code == 422
    missing = client.post(f"/api/projects/{pid}/baselines", json={"name": "Future", "version": 99})
    assert missing.status_code == 404
    names = [b["name"] for b in client.get(f"/api/projects/{pid}").json()["baselines"]]
    assert names == ["v1.0 Kickoff baseline", "Sept re-plan"]


def test_seed_metrics(client, pid):
    m = client.get(f"/api/projects/{pid}/metrics").json()
    s = m["summary"]
    assert s["commits"] == 5
    # prototype -7 (earlier, no prior slip), prod-ui +5
    assert s["gross_churn_days"] == 12
    assert s["recovery_days"] == 0
    assert next(d for d in m["deliverables"] if d["id"] == "prod-ui")["net_movement_days"] == 5


def test_recovery_counts_days_regained_after_a_slip(client, pid):
    commit(client, pid, [move("uat", end_date="2026-10-21")])
    commit(client, pid, [move("uat", end_date="2026-10-18")])
    m = client.get(f"/api/projects/{pid}/metrics").json()
    uat = next(d for d in m["deliverables"] if d["id"] == "uat")
    assert (uat["slip_days"], uat["recovery_days"], uat["net_movement_days"]) == (5, 3, 2)


def test_unknown_project_and_version(client, pid):
    assert client.get("/api/projects/nope/state").status_code == 404
    assert client.get(f"/api/projects/{pid}/versions/99").status_code == 404
