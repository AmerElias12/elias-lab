"""Registering, logging in, and choosing which lab you are working in.

These are the only routes that touch the database outside a lab scope, and
they do it through the three SECURITY DEFINER functions in docs/eln-auth.sql
rather than by querying tables directly. Everything else in the API goes
through a LabScope.
"""
from __future__ import annotations

import datetime as dt
import logging
import uuid
from typing import Annotated

import sqlalchemy as sa
from asyncpg.exceptions import UniqueViolationError
from fastapi import APIRouter, Cookie, HTTPException, Request, Response, status
from fastapi.responses import JSONResponse
from sqlalchemy.exc import DBAPIError, IntegrityError

from app.deps import SessionDep, UserCtxDep
from app.scoping import apply_identity
from app.db import LabRole
from app.schemas import (
    LabCreate,
    SessionRead,
    LabMembershipRead,
    LabRead,
    LabSwitch,
    LoginRequest,
    MeRead,
    Token,
    UserCreate,
    UserRead,
)
from app.config import get_settings
from app.models import RefreshToken
from app.security import (
    create_access_token,
    hash_password,
    hash_refresh_token,
    needs_rehash,
    new_refresh_token,
    verify_password,
)

router = APIRouter(prefix="/api/auth", tags=["auth"])

log = logging.getLogger("eln.auth")

#: The refresh cookie. Scoped to /api/auth so it is not attached to every
#: request for a stylesheet, httpOnly so script on this origin cannot read it,
#: and SameSite=strict so a cross-site form post cannot carry it — which is
#: what stands in for a CSRF token on /refresh and /logout. Those two are the
#: only endpoints that act on a cookie rather than on a bearer token, so they
#: are the only ones that need it.
REFRESH_COOKIE = "eln_refresh"
REFRESH_PATH = "/api/auth"


def _set_refresh_cookie(response: Response, raw: str) -> None:
    settings = get_settings()
    response.set_cookie(
        REFRESH_COOKIE,
        raw,
        max_age=settings.refresh_token_days * 24 * 3600,
        httponly=True,
        samesite="strict",
        secure=settings.refresh_cookie_secure,
        path=REFRESH_PATH,
    )


def _clear_refresh_cookie(response: Response) -> None:
    # The path has to match the one it was set with, or the browser keeps the
    # original cookie and the person stays signed in after signing out.
    response.delete_cookie(REFRESH_COOKIE, path=REFRESH_PATH, httponly=True, samesite="strict")


async def _issue_session(
    session, response: Response, user_id: uuid.UUID, user_agent: str | None
) -> None:
    """Start a new session family and set its cookie.

    Inserted through the ordinary policy rather than a SECURITY DEFINER
    function: by the time this runs the password has been checked and
    apply_identity has told the database who it is, so
    `user_id = current_user_id()` is true and the INSERT policy is satisfied.
    Only the refresh *rotation* needs the exemption, because that one happens
    before anybody is authenticated.
    """
    settings = get_settings()
    raw, digest = new_refresh_token()
    family = uuid.uuid4()
    expires = dt.datetime.now(tz=dt.timezone.utc) + dt.timedelta(days=settings.refresh_token_days)
    session.add(
        RefreshToken(
            user_id=user_id,
            token_sha256=digest,
            family_id=family,
            expires_at=expires,
            user_agent=(user_agent or "")[:300] or None,
        )
    )
    await session.flush()
    _set_refresh_cookie(response, raw)


# One message for every way a login can fail. Telling the caller whether the
# address exists turns the login form into a membership check for the lab.
_BAD_SESSION = HTTPException(
    status_code=status.HTTP_401_UNAUTHORIZED,
    detail="your session has ended — sign in again",
    headers={"WWW-Authenticate": "Bearer"},
)

_BAD_LOGIN = HTTPException(
    status_code=status.HTTP_401_UNAUTHORIZED,
    detail="incorrect email or password",
    headers={"WWW-Authenticate": "Bearer"},
)


def _is_unique_violation(exc: Exception) -> bool:
    """asyncpg's error arrives wrapped by SQLAlchemy, and the wrapper differs
    between an INSERT it understands and a RAISE from inside a function."""
    if isinstance(exc, IntegrityError):
        return True
    orig = getattr(exc, "orig", None)
    return isinstance(orig, UniqueViolationError) or "duplicate key" in str(orig or exc)


@router.post("/register", response_model=UserRead, status_code=status.HTTP_201_CREATED)
async def register(body: UserCreate, session: SessionDep) -> UserRead:
    """Create an account. It belongs to no lab, and therefore sees nothing
    until an administrator adds it to one — that is the approval step, and it
    is why open registration is safe here.

    The password is hashed in this process. It is passed to the database only
    as a finished Argon2 string, so a plaintext password never appears in a
    query, in pg_stat_activity, or in a statement log.
    """
    hashed = hash_password(body.password)
    try:
        row = (
            await session.execute(
                sa.text(
                    "SELECT * FROM auth_register_user(:email, :full_name, :hashed, :orcid)"
                ),
                {
                    "email": body.email,
                    "full_name": body.full_name,
                    "hashed": hashed,
                    "orcid": body.orcid,
                },
            )
        ).mappings().one()
    except (IntegrityError, DBAPIError) as exc:
        if _is_unique_violation(exc):
            # 409 rather than 400: the request was well formed, the address is
            # simply taken. Not 200-with-a-lie, which some registration flows
            # do to avoid disclosing membership — this is an internal lab tool
            # and a confusing signup is worse than a known address.
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="an account with that email already exists",
            ) from exc
        raise

    # No read-back query: the function returned the row, because at this point
    # nothing else could. See docs/eln-auth.sql §2.
    return UserRead.model_validate(dict(row))


@router.post("/login", response_model=Token)
async def login(
    body: LoginRequest, session: SessionDep, response: Response, request: Request
) -> Token:
    """Verify the password, then issue a token scoped to one lab.

    If the account belongs to several labs the first one joined is chosen, and
    the frontend can switch with /switch-lab. If it belongs to none, the token
    carries no lab: the holder is authenticated, can read their own profile,
    and can see nothing else.
    """
    row = (
        await session.execute(
            sa.text(
                "SELECT id, full_name, hashed_password, is_active "
                "  FROM auth_lookup_credentials(:email)"
            ),
            {"email": body.email},
        )
    ).mappings().one_or_none()

    if row is None:
        # Hash anyway. Returning early for an unknown address makes the
        # response measurably faster than for a known one, which is enough to
        # enumerate accounts; Argon2 at these parameters is ~50 ms either way.
        hash_password(body.password)
        raise _BAD_LOGIN

    if not verify_password(row["hashed_password"], body.password):
        raise _BAD_LOGIN
    if not row["is_active"]:
        # Same 401 as a wrong password, so a disabled account is not
        # distinguishable from the outside.
        raise _BAD_LOGIN

    user_id: uuid.UUID = row["id"]

    # The password checked out, so tell the database who this is before doing
    # anything else. Everything below needs it:
    #
    #   the rehash          app_user_update permits id = current_user_id()
    #   the membership read lab_member_select permits user_id = current_user_id()
    #   last_login_at       same as the rehash
    #
    # Without it all three run as nobody: the updates match zero rows in
    # silence, and the membership query comes back empty, which produces a
    # perfectly valid token scoped to no lab. That failure mode is worth
    # naming because it looks like a login that worked.
    await apply_identity(session, user_id=user_id)

    # Opportunistic upgrade: the plaintext is in hand exactly here, and nowhere
    # else, so this is the only point at which an old hash can be replaced.
    if needs_rehash(row["hashed_password"]):
        await session.execute(
            sa.text("UPDATE app_user SET hashed_password = :h WHERE id = :id"),
            {"h": hash_password(body.password), "id": user_id},
        )

    membership = (
        await session.execute(
            sa.text(
                "SELECT lab_id, role FROM lab_member "
                " WHERE user_id = :uid ORDER BY joined_at LIMIT 1"
            ),
            {"uid": user_id},
        )
    ).mappings().one_or_none()

    await session.execute(
        sa.text("UPDATE app_user SET last_login_at = :now WHERE id = :id"),
        {"now": dt.datetime.now(tz=dt.timezone.utc), "id": user_id},
    )

    await _issue_session(session, response, user_id, request.headers.get("user-agent"))

    lab_id = membership["lab_id"] if membership else None
    role = LabRole(membership["role"]) if membership else None
    token, expires_in = create_access_token(user_id=user_id, lab_id=lab_id, role=role)
    return Token(access_token=token, expires_in=expires_in)


@router.post("/refresh", response_model=Token)
async def refresh(
    session: SessionDep,
    response: Response,
    request: Request,
    eln_refresh: Annotated[str | None, Cookie()] = None,
) -> Token:
    """Exchange the refresh cookie for a new access token, and rotate it.

    This runs when the access token has already expired, so there is no bearer
    token and nobody is authenticated — which is why the work happens inside
    auth_rotate_refresh_token, the one place allowed past the policies on
    refresh_token. It validates, mints the successor and links the two in a
    single statement, because splitting that across round trips lets two
    refreshes arriving together both succeed and look exactly like the theft
    the reuse detection is there to catch.

    Every failure is the same 401 and the same cleared cookie. The caller
    cannot tell an expired session from a revoked one from a token that never
    existed, and does not need to: the answer in all three cases is sign in
    again.
    """
    settings = get_settings()
    if not eln_refresh:
        raise _BAD_SESSION

    raw, digest = new_refresh_token()
    expires = dt.datetime.now(tz=dt.timezone.utc) + dt.timedelta(days=settings.refresh_token_days)
    row = (
        await session.execute(
            sa.text(
                "SELECT user_id, family_id, outcome "
                "  FROM auth_rotate_refresh_token(:old, :new, :expires, :ua)"
            ),
            {
                "old": hash_refresh_token(eln_refresh),
                "new": digest,
                "expires": expires,
                "ua": (request.headers.get("user-agent") or "")[:300] or None,
            },
        )
    ).mappings().one()

    if row["outcome"] != "ok":
        if row["outcome"] == "reused":
            # The only one of these that is a security event rather than an
            # expired tab. Both the holder and whoever copied it are now
            # signed out, because there is no way to tell which is which.
            log.warning(
                "refresh token reused; revoked session family %s for user %s",
                row["family_id"], row["user_id"],
            )
        # Returned, not raised. The request runs inside one transaction, and
        # raising here would unwind it — taking the family revocation that was
        # just performed with it, so a detected theft would leave the stolen
        # session working. Returning a response lets the transaction commit.
        failed = JSONResponse(
            status_code=status.HTTP_401_UNAUTHORIZED,
            content={"detail": _BAD_SESSION.detail},
            headers={"WWW-Authenticate": "Bearer"},
        )
        _clear_refresh_cookie(failed)
        return failed

    user_id = row["user_id"]
    await apply_identity(session, user_id=user_id)

    membership = (
        await session.execute(
            sa.text(
                "SELECT lab_id, role FROM lab_member "
                " WHERE user_id = :uid ORDER BY joined_at LIMIT 1"
            ),
            {"uid": user_id},
        )
    ).mappings().one_or_none()

    _set_refresh_cookie(response, raw)
    lab_id = membership["lab_id"] if membership else None
    role = LabRole(membership["role"]) if membership else None
    token, expires_in = create_access_token(user_id=user_id, lab_id=lab_id, role=role)
    return Token(access_token=token, expires_in=expires_in)


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
async def logout(
    session: SessionDep,
    response: Response,
    eln_refresh: Annotated[str | None, Cookie()] = None,
) -> Response:
    """End the session this cookie belongs to.

    Unauthenticated on purpose: signing out must work when the access token
    has already expired, which is most of the time somebody clicks it. The
    cookie is the only credential needed, and the worst a forged request can
    do is sign somebody out.

    Revokes the whole family, not just the presented token — the point of
    signing out is that the session is over, and its successor is what would
    otherwise still be live.
    """
    if eln_refresh:
        # Through the SECURITY DEFINER function, not a plain UPDATE. Nobody is
        # authenticated here, so current_user_id() is null, and the policy on
        # refresh_token would match no rows and refuse in silence — the
        # sign-out would appear to work and end nothing. See eln-rls.sql §11.
        await session.execute(
            sa.text("SELECT auth_revoke_refresh_family(:h, 'signed out')"),
            {"h": hash_refresh_token(eln_refresh)},
        )
    _clear_refresh_cookie(response)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/sessions", response_model=list[SessionRead])
async def list_sessions(
    ctx: UserCtxDep,
    eln_refresh: Annotated[str | None, Cookie()] = None,
) -> list[SessionRead]:
    """Where this account is signed in.

    Your own only — the policy on refresh_token has no branch for an
    administrator. A session is not lab data; it is the thing that proves
    somebody is who they say they are, and an admin who could read one could
    become its owner.
    """
    rows = (
        await ctx.session.execute(
            sa.select(RefreshToken)
            .where(
                RefreshToken.user_id == ctx.identity.user_id,
                RefreshToken.revoked_at.is_(None),
                RefreshToken.replaced_by_id.is_(None),
                RefreshToken.expires_at > sa.func.now(),
            )
            .order_by(RefreshToken.issued_at.desc())
        )
    ).scalars().all()

    current = hash_refresh_token(eln_refresh) if eln_refresh else None
    return [
        SessionRead(
            id=r.id,
            issued_at=r.issued_at,
            expires_at=r.expires_at,
            last_used_at=r.last_used_at,
            user_agent=r.user_agent,
            current=bool(current and r.token_sha256 == current),
        )
        for r in rows
    ]


@router.delete("/sessions/{session_id}", status_code=status.HTTP_204_NO_CONTENT)
async def revoke_session(session_id: uuid.UUID, ctx: UserCtxDep) -> Response:
    """Sign out somewhere else — the reason to keep sessions as rows."""
    result = await ctx.session.execute(
        sa.update(RefreshToken)
        .where(
            RefreshToken.id == session_id,
            RefreshToken.user_id == ctx.identity.user_id,
            RefreshToken.revoked_at.is_(None),
        )
        .values(revoked_at=sa.func.now(), revoked_reason="revoked by the account holder")
    )
    if result.rowcount == 0:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="no such session")
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/me", response_model=MeRead)
async def me(ctx: UserCtxDep) -> MeRead:
    """Who the token belongs to, and which labs it could be scoped to.

    Readable with no lab set because of the two policies in docs/eln-auth.sql
    §5: your own row and your own memberships need an identity, not a lab.
    """
    user = (
        await ctx.session.execute(
            sa.text(
                "SELECT id, email, full_name, orcid, is_active, created_at, last_login_at "
                "  FROM app_user WHERE id = :id"
            ),
            {"id": ctx.identity.user_id},
        )
    ).mappings().one_or_none()
    if user is None:
        # The token verified, but the account is gone. Treat as unauthenticated.
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="unknown account")

    labs = (
        await ctx.session.execute(
            sa.text(
                "SELECT m.lab_id, l.name, l.slug, m.role "
                "  FROM lab_member m JOIN lab l ON l.id = m.lab_id "
                " WHERE m.user_id = :uid ORDER BY m.joined_at"
            ),
            {"uid": ctx.identity.user_id},
        )
    ).mappings().all()

    return MeRead(
        user=UserRead.model_validate(dict(user)),
        labs=[LabMembershipRead.model_validate(dict(r)) for r in labs],
        current_lab_id=ctx.identity.lab_id,
        current_role=ctx.identity.role,
    )


@router.post("/labs", response_model=LabRead, status_code=status.HTTP_201_CREATED)
async def create_lab(body: LabCreate, ctx: UserCtxDep) -> LabRead:
    """Start a lab, with the caller as its owner.

    The lab and the first membership are created together inside
    auth_create_lab, because a lab with no members is unreachable: no
    membership means can_read() is false for everybody, including whoever
    would have added the first member.

    The caller needs a new token to work in it — the lab is in the token, so
    the frontend calls /switch-lab next.
    """
    try:
        lab_id = (
            await ctx.session.execute(
                sa.text("SELECT auth_create_lab(:name, :slug, :uid) AS id"),
                {"name": body.name, "slug": body.slug, "uid": ctx.identity.user_id},
            )
        ).scalar_one()
    except (IntegrityError, DBAPIError) as exc:
        if _is_unique_violation(exc):
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"the slug '{body.slug}' is already taken",
            ) from exc
        raise
    return LabRead(id=lab_id, name=body.name, slug=body.slug)


@router.post("/switch-lab", response_model=Token)
async def switch_lab(body: LabSwitch, ctx: UserCtxDep) -> Token:
    """Reissue the token for a different lab.

    Membership is checked here so the answer is an honest 403, but the check is
    not what provides the safety: a token naming a lab the holder does not
    belong to produces no rows anyway, because every policy reads lab_member
    rather than the claim. This route is the convenience; the policy is the
    guarantee.
    """
    membership = (
        await ctx.session.execute(
            sa.text(
                "SELECT role FROM lab_member WHERE user_id = :uid AND lab_id = :lab"
            ),
            {"uid": ctx.identity.user_id, "lab": body.lab_id},
        )
    ).mappings().one_or_none()
    if membership is None:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="you are not a member of that lab",
        )
    role = LabRole(membership["role"])
    token, expires_in = create_access_token(
        user_id=ctx.identity.user_id, lab_id=body.lab_id, role=role
    )
    return Token(access_token=token, expires_in=expires_in)
