from __future__ import annotations

from typing import Any, Iterator

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import JSONResponse
from sqlalchemy.orm import Session

from ..domain.commands import BaselineRequest, CommitRequest, DomainError, PreviewRequest, ProjectCreateRequest, RevertRequest
from ..domain.events import serialize_state
from ..domain.validators import REASON_CATEGORIES
from ..services import commit_service, diff_service, projection_service, history_service, metrics_service, project_service, version_service
from ..services.commit_service import NotFound, VersionConflict

router = APIRouter(prefix="/api")


def get_session(request: Request) -> Iterator[Session]:
    # Write routes commit explicitly before returning; anything uncommitted is rolled back on close.
    with request.app.state.sessionmaker() as session:
        yield session


def _version_or_404(session: Session, project_id: str, version: int) -> int:
    current = version_service.current_version(session, project_id)
    if version < 0 or version > current:
        raise NotFound(f"version {version} does not exist (current is {current})")
    return version


@router.get("/categories")
def categories() -> list[dict[str, str]]:
    return REASON_CATEGORIES


@router.get("/projects")
def list_projects(session: Session = Depends(get_session)) -> list[dict[str, Any]]:
    return project_service.list_projects(session)


@router.post("/projects", status_code=201)
def create_project(body: ProjectCreateRequest, session: Session = Depends(get_session)) -> dict[str, Any]:
    project = project_service.create_project(session, body.name, body.description)
    session.commit()
    return project_service.project_to_dict(session, project)


@router.get("/projects/{project_id}")
def get_project(project_id: str, session: Session = Depends(get_session)) -> dict[str, Any]:
    return project_service.project_to_dict(session, commit_service.require_project(session, project_id))


@router.get("/projects/{project_id}/state")
def current_state(project_id: str, session: Session = Depends(get_session)) -> dict[str, Any]:
    commit_service.require_project(session, project_id)
    return {
        "version": version_service.current_version(session, project_id),
        "state": serialize_state(projection_service.load_state(session, project_id)),
    }


@router.get("/projects/{project_id}/versions/{version}")
def state_at_version(project_id: str, version: int, session: Session = Depends(get_session)) -> dict[str, Any]:
    commit_service.require_project(session, project_id)
    _version_or_404(session, project_id, version)
    return {"version": version, "state": serialize_state(version_service.state_at(session, project_id, version))}


@router.get("/projects/{project_id}/commits")
def list_commits(project_id: str, include_events: bool = False, session: Session = Depends(get_session)) -> list[dict[str, Any]]:
    commit_service.require_project(session, project_id)
    return history_service.list_commits(session, project_id, include_events)


@router.get("/projects/{project_id}/commits/{seq}")
def get_commit(project_id: str, seq: int, session: Session = Depends(get_session)) -> dict[str, Any]:
    commit_service.require_project(session, project_id)
    return history_service.get_commit(session, project_id, seq)


@router.post("/projects/{project_id}/preview")
def preview(project_id: str, body: PreviewRequest, session: Session = Depends(get_session)) -> dict[str, Any]:
    return commit_service.preview(session, project_id, body.changes)


@router.post("/projects/{project_id}/commits", status_code=201)
def create_commit(project_id: str, body: CommitRequest, session: Session = Depends(get_session)) -> dict[str, Any]:
    commit, events = commit_service.create_commit(
        session,
        project_id,
        reason=body.reason,
        author=body.author,
        base_version=body.base_version,
        changes=body.changes,
        category=body.category,
        reference=body.reference,
    )
    result = commit_service.commit_result(session, project_id, commit, events)
    session.commit()
    return result


@router.post("/projects/{project_id}/commits/{seq}/revert", status_code=201)
def revert_commit(project_id: str, seq: int, body: RevertRequest, session: Session = Depends(get_session)) -> dict[str, Any]:
    commit, events = commit_service.revert_commit(
        session, project_id, seq, author=body.author, base_version=body.base_version, reason=body.reason, category=body.category
    )
    result = commit_service.commit_result(session, project_id, commit, events)
    session.commit()
    return result


@router.get("/projects/{project_id}/diff")
def diff(
    project_id: str,
    from_version: int = Query(alias="from"),
    to_version: int | None = Query(default=None, alias="to"),
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    commit_service.require_project(session, project_id)
    if to_version is None:
        to_version = version_service.current_version(session, project_id)
    _version_or_404(session, project_id, from_version)
    _version_or_404(session, project_id, to_version)
    old = version_service.state_at(session, project_id, from_version)
    new = version_service.state_at(session, project_id, to_version)
    return {"from": from_version, "to": to_version, **diff_service.diff_states(old, new)}


@router.get("/projects/{project_id}/baselines")
def list_baselines(project_id: str, session: Session = Depends(get_session)) -> list[dict[str, Any]]:
    commit_service.require_project(session, project_id)
    return project_service.list_baselines(session, project_id)


@router.post("/projects/{project_id}/baselines", status_code=201)
def create_baseline(project_id: str, body: BaselineRequest, session: Session = Depends(get_session)) -> dict[str, Any]:
    baseline = project_service.create_baseline(session, project_id, body.name, body.version)
    session.commit()
    return baseline


@router.get("/projects/{project_id}/metrics")
def metrics(project_id: str, baseline: int | None = None, session: Session = Depends(get_session)) -> dict[str, Any]:
    commit_service.require_project(session, project_id)
    if baseline is not None:
        _version_or_404(session, project_id, baseline)
    return metrics_service.compute_metrics(session, project_id, baseline)


@router.get("/projects/{project_id}/export")
def export_project(project_id: str, session: Session = Depends(get_session)) -> dict[str, Any]:
    project = commit_service.require_project(session, project_id)
    return {
        "format": "backstroke-history/1",
        "project": {"id": project.id, "name": project.name, "description": project.description, "created_at": project.created_at},
        "baselines": project_service.list_baselines(session, project_id),
        "commits": history_service.list_commits(session, project_id, include_events=True),
    }


def install_error_handlers(app) -> None:
    @app.exception_handler(DomainError)
    async def _domain(_request, exc: DomainError):
        return JSONResponse(status_code=422, content={"code": "VALIDATION_FAILED", "errors": exc.errors})

    @app.exception_handler(VersionConflict)
    async def _conflict(_request, exc: VersionConflict):
        return JSONResponse(
            status_code=409,
            content={
                "code": "VERSION_CONFLICT",
                "base_version": exc.base_version,
                "current_version": exc.current_version,
                "message": f"The project changed since you started editing. Review v{exc.current_version} before committing.",
            },
        )

    @app.exception_handler(NotFound)
    async def _not_found(_request, exc: NotFound):
        return JSONResponse(status_code=404, content={"code": "NOT_FOUND", "message": str(exc)})
