#!/usr/bin/env python3
"""Checks for the science service — app/science.py and app/auth_light.py.

    pip install -r requirements-dev.txt
    python scripts/check_science.py

No PostgreSQL, because the thing being checked is that there is no PostgreSQL.
The app is driven in-process over ASGI with a database URL pointing at a port
nothing is listening on: if anything in either endpoint reached for a
connection, these checks would hang or fail rather than pass quietly.

Most of what follows is about tokens, and one check earns the rest of the
file. A Supabase project's publishable (anon) key is a JWT signed with the
project's JWT secret, and it is public — it is in this repository and in the
HTML of the live site. "The signature verifies" is therefore not a fact about
who is calling. The claims are. So there is a check that forges exactly that
key and insists on a 401, and if it ever goes green-to-red, the service has
become open to anyone who views source.
"""
from __future__ import annotations

import asyncio
import base64
import json
import os
import pathlib
import random
import sys
import time
import uuid

BACKEND = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND))

import jwt  # noqa: E402

passed = 0
failures: list[str] = []

# Two different secrets throughout, deliberately. With one shared secret, a
# token meant for one issuer would verify as the other and several of these
# checks would pass for the wrong reason.
SUPA_SECRET = "supabase-jwt-secret-" + "x" * 24
ELN_SECRET = "eln-signing-secret-" + "y" * 24
ORIGIN = "https://amerelias12.github.io"

# A port nothing listens on. Nothing here should ever dial it.
NO_DATABASE = "postgresql+asyncpg://nobody@127.0.0.1:1/nope"


# ---------------------------------------------------------------------------
# Harness
# ---------------------------------------------------------------------------
def check(what: str, fn) -> None:
    global passed
    try:
        fn()
    except AssertionError as exc:
        failures.append(f"{what}: {exc}")
        print(f"  FAIL  {what}\n          {exc}")
        return
    except Exception as exc:  # noqa: BLE001
        failures.append(f"{what}: unexpected {type(exc).__name__}: {exc}")
        print(f"  FAIL  {what}\n          unexpected {type(exc).__name__}: {exc}")
        return
    passed += 1
    print(f"  ok    {what}")


def acheck(what: str, coro_fn) -> None:
    check(what, lambda: asyncio.run(coro_fn()))


def raises(fn, kind, fragment: str) -> None:
    try:
        fn()
    except kind as exc:
        assert fragment.lower() in str(exc).lower(), f"wrong message: {exc}"
        return
    raise AssertionError(f"expected {kind.__name__} mentioning {fragment!r}")


# ---------------------------------------------------------------------------
# Building the app under a given configuration
# ---------------------------------------------------------------------------
def build(**env):
    """A fresh app with exactly the ELN_* settings given, and no others.

    Clearing every ELN_* variable first matters: these checks are about what
    happens when a secret is *absent*, and a leftover from the previous
    configuration would make an unconfigured service look configured. The
    settings cache has to go with it, and so does the JWKS client, which holds
    both a URL and the keys fetched from it.
    """
    from app import auth_light
    from app.config import get_settings

    for key in [k for k in os.environ if k.startswith("ELN_")]:
        del os.environ[key]
    os.environ.update(env)
    get_settings.cache_clear()
    auth_light._jwks_client = None
    auth_light._jwks_url = None

    from app import science

    return science.create_app()


def science_config(**over) -> dict[str, str]:
    """The ordinary deployment: Supabase tokens, one allowed origin, and a
    database URL that must never be used."""
    env = {
        "ELN_MODE": "science",
        "ELN_ENVIRONMENT": "development",
        "ELN_SUPABASE_JWT_SECRET": SUPA_SECRET,
        "ELN_CORS_ORIGINS": json.dumps([ORIGIN]),
        "ELN_DATABASE_URL": NO_DATABASE,
    }
    env.update(over)
    return env


def client(app):
    import httpx

    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://science"
    )


# ---------------------------------------------------------------------------
# Forging tokens
# ---------------------------------------------------------------------------
_OMIT = object()


def supabase_token(*, secret: str = SUPA_SECRET, alg: str = "HS256", **over) -> str:
    """A Supabase session token, as issued to a signed-in person."""
    now = int(time.time())
    claims: dict = {
        "sub": str(uuid.uuid4()),
        "aud": "authenticated",
        "role": "authenticated",
        "iss": "https://project-ref.supabase.co/auth/v1",
        "iat": now,
        "exp": now + 3600,
    }
    claims.update(over)
    claims = {k: v for k, v in claims.items() if v is not _OMIT}
    return jwt.encode(claims, secret, algorithm=alg)


def anon_key(secret: str = SUPA_SECRET) -> str:
    """The shape of a Supabase publishable key: real signature, no person.

    No `sub` and `role` of "anon" — that is the whole of what distinguishes it
    from a signed-in user's token, and it is why both are checked.
    """
    now = int(time.time())
    return jwt.encode(
        {"iss": "supabase", "ref": "project-ref", "role": "anon",
         "iat": now, "exp": now + 10 * 365 * 24 * 3600},
        secret,
        algorithm="HS256",
    )


def service_key(secret: str = SUPA_SECRET) -> str:
    now = int(time.time())
    return jwt.encode(
        {"iss": "supabase", "ref": "project-ref", "role": "service_role",
         "iat": now, "exp": now + 10 * 365 * 24 * 3600},
        secret,
        algorithm="HS256",
    )


def eln_token(*, secret: str = ELN_SECRET, lab: bool = True, **over) -> str:
    """What app/security.py issues: sub, lab_id, role, jti, exp."""
    now = int(time.time())
    claims: dict = {
        "sub": str(uuid.uuid4()),
        "lab_id": str(uuid.uuid4()) if lab else None,
        "role": "member",
        "iat": now,
        "exp": now + 900,
        "jti": uuid.uuid4().hex,
    }
    claims.update(over)
    claims = {k: v for k, v in claims.items() if v is not _OMIT}
    return jwt.encode(claims, secret, algorithm="HS256")


def unsigned_token() -> str:
    """alg=none, built by hand because PyJWT will not help.

    The classic forgery: valid-looking claims and no signature at all. It only
    works against a verifier that trusts the token's own header to say how it
    should be checked.
    """
    def b64(raw: bytes) -> str:
        return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()

    now = int(time.time())
    header = b64(json.dumps({"alg": "none", "typ": "JWT"}).encode())
    payload = b64(json.dumps({
        "sub": str(uuid.uuid4()), "aud": "authenticated",
        "role": "authenticated", "iat": now, "exp": now + 3600,
    }).encode())
    return f"{header}.{payload}."


def bearer(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


# ---------------------------------------------------------------------------
# Payloads the endpoints accept
# ---------------------------------------------------------------------------
ECORI, BAMHI = "GAATTC", "GGATCC"
VECTOR = (
    "ATGCATGCATGCATGCATGCATGCATGCATGCATGCATGC"
    + ECORI + "TTTTTTTTTTTTTTTTTTTT" + BAMHI
    + "CGCGCGCGCGCGCGCGCGCGCGCGCGCGCGCGCGCGCGCG"
)
INSERT = (
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
    + ECORI + "ACGTACGTACGTACGTACGTACGTACGTACGTACGTACGT" + BAMHI
    + "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCC"
)
CLONING_BODY = {
    "sequence_a": VECTOR,
    "sequence_b": INSERT,
    "enzymes": ["EcoRI", "BamHI"],
    "name_a": "pVector",
    "name_b": "pInsert",
}

_rng = random.Random(42)
TEMPLATE = "".join(_rng.choice("ACGT") for _ in range(1500))
DESIGN_BODY = {"template": TEMPLATE, "product_length": 500, "optimal_tm": 60}

#: Every route that needs a caller. Each unauthenticated check runs against
#: all of them, so a route added later without a dependency is caught by the
#: existing checks rather than by nobody.
GUARDED = [
    ("POST", "/api/cloning/digest-ligation", CLONING_BODY),
    ("GET", "/api/cloning/enzymes", None),
    ("POST", "/api/primers/design", DESIGN_BODY),
]


async def call(cli, method: str, path: str, body, headers=None):
    if method == "GET":
        return await cli.get(path, headers=headers)
    return await cli.post(path, json=body, headers=headers)


print("science service: auth, CORS and statelessness")

# ---------------------------------------------------------------------------
# 1. Starting up
# ---------------------------------------------------------------------------
print("\nstartup")


async def _refuses_with_no_way_to_verify():
    app = build(**science_config(ELN_SUPABASE_JWT_SECRET=""))
    try:
        async with app.router.lifespan_context(app):
            pass
    except RuntimeError as exc:
        assert "verify no tokens" in str(exc), f"wrong message: {exc}"
        return
    raise AssertionError("started with no token verification configured")


acheck("it refuses to start when it could not verify any token",
       _refuses_with_no_way_to_verify)


async def _refuses_production_without_cors():
    app = build(**science_config(ELN_ENVIRONMENT="production", ELN_CORS_ORIGINS="[]"))
    try:
        async with app.router.lifespan_context(app):
            pass
    except RuntimeError as exc:
        assert "CORS" in str(exc), f"wrong message: {exc}"
        return
    raise AssertionError("started in production with no allowed origin")


acheck("it refuses to start in production with no allowed origin",
       _refuses_production_without_cors)


async def _starts_in_development_without_cors():
    """A warning, not a refusal: uvicorn on localhost with a page opened from
    a file is a normal thing to be doing while writing one of these tools."""
    app = build(**science_config(ELN_CORS_ORIGINS="[]"))
    async with app.router.lifespan_context(app):
        pass


acheck("in development, a missing origin is a warning and not a refusal",
       _starts_in_development_without_cors)


async def _starts_when_configured():
    app = build(**science_config())
    async with app.router.lifespan_context(app):
        async with client(app) as cli:
            r = await cli.get("/api/health")
            assert r.status_code == 200, r.text
            assert r.json()["accepts"] == ["supabase"], r.json()


acheck("configured, it starts and health reports which tokens it takes",
       _starts_when_configured)


def _rejects_an_unknown_mode():
    from app.config import Settings, get_settings

    get_settings.cache_clear()
    os.environ["ELN_MODE"] = "sience"
    try:
        raises(lambda: Settings(), Exception, "must be 'full' or 'science'")
    finally:
        del os.environ["ELN_MODE"]
        get_settings.cache_clear()


check("a mistyped ELN_MODE is refused rather than silently meaning 'full'",
      _rejects_an_unknown_mode)


def _issuers_are_reported_from_what_is_set():
    from app.auth_light import configured_issuers
    from app.config import Settings

    # _env_file=None skips the .env file but not the environment, so the
    # "nothing configured" case below needs the variables actually gone — a
    # leftover from the previous check is exactly what made this pass for the
    # wrong reason the first time it was written.
    for key in [k for k in os.environ if k.startswith("ELN_")]:
        del os.environ[key]

    both = Settings(
        _env_file=None, jwt_secret=ELN_SECRET, supabase_jwt_secret=SUPA_SECRET
    )
    assert configured_issuers(both) == ["eln", "supabase"], configured_issuers(both)

    jwks_only = Settings(_env_file=None, supabase_url="https://ref.supabase.co")
    assert configured_issuers(jwks_only) == ["supabase"], configured_issuers(jwks_only)

    none_at_all = Settings(_env_file=None)
    assert configured_issuers(none_at_all) == [], configured_issuers(none_at_all)


check("configured_issuers reflects the secrets actually set",
      _issuers_are_reported_from_what_is_set)


def _jwks_endpoint_is_derived():
    from app.config import Settings

    s = Settings(_env_file=None, supabase_url="https://ref.supabase.co/")
    assert s.supabase_jwks_endpoint == (
        "https://ref.supabase.co/auth/v1/.well-known/jwks.json"
    ), s.supabase_jwks_endpoint
    assert Settings(_env_file=None).supabase_jwks_endpoint is None


check("the JWKS endpoint is derived from the project URL, trailing slash or not",
      _jwks_endpoint_is_derived)


# ---------------------------------------------------------------------------
# 2. Who is turned away
# ---------------------------------------------------------------------------
print("\nrejected callers")


async def _no_header():
    app = build(**science_config())
    async with client(app) as cli:
        for method, path, body in GUARDED:
            r = await call(cli, method, path, body)
            assert r.status_code == 401, f"{path}: {r.status_code}"
            assert r.headers.get("www-authenticate") == "Bearer", (
                f"{path}: no challenge header"
            )


acheck("every endpoint answers 401 with a challenge when no token is sent", _no_header)


async def _rubbish_token():
    app = build(**science_config())
    async with client(app) as cli:
        for token in ("", "notatoken", "a.b.c", "Bearer", "." * 40):
            for method, path, body in GUARDED:
                r = await call(cli, method, path, body, bearer(token))
                assert r.status_code == 401, f"{path} with {token!r}: {r.status_code}"


acheck("a malformed token is 401 on every endpoint", _rubbish_token)


async def _the_published_anon_key_is_not_a_credential():
    """The check this file exists for.

    The anon key's signature is genuine — it is signed with the very secret
    this service verifies against. What it has not got is a person: no `sub`,
    and `role` of "anon". If this ever returns 200, the service is open to
    anybody who opens the browser's view-source on the lab's site.
    """
    app = build(**science_config())
    async with client(app) as cli:
        key = anon_key()
        # The signature really does verify. Stated here so a reader does not
        # take the 401 below as evidence that it does not.
        jwt.decode(key, SUPA_SECRET, algorithms=["HS256"],
                   options={"verify_aud": False})
        for method, path, body in GUARDED:
            r = await call(cli, method, path, body, bearer(key))
            assert r.status_code == 401, (
                f"{path}: the published anon key was accepted ({r.status_code})"
            )


acheck("the Supabase publishable (anon) key is refused, signature and all",
       _the_published_anon_key_is_not_a_credential)


async def _the_service_key_is_not_a_credential():
    """It would be a catastrophic one to accept, but for the same reason as
    the anon key it has no `sub`, so it fails the same check."""
    app = build(**science_config())
    async with client(app) as cli:
        for method, path, body in GUARDED:
            r = await call(cli, method, path, body, bearer(service_key()))
            assert r.status_code == 401, f"{path}: service_role accepted"


acheck("a service_role key is refused too", _the_service_key_is_not_a_credential)


async def _claims_that_do_not_name_a_person():
    app = build(**science_config())
    cases = {
        "no sub": supabase_token(sub=_OMIT),
        "empty sub": supabase_token(sub=""),
        "sub is not a user id": supabase_token(sub="someone@example.org"),
        "role is anon": supabase_token(role="anon"),
        "role is service_role": supabase_token(role="service_role"),
        "no role": supabase_token(role=_OMIT),
    }
    async with client(app) as cli:
        for name, token in cases.items():
            r = await cli.post("/api/primers/design", json=DESIGN_BODY,
                               headers=bearer(token))
            assert r.status_code == 401, f"{name}: accepted ({r.status_code})"


acheck("a signed token that names no authenticated person is refused",
       _claims_that_do_not_name_a_person)


async def _wrong_signature_or_algorithm():
    app = build(**science_config())
    cases = {
        "signed with another secret": supabase_token(secret="a" * 40),
        "unsigned, alg=none": unsigned_token(),
        "HS512 instead of the pinned HS256": supabase_token(alg="HS512"),
        "expired an hour ago": supabase_token(exp=int(time.time()) - 3600),
        "no exp at all": supabase_token(exp=_OMIT),
        "wrong audience": supabase_token(aud="anon"),
        "no audience": supabase_token(aud=_OMIT),
    }
    async with client(app) as cli:
        for name, token in cases.items():
            r = await cli.post("/api/primers/design", json=DESIGN_BODY,
                               headers=bearer(token))
            assert r.status_code == 401, f"{name}: accepted ({r.status_code})"


acheck("a bad signature, a bad algorithm, a bad audience or an expiry is 401",
       _wrong_signature_or_algorithm)


async def _the_reason_is_not_returned():
    """Expired and forged must be indistinguishable from outside. Saying which
    is a free oracle for somebody working through crafted tokens."""
    app = build(**science_config())
    async with client(app) as cli:
        expired = await cli.post("/api/primers/design", json=DESIGN_BODY,
                                 headers=bearer(supabase_token(exp=1)))
        forged = await cli.post("/api/primers/design", json=DESIGN_BODY,
                                headers=bearer(supabase_token(secret="z" * 40)))
    assert expired.status_code == forged.status_code == 401
    assert expired.json() == forged.json(), (expired.json(), forged.json())


acheck("an expired token and a forged one give the same answer",
       _the_reason_is_not_returned)


async def _an_unreachable_jwks_fails_closed():
    """Configured for a project that signs with a published key, with nothing
    at the other end. It must refuse rather than fall back to treating the
    secret-shaped key material as an HMAC secret."""
    app = build(**science_config(
        ELN_SUPABASE_JWT_SECRET="",
        ELN_SUPABASE_URL="http://127.0.0.1:1",
    ))
    async with client(app) as cli:
        r = await cli.post("/api/primers/design", json=DESIGN_BODY,
                           headers=bearer(supabase_token()))
        assert r.status_code == 401, r.status_code


acheck("with only a JWKS configured and nothing serving it, an HS256 token is refused",
       _an_unreachable_jwks_fails_closed)


async def _tokens_do_not_cross_between_issuers():
    supa_only = build(**science_config())
    async with client(supa_only) as cli:
        r = await cli.post("/api/primers/design", json=DESIGN_BODY,
                           headers=bearer(eln_token()))
        assert r.status_code == 401, f"an ELN token was taken by a Supabase-only service: {r.status_code}"

    eln_only = build(**science_config(
        ELN_SUPABASE_JWT_SECRET="", ELN_JWT_SECRET=ELN_SECRET
    ))
    async with client(eln_only) as cli:
        r = await cli.post("/api/primers/design", json=DESIGN_BODY,
                           headers=bearer(supabase_token()))
        assert r.status_code == 401, f"a Supabase token was taken by an ELN-only service: {r.status_code}"


acheck("a token is only accepted by the issuer that is configured",
       _tokens_do_not_cross_between_issuers)


# ---------------------------------------------------------------------------
# 3. Who gets through
# ---------------------------------------------------------------------------
print("\naccepted callers")


async def _a_signed_in_supabase_user_can_design():
    app = build(**science_config())
    async with client(app) as cli:
        r = await cli.post("/api/primers/design", json=DESIGN_BODY,
                           headers=bearer(supabase_token()))
        assert r.status_code == 200, r.text
        pairs = r.json()["pairs"]
        assert 1 <= len(pairs) <= 3, len(pairs)
        fwd = pairs[0]["forward"]
        assert TEMPLATE[fwd["start"]:fwd["end"]] == fwd["sequence"], (
            "the forward primer is not where the response says it is"
        )


acheck("a signed-in Supabase user gets primer pairs placed on the template",
       _a_signed_in_supabase_user_can_design)


async def _a_signed_in_supabase_user_can_clone():
    app = build(**science_config())
    async with client(app) as cli:
        r = await cli.post("/api/cloning/digest-ligation", json=CLONING_BODY,
                           headers=bearer(supabase_token()))
        assert r.status_code == 200, r.text
        out = r.json()
        assert out["constructs"], "no construct came back"
        assert out["enzymes"] == ["BamHI", "EcoRI"], out["enzymes"]


acheck("the same user gets a construct out of a two-enzyme digest and ligation",
       _a_signed_in_supabase_user_can_clone)


async def _an_eln_token_with_a_lab_works():
    app = build(**science_config(ELN_JWT_SECRET=ELN_SECRET))
    async with client(app) as cli:
        r = await cli.get("/api/cloning/enzymes?q=ecor", headers=bearer(eln_token()))
        assert r.status_code == 200, r.text
        assert "EcoRI" in r.json(), r.json()


acheck("the ELN's own token works where it is configured alongside Supabase",
       _an_eln_token_with_a_lab_works)


async def _an_eln_token_with_no_lab_is_403_not_401():
    """The approval step, preserved. A new account belongs to no lab, and the
    full application answers 403 with a reason rather than 401 — that must not
    change just because this route no longer asks the database."""
    app = build(**science_config(ELN_JWT_SECRET=ELN_SECRET))
    async with client(app) as cli:
        r = await cli.post("/api/primers/design", json=DESIGN_BODY,
                           headers=bearer(eln_token(lab=False)))
        assert r.status_code == 403, f"{r.status_code}: {r.text}"
        assert "lab" in r.json()["detail"], r.json()


acheck("an ELN token naming no lab is 403 with a reason, not a bare 401",
       _an_eln_token_with_no_lab_is_403_not_401)


# ---------------------------------------------------------------------------
# 4. No database
# ---------------------------------------------------------------------------
print("\nstatelessness")


async def _nothing_touches_the_database():
    """The database URL points at a closed port throughout this file. If
    either endpoint opened a session, this would raise rather than answer."""
    app = build(**science_config())
    async with client(app) as cli:
        token = supabase_token()
        for method, path, body in GUARDED:
            r = await call(cli, method, path, body, bearer(token))
            assert r.status_code == 200, f"{path}: {r.status_code} {r.text[:200]}"


acheck("every endpoint answers with the database URL pointing at a closed port",
       _nothing_touches_the_database)


def _it_never_imports_what_the_slim_install_leaves_out():
    """requirements-science.txt drops asyncpg, psycopg and alembic.

    Dropping them is only safe while nothing imports them, and an import added
    later would not fail here — it would fail on the first boot of a container
    built from the slim list, which is a worse place to find out. This runs
    before the check below, which imports app.session deliberately.
    """
    assert "app.science" in sys.modules, "the app has not been imported yet"
    for module, distribution in (
        ("asyncpg", "asyncpg"),
        ("psycopg", "psycopg[binary]"),
        ("alembic", "alembic"),
        ("app.deps", "the database-backed dependencies"),
        ("app.models", "the ORM models"),
    ):
        assert module not in sys.modules, (
            f"the science service imported {module}, which "
            f"requirements-science.txt leaves out ({distribution})"
        )


check("it imports none of the dependencies the slim install drops",
      _it_never_imports_what_the_slim_install_leaves_out)


def _the_engine_is_never_created():
    """Stronger than the above: not merely unused, never built.

    app/session.py builds the engine lazily, so asking whether it exists after
    a round of requests distinguishes "did not query" from "did not connect".
    """
    from app import session as session_module

    assert session_module._engine is None, (
        "something created a database engine in a service that has no database"
    )


check("no database engine was ever constructed", _the_engine_is_never_created)


def _it_serves_only_the_two_tools():
    app = build(**science_config())
    paths = set(app.openapi()["paths"])
    assert paths == {
        "/api/health",
        "/api/cloning/digest-ligation",
        "/api/cloning/enzymes",
        "/api/primers/design",
    }, sorted(paths)


check("it exposes the two tools and a health check, and nothing else",
      _it_serves_only_the_two_tools)


def _no_notebook_routes_leaked_in():
    """Named separately from the exact-set check above, because this is the
    one somebody would break by adding a convenient import."""
    app = build(**science_config())
    paths = app.openapi()["paths"]
    for prefix in ("/api/auth", "/api/entries", "/api/plasmids", "/api/members",
                   "/api/guides", "/api/dashboard", "/api/assemblies", "/api/pcr"):
        leaked = [p for p in paths if p.startswith(prefix)]
        assert not leaked, f"{prefix} reached the science service: {leaked}"


check("none of the notebook's routes are reachable here", _no_notebook_routes_leaked_in)


# ---------------------------------------------------------------------------
# 5. CORS
# ---------------------------------------------------------------------------
print("\ncross-origin")


async def _preflight_from_the_configured_origin():
    app = build(**science_config())
    async with client(app) as cli:
        r = await cli.options("/api/primers/design", headers={
            "Origin": ORIGIN,
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "authorization,content-type",
        })
        assert r.status_code in (200, 204), r.status_code
        assert r.headers.get("access-control-allow-origin") == ORIGIN, dict(r.headers)
        allowed = r.headers.get("access-control-allow-headers", "").lower()
        assert "authorization" in allowed, allowed


acheck("a preflight from the site's origin is allowed, Authorization included",
       _preflight_from_the_configured_origin)


async def _preflight_from_anywhere_else():
    app = build(**science_config())
    async with client(app) as cli:
        r = await cli.options("/api/primers/design", headers={
            "Origin": "https://not-the-lab.example",
            "Access-Control-Request-Method": "POST",
        })
        assert "access-control-allow-origin" not in r.headers, dict(r.headers)


acheck("a preflight from any other origin gets no allow-origin header",
       _preflight_from_anywhere_else)


async def _credentials_are_not_invited():
    """The token travels in a header, so the browser never needs to send
    cookies. Leaving credentials off keeps this out of CSRF's way entirely."""
    app = build(**science_config())
    async with client(app) as cli:
        r = await cli.post("/api/primers/design", json=DESIGN_BODY,
                           headers={**bearer(supabase_token()), "Origin": ORIGIN})
        assert r.status_code == 200, r.text
        assert "access-control-allow-credentials" not in r.headers, dict(r.headers)


acheck("responses do not invite credentials, because the token is a header",
       _credentials_are_not_invited)


async def _health_needs_no_token():
    app = build(**science_config())
    async with client(app) as cli:
        r = await cli.get("/api/health")
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["mode"] == "science", body
        # Whatever it says, it must not be a secret.
        assert SUPA_SECRET not in r.text and ELN_SECRET not in r.text


acheck("health answers without a token and names no secret", _health_needs_no_token)


# ---------------------------------------------------------------------------
# 6. The full application still works the way it did
# ---------------------------------------------------------------------------
print("\nthe full application")


def _the_full_app_still_has_design_at_the_same_path():
    """Moving the route to its own module must not move the route."""
    import importlib

    from app.config import get_settings

    for key in [k for k in os.environ if k.startswith("ELN_")]:
        del os.environ[key]
    os.environ.update({
        "ELN_JWT_SECRET": ELN_SECRET,
        "ELN_DATABASE_URL": NO_DATABASE,
        "ELN_ENVIRONMENT": "development",
    })
    get_settings.cache_clear()
    main = importlib.import_module("app.main")
    app = main.create_app()
    paths = app.openapi()["paths"]
    assert "/api/primers/design" in paths, sorted(p for p in paths if "primer" in p)
    assert "post" in paths["/api/primers/design"], paths["/api/primers/design"]
    # And the rest of the notebook is still there, which is what says this was
    # a move and not a removal.
    for p in ("/api/primers", "/api/primers/{primer_id}", "/api/entries",
              "/api/cloning/digest-ligation"):
        assert p in paths, f"{p} went missing: {sorted(paths)}"


check("the full application still serves POST /api/primers/design",
      _the_full_app_still_has_design_at_the_same_path)


async def _the_full_app_refuses_without_a_signing_key():
    """ELN_JWT_SECRET became optional in the settings so this service could
    run on Supabase tokens alone. The notebook issues tokens, so for it the
    key is still required — and the check has to live somewhere now that
    pydantic no longer makes it impossible to omit."""
    import importlib

    from app.config import get_settings

    for key in [k for k in os.environ if k.startswith("ELN_")]:
        del os.environ[key]
    os.environ.update({
        "ELN_DATABASE_URL": NO_DATABASE,
        "ELN_ENVIRONMENT": "development",
    })
    get_settings.cache_clear()
    main = importlib.import_module("app.main")
    app = main.create_app()
    try:
        async with app.router.lifespan_context(app):
            pass
    except RuntimeError as exc:
        assert "ELN_JWT_SECRET" in str(exc), f"wrong message: {exc}"
        return
    raise AssertionError("the notebook started with no signing key")


acheck("the notebook still refuses to start without ELN_JWT_SECRET",
       _the_full_app_refuses_without_a_signing_key)


def _issuing_a_token_without_a_key_says_what_is_missing():
    from app.config import get_settings
    from app.security import TokenError, create_access_token

    for key in [k for k in os.environ if k.startswith("ELN_")]:
        del os.environ[key]
    get_settings.cache_clear()
    raises(
        lambda: create_access_token(user_id=uuid.uuid4(), lab_id=None, role=None),
        TokenError,
        "ELN_JWT_SECRET is not set",
    )


check("signing with no key configured says which variable is missing",
      _issuing_a_token_without_a_key_says_what_is_missing)


# ---------------------------------------------------------------------------
print()
if failures:
    print(f"{passed} passed, {len(failures)} failed")
    for f in failures:
        print(f"  - {f}")
    sys.exit(1)
print(f"{passed} checks passed")
