import pytest
from sqlalchemy import func, select, text
from sqlalchemy.exc import DBAPIError

from app.domain.models import Commit, Event
from app.services import projection_service

from .conftest import commit, move


def count_commits(app, pid):
    with app.state.sessionmaker() as s:
        return s.scalar(select(func.count()).select_from(Commit).where(Commit.project_id == pid))


def test_single_date_change_creates_commit_and_event(client, pid):
    before = client.get(f"/api/projects/{pid}/state").json()
    result = commit(client, pid, [move("uat", end_date="2026-10-20")], reason="UAT needs an extra two days")
    assert result["version"] == before["version"] + 1
    assert result["commit"]["reason"] == "UAT needs an extra two days"
    assert result["commit"]["author"] == "tester"
    assert result["commit"]["events"] == [
        {"entity_type": "deliverable", "entity_id": "uat", "operation": "update", "field_name": "end_date", "old_value": "2026-10-16", "new_value": "2026-10-20"}
    ]
    uat = next(d for d in result["state"]["deliverables"] if d["id"] == "uat")
    assert uat["end_date"] == "2026-10-20"


@pytest.mark.parametrize("reason", ["", "   "])
def test_reason_is_required(client, app, pid, reason):
    n = count_commits(app, pid)
    res = commit(client, pid, [move("uat", end_date="2026-10-20")], reason=reason, expect=422)
    assert res["errors"][0]["code"] == "reason_required"
    assert count_commits(app, pid) == n


def test_multi_change_commit_is_atomic(client, app, pid):
    n = count_commits(app, pid)
    res = commit(
        client,
        pid,
        [move("uat", end_date="2026-10-20"), move("go-live", start_date="not-a-date")],
        expect=422,
    )
    assert res["errors"][0]["change_index"] == 1
    assert count_commits(app, pid) == n
    state = client.get(f"/api/projects/{pid}/state").json()["state"]
    assert next(d for d in state["deliverables"] if d["id"] == "uat")["end_date"] == "2026-10-16"


def test_projection_failure_rolls_back_everything(client, app, pid, monkeypatch):
    n = count_commits(app, pid)

    def boom(*_args, **_kwargs):
        raise RuntimeError("disk on fire")

    monkeypatch.setattr(projection_service, "apply_to_projection", boom)
    with pytest.raises(RuntimeError):
        client.post(
            f"/api/projects/{pid}/commits",
            json={"reason": "r", "author": "a", "base_version": 5, "changes": [move("uat", end_date="2026-10-20")]},
        )
    assert count_commits(app, pid) == n


def test_old_values_come_from_the_server(client, pid):
    # The client cannot inject old values: there is nowhere to put them, and events report the true prior value.
    result = commit(client, pid, [move("uat", end_date="2026-10-21")])
    assert result["commit"]["events"][0]["old_value"] == "2026-10-16"


def test_stale_base_version_is_rejected(client, app, pid):
    version = client.get(f"/api/projects/{pid}/state").json()["version"]
    commit(client, pid, [move("uat", end_date="2026-10-20")], base=version)
    res = commit(client, pid, [move("uat", end_date="2026-10-22")], base=version, expect=409)
    assert res["code"] == "VERSION_CONFLICT"
    assert res["current_version"] == version + 1


def test_no_op_commit_is_rejected(client, pid):
    res = commit(client, pid, [move("uat", end_date="2026-10-16")], expect=422)
    assert res["errors"][0]["code"] == "no_changes"


@pytest.mark.parametrize(
    "changes, code",
    [
        ([move("uat", start_date="2026-10-20")], "invalid_dates"),
        ([move("go-live", start_date="2026-10-29")], "invalid_milestone"),
        ([move("nope", start_date="2026-10-29")], "not_found"),
        ([move("uat", workstream_id="missing")], "missing_workstream"),
        ([move("uat", colour="red")], "invalid_field"),
        ([{"entity_type": "dependency", "operation": "create", "fields": {"predecessor_id": "go-live", "successor_id": "data-model"}}], "dependency_cycle"),
        ([{"entity_type": "dependency", "operation": "create", "fields": {"predecessor_id": "uat", "successor_id": "go-live"}}], "duplicate_dependency"),
        ([{"entity_type": "workstream", "entity_id": "testing", "operation": "delete"}], "missing_workstream"),
    ],
)
def test_validation_rules(client, pid, changes, code):
    res = commit(client, pid, changes, expect=422)
    assert code in {e["code"] for e in res["errors"]}


def test_create_and_link_in_one_commit(client, pid):
    result = commit(
        client,
        pid,
        [
            {"entity_type": "deliverable", "entity_id": "perf-test", "operation": "create", "fields": {"workstream_id": "testing", "name": "Perf Test", "start_date": "2026-10-19", "end_date": "2026-10-23"}},
            {"entity_type": "dependency", "operation": "create", "fields": {"predecessor_id": "perf-test", "successor_id": "go-live"}},
        ],
    )
    assert [e["operation"] for e in result["commit"]["events"]] == ["create", "create"]
    assert any(d["predecessor_id"] == "perf-test" for d in result["state"]["dependencies"])


def test_deleting_deliverable_cascades_its_dependencies(client, pid):
    result = commit(client, pid, [{"entity_type": "deliverable", "entity_id": "uat", "operation": "delete"}])
    ops = [(e["entity_type"], e["operation"]) for e in result["commit"]["events"]]
    assert ops.count(("dependency", "delete")) == 4
    assert ops[-1] == ("deliverable", "delete")
    assert not any("uat" in (d["predecessor_id"], d["successor_id"]) for d in result["state"]["dependencies"])


def test_history_is_append_only_in_the_database(app):
    with app.state.engine.connect() as conn:
        for sql in ("UPDATE commits SET reason = 'x'", "DELETE FROM commits", "UPDATE events SET new_value_json = 'x'", "DELETE FROM events"):
            with pytest.raises(DBAPIError, match="append-only"):
                conn.execute(text(sql))
            conn.rollback()


def test_undo_is_a_compensating_commit(client, pid):
    moved = commit(client, pid, [move("uat", start_date="2026-10-19", end_date="2026-10-23")])
    seq = moved["version"]
    res = client.post(f"/api/projects/{pid}/commits/{seq}/revert", json={"author": "tester", "base_version": seq})
    assert res.status_code == 201, res.json()
    body = res.json()
    assert body["version"] == seq + 1
    assert body["commit"]["reason"].startswith(f"Revert #{seq}")
    uat = next(d for d in body["state"]["deliverables"] if d["id"] == "uat")
    assert (uat["start_date"], uat["end_date"]) == ("2026-10-12", "2026-10-16")
    # The original commit is still in history.
    assert client.get(f"/api/projects/{pid}/commits/{seq}").json()["reason"] == "test change"


def test_undo_of_delete_restores_entity_and_links(client, pid):
    deleted = commit(client, pid, [{"entity_type": "deliverable", "entity_id": "uat", "operation": "delete"}])
    seq = deleted["version"]
    body = client.post(f"/api/projects/{pid}/commits/{seq}/revert", json={"author": "tester", "base_version": seq}).json()
    assert any(d["id"] == "uat" for d in body["state"]["deliverables"])
    assert sum(1 for d in body["state"]["dependencies"] if "uat" in (d["predecessor_id"], d["successor_id"])) == 4


def test_undo_refuses_when_later_commits_touched_the_same_value(client, pid):
    first = commit(client, pid, [move("uat", end_date="2026-10-20")])
    commit(client, pid, [move("uat", end_date="2026-10-21")])
    res = client.post(f"/api/projects/{pid}/commits/{first['version']}/revert", json={"author": "t", "base_version": first["version"] + 1})
    assert res.status_code == 422
    assert res.json()["errors"][0]["code"] == "revert_conflict"


def test_history_order_and_summary(client, pid):
    commits = client.get(f"/api/projects/{pid}/commits").json()
    assert [c["seq"] for c in commits] == list(range(1, len(commits) + 1))
    first = commits[0]
    assert first["baselines"] == ["v1.0 Kickoff baseline"]
    assert first["deliverables_affected"] == 8
    detail = client.get(f"/api/projects/{pid}/commits/3").json()
    assert detail["change_count"] == 2 and len(detail["events"]) == 2


def test_event_ordinals_are_preserved(app, pid):
    with app.state.sessionmaker() as s:
        rows = s.execute(select(Event.commit_id, Event.ordinal).order_by(Event.commit_id, Event.ordinal)).all()
    by_commit = {}
    for cid, ordinal in rows:
        by_commit.setdefault(cid, []).append(ordinal)
    assert all(v == list(range(len(v))) for v in by_commit.values())
