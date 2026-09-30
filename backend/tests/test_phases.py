"""Optional phases inside a deliverable: validation, history, diff and metrics."""

import pytest

from app.domain.events import Event, apply_events, empty_state, serialize_state
from app.domain.phases import phase_spans
from app.seed import CHECKOUT_HISTORY, CHECKOUT_ID, CHECKOUT_PROGRESS
from app.services import projection_service, version_service

from .conftest import commit, move

PHASES = [{"name": "Dev", "days": 3}, {"name": "Review", "days": 1}, {"name": "UAT"}]


def deliverable(client, pid, did):
    state = client.get(f"/api/projects/{pid}/state").json()["state"]
    return next(d for d in state["deliverables"] if d["id"] == did)


def test_plain_deliverables_have_no_phases(client, pid):
    assert deliverable(client, pid, "uat")["phases"] is None


def test_break_into_phases_and_remove_them(client, pid):
    # UAT runs 12–16 Oct (5 days): Dev 12–14, Review 15, UAT 16.
    result = commit(client, pid, [move("uat", phases=PHASES)], reason="Track UAT by phase")
    assert result["commit"]["events"] == [
        {"entity_type": "deliverable", "entity_id": "uat", "operation": "update", "field_name": "phases", "old_value": None, "new_value": PHASES}
    ]
    d = deliverable(client, pid, "uat")
    assert [(s["name"], s["start_date"], s["end_date"], s["days"]) for s in phase_spans(d)] == [
        ("Dev", "2026-10-12", "2026-10-14", 3),
        ("Review", "2026-10-15", "2026-10-15", 1),
        ("UAT", "2026-10-16", "2026-10-16", 1),
    ]
    commit(client, pid, [move("uat", phases=None)], reason="Back to one bar")
    assert deliverable(client, pid, "uat")["phases"] is None


def test_moving_a_phased_deliverable_keeps_its_phases(client, pid):
    commit(client, pid, [move("uat", phases=PHASES)])
    result = commit(client, pid, [move("uat", start_date="2026-10-19", end_date="2026-10-23")])
    assert [e["field_name"] for e in result["commit"]["events"]] == ["start_date", "end_date"]
    assert deliverable(client, pid, "uat")["phases"] == PHASES


def test_gap_before_a_phase(client, pid):
    # UAT runs 12–16 Oct: Dev 12–13, a 1-day gap on the 14th, Review 15, UAT 16.
    phases = [{"name": "Dev", "days": 2}, {"name": "Review", "days": 1, "gap": 1}, {"name": "UAT"}]
    commit(client, pid, [move("uat", phases=phases)])
    d = deliverable(client, pid, "uat")
    assert d["phases"] == phases
    assert [(s["name"], s["start_date"], s["end_date"]) for s in phase_spans(d)] == [
        ("Dev", "2026-10-12", "2026-10-13"),
        ("Review", "2026-10-15", "2026-10-15"),
        ("UAT", "2026-10-16", "2026-10-16"),
    ]


def test_zero_gap_is_the_default_and_is_left_out(client, pid):
    commit(client, pid, [move("uat", phases=[{"name": "Dev", "days": 2, "gap": 0}, {"name": "UAT", "gap": 0}])])
    assert deliverable(client, pid, "uat")["phases"] == [{"name": "Dev", "days": 2}, {"name": "UAT"}]


def test_phase_names_are_trimmed(client, pid):
    commit(client, pid, [move("uat", phases=[{"name": " Dev ", "days": 2}, {"name": "UAT "}])])
    assert deliverable(client, pid, "uat")["phases"] == [{"name": "Dev", "days": 2}, {"name": "UAT"}]


@pytest.mark.parametrize(
    "phases, code",
    [
        ([{"name": "Only"}], "invalid_field"),
        ([{"name": "Dev", "days": 2}, {"name": "UAT", "days": 3}], "invalid_field"),
        ([{"name": "Dev"}, {"name": "UAT"}], "invalid_field"),
        ([{"name": "Dev", "days": 0}, {"name": "UAT"}], "invalid_field"),
        ([{"name": "Dev", "days": True}, {"name": "UAT"}], "invalid_field"),
        ([{"name": "Dev", "days": 2}, {"name": "dev"}], "invalid_field"),
        ([{"name": "", "days": 2}, {"name": "UAT"}], "invalid_field"),
        ([{"name": "Dev", "days": 2, "owner": "x"}, {"name": "UAT"}], "invalid_field"),
        ("Dev, UAT", "invalid_field"),
        ([{"name": "Dev", "days": 2, "gap": 1}, {"name": "UAT"}], "invalid_field"),
        ([{"name": "Dev", "days": 2}, {"name": "UAT", "gap": -1}], "invalid_field"),
        # Gaps count toward the length: 2 + 3 gap days leave nothing for UAT in 5 days.
        ([{"name": "Dev", "days": 2}, {"name": "UAT", "gap": 3}], "phases_do_not_fit"),
        # UAT is 5 days long; fixed phases of 5 days leave nothing for the last phase.
        ([{"name": "Dev", "days": 4}, {"name": "Review", "days": 1}, {"name": "UAT"}], "phases_do_not_fit"),
    ],
)
def test_invalid_phases_are_rejected(client, pid, phases, code):
    res = commit(client, pid, [move("uat", phases=phases)], expect=422)
    assert res["errors"][0]["code"] == code


def test_shrinking_a_deliverable_below_its_phases_is_rejected(client, pid):
    commit(client, pid, [move("uat", phases=PHASES)])
    res = commit(client, pid, [move("uat", end_date="2026-10-15")], expect=422)
    assert res["errors"][0]["code"] == "phases_do_not_fit"


def test_milestones_cannot_have_phases(client, pid):
    res = commit(client, pid, [move("go-live", phases=[{"name": "A", "days": 1}, {"name": "B"}])], expect=422)
    assert res["errors"][0]["code"] == "invalid_phases"


def test_undo_restores_previous_phases(client, pid):
    commit(client, pid, [move("uat", phases=PHASES)])
    changed = commit(client, pid, [move("uat", phases=[{"name": "Dev", "days": 2}, {"name": "UAT"}])])
    seq = changed["version"]
    res = client.post(f"/api/projects/{pid}/commits/{seq}/revert", json={"author": "tester", "base_version": seq})
    assert res.status_code == 201, res.json()
    assert deliverable(client, pid, "uat")["phases"] == PHASES


def test_create_events_written_before_phases_replay_as_plain():
    state = apply_events(
        empty_state(),
        [
            Event("workstream", "w", "create", new_value={"name": "W", "order_index": 0}),
            Event("deliverable", "d", "create", new_value={"workstream_id": "w", "type": "task", "name": "D", "start_date": "2026-01-01", "end_date": "2026-01-05"}),
        ],
    )
    assert state["deliverables"]["d"]["phases"] is None


def test_checkout_seed_replays_to_its_projection(session):
    version = version_service.current_version(session, CHECKOUT_ID)
    assert version == len(CHECKOUT_HISTORY) + len(CHECKOUT_PROGRESS)
    replayed = version_service.state_at(session, CHECKOUT_ID, version)
    assert serialize_state(replayed) == serialize_state(projection_service.load_state(session, CHECKOUT_ID))


def test_diff_reports_per_phase_change(client):
    diff = client.get(f"/api/projects/{CHECKOUT_ID}/diff", params={"from": 1, "to": 2}).json()
    pay = next(d for d in diff["deliverables"] if d["id"] == "pay-142")
    assert pay["end_delta_days"] == 4
    assert [(p["name"], p["before_days"], p["after_days"], p["delta_days"]) for p in pay["phase_deltas"]] == [
        ("Dev", 11, 16, 5),
        ("Review", 5, 6, 1),
        ("UAT", 10, 8, -2),
    ]


def test_diff_skips_phase_deltas_when_phases_differ(client):
    # WEB-219 was a plain bar at #1 and was broken into phases at #5.
    diff = client.get(f"/api/projects/{CHECKOUT_ID}/diff", params={"from": 1, "to": 5}).json()
    web = next(d for d in diff["deliverables"] if d["id"] == "web-219")
    assert "phase_deltas" not in web


def test_metrics_show_where_the_time_went(client):
    m = client.get(f"/api/projects/{CHECKOUT_ID}/metrics").json()
    by_phase = m["by_phase"]
    # pay-142, pay-151, acc-88, acc-93 and web-204 had the same phases at the baseline; web-219 did not.
    assert by_phase["compared"] == 5
    assert by_phase["not_compared"] == 1
    rows = {p["name"]: p for p in by_phase["phases"]}
    assert [p["name"] for p in by_phase["phases"]] == ["Dev", "Review", "UAT"]
    assert rows["Dev"]["net_days"] == 5 + 7
    assert rows["Review"]["net_days"] == 1 + 1
    # pay-142 UAT −2, web-204 UAT +2
    assert (rows["UAT"]["net_days"], rows["UAT"]["longer_days"], rows["UAT"]["shorter_days"]) == (0, 2, 2)
    # ACC-93 Review now waits two days after Dev.
    assert by_phase["gaps"] == {"net_days": 2, "longer_days": 2, "shorter_days": 0}


def test_diff_reports_gap_and_start_shift(client):
    diff = client.get(f"/api/projects/{CHECKOUT_ID}/diff", params={"from": 5, "to": 6}).json()
    acc = next(d for d in diff["deliverables"] if d["id"] == "acc-93")
    review = next(p for p in acc["phase_deltas"] if p["name"] == "Review")
    assert (review["before_gap_days"], review["after_gap_days"], review["start_delta_days"], review["delta_days"]) == (0, 2, 2, 0)
