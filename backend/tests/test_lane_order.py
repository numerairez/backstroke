"""Lane and row order are display settings: saved at once for everyone, never a commit."""

from fastapi.testclient import TestClient

from .conftest import sign_up


def test_lane_order_is_saved_without_a_commit(client, app, pid):
    state = client.get(f"/api/projects/{pid}/state").json()
    lanes = [w["id"] for w in state["state"]["workstreams"]]
    assert client.get(f"/api/projects/{pid}").json()["lane_order"] == []

    flipped = list(reversed(lanes))
    saved = client.put(f"/api/projects/{pid}/lane-order", json={"workstream_ids": [*flipped, "nope", flipped[0]]}).json()
    assert saved["lane_order"] == flipped  # unknown ids and repeats dropped
    assert saved["version"] == state["version"]  # no commit
    assert client.get(f"/api/projects/{pid}/state").json() == state  # the plan is untouched

    # Any member can reorder, and everyone sees it.
    with TestClient(app) as ravi:
        sign_up(ravi, "ravi")
        assert ravi.put(f"/api/projects/{pid}/lane-order", json={"workstream_ids": lanes}).status_code == 200
    assert client.get(f"/api/projects/{pid}").json()["lane_order"] == lanes


def test_row_order_is_saved_without_a_commit(client, pid):
    state = client.get(f"/api/projects/{pid}/state").json()
    rows = [d["id"] for d in state["state"]["deliverables"]][::-1]
    saved = client.put(f"/api/projects/{pid}/row-order", json={"deliverable_ids": ["nope", *rows, rows[0]]}).json()
    assert saved["row_order"] == rows
    assert client.get(f"/api/projects/{pid}/state").json() == state
