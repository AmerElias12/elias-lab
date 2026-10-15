"""The engine, the session factory, and the startup check that decides whether
any of the row-level security actually applies.

The engine is built lazily rather than at import, so that importing `app` does
not require a reachable database — which is what lets the schemas and models be
tested without one.
"""
from __future__ import annotations

from typing import NamedTuple

import sqlalchemy as sa
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker, create_async_engine

from app.config import get_settings

_engine: AsyncEngine | None = None
_sessionmaker: async_sessionmaker[AsyncSession] | None = None


def get_engine() -> AsyncEngine:
    global _engine
    if _engine is None:
        s = get_settings()
        _engine = create_async_engine(
            s.database_url,
            echo=s.db_echo,
            pool_size=s.db_pool_size,
            max_overflow=s.db_max_overflow,
            # The scope is set with SET LOCAL, which dies with the transaction,
            # so a recycled connection cannot carry one request's identity into
            # the next. pool_pre_ping covers the other failure, a connection the
            # database closed while it sat idle in the pool.
            pool_pre_ping=True,
        )
    return _engine


def get_sessionmaker() -> async_sessionmaker[AsyncSession]:
    global _sessionmaker
    if _sessionmaker is None:
        _sessionmaker = async_sessionmaker(
            get_engine(),
            expire_on_commit=False,  # a committed row is still readable for the response
            autoflush=False,         # flush where it is meant to happen, not mid-read
        )
    return _sessionmaker


async def dispose_engine() -> None:
    global _engine, _sessionmaker
    if _engine is not None:
        await _engine.dispose()
    _engine, _sessionmaker = None, None


class RoleCheck(NamedTuple):
    role: str
    is_superuser: bool
    bypasses_rls: bool
    owns_tables: list[str]

    @property
    def rls_applies(self) -> bool:
        """Policies constrain this connection only if all three are false.

        A superuser ignores RLS. BYPASSRLS ignores RLS. A table's owner ignores
        its policies unless the table is FORCEd — and FORCE is set in
        docs/eln-rls.sql, so owning a table is survivable, but it means the
        separation the file assumes is not in place.
        """
        return not self.is_superuser and not self.bypasses_rls and not self.owns_tables


async def check_rls_is_effective() -> RoleCheck:
    """Ask the database who we are connecting as.

    Worth doing on every start, because every other protection in this
    application is downstream of the answer and the failure is silent: an app
    connected as the owner works perfectly and shows every lab's data to
    everybody.
    """
    async with get_engine().connect() as conn:
        row = (
            await conn.execute(
                sa.text(
                    "SELECT current_user AS role, rolsuper, rolbypassrls "
                    "  FROM pg_roles WHERE rolname = current_user"
                )
            )
        ).one()
        owned = (
            await conn.execute(
                sa.text(
                    "SELECT tablename FROM pg_tables "
                    " WHERE schemaname = 'public' AND tableowner = current_user "
                    " ORDER BY tablename"
                )
            )
        ).scalars().all()
    return RoleCheck(
        role=row.role,
        is_superuser=bool(row.rolsuper),
        bypasses_rls=bool(row.rolbypassrls),
        owns_tables=list(owned),
    )
