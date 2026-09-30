"""Deterministic planning-history metrics.

Movement is measured on a deliverable's planned end date (its delivery date),
from `end_date` update events. Metrics describe how the plan behaved; they are
not scores.
"""

from __future__ import annotations

from datetime import date, datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..domain.models import Commit
from ..domain.phases import phase_deltas, phase_spans
from ..domain.validators import PROGRESS_CATEGORY
from . import version_service
from .dependency_service import days_between
from .history_service import _events_by_commit
from .project_service import list_baselines

LATE_STAGE_WINDOW_DAYS = 14


def _commit_date(created_at: str) -> date:
    return datetime.strptime(created_at[:10], "%Y-%m-%d").date()


def compute_metrics(session: Session, project_id: str, baseline_version: int | None = None, today: date | None = None) -> dict[str, Any]:
    today = today or date.today()
    version = version_service.current_version(session, project_id)
    commits = session.scalars(select(Commit).where(Commit.project_id == project_id).order_by(Commit.seq_no)).all()
    events = _events_by_commit(session, [c.id for c in commits])
    states = version_service.states_through(session, project_id, version)

    if baseline_version is None:
        baselines = list_baselines(session, project_id)
        baseline_version = baselines[0]["version"] if baselines else min(1, version)
    baseline = states[baseline_version]
    current = states[version]

    per_deliverable: dict[str, dict[str, Any]] = {}
    by_category: dict[str, dict[str, Any]] = {}
    by_workstream: dict[str, dict[str, Any]] = {}
    propagation: list[dict[str, Any]] = []
    outstanding_slip: dict[str, int] = {}
    totals = {"gross_churn_days": 0, "recovery_days": 0, "late_stage_churn_days": 0, "slip_days": 0}

    def deliverable_entry(d_id: str, seq: int) -> dict[str, Any]:
        if d_id not in per_deliverable:
            per_deliverable[d_id] = {
                "id": d_id,
                "commit_count": 0,
                "gross_churn_days": 0,
                "slip_days": 0,
                "recovery_days": 0,
                "last_date_change_seq": None,
                "last_date_change_at": None,
                "created_seq": seq,
            }
        return per_deliverable[d_id]

    finish_plans = _finish_plans(commits, states)

    for commit in commits:
        seq = commit.seq_no
        if commit.category == PROGRESS_CATEGORY:
            continue  # progress is not a plan change: no churn, slip or commit counts
        after = states[seq]
        category = commit.category or "uncategorized"
        cat = by_category.setdefault(category, {"category": category, "commit_count": 0, "later_days": 0, "earlier_days": 0, "movements": 0})
        cat["commit_count"] += 1

        touched: set[str] = set()
        end_delta: dict[str, int] = {}
        for e in events[commit.id]:
            if e.entity_type != "deliverable":
                continue
            entry = deliverable_entry(e.entity_id, seq)
            touched.add(e.entity_id)
            if e.operation == "update" and e.field_name in ("start_date", "end_date"):
                entry["last_date_change_seq"] = seq
                entry["last_date_change_at"] = commit.created_at
            if not (e.operation == "update" and e.field_name == "end_date"):
                continue

            delta = days_between(e.old_value, e.new_value)
            end_delta[e.entity_id] = delta
            magnitude = abs(delta)
            entry["gross_churn_days"] += magnitude
            totals["gross_churn_days"] += magnitude
            cat["movements"] += 1
            if delta > 0:
                cat["later_days"] += delta
                entry["slip_days"] += delta
                totals["slip_days"] += delta
                outstanding_slip[e.entity_id] = outstanding_slip.get(e.entity_id, 0) + delta
            else:
                cat["earlier_days"] += magnitude
                regained = min(magnitude, outstanding_slip.get(e.entity_id, 0))
                outstanding_slip[e.entity_id] = outstanding_slip.get(e.entity_id, 0) - regained
                entry["recovery_days"] += regained
                totals["recovery_days"] += regained
            if days_between(commit.created_at[:10], e.old_value) <= LATE_STAGE_WINDOW_DAYS:
                totals["late_stage_churn_days"] += magnitude

        for d_id in touched:
            per_deliverable[d_id]["commit_count"] += 1
        lanes = set()
        for d_id in touched:
            d = after["deliverables"].get(d_id) or states[seq - 1]["deliverables"].get(d_id)
            if d:
                lanes.add(d["workstream_id"])
        for lane in lanes:
            ws = by_workstream.setdefault(lane, {"id": lane, "commit_count": 0, "gross_churn_days": 0})
            ws["commit_count"] += 1
        for d_id, delta in end_delta.items():
            d = after["deliverables"].get(d_id)
            if d:
                by_workstream.setdefault(d["workstream_id"], {"id": d["workstream_id"], "commit_count": 0, "gross_churn_days": 0})["gross_churn_days"] += abs(delta)

        for dep in after["dependencies"].values():
            p, s = dep["predecessor_id"], dep["successor_id"]
            if end_delta.get(p, 0) > 0 and end_delta.get(s, 0) > 0:
                propagation.append({"seq": seq, "predecessor_id": p, "successor_id": s, "predecessor_delta_days": end_delta[p], "successor_delta_days": end_delta[s]})

    deliverables_out = []
    for d_id, d in current["deliverables"].items():
        entry = deliverable_entry(d_id, version)
        base = baseline["deliverables"].get(d_id)
        last_change = entry["last_date_change_at"]
        created_commit = next((c for c in commits if c.seq_no == entry["created_seq"]), None)
        since = last_change or (created_commit.created_at if created_commit else None)
        deliverables_out.append(
            {
                **entry,
                "name": d["name"],
                "type": d["type"],
                "workstream_id": d["workstream_id"],
                "baseline_end_date": base["end_date"] if base else None,
                "current_end_date": d["end_date"],
                "net_movement_days": days_between(base["end_date"], d["end_date"]) if base else None,
                "unchanged_for_days": (today - _commit_date(since)).days if since else None,
            }
        )
    deliverables_out.sort(key=lambda d: (-(d["gross_churn_days"]), d["name"]))

    by_phase = _phase_movement(baseline, current)

    net_values = [d["net_movement_days"] for d in deliverables_out if d["net_movement_days"] is not None]
    milestones = [d for d in deliverables_out if d["type"] == "milestone"]
    for ws_id, ws in by_workstream.items():
        lane = current["workstreams"].get(ws_id) or baseline["workstreams"].get(ws_id)
        ws["name"] = lane["name"] if lane else ws_id

    return {
        "version": version,
        "baseline_version": baseline_version,
        "summary": {
            # Plan changes only; progress commits are counted in "finishes".
            "commits": sum(1 for c in commits if c.category != PROGRESS_CATEGORY),
            "events": sum(len(events[c.id]) for c in commits if c.category != PROGRESS_CATEGORY),
            **totals,
            "net_movement_days": sum(net_values),
            "max_net_movement_days": max(net_values, default=0),
            "propagated_movements": len(propagation),
        },
        "milestones": [
            {"id": m["id"], "name": m["name"], "baseline_date": m["baseline_end_date"], "current_date": m["current_end_date"], "net_movement_days": m["net_movement_days"]}
            for m in sorted(milestones, key=lambda m: m["current_end_date"])
        ],
        "deliverables": deliverables_out,
        "by_category": sorted(by_category.values(), key=lambda c: -(c["later_days"] + c["earlier_days"])),
        "by_workstream": sorted(by_workstream.values(), key=lambda w: -w["gross_churn_days"]),
        "propagation": propagation,
        "by_phase": by_phase,
        "finishes": _finishes(current, baseline, finish_plans),
        "late_stage_window_days": LATE_STAGE_WINDOW_DAYS,
    }


def _planned_ends(d: dict[str, Any]) -> dict[str | None, tuple[str, str | None]]:
    """(planned end, finish date) for the deliverable (key None) or each of its phases (key: name)."""
    if d.get("phases"):
        return {s["name"]: (s["end_date"], p.get("finished_on")) for s, p in zip(phase_spans(d), d["phases"])}
    return {None: (d["end_date"], d.get("finished_on"))}


def _finish_plans(commits: list[Commit], states: dict[int, dict[str, Any]]) -> dict[tuple[str, str | None], str]:
    """The planned end at the moment each finish was recorded, so a later replan can't hide a late finish."""
    plans: dict[tuple[str, str | None], str] = {}
    for commit in commits:
        if commit.category != PROGRESS_CATEGORY:
            continue
        before, after = states[commit.seq_no - 1], states[commit.seq_no]
        for d_id, d in after["deliverables"].items():
            old = _planned_ends(before["deliverables"].get(d_id) or d)
            for key, (end, finished) in _planned_ends(d).items():
                if finished and old.get(key, (None, None))[1] != finished:
                    plans[(d_id, key)] = end
    return plans


def _finishes(current: dict[str, Any], baseline: dict[str, Any], plans: dict[tuple[str, str | None], str]) -> dict[str, Any]:
    """Everything finished so far, against the plan when it was marked done and against the baseline."""
    rows = []
    for d in sorted(current["deliverables"].values(), key=lambda d: (d["start_date"], d["id"])):
        base = baseline["deliverables"].get(d["id"])
        base_ends = _planned_ends(base) if base else {}
        for key, (end, finished) in _planned_ends(d).items():
            if not finished:
                continue
            planned = plans.get((d["id"], key), end)
            base_end = base_ends.get(key, (None, None))[0]
            rows.append(
                {
                    "deliverable_id": d["id"],
                    "name": d["name"],
                    "phase": key,
                    "finished_on": finished,
                    "planned_end": planned,
                    "delta_days": days_between(planned, finished),
                    "baseline_end": base_end,
                    "baseline_delta_days": days_between(base_end, finished) if base_end else None,
                }
            )
    rows.sort(key=lambda r: r["finished_on"], reverse=True)
    return {"on_time": sum(1 for r in rows if r["delta_days"] <= 0), "total": len(rows), "rows": rows}


def _phase_movement(baseline: dict[str, Any], current: dict[str, Any]) -> dict[str, Any]:
    """Where the time went: change in each phase's length since the baseline.

    Gaps between phases (time spent on other work) are totalled separately.

    Only deliverables whose phases are the same in both versions can be compared
    phase by phase. The rest (no phases, added later, or re-phased) are counted so
    the UI can say what was left out.
    """
    phases: dict[str, dict[str, Any]] = {}
    gaps = {"net_days": 0, "longer_days": 0, "shorter_days": 0}
    compared = not_compared = 0
    for d in sorted(current["deliverables"].values(), key=lambda d: (d["start_date"], d["id"])):
        if not d.get("phases"):
            continue
        deltas = phase_deltas(baseline["deliverables"].get(d["id"]), d)
        if deltas is None:
            not_compared += 1
            continue
        compared += 1
        for p in deltas:
            row = phases.setdefault(p["name"], {"name": p["name"], "net_days": 0, "longer_days": 0, "shorter_days": 0, "deliverables": 0})
            row["net_days"] += p["delta_days"]
            row["longer_days"] += max(0, p["delta_days"])
            row["shorter_days"] += max(0, -p["delta_days"])
            row["deliverables"] += 1
            gap_delta = p["after_gap_days"] - p["before_gap_days"]
            gaps["net_days"] += gap_delta
            gaps["longer_days"] += max(0, gap_delta)
            gaps["shorter_days"] += max(0, -gap_delta)
    return {"compared": compared, "not_compared": not_compared, "phases": list(phases.values()), "gaps": gaps}
