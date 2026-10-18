"""Alembic environment.

The URL comes from the environment via app.config rather than from
alembic.ini, so there is one place that knows how to reach the database and no
connection string in a public repository.

It reads the URL with a standalone helper rather than by building a Settings:
`alembic upgrade head` is something a DBA runs, and it should not fail because
the application's JWT secret is unset. Migrations do not sign tokens.

A note on autogenerate, because the obvious thing to do here is wrong
---------------------------------------------------------------------
`target_metadata` is set, so `alembic revision --autogenerate` will run and
produce something. Treat what it produces as a hint and never as a migration.

The schema's source of truth is the four files in ../docs. They contain
row-level security policies, SECURITY DEFINER functions, triggers, a domain,
generated columns and two views — and autogenerate models none of them. Left
to itself it will cheerfully emit a revision that drops the policies, because
it compares the database against SQLAlchemy metadata that has never heard of
them, and a schema where the policies have been dropped still passes every
type check in this repository.

So: write revisions by hand. Run autogenerate when you want a second opinion
about a column you might have missed, read it, and throw it away.
"""
from __future__ import annotations

import pathlib
import sys
from logging.config import fileConfig

from alembic import context
from sqlalchemy import engine_from_config, pool

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))

from app.config import migration_url_from_env  # noqa: E402
from app.db import Base  # noqa: E402
import app.models  # noqa: F401,E402  — registers every mapping on Base.metadata

config = context.config
if config.config_file_name is not None:
    fileConfig(config.config_file_name)

target_metadata = Base.metadata
config.set_main_option("sqlalchemy.url", migration_url_from_env())


def run_migrations_offline() -> None:
    """Emit SQL to stdout instead of running it — `alembic upgrade head --sql`.

    Worth having here: these migrations create roles and change ownership, and
    some sites will want a DBA to read the SQL before anyone runs it.
    """
    context.configure(
        url=config.get_main_option("sqlalchemy.url"),
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    connectable = engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )
    with connectable.connect() as connection:
        context.configure(
            connection=connection,
            target_metadata=target_metadata,
            # PostgreSQL has transactional DDL, so a migration that fails
            # half way leaves nothing behind. That is the single best reason
            # to run these against PostgreSQL and not to hand-apply them.
            transaction_per_migration=True,
            compare_type=True,
        )
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
