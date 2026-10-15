#!/usr/bin/env python3
"""Apply the four SQL files to a database, in the order they depend on.

    python scripts/bootstrap_db.py "postgresql://postgres@localhost/eln"

Run as a superuser, not as eln_app: the files create roles, set BYPASSRLS on
eln_auth, and change table ownership. The application connects as eln_app
afterwards, which is the whole point of the separation.

The order matters and is not alphabetical:

    eln-schema.sql         tables, constraints, triggers, views
    eln-rls.sql            roles, helpers, lab isolation
    eln-rls-ownership.sql  per-record ownership and sharing (replaces policies
                           from the previous file, so it must come after)
    eln-auth.sql           the three pre-identity operations

This is a bootstrap, not a migration tool. It is safe to re-run on a database
it has already been applied to — every statement is CREATE OR REPLACE, ADD
COLUMN IF NOT EXISTS, or a DROP/CREATE pair — but it has no notion of versions
and will not alter a table whose definition changed. Alembic is the next piece
of work, and until it exists, changing the schema means recreating the
database.
"""
from __future__ import annotations

import pathlib
import sys

FILES = [
    "eln-schema.sql",
    "eln-rls.sql",
    "eln-rls-ownership.sql",
    "eln-auth.sql",
]

DOCS = pathlib.Path(__file__).resolve().parent.parent.parent / "docs"


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print(__doc__)
        return 2

    try:
        import psycopg  # type: ignore
    except ModuleNotFoundError:
        try:
            import psycopg2 as psycopg  # type: ignore
        except ModuleNotFoundError:
            print(
                "This script needs a synchronous driver: pip install psycopg[binary]\n"
                "(asyncpg, which the application uses, cannot run these files: it has\n"
                " no multi-statement execute, and these are multi-statement scripts.)",
                file=sys.stderr,
            )
            return 1

    missing = [f for f in FILES if not (DOCS / f).is_file()]
    if missing:
        print(f"not found in {DOCS}: {', '.join(missing)}", file=sys.stderr)
        return 1

    with psycopg.connect(argv[1]) as conn:
        conn.autocommit = True
        with conn.cursor() as cur:
            for name in FILES:
                sql = (DOCS / name).read_text()
                print(f"applying {name} ({len(sql.splitlines())} lines)…", flush=True)
                cur.execute(sql)

            cur.execute(
                "SELECT rolname, rolbypassrls FROM pg_roles "
                " WHERE rolname IN ('eln_app', 'eln_auth') ORDER BY rolname"
            )
            print("\nroles:")
            for role, bypass in cur.fetchall():
                print(f"  {role:10s} bypassrls={bypass}")

            cur.execute(
                "SELECT count(*) FROM pg_class "
                " WHERE relnamespace = 'public'::regnamespace AND relkind = 'r' "
                "   AND relrowsecurity AND relforcerowsecurity"
            )
            forced = cur.fetchone()[0]
            cur.execute(
                "SELECT count(*) FROM pg_class "
                " WHERE relnamespace = 'public'::regnamespace AND relkind = 'r'"
            )
            total = cur.fetchone()[0]
            print(f"\n{forced} of {total} tables have RLS enabled and forced")
            if forced != total:
                print(
                    "  A table without FORCE is a table whose policies are not consulted.\n"
                    "  Add it to the array in docs/eln-rls.sql section 4.",
                    file=sys.stderr,
                )
                return 1

    print("\nNow give eln_app a password and let it log in, e.g.")
    print("  ALTER ROLE eln_app WITH LOGIN PASSWORD '…';")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
