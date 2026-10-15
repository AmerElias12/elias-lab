"""The part that actually filters by ownership.

A `lab_id` column does not stop a leak; forgetting the WHERE clause is what
causes one, and that is a thing a tired developer does at 2am, not something a
mixin prevents. So queries are built through LabScope, which puts the filter in
for you and refuses to build a statement for a model that is not lab-scoped.

Defence in depth, outermost first:
  1. the route gets a LabScope from the authenticated token
  2. LabScope.select() adds lab_id and the soft-delete filter
  3. PostgreSQL row-level security refuses the row anyway if both are bypassed

Layer 3 is the one that holds when layers 1 and 2 are wrong, which is why the
application role must not be the table owner and must not have BYPASSRLS.
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass
from typing import Any, TypeVar

import sqlalchemy as sa
from sqlalchemy import Select, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import LabRole
from app.models import LabScopedMixin

M = TypeVar("M")


class ScopeError(RuntimeError):
    """Raised when a query is built for a model that carries no lab_id. It is a
    programming error, not a user error: fail loudly rather than return rows."""


@dataclass(frozen=True, slots=True)
class LabScope:
    """Everything a request is allowed to see, derived from the token once."""

    lab_id: uuid.UUID
    user_id: uuid.UUID
    role: LabRole

    # ---- reading ---------------------------------------------------------
    def select(self, model: type[M], *, include_deleted: bool = False) -> Select[tuple[M]]:
        """A SELECT already narrowed to this lab, and to rows that still exist."""
        if not issubclass(model, LabScopedMixin):
            raise ScopeError(
                f"{model.__name__} has no lab_id, so it cannot be queried through a LabScope. "
                "Add LabScopedMixin, or reach it by joining from something that has one."
            )
        stmt = select(model).where(model.lab_id == self.lab_id)
        if not include_deleted and hasattr(model, "deleted_at"):
            stmt = stmt.where(model.deleted_at.is_(None))
        return stmt

    def visible(self, model: type[M], **kw: Any) -> Select[tuple[M]]:
        """What this person may actually read: their own records, plus the ones
        their lab shares, plus everything if they administer the lab.

        This mirrors the SELECT policy in docs/eln-rls-ownership.sql. The
        database would apply that predicate regardless, so this is not what
        makes the query safe — it is here so that a list endpoint returns a
        correct count and a correct page. Without it the query asks for fifty
        rows, RLS silently removes the ones you may not see, and the page comes
        back short with no explanation. Keep the two in step: if the policy
        changes, this changes with it.
        """
        stmt = self.select(model, **kw)
        if not hasattr(model, "is_shared") or self.may_administer():
            return stmt
        # Written out rather than `a or b`: these are column objects, and a
        # SQLAlchemy column raises on truth-testing rather than answering.
        if hasattr(model, "owner_id"):
            owner = model.owner_id
        elif hasattr(model, "author_id"):
            owner = model.author_id
        else:
            return stmt.where(model.is_shared.is_(True))
        return stmt.where(sa.or_(owner == self.user_id, model.is_shared.is_(True)))

    def mine(self, model: type[M], **kw: Any) -> Select[tuple[M]]:
        """Narrowed further to rows this person owns. Entries use author_id, so
        both spellings are accepted."""
        stmt = self.select(model, **kw)
        if hasattr(model, "owner_id"):
            return stmt.where(model.owner_id == self.user_id)
        if hasattr(model, "author_id"):
            return stmt.where(model.author_id == self.user_id)
        raise ScopeError(f"{model.__name__} records no owner, so 'mine' means nothing for it")

    # ---- writing ---------------------------------------------------------
    def stamp(self, values: dict[str, Any], *, owner: bool = True) -> dict[str, Any]:
        """Put the scope onto a row being created. The client never supplies
        lab_id or owner_id — this is where they come from, so a request cannot
        write into another lab by sending its id in the body."""
        out = dict(values)
        out["lab_id"] = self.lab_id
        if owner:
            out.setdefault("owner_id", self.user_id)
        return out

    def may_write(self) -> bool:
        return self.role in (LabRole.owner, LabRole.admin, LabRole.member)

    def may_administer(self) -> bool:
        return self.role in (LabRole.owner, LabRole.admin)

    def owns(self, row: Any) -> bool:
        holder = getattr(row, "owner_id", None) or getattr(row, "author_id", None)
        return holder == self.user_id

    def may_edit(self, row: Any) -> bool:
        """Members edit their own; admins edit anything in the lab."""
        return self.may_administer() or (self.may_write() and self.owns(row))


async def apply_identity(
    session: AsyncSession, *, user_id: uuid.UUID, lab_id: uuid.UUID | None = None
) -> None:
    """Hand the caller's identity to PostgreSQL for the life of the transaction.

    `app.current_user_id` is what the audit trigger records, so the trail names
    a person rather than the connection pool, and it is what current_user_id()
    returns in every policy. `app.lab_id` is which of that person's labs the
    request is working in.

    The third argument to set_config is is_local: the setting dies with the
    transaction, which is what makes this safe on a pooled connection. Without
    it, one request's identity would still be set when the next request
    borrowed the same connection.

    lab_id may be None, for the window after logging in and before choosing a
    lab. It is written as the empty string rather than left unset, because an
    unset GUC makes current_setting raise instead of returning NULL, and the
    policies are written to treat empty as "nobody, nothing".

    These two names are the entire contract between this application and the
    policies in docs/eln-rls.sql. They are spelled out in exactly one place,
    here, so that renaming one cannot half-happen.
    """
    await session.execute(
        sa.text(
            "SELECT set_config('app.current_user_id', :actor, true), "
            "       set_config('app.lab_id',          :lab,   true)"
        ),
        {"actor": str(user_id), "lab": str(lab_id) if lab_id else ""},
    )


async def apply_session_scope(session: AsyncSession, scope: LabScope) -> None:
    """Hand a full lab scope to PostgreSQL. See apply_identity."""
    await apply_identity(session, user_id=scope.user_id, lab_id=scope.lab_id)
