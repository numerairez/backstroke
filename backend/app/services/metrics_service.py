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

    for commit in commits:
        seq = commit.seq_no
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

    net_values = [d["net_movement_days"] for d in deliverables_out if d["net_movement_days"] is not None]
    milestones = [d for d in deliverables_out if d["type"] == "milestone"]
    for ws_id, ws in by_workstream.items():
        lane = current["workstreams"].get(ws_id) or baseline["workstreams"].get(ws_id)
        ws["name"] = lane["name"] if lane else ws_id

    return {
        "version": version,
        "baseline_version": baseline_version,
        "summary": {
            "commits": len(commits),
            "events": sum(len(v) for v in events.values()),
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
        "late_stage_window_days": LATE_STAGE_WINDOW_DAYS,
    }
