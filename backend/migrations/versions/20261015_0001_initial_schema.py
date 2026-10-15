"""The schema, its policies, and the roles they rest on.

Revision ID: 0001_initial_schema
Revises:
Created: 2026-10-15

This revision applies the four SQL files in docs/, in the order they depend on
each other. They are the source of truth for the schema; this revision is what
puts them in order and records that they ran.

Why one revision and not four
-----------------------------
They are not independently useful. eln-rls-ownership.sql *replaces* policies
created by eln-rls.sql rather than adding to them, and eln-auth.sql grants
EXECUTE on a function eln-rls.sql defines. A database with the first two
applied and not the third cannot log anybody in. Rolling back to that state is
not a state anyone wants, so it is not offered.

What this needs to run as
-------------------------
A role that can CREATE ROLE, ALTER ROLE ... BYPASSRLS, and ALTER FUNCTION ...
OWNER TO. On a managed PostgreSQL that usually means the instance's superuser
or its nearest equivalent. It must NOT be eln_app: that role exists precisely
to be unable to do these things, and granting it the privileges to run its own
migrations would undo the separation the policies rest on.
"""
from __future__ import annotations

import pathlib

from alembic import op

revision = "0001_initial_schema"
down_revision = None
branch_labels = None
depends_on = None

# backend/migrations/versions/this.py -> backend -> the repository -> docs
DOCS = pathlib.Path(__file__).resolve().parents[3] / "docs"

# The order matters and is not alphabetical.
FILES = (
    "eln-schema.sql",          # tables, constraints, triggers, views
    "eln-rls.sql",             # roles, helpers, lab isolation
    "eln-rls-ownership.sql",   # per-record ownership; replaces policies above
    "eln-auth.sql",            # the operations that precede identity
)


def _read(name: str) -> str:
    path = DOCS / name
    if not path.is_file():
        raise FileNotFoundError(
            f"{path} is missing. This revision applies the SQL files from the "
            f"repository, so the repository has to be there — which also means "
            f"this is not a migration you can run from a wheel."
        )
    return path.read_text()


def upgrade() -> None:
    for name in FILES:
        # One op.execute per file rather than per statement: psycopg sends the
        # script as one multi-statement command, and every file is written to
        # be applied whole. env.py wraps each migration in a transaction, so a
        # failure in the third file rolls back the first two as well.
        op.execute(_read(name))


def downgrade() -> None:
    """Remove everything this created, including the roles.

    This empties the database. It is the honest downgrade for an initial
    revision — there is no earlier state to return to — and it is destructive
    in the way that implies.

    It drops objects one kind at a time rather than `DROP SCHEMA public
    CASCADE`, for one specific reason: alembic_version lives in public too.
    Dropping the schema takes Alembic's own bookkeeping with it, and the very
    next thing Alembic does is DELETE the row recording this revision — which
    fails on a table that no longer exists, leaving the database emptied and
    still claiming to be at head. Found by running it.

    Order is forced throughout: views before the tables they read, tables
    before the types their columns use, and DROP OWNED before DROP ROLE,
    because a role holding a single grant cannot be dropped.
    """
    op.execute(
        """
        DO $$
        DECLARE r record;
        BEGIN
          FOR r IN SELECT viewname FROM pg_views WHERE schemaname = 'public' LOOP
            EXECUTE format('DROP VIEW IF EXISTS public.%I CASCADE', r.viewname);
          END LOOP;

          FOR r IN SELECT tablename FROM pg_tables
                    WHERE schemaname = 'public' AND tablename <> 'alembic_version' LOOP
            EXECUTE format('DROP TABLE IF EXISTS public.%I CASCADE', r.tablename);
          END LOOP;

          -- regprocedure renders the argument types, which is what makes this
          -- unambiguous for the overloaded auth_* functions.
          FOR r IN SELECT oid::regprocedure AS sig FROM pg_proc
                    WHERE pronamespace = 'public'::regnamespace LOOP
            EXECUTE format('DROP FUNCTION IF EXISTS %s CASCADE', r.sig);
          END LOOP;

          -- 'e' is the enums, 'd' the dna_sequence domain. DROP TYPE handles both.
          FOR r IN SELECT typname FROM pg_type
                    WHERE typnamespace = 'public'::regnamespace AND typtype IN ('e', 'd') LOOP
            EXECUTE format('DROP TYPE IF EXISTS public.%I CASCADE', r.typname);
          END LOOP;
        END
        $$;
        """
    )

    for role in ("eln_app", "eln_auth"):
        op.execute(
            f"""
            DO $$
            BEGIN
              IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '{role}') THEN
                EXECUTE 'DROP OWNED BY {role} CASCADE';
                EXECUTE 'DROP ROLE {role}';
              END IF;
            END
            $$;
            """
        )
