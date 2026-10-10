from __future__ import annotations

from typing import Any, Iterator

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import JSONResponse, PlainTextResponse
from sqlalchemy.orm import Session

from ..domain.commands import BaselineRequest, CommitRequest, DomainError, PreviewRequest, ProgressRequest, ProjectCreateRequest, RevertRequest
from ..domain.events import serialize_state
from ..domain.meetings import FinishMeetingRequest, ItemCreateRequest, ItemInput, ItemUpdateRequest, MeetingCreateRequest, MeetingUpdateRequest, PeopleRequest
from ..domain.validators import REASON_CATEGORIES
from ..services import commit_service, diff_service, history_service, knowledge_service, meeting_service, people_service, trail_service, metrics_service, project_service, projection_service, version_service
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
def categories() -> list[dict[str, Any]]:
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


@router.post("/projects/{project_id}/progress", status_code=201)
def record_progress(project_id: str, body: ProgressRequest, session: Session = Depends(get_session)) -> dict[str, Any]:
    """Mark done or reopen: one click, recorded as its own commit without a reason."""
    commit, events = commit_service.record_progress(
        session,
        project_id,
        author=body.author,
        base_version=body.base_version,
        deliverable_id=body.deliverable_id,
        phase=body.phase,
        finished_on=body.finished_on,
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
        "people": people_service.list_people(session, project_id),
        "meetings": meeting_service.list_meetings(session, project_id),
        "register": meeting_service.list_items(session, project_id),
    }


@router.get("/projects/{project_id}/export/knowledge", response_class=PlainTextResponse)
def export_knowledge(
    project_id: str,
    history: bool = True,
    notes: bool = True,
    closed: bool = True,
    as_of: str | None = None,
    session: Session = Depends(get_session),
) -> PlainTextResponse:
    """The project as one Markdown file for pasting into an LLM: plan, history, meetings, register."""
    markdown = knowledge_service.build_markdown(
        session, project_id, today=as_of, include_history=history, include_notes=notes, include_closed=closed
    )
    return PlainTextResponse(markdown, media_type="text/markdown; charset=utf-8")


@router.get("/projects/{project_id}/people")
def list_people(project_id: str, session: Session = Depends(get_session)) -> dict[str, Any]:
    return people_service.list_people(session, project_id)


@router.put("/projects/{project_id}/people")
def replace_people(project_id: str, body: PeopleRequest, session: Session = Depends(get_session)) -> dict[str, Any]:
    """Save the whole roster. Order is kept; people and groups are unique ignoring case."""
    people = people_service.replace_people(session, project_id, body.people, body.groups)
    session.commit()
    return people


@router.get("/projects/{project_id}/meetings")
def list_meetings(project_id: str, session: Session = Depends(get_session)) -> list[dict[str, Any]]:
    return meeting_service.list_meetings(session, project_id)


@router.post("/projects/{project_id}/meetings", status_code=201)
def create_meeting(project_id: str, body: MeetingCreateRequest, session: Session = Depends(get_session)) -> dict[str, Any]:
    meeting = meeting_service.create_meeting(session, project_id, body.title, body.held_on, body.attendees)
    session.commit()
    return meeting_service.meeting_to_dict(session, meeting)


@router.get("/projects/{project_id}/meetings/{meeting_id}")
def get_meeting(project_id: str, meeting_id: int, session: Session = Depends(get_session)) -> dict[str, Any]:
    return meeting_service.meeting_to_dict(session, meeting_service.require_meeting(session, project_id, meeting_id))


@router.patch("/projects/{project_id}/meetings/{meeting_id}")
def update_meeting(project_id: str, meeting_id: int, body: MeetingUpdateRequest, session: Session = Depends(get_session)) -> dict[str, Any]:
    meeting = meeting_service.update_meeting(session, project_id, meeting_id, body)
    session.commit()
    return meeting_service.meeting_to_dict(session, meeting)


@router.delete("/projects/{project_id}/meetings/{meeting_id}", status_code=204)
def delete_meeting(project_id: str, meeting_id: int, session: Session = Depends(get_session)) -> None:
    meeting_service.delete_meeting(session, project_id, meeting_id)
    session.commit()


@router.post("/projects/{project_id}/meetings/{meeting_id}/finish", status_code=201)
def finish_meeting(project_id: str, meeting_id: int, body: FinishMeetingRequest, session: Session = Depends(get_session)) -> dict[str, Any]:
    """Record the meeting's actions, risks and decisions, plus at most one plan commit, atomically."""
    result = meeting_service.finish_meeting(session, project_id, meeting_id, body)
    session.commit()
    return result


@router.get("/projects/{project_id}/meetings/{meeting_id}/preread")
def meeting_preread(project_id: str, meeting_id: int, session: Session = Depends(get_session)) -> dict[str, Any]:
    """Changes since the series last met, what needs attention, what's coming up, and a draft agenda."""
    return trail_service.preread(session, project_id, meeting_id)


@router.get("/projects/{project_id}/deliverables/{deliverable_id}/trail")
def deliverable_trail(project_id: str, deliverable_id: str, session: Session = Depends(get_session)) -> dict[str, Any]:
    """Every commit, meeting and register item that explains where a deliverable is."""
    return trail_service.deliverable_trail(session, project_id, deliverable_id)


@router.get("/projects/{project_id}/surprises")
def surprises(project_id: str, session: Session = Depends(get_session)) -> dict[str, Any]:
    """Date moves classed as agreed at a meeting, raised beforehand, or not raised before they were committed."""
    return trail_service.surprises(session, project_id)


@router.get("/projects/{project_id}/register")
def list_register(project_id: str, session: Session = Depends(get_session)) -> list[dict[str, Any]]:
    return meeting_service.list_items(session, project_id)


@router.post("/projects/{project_id}/register", status_code=201)
def create_register_item(project_id: str, body: ItemCreateRequest, session: Session = Depends(get_session)) -> dict[str, Any]:
    item = meeting_service.create_item(session, project_id, ItemInput(**body.model_dump(exclude={"author"})), author=body.author)
    session.commit()
    return meeting_service.item_to_dict(session, item)


@router.patch("/projects/{project_id}/register/{item_id}")
def update_register_item(project_id: str, item_id: int, body: ItemUpdateRequest, session: Session = Depends(get_session)) -> dict[str, Any]:
    item = meeting_service.update_item(session, project_id, item_id, body)
    session.commit()
    return meeting_service.item_to_dict(session, item)


@router.get("/projects/{project_id}/register/{item_id}/history")
def register_item_history(project_id: str, item_id: int, session: Session = Depends(get_session)) -> list[dict[str, Any]]:
    """Every change to one item, oldest first. Closed items stay in the register; nothing is deleted."""
    return meeting_service.item_history(session, project_id, item_id)


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
