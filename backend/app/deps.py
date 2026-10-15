"""What every request needs: who is asking, which lab, and a session that has
already told PostgreSQL both.

The ordering here is the whole security model in four steps:

    1. the bearer token is decoded and verified      -> Identity
    2. a LabScope is built from it                   -> the filter
    3. the scope is pushed into the transaction      -> SET LOCAL
    4. the route queries through the scope           -> WHERE lab_id = ...

Step 3 is the one that is easy to leave out, and leaving it out fails *closed*:
with no app.lab_id set, current_lab() is NULL, every policy compares against
NULL and the route returns an empty list. A confusing bug rather than a leak,
which is the right way round.
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass
from typing import Annotated, AsyncIterator

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import LabRole
from app.scoping import LabScope, apply_identity, apply_session_scope
from app.security import TokenError, decode_access_token
from app.session import get_sessionmaker

# auto_error=False so a missing header produces our own 401 with a
# WWW-Authenticate challenge rather than HTTPBearer's bare 403.
_bearer = HTTPBearer(auto_error=False, description="Bearer <access token>")

_UNAUTHENTICATED = HTTPException(
    status_code=status.HTTP_401_UNAUTHORIZED,
    detail="not authenticated",
    headers={"WWW-Authenticate": "Bearer"},
)


@dataclass(frozen=True, slots=True)
class Identity:
    """The token's claims, after verification. `lab_id` and `role` are claims
    and nothing more — the database checks membership itself, so a token naming
    a lab the holder has left returns no rows rather than that lab's data."""

    user_id: uuid.UUID
    lab_id: uuid.UUID | None
    role: LabRole | None


async def current_identity(
    creds: Annotated[HTTPAuthorizationCredentials | None, Depends(_bearer)],
) -> Identity:
    if creds is None or not creds.credentials:
        raise _UNAUTHENTICATED
    try:
        claims = decode_access_token(creds.credentials)
    except TokenError:
        # Deliberately not saying which part failed. "Signature invalid" versus
        # "expired" is a free oracle for someone probing with crafted tokens.
        raise _UNAUTHENTICATED from None
    try:
        user_id = uuid.UUID(claims["sub"])
        lab_id = uuid.UUID(claims["lab_id"]) if claims.get("lab_id") else None
        role = LabRole(claims["role"]) if claims.get("role") else None
    except (KeyError, ValueError):
        raise _UNAUTHENTICATED from None
    return Identity(user_id=user_id, lab_id=lab_id, role=role)


async def unscoped_session() -> AsyncIterator[AsyncSession]:
    """For the three operations that happen before there is a scope: logging
    in, registering, and creating a lab. These reach the database through the
    SECURITY DEFINER functions in docs/eln-auth.sql, which are the only way
    past the policies and are narrow enough to read in one sitting."""
    async with get_sessionmaker()() as session:
        async with session.begin():
            yield session


@dataclass(frozen=True, slots=True)
class Ctx:
    """A scoped session plus the scope that built it.

    One object because they belong together: a session carrying lab A's
    settings and a scope for lab B would pass every type check and quietly
    return nothing. Handing them out as a pair makes that impossible to
    assemble by accident.
    """

    session: AsyncSession
    scope: LabScope


async def get_ctx(
    identity: Annotated[Identity, Depends(current_identity)],
) -> AsyncIterator[Ctx]:
    if identity.lab_id is None or identity.role is None:
        # Authenticated but not working in any lab. A new account sits here
        # until somebody adds them to one, which is the approval step.
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="this account does not belong to a lab yet",
        )
    scope = LabScope(lab_id=identity.lab_id, user_id=identity.user_id, role=identity.role)
    async with get_sessionmaker()() as session:
        # One transaction for the whole request, which is what makes SET LOCAL
        # the right tool: the identity cannot outlive the request even if the
        # pooled connection does. Routes must therefore not commit — the
        # commit is here, on the way out, and a commit mid-route would drop the
        # settings and leave the rest of the handler seeing nothing.
        async with session.begin():
            await apply_session_scope(session, scope)
            yield Ctx(session=session, scope=scope)


@dataclass(frozen=True, slots=True)
class UserCtx:
    """Authenticated, but not necessarily working in a lab.

    For the routes that exist either side of choosing one: reading your own
    profile, listing the labs you belong to, switching between them. The
    policies added in docs/eln-auth.sql §5 are what make these readable with
    no lab set — "rows about me" needs no lab, only an identity.
    """

    session: AsyncSession
    identity: Identity


async def get_user_ctx(
    identity: Annotated[Identity, Depends(current_identity)],
) -> AsyncIterator[UserCtx]:
    async with get_sessionmaker()() as session:
        async with session.begin():
            await apply_identity(
                session, user_id=identity.user_id, lab_id=identity.lab_id
            )
            yield UserCtx(session=session, identity=identity)


def require_admin(ctx: Annotated[Ctx, Depends(get_ctx)]) -> Ctx:
    """For routes that manage the lab itself. The database enforces this too;
    this exists so the answer is 403 with a reason rather than a silent empty
    result, which is what a policy on its own would give."""
    if not ctx.scope.may_administer():
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="only a lab owner or admin may do this",
        )
    return ctx


def require_writer(ctx: Annotated[Ctx, Depends(get_ctx)]) -> Ctx:
    if not ctx.scope.may_write():
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="this account has read-only access to the lab",
        )
    return ctx


CtxDep = Annotated[Ctx, Depends(get_ctx)]
WriterDep = Annotated[Ctx, Depends(require_writer)]
AdminDep = Annotated[Ctx, Depends(require_admin)]
UserCtxDep = Annotated[UserCtx, Depends(get_user_ctx)]
SessionDep = Annotated[AsyncSession, Depends(unscoped_session)]
IdentityDep = Annotated[Identity, Depends(current_identity)]
