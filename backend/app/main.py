"""The application.

Assembly only: settings, the startup check, error translation, routes, and the
static frontend. No business logic lives here, so this file is short enough to
read before a deploy.
"""
from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from typing import AsyncIterator

from fastapi import FastAPI, Request, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy.exc import DBAPIError

from app.config import get_settings
from app.routers import (
    auth, cloning, constructions, dashboard, entries, guides, members, plasmids,
    primers,
)
from app.session import check_rls_is_effective, dispose_engine

log = logging.getLogger("eln")


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """Check, on the way up, that the policies actually apply to us.

    This is worth a startup query because the failure mode is silent: an
    application connected as the table owner or a superuser works perfectly
    and shows every lab's data to everybody. Nothing in a test suite that runs
    against the right role will catch the deployment that uses the wrong one.

    In production it refuses to start. In development it warns, because
    pointing at a scratch database as its owner is a normal thing to do while
    writing a migration.
    """
    settings = get_settings()
    try:
        check = await check_rls_is_effective()
    except Exception as exc:  # noqa: BLE001 — any failure here is fatal context
        log.error("cannot reach the database at startup: %s", exc)
        raise

    if check.rls_applies:
        log.info("connected as %r; row-level security applies", check.role)
    else:
        reasons = []
        if check.is_superuser:
            reasons.append("it is a superuser")
        if check.bypasses_rls:
            reasons.append("it has BYPASSRLS")
        if check.owns_tables:
            reasons.append(f"it owns {len(check.owns_tables)} of the tables")
        message = (
            f"the database role {check.role!r} is not constrained by row-level "
            f"security because {', and '.join(reasons)}. Every lab's data is "
            f"visible to every request. Connect as eln_app."
        )
        if settings.is_production:
            raise RuntimeError(message)
        log.warning("%s", message)

    yield
    await dispose_engine()


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(
        title="Elias Lab ELN",
        version="0.1.0",
        summary="Electronic lab notebook: entries, plasmids, primers and guides.",
        lifespan=lifespan,
    )

    if settings.cors_origins:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=settings.cors_origins,
            allow_credentials=True,
            allow_methods=["*"],
            allow_headers=["*"],
        )

    @app.exception_handler(DBAPIError)
    async def database_refused(request: Request, exc: DBAPIError) -> JSONResponse:
        """Turn a policy refusal into 403 instead of 500.

        SQLSTATE 42501 from a WITH CHECK clause means the request tried to
        write a row it is not allowed to write — for example an entry stamped
        with another lab. That is the caller's problem, not a server fault, and
        a 500 would send someone reading logs looking for a bug that is not
        there.

        Note that the other kind of refusal never arrives here: a USING clause
        filters rather than raises, which is why the routes check row counts.
        """
        orig = getattr(exc, "orig", None)
        sqlstate = getattr(orig, "sqlstate", None) or getattr(orig, "pgcode", None)
        message = str(getattr(orig, "message", "") or orig or "")

        # 42501 is insufficient_privilege, and it arrives for two unrelated
        # reasons that must not be answered the same way:
        #
        #   a policy's WITH CHECK refused the row   -> the caller's problem, 403
        #   a GRANT is missing                      -> our problem, 500
        #
        # Only the first says "row-level security". Treating both as 403 hides
        # a broken deployment behind a plausible permission message, which is
        # exactly what happened while building this: a missing EXECUTE grant
        # presented itself as "the database refused this write" and looked for
        # all the world like a policy doing its job.
        if sqlstate == "42501" and "row-level security" in message:
            log.warning("policy refused a write on %s", request.url.path)
            return JSONResponse(
                status_code=status.HTTP_403_FORBIDDEN,
                content={"detail": "the database refused this write"},
            )

        # The constraints are part of the contract, not an internal detail: a
        # guide with nothing to target and a primer filed against a plasmid
        # that does not exist are both bad requests, and answering 500 sends
        # whoever reads the logs hunting for a server fault that is not there.
        #
        # The constraint's name goes back, because "guide_rna_has_target" tells
        # the caller what rule they broke. The driver's DETAIL does not: it
        # quotes the offending row, which is the lab's data.
        constraint = getattr(orig, "constraint_name", None) or ""
        client_errors = {
            "23505": (status.HTTP_409_CONFLICT, "that already exists"),
            "23503": (status.HTTP_400_BAD_REQUEST, "it refers to something that does not exist"),
            "23514": (status.HTTP_400_BAD_REQUEST, "that combination of values is not allowed"),
            "22P02": (status.HTTP_400_BAD_REQUEST, "a value is not of the expected type"),
        }
        if sqlstate in client_errors:
            code, detail = client_errors[sqlstate]
            log.info("rejected on %s: %s %s", request.url.path, sqlstate, constraint)
            return JSONResponse(
                status_code=code,
                content={"detail": f"{detail}{f' ({constraint})' if constraint else ''}"},
            )

        log.exception("database error on %s", request.url.path)
        return JSONResponse(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            content={"detail": "database error"},
        )

    @app.get("/api/health", tags=["meta"])
    async def health() -> dict[str, object]:
        """Liveness, plus whether the policies bind. Deliberately unauthenticated
        and deliberately not reporting the role name."""
        try:
            check = await check_rls_is_effective()
            return {"status": "ok", "rls_enforced": check.rls_applies}
        except Exception:  # noqa: BLE001
            return {"status": "degraded", "rls_enforced": None}

    app.include_router(auth.router)
    app.include_router(entries.router)
    app.include_router(dashboard.router)
    app.include_router(members.router)
    app.include_router(plasmids.router)
    app.include_router(primers.router)
    app.include_router(guides.router)
    app.include_router(constructions.pcr_router)
    app.include_router(constructions.assembly_router)
    app.include_router(cloning.router)

    # Mounted last and at the root, so it only sees paths no API route claimed.
    # html=True serves index.html for unknown paths, which is what makes the
    # dashboard's client-side navigation survive a reload.
    if settings.static_dir.is_dir():
        app.mount("/", StaticFiles(directory=settings.static_dir, html=True), name="static")

    return app


app = create_app()
