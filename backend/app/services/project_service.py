"""Projects and named baselines."""

from __future__ import annotations

import re
import uuid
from typing import Any

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..domain.commands import DomainError
from ..domain.models import Baseline, Commit, Project
from .commit_service import NotFound, require_project, utc_now
from .version_service import current_version


def project_to_dict(session: Session, project: Project) -> dict[str, Any]:
    return {
        "id": project.id,
        "name": project.name,
        "description": project.description,
        "created_at": project.created_at,
        "version": current_version(session, project.id),
        "baselines": list_baselines(session, project.id),
    }


def list_projects(session: Session) -> list[dict[str, Any]]:
    projects = session.scalars(select(Project).order_by(Project.created_at, Project.name)).all()
    return [project_to_dict(session, p) for p in projects]


def create_project(session: Session, name: str, description: str = "", project_id: str | None = None, created_at: str | None = None) -> Project:
    if not name or not name.strip():
        raise DomainError([{"change_index": None, "code": "name_required", "message": "A project name is required"}])
    if project_id is None:
        slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:32] or "project"
        project_id = f"{slug}-{uuid.uuid4().hex[:6]}"
    project = Project(id=project_id, name=name.strip(), description=description.strip(), created_at=created_at or utc_now())
    session.add(project)
    session.flush()
    return project


def list_baselines(session: Session, project_id: str) -> list[dict[str, Any]]:
    rows = session.execute(
        select(Baseline, Commit.seq_no)
        .join(Commit, Commit.id == Baseline.commit_id)
        .where(Baseline.project_id == project_id)
        .order_by(Commit.seq_no, Baseline.id)
    ).all()
    return [{"id": b.id, "name": b.name, "version": seq, "created_at": b.created_at} for b, seq in rows]


def create_baseline(session: Session, project_id: str, name: str, version: int, created_at: str | None = None) -> dict[str, Any]:
    require_project(session, project_id)
    if not name or not name.strip():
        raise DomainError([{"change_index": None, "code": "name_required", "message": "A baseline name is required"}])
    commit = session.scalar(select(Commit).where(Commit.project_id == project_id, Commit.seq_no == version))
    if commit is None:
        raise NotFound(f"commit #{version} not found")
    baseline = Baseline(project_id=project_id, name=name.strip(), commit_id=commit.id, created_at=created_at or utc_now())
    session.add(baseline)
    try:
        session.flush()
    except IntegrityError:
        raise DomainError([{"change_index": None, "code": "duplicate_baseline", "message": f"A baseline named “{name.strip()}” already exists"}]) from None
    return {"id": baseline.id, "name": baseline.name, "version": version, "created_at": baseline.created_at}
