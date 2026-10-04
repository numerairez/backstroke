"""Knowledge base export: one Markdown file with the plan, history, meetings and register."""

from app.seed import CHECKOUT_ID

from .conftest import move


def knowledge(client, pid, **params):
    res = client.get(f"/api/projects/{pid}/export/knowledge", params={"as_of": "2026-10-04", **params})
    assert res.status_code == 200
    assert res.headers["content-type"].startswith("text/markdown")
    return res.text


def test_sections_and_conventions(client, pid):
    text = knowledge(client, pid)
    assert text.startswith("# Example Program: project knowledge base")
    for heading in ["## How to read this file", "## Summary", "## Current plan (version #5)", "## Dependencies", "## Baselines", "## Change history", "## Meetings", "## Register"]:
        assert heading in text
    assert "Status is as of 2026-10-04." in text


def test_plan_rows_carry_status_as_of_the_given_day(client, pid):
    text = knowledge(client, pid)
    assert "| Data Mapping | 2026-09-28 | 2026-10-09 | In progress, 5 days left |  |" in text
    assert "| Go-Live (milestone) | 2026-10-30 | | | |" in text
    assert "- Data Mapping must finish before Data Ready is due" in text
    assert "- Data Ready must finish before UAT starts" in text


def test_history_says_what_moved_and_where_it_was_agreed(client, pid):
    text = knowledge(client, pid)
    assert "### #5 · 2026-09-24 · Scope · Priya (PMO)" in text
    assert "Agreed at: Steering committee 2026-09-24" in text
    assert "- Agent Build: start 2026-09-14 → 2026-09-10 (-4d)" in text
    assert "- Created 4 workstreams, 8 deliverables, 7 dependencies" in text
    assert "Reference: InfoSec review request #218" in text


def test_phases_and_progress_in_history(client):
    text = knowledge(client, CHECKOUT_ID)
    assert "- WEB-219 Order history: split into phases Dev 16d, Review 3d, UAT" in text
    assert "- PAY-142 Card vault migration: Dev marked done 2026-09-23" in text
    assert "| ACC-88 Login with passkeys | 2026-09-14 | 2026-10-16 | Behind: Dev is 8 days late |" in text


def test_register_and_meetings(client, pid):
    text = knowledge(client, pid)
    assert "| A-1 | Get the vendor to confirm feed schema v3 by 2 Oct | Ravi | Data Mapping | Steering committee 2026-09-24 | 2026-10-02 | open, overdue |" in text
    assert "| A-2 | Name an owner for the escalation tool API by 1 Oct | Marco | Agent Build | Steering committee 2026-09-24 | 2026-10-01 | done 2026-09-30 |" in text
    assert "Absent: Lena" in text
    assert "> ?risk @Ravi vendor feed schema may change late" in text
    assert "- Register: 1 open action (1 overdue), 2 open risks, 2 active decisions." in text


def test_options_leave_out_history_notes_and_closed_items(client, pid):
    text = knowledge(client, pid, history="false", notes="false", closed="false")
    assert "## Change history" not in text
    assert "> ?risk" not in text
    assert "| A-2 |" not in text and "| A-1 |" in text


def test_a_meeting_commit_and_programme_items_show_up(client, pid):
    m = client.post(f"/api/projects/{pid}/meetings", json={"title": "Steering committee", "held_on": "2026-10-08"}).json()
    base = client.get(f"/api/projects/{pid}/state").json()["version"]
    client.post(
        f"/api/projects/{pid}/meetings/{m['id']}/finish",
        json={
            "author": "tester",
            "items": [{"kind": "action", "text": "Book the comms slot | room 4", "owner": "Priya"}],
            "commit": {"reason": "Accept the slip", "base_version": base, "changes": [move("data-mapping", end_date="2026-10-16")]},
        },
    )
    text = knowledge(client, pid)
    assert "Agreed at: Steering committee 2026-10-08" in text
    assert "- Data Mapping: end 2026-10-09 → 2026-10-16 (+7d)" in text
    # Pipes in cell text are escaped so the table holds together.
    assert "| A-3 | Book the comms slot \\| room 4 | Priya | programme |" in text
