"""The science service: restriction cloning and primer design, nothing else.

    uvicorn app.science:app

Why this exists
---------------
The lab's records stay in Supabase. What Supabase cannot do is run pydna,
Biopython's REBASE tables or the primer scoring in app/primer_design.py — its
Edge Functions are Deno, and there is no Python runtime to put these libraries
in. So the two endpoints that are *only* computation get their own process,
and the site calls it directly:

    https://eliaslab.example/tools/   (GitHub Pages, static)
        |
        |  fetch, with the Supabase session token
        v
    this service  ->  pydna / Biopython / primers
        |
        |  what the lab chooses to keep
        v
    Supabase (Postgres + RLS)

It holds no data, so there is nothing here to leak and nothing to back up. A
restart loses nothing. That is the whole reason it is a separate app rather
than ELN_MODE on the full one: the full application will not start without a
database and a working set of policies, and both of those checks are correct
for a notebook and meaningless for a calculator.

What it does not have
---------------------
No database, no sessions, no `SET LOCAL`, no row-level security — there are no
rows. No /api/auth: it verifies a token Supabase issued rather than issuing
one, so there is no password to hash here and no refresh family to rotate. No
static files; the pages are served by GitHub Pages from the repository root.
"""
from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from typing import AsyncIterator

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.auth_light import configured_issuers
from app.config import get_settings
from app.routers import cloning, design

log = logging.getLogger("eln.science")


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """One check, and it is about being able to say no.

    A service with no way to verify a token would answer 401 to everybody,
    which is safe but looks exactly like a bad token from the outside. A
    service with no configured CORS origin would answer every request and have
    every browser discard it, which looks exactly like a server that is down.
    Both are hours of debugging, so both are said here, once, loudly.
    """
    settings = get_settings()

    issuers = configured_issuers(settings)
    if not issuers:
        raise RuntimeError(
            "this service can verify no tokens and would refuse every request. "
            "Set ELN_SUPABASE_JWT_SECRET (Supabase → Settings → API → JWT "
            "Secret) or ELN_SUPABASE_URL for a project that signs with a "
            "published key, or ELN_JWT_SECRET to accept the ELN's own tokens."
        )
    log.info("accepting tokens from: %s", ", ".join(issuers))

    if not settings.cors_origins:
        message = (
            "ELN_CORS_ORIGINS is empty. This service has no frontend of its "
            "own, so a browser on the lab's site will have every response "
            "rejected by the same-origin policy. Set it to the site's origin, "
            "e.g. https://amerelias12.github.io"
        )
        if settings.is_production:
            raise RuntimeError(message)
        log.warning("%s", message)

    yield


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(
        title="Elias Lab — molecular tools",
        version="0.1.0",
        summary="In-silico restriction cloning and primer design. Stateless.",
        lifespan=lifespan,
    )

    if settings.cors_origins:
        # allow_credentials stays false: the caller sends the Supabase token in
        # an Authorization header, not a cookie, and turning credentials on
        # here would forbid the wildcard without buying anything. Methods and
        # headers are listed rather than "*" so that adding one is a decision.
        app.add_middleware(
            CORSMiddleware,
            allow_origins=settings.cors_origins,
            allow_credentials=False,
            allow_methods=["GET", "POST", "OPTIONS"],
            allow_headers=["Authorization", "Content-Type"],
            max_age=3600,
        )

    @app.get("/api/health", tags=["meta"])
    async def health() -> dict[str, object]:
        """Liveness, for whatever is restarting this. Deliberately
        unauthenticated, and deliberately naming no secrets — which token
        kinds are accepted is a fact about configuration, not a credential."""
        return {
            "status": "ok",
            "mode": "science",
            "accepts": configured_issuers(),
        }

    app.include_router(design.router)
    app.include_router(cloning.router)

    return app


app = create_app()
