#!/usr/bin/env python3
"""Run the app against a throwaway PostgreSQL, for looking at the dashboard.

    python scripts/dev_server.py            # http://localhost:8000

Starts an embedded PostgreSQL (pgserver), brings it up to date with
`alembic upgrade head`, then serves the API and the static frontend. The data
directory persists between runs so an account created once survives a restart;
delete it to start clean. The path is printed on startup.

This is a convenience for development only. It connects as eln_app, exactly as
production does, so the policies apply here too — a dev server that quietly ran
as the owner would be the one place the authorisation never gets exercised.
"""
from __future__ import annotations

import os
import pathlib
import sys

BACKEND = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND))
DATADIR = pathlib.Path(
    os.environ.get("ELN_DEV_DATADIR", pathlib.Path.home() / ".cache" / "eln-dev-db")
)


def main() -> int:
    import pgserver
    import uvicorn

    DATADIR.mkdir(parents=True, exist_ok=True)
    print(f"postgres data directory: {DATADIR}")
    srv = pgserver.get_server(DATADIR)

    # Provision through Alembic, exactly as a real deployment does. A dev
    # server that applies the SQL its own way is the one place the migration
    # never gets exercised, which is where migrations rot.
    os.environ.setdefault(
        "ELN_MIGRATION_DATABASE_URL", f"postgresql+psycopg://postgres@/postgres?host={DATADIR}"
    )
    os.environ.setdefault(
        "ELN_DATABASE_URL", f"postgresql+asyncpg://eln_app@/postgres?host={DATADIR}"
    )

    from alembic import command
    from alembic.config import Config

    cfg = Config(str(BACKEND / "alembic.ini"))
    cfg.set_main_option("script_location", str(BACKEND / "migrations"))

    def _has(table: str) -> bool:
        out = srv.psql(
            "SELECT count(*) FROM pg_tables "
            f"WHERE schemaname = 'public' AND tablename = '{table}';"
        )
        return "1" in out.split()

    if _has("app_user") and not _has("alembic_version"):
        # A database provisioned before migrations existed. Record where it
        # already is rather than trying to create everything a second time —
        # the same thing you would do to an existing production database.
        print("existing schema found; stamping it instead of re-applying")
        command.stamp(cfg, "head")

    command.upgrade(cfg, "head")
    print("alembic upgrade head: done")
    # eln_app is NOLOGIN in production, where it authenticates through the
    # pooler; here it has to connect for itself.
    srv.psql("ALTER ROLE eln_app WITH LOGIN;")

    os.environ.setdefault("ELN_JWT_SECRET", "dev-only-" + "0" * 32)
    os.environ.setdefault("ELN_ENVIRONMENT", "development")

    port = int(os.environ.get("PORT", "8000"))
    print(f"\n  http://localhost:{port}\n")
    # Imported after the environment is set: Settings is read at first use and
    # cached, so an import before this point would pin the wrong values.
    from app.main import app

    uvicorn.run(app, host="127.0.0.1", port=port, log_level="info")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
