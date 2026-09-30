"""AC-04 / AC-05: every version can be reconstructed, and full replay equals the projection."""

from app.domain.events import Event, ReplayError, apply_events, empty_state, serialize_state
from app.seed import HISTORY
from app.services import projection_service, version_service

from .conftest import commit, move


def test_replay_equals_projection_after_seed(session, pid):
    version = version_service.current_version(session, pid)
    assert version == len(HISTORY)
    replayed = version_service.state_at(session, pid, version)
    assert serialize_state(replayed) == serialize_state(projection_service.load_state(session, pid))


def test_replay_equals_projection_after_many_edits(client, app, pid):
    commit(client, pid, [move("uat", start_date="2026-10-13", end_date="2026-10-19")])
    commit(client, pid, [{"entity_type": "dependency", "entity_id": "d4", "operation": "delete"}])
    commit(client, pid, [{"entity_type": "deliverable", "entity_id": "prototype", "operation": "delete"}])
    commit(client, pid, [{"entity_type": "workstream", "entity_id": "ui", "operation": "update", "fields": {"name": "Front end"}}])
    with app.state.sessionmaker() as s:
        v = version_service.current_version(s, pid)
        assert serialize_state(version_service.state_at(s, pid, v)) == serialize_state(projection_service.load_state(s, pid))


def test_every_version_is_reconstructable_and_incremental(session, pid):
    version = version_service.current_version(session, pid)
    all_states = version_service.states_through(session, pid, version)
    for v in range(version + 1):
        assert serialize_state(version_service.state_at(session, pid, v)) == serialize_state(all_states[v])
    assert all_states[0] == empty_state()


def test_historical_version_is_unchanged_by_later_commits(client, pid):
    before = client.get(f"/api/projects/{pid}/versions/1").json()
    commit(client, pid, [move("data-model", end_date="2026-09-26")])
    after = client.get(f"/api/projects/{pid}/versions/1").json()
    assert before == after


def test_apply_events_is_pure_and_rejects_impossible_events():
    state = empty_state()
    created = apply_events(state, [Event("workstream", "w", "create", new_value={"name": "W", "order_index": 0})])
    assert state == empty_state()
    assert created["workstreams"]["w"] == {"id": "w", "name": "W", "order_index": 0}
    try:
        apply_events(created, [Event("workstream", "w", "create", new_value={"name": "W", "order_index": 0})])
    except ReplayError:
        pass
    else:
        raise AssertionError("duplicate create should fail")
