#!/usr/bin/env python3
"""Run the app against a throwaway PostgreSQL, for looking at the dashboard.

    python scripts/dev_server.py            # http://localhost:8000

Starts an embedded PostgreSQL (pgserver), applies the four SQL files the first
time, then serves the API and the static frontend. The data directory persists
between runs so an account created once survives a restart; delete it to start
clean. The path is printed on startup.

This is a convenience for development only. It connects as eln_app, exactly as
production does, so the policies apply here too — a dev server that quietly ran
as the owner would be the one place the authorisation never gets exercised.
"""
from __future__ import annotations

import os
import pathlib
import sys

BACKEND = pathlib.Path(__file__).resolve().parent.parent
DOCS = BACKEND.parent / "docs"
sys.path.insert(0, str(BACKEND))

SQL_FILES = ["eln-schema.sql", "eln-rls.sql", "eln-rls-ownership.sql", "eln-auth.sql"]
DATADIR = pathlib.Path(
    os.environ.get("ELN_DEV_DATADIR", pathlib.Path.home() / ".cache" / "eln-dev-db")
)


def main() -> int:
    import pgserver
    import uvicorn

    DATADIR.mkdir(parents=True, exist_ok=True)
    print(f"postgres data directory: {DATADIR}")
    srv = pgserver.get_server(DATADIR)

    existing = srv.psql(
        "SELECT count(*) FROM pg_tables WHERE schemaname = 'public' AND tablename = 'app_user';"
    )
    if "1" not in existing.split():
        for name in SQL_FILES:
            print(f"applying {name}…")
            srv.psql((DOCS / name).read_text())
        srv.psql("ALTER ROLE eln_app WITH LOGIN;")
        print("schema, policies and auth functions applied")
    else:
        print("reusing the existing database")

    os.environ.setdefault(
        "ELN_DATABASE_URL", f"postgresql+asyncpg://eln_app@/postgres?host={DATADIR}"
    )
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
