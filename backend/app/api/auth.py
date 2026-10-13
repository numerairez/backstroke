"""Sign-in routes, and the dependencies that guard everything else under /api."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Request, Response
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..domain.models import Account
from ..services import auth_service
from ..services.auth_service import Forbidden, Unauthorized
from ..services.commit_service import NotFound
from .session import get_session

COOKIE = "backstroke_session"

auth_router = APIRouter(prefix="/api/auth")


class RegisterRequest(BaseModel):
    name: str
    email: str
    password: str


class LoginRequest(BaseModel):
    email: str
    password: str


class AdminRequest(BaseModel):
    is_admin: bool


def current_account(request: Request, session: Session = Depends(get_session)) -> Account:
    """The signed-in account, or 401. A project the account can't see is reported as not found."""
    account = auth_service.account_for_token(session, request.cookies.get(COOKIE))
    if account is None:
        raise Unauthorized()
    project_id = request.path_params.get("project_id")
    if project_id and not auth_service.can_see_project(session, account, project_id):
        raise NotFound(f"project {project_id} not found")
    request.state.account = account
    request.state.author = auth_service.account_to_dict(session, account)["name"]
    return account


def require_admin(account: Account = Depends(current_account)) -> Account:
    if not account.is_admin:
        raise Forbidden()
    return account


def _signed_in(response: Response, request: Request, session: Session, account: Account) -> dict[str, Any]:
    token = auth_service.start_session(session, account)
    session.commit()
    response.set_cookie(
        COOKIE,
        token,
        max_age=auth_service.SESSION_DAYS * 86400,
        httponly=True,
        samesite="lax",
        secure=request.url.scheme == "https",
        path="/",
    )
    return {"account": auth_service.account_to_dict(session, account), "needs_setup": False}


@auth_router.get("/me")
def me(request: Request, session: Session = Depends(get_session)) -> dict[str, Any]:
    """Who is signed in (or null), and whether no account exists yet (the first to register is the admin)."""
    account = auth_service.account_for_token(session, request.cookies.get(COOKIE))
    return {"account": auth_service.account_to_dict(session, account) if account else None, "needs_setup": auth_service.needs_setup(session)}


@auth_router.post("/register", status_code=201)
def register(body: RegisterRequest, request: Request, response: Response, session: Session = Depends(get_session)) -> dict[str, Any]:
    account = auth_service.register(session, body.name, body.email, body.password)
    return _signed_in(response, request, session, account)


@auth_router.post("/login")
def login(body: LoginRequest, request: Request, response: Response, session: Session = Depends(get_session)) -> dict[str, Any]:
    account = auth_service.login(session, body.email, body.password)
    return _signed_in(response, request, session, account)


@auth_router.post("/logout", status_code=204)
def logout(request: Request, response: Response, session: Session = Depends(get_session)) -> None:
    auth_service.end_session(session, request.cookies.get(COOKIE))
    session.commit()
    response.delete_cookie(COOKIE, path="/")


@auth_router.get("/accounts", dependencies=[Depends(require_admin)])
def list_accounts(session: Session = Depends(get_session)) -> list[dict[str, Any]]:
    return auth_service.list_accounts(session)


@auth_router.patch("/accounts/{account_id}")
def set_admin(account_id: int, body: AdminRequest, account: Account = Depends(require_admin), session: Session = Depends(get_session)) -> dict[str, Any]:
    changed = auth_service.set_admin(session, account, account_id, body.is_admin)
    session.commit()
    return auth_service.account_to_dict(session, changed)


@auth_router.delete("/accounts/{account_id}", status_code=204)
def remove_account(account_id: int, account: Account = Depends(require_admin), session: Session = Depends(get_session)) -> None:
    """Revoke a sign-in. The person stays listed and can register again, which is how a forgotten password is reset."""
    auth_service.remove_account(session, account, account_id)
    session.commit()
