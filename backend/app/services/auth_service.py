"""Sign-in: accounts, passwords and sessions.

People sign in with the username an admin gave them in People (usually their Windows login), so
registering is just choosing a password. The very first account is the exception: it can be
anyone (adding them to People if needed) and is an admin, so a fresh install can be set up. Admins change Settings and see every project; anyone
else sees only the projects their groups work on.

Passwords are hashed with scrypt. A session is a random token in an HttpOnly cookie; only its
SHA-256 is stored, so a copy of the database can't be used to sign in.
"""

from __future__ import annotations

import hashlib
import hmac
import secrets
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from ..domain.models import Account, LoginSession, Person
from . import people_service
from .commit_service import NotFound, utc_now
from .meeting_service import fail
from .people_service import EMAIL, USERNAME, clean_email, clean_username

SESSION_DAYS = 30
MIN_PASSWORD = 8
# scrypt cost: n=2**14, r=8, p=1 (~16 MB, tens of milliseconds).
SCRYPT = {"n": 2**14, "r": 8, "p": 1}


class Unauthorized(Exception):
    """No valid session: the client should show the sign-in page."""


class Forbidden(Exception):
    """Signed in, but this needs an admin."""


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode(), salt=salt, dklen=32, **SCRYPT)
    return f"scrypt${SCRYPT['n']}${SCRYPT['r']}${SCRYPT['p']}${salt.hex()}${digest.hex()}"


def check_password(password: str, stored: str) -> bool:
    try:
        _, n, r, p, salt, digest = stored.split("$")
        actual = hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt), dklen=32, n=int(n), r=int(r), p=int(p))
    except ValueError:
        return False
    return hmac.compare_digest(actual.hex(), digest)


# Compared against when the username is unknown, so a wrong username takes as long as a wrong password.
_DUMMY_HASH = hash_password(secrets.token_hex(8))


def _token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def account_to_dict(session: Session, account: Account) -> dict[str, Any]:
    person = session.get(Person, account.person_id)
    return {
        "id": account.id,
        "name": person.name if person else "",
        "person_id": account.person_id,
        "username": (person.username if person else None) or "",
        "email": (person.email if person else None) or "",
        "is_admin": account.is_admin,
    }


def needs_setup(session: Session) -> bool:
    return session.scalar(select(func.count()).select_from(Account)) == 0


def _check_password_rules(password: str) -> None:
    if len(password) < MIN_PASSWORD:
        raise fail("password_too_short", f"Use at least {MIN_PASSWORD} characters")


def _person_by_username(session: Session, username: str) -> Person | None:
    """Their username, or (for anyone used to it) their email."""
    column = Person.email if "@" in username else Person.username
    return session.scalar(select(Person).where(column == username)) if username else None


def register(session: Session, username: str, password: str, name: str = "", email: str = "") -> Account:
    """Choose a password for the person with this username. Name and email only matter for the first account."""
    username = clean_username(username) or ""
    _check_password_rules(password)
    if needs_setup(session):
        return _register_first(session, name.strip(), username, clean_email(email) or "", password)
    person = _person_by_username(session, username)
    if person is None:
        raise fail("not_listed", "There's no one with that username in Backstroke. Check it with an admin, who can add it under Settings → People")
    if session.scalar(select(Account).where(Account.person_id == person.id)):
        raise fail("already_registered", f"{person.name} already has a password. Sign in, or ask an admin to reset it")
    return _add_account(session, person, password, is_admin=False)


def _register_first(session: Session, name: str, username: str, email: str, password: str) -> Account:
    if not USERNAME.match(username):
        raise fail("invalid_username", "Enter a username: letters, digits, dots, dashes and underscores")
    if email and not EMAIL.match(email):
        raise fail("invalid_email", "Enter an email address, like ana@example.com")
    person = session.scalar(select(Person).where(Person.username == username))
    if person is None:
        person = next((p for p in session.scalars(select(Person)) if p.name.lower() == name.lower()), None) if name else None
        if person is None:
            if not name:
                raise fail("name_required", "Enter your name")
            if name.lower() in (g.lower() for g in people_service.list_org(session)["groups"]):
                raise fail("group_is_person", f"{name} is a group's name; register with your own name")
            person = Person(name=name, groups=[], position=session.scalar(select(func.count()).select_from(Person)))
            session.add(person)
        elif person.username and person.username != username:
            raise fail("username_taken", f"{person.name} is listed with the username {person.username}")
        person.username = username
    if email:
        if session.scalar(select(Person).where(Person.email == email, Person.id != person.id)) is not None:
            raise fail("email_taken", "Someone else in People has that email")
        person.email = email
    session.flush()
    return _add_account(session, person, password, is_admin=True)


def _add_account(session: Session, person: Person, password: str, is_admin: bool) -> Account:
    account = Account(person_id=person.id, password_hash=hash_password(password), is_admin=is_admin, created_at=utc_now())
    session.add(account)
    session.flush()
    return account


def login(session: Session, username: str, password: str) -> Account:
    person = _person_by_username(session, clean_username(username) or "")
    account = session.scalar(select(Account).where(Account.person_id == person.id)) if person else None
    if not check_password(password, account.password_hash if account else _DUMMY_HASH) or account is None:
        raise fail("wrong_credentials", "That username and password don't match. First time here? Choose Register to set your password")
    return account


def start_session(session: Session, account: Account) -> str:
    token = secrets.token_urlsafe(32)
    now = datetime.now(timezone.utc)
    session.add(
        LoginSession(
            token_hash=_token_hash(token),
            account_id=account.id,
            created_at=now.isoformat(timespec="seconds"),
            expires_at=(now + timedelta(days=SESSION_DAYS)).isoformat(timespec="seconds"),
        )
    )
    session.flush()
    return token


def end_session(session: Session, token: str | None) -> None:
    if token:
        session.execute(delete(LoginSession).where(LoginSession.token_hash == _token_hash(token)))


def account_for_token(session: Session, token: str | None) -> Account | None:
    if not token:
        return None
    row = session.get(LoginSession, _token_hash(token))
    if row is None or row.expires_at < datetime.now(timezone.utc).isoformat(timespec="seconds"):
        return None
    return session.get(Account, row.account_id)


def can_see_project(session: Session, account: Account, project_id: str) -> bool:
    if account.is_admin:
        return True
    person = session.get(Person, account.person_id)
    return person is not None and person.name in people_service.member_names(session, project_id)


def list_accounts(session: Session) -> list[dict[str, Any]]:
    return [account_to_dict(session, a) for a in session.scalars(select(Account).order_by(Account.created_at, Account.id))]


def _require_account(session: Session, account_id: int) -> Account:
    account = session.get(Account, account_id)
    if account is None:
        raise NotFound(f"account {account_id} not found")
    return account


def set_admin(session: Session, acting: Account, account_id: int, is_admin: bool) -> Account:
    account = _require_account(session, account_id)
    if account.id == acting.id and not is_admin:
        raise fail("cannot_demote_yourself", "Ask another admin to take away your admin rights")
    account.is_admin = is_admin
    session.flush()
    return account


def remove_account(session: Session, acting: Account, account_id: int) -> None:
    """Revoke someone's sign-in; they stay in People and can register again (e.g. a forgotten password)."""
    account = _require_account(session, account_id)
    if account.id == acting.id:
        raise fail("cannot_remove_yourself", "You can't remove your own account")
    session.delete(account)
    session.flush()
