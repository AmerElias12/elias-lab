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


async def apply_session_scope(session: AsyncSession, scope: LabScope) -> None:
    """Hand the scope to PostgreSQL for the life of the transaction.

    `app.actor_id` is what the audit trigger records, so the trail names a
    person rather than the connection pool. `app.lab_id` is what the row-level
    security policies compare against. SET LOCAL ends with the transaction,
    which is what makes this safe with a pooled connection.
    """
    await session.execute(
        sa.text("SELECT set_config('app.actor_id', :actor, true), "
                "       set_config('app.lab_id',  :lab,   true)"),
        {"actor": str(scope.user_id), "lab": str(scope.lab_id)},
    )
