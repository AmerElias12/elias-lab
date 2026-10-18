"""Verifying a caller without a database.

The two scientific endpoints — restriction cloning and primer design — read
nothing and write nothing. Sequence goes in, constructs or primer pairs come
back. That makes them deployable on their own, next to a lab that keeps its
data in Supabase, and this module is what lets them check who is calling
without carrying a schema, a connection pool and a policy set along for the
ride.

Two kinds of token are accepted, and only the ones that are configured:

    the ELN's own access token   signed with ELN_JWT_SECRET
    a Supabase session token     signed by the Supabase project

Both are checked against a key held in this process, never against a lookup,
so a request costs one HMAC or one cached signature verification.

The hazard worth naming
-----------------------
A Supabase project's *publishable* (anon) key is itself a JWT signed with the
project's JWT secret, and it is public — it is in this repository and it is in
the HTML of the live site. Verifying the signature therefore proves nothing
about who is calling. What separates a signed-in person from the published key
is the claims:

    anon key      role="anon",            no sub
    service key   role="service_role",    no sub
    a person      role="authenticated",   sub=<their user id>

So this module requires `role == "authenticated"` *and* a `sub` that parses as
a UUID. Without both of those checks, the anon key in the published page is a
valid credential for anybody who views source.
"""
from __future__ import annotations

import asyncio
import logging
import uuid
from dataclasses import dataclass
from typing import Annotated, Any

import jwt
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from app.config import Settings, get_settings
from app.security import TokenError, decode_access_token

log = logging.getLogger("eln.auth_light")

_bearer = HTTPBearer(auto_error=False, description="Bearer <access token>")

_UNAUTHENTICATED = HTTPException(
    status_code=status.HTTP_401_UNAUTHORIZED,
    detail="not authenticated",
    headers={"WWW-Authenticate": "Bearer"},
)

#: Supabase signs with the project's shared secret (HS256) on older projects
#: and with a rotating asymmetric key published as a JWKS on newer ones. Both
#: are supported, but never interchangeably: each is decoded with its own key
#: and its own single-purpose algorithm list, because a list mixing an HMAC
#: algorithm with an asymmetric one is how a public key ends up being accepted
#: as a shared secret.
_SUPABASE_SYMMETRIC = ["HS256"]
_SUPABASE_ASYMMETRIC = ["ES256", "RS256"]

_jwks_client: jwt.PyJWKClient | None = None
_jwks_url: str | None = None


@dataclass(frozen=True, slots=True)
class ApiUser:
    """A verified caller, and nothing more.

    No role, no permissions, and no lab membership for a Supabase caller —
    there is nothing here to be permitted *to*. The identity exists so the
    service is not an open compute endpoint with the lab's name on it, and so
    a log line can say whose simulation fell over.
    """

    user_id: uuid.UUID
    lab_id: uuid.UUID | None
    issuer: str  # "eln" | "supabase"

    @property
    def label(self) -> str:
        """What goes in a log line: the lab when there is one, the user
        otherwise. Never the token, and never an email address."""
        if self.lab_id:
            return f"lab {self.lab_id}"
        return f"{self.issuer} user {self.user_id}"


def configured_issuers(settings: Settings | None = None) -> list[str]:
    """Which token kinds this process can verify at all.

    An empty list means the service cannot authenticate anybody. That is a
    configuration error rather than a lockout to be discovered one request at
    a time, so both apps check it on the way up.
    """
    settings = get_settings() if settings is None else settings
    issuers = []
    if settings.jwt_secret:
        issuers.append("eln")
    if settings.supabase_jwt_secret or settings.supabase_jwks_endpoint:
        issuers.append("supabase")
    return issuers


# ---------------------------------------------------------------------------
# Supabase
# ---------------------------------------------------------------------------
def _get_jwks_client(url: str) -> jwt.PyJWKClient:
    global _jwks_client, _jwks_url
    if _jwks_client is None or _jwks_url != url:
        # Keys are cached, so the network call happens on the first request
        # after a rotation rather than on every request. `lifespan` is how long
        # a cached JWKS stays trusted; 300 s is PyJWT's default and is short
        # enough that a withdrawn key stops working within minutes.
        _jwks_client = jwt.PyJWKClient(url, cache_keys=True, lifespan=300)
        _jwks_url = url
    return _jwks_client


def _check_supabase_claims(claims: dict[str, Any]) -> uuid.UUID:
    """The part that is not the signature, and the part that matters.

    See the module docstring: the signature is satisfied by the published anon
    key, so these two claims are what actually distinguish a person from a key
    anybody can read off the page.
    """
    if claims.get("role") != "authenticated":
        raise TokenError(f"role is {claims.get('role')!r}, not an end user")
    sub = claims.get("sub")
    if not sub:
        raise TokenError("no sub")
    try:
        return uuid.UUID(str(sub))
    except ValueError as exc:
        raise TokenError("sub is not a user id") from exc


def _decode_supabase_symmetric(token: str, settings: Settings) -> dict[str, Any]:
    secret = settings.supabase_jwt_secret
    assert secret  # the caller checks; this keeps the type checker happy
    return jwt.decode(
        token,
        secret,
        algorithms=_SUPABASE_SYMMETRIC,
        audience=settings.supabase_audience,
        options={"require": ["exp", "sub"]},
    )


def _decode_supabase_asymmetric(token: str, settings: Settings) -> dict[str, Any]:
    url = settings.supabase_jwks_endpoint
    assert url
    key = _get_jwks_client(url).get_signing_key_from_jwt(token)
    return jwt.decode(
        token,
        key.key,
        algorithms=_SUPABASE_ASYMMETRIC,
        audience=settings.supabase_audience,
        options={"require": ["exp", "sub"]},
    )


def _verify_supabase_blocking(token: str, settings: Settings) -> ApiUser:
    """Runs off the event loop, because the JWKS fetch is synchronous HTTP.

    Only the first request after a rotation actually fetches, but "blocks the
    loop for a network round trip, but only sometimes" is not a property worth
    building on, so the whole function goes to a thread.
    """
    reasons: list[str] = []
    candidates = []
    if settings.supabase_jwt_secret:
        candidates.append(_decode_supabase_symmetric)
    if settings.supabase_jwks_endpoint:
        candidates.append(_decode_supabase_asymmetric)

    for decode in candidates:
        try:
            claims = decode(token, settings)
        except jwt.PyJWTError as exc:
            reasons.append(f"{decode.__name__}: {exc}")
            continue
        except Exception as exc:  # noqa: BLE001 — a JWKS fetch can fail any way
            # Worth a log line of its own: an unreachable JWKS endpoint looks
            # exactly like a bad token from the caller's side, and the caller
            # cannot do anything about it.
            log.warning("could not fetch Supabase signing keys: %s", exc)
            reasons.append(f"{decode.__name__}: {exc}")
            continue
        return ApiUser(
            user_id=_check_supabase_claims(claims), lab_id=None, issuer="supabase"
        )

    raise TokenError("; ".join(reasons) or "no Supabase verification configured")


# ---------------------------------------------------------------------------
# The ELN's own token
# ---------------------------------------------------------------------------
def _verify_eln(token: str) -> ApiUser:
    claims = decode_access_token(token)
    try:
        user_id = uuid.UUID(claims["sub"])
        lab_id = uuid.UUID(claims["lab_id"]) if claims.get("lab_id") else None
    except (KeyError, ValueError) as exc:
        raise TokenError("malformed claims") from exc
    if lab_id is None:
        # The same gate app/deps.py applies, reached from the claim instead of
        # from a membership query. A new account belongs to no lab and can do
        # nothing until somebody adds them to one — that is the approval step,
        # and it should not become skippable by picking the endpoint that
        # happens not to need a database.
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="this account does not belong to a lab yet",
        )
    return ApiUser(user_id=user_id, lab_id=lab_id, issuer="eln")


# ---------------------------------------------------------------------------
# The dependency
# ---------------------------------------------------------------------------
async def current_caller(
    creds: Annotated[HTTPAuthorizationCredentials | None, Depends(_bearer)],
) -> ApiUser:
    """Whoever is calling, or 401. Touches no database.

    The ELN's own token is tried first because it costs one HMAC and no
    network. Which check failed is logged at debug and never returned:
    "expired" versus "bad signature" is a free oracle for somebody probing
    with crafted tokens.
    """
    if creds is None or not creds.credentials:
        raise _UNAUTHENTICATED
    settings = get_settings()
    token = creds.credentials
    reasons: list[str] = []

    if settings.jwt_secret:
        try:
            return _verify_eln(token)
        except TokenError as exc:
            reasons.append(f"eln: {exc}")
        # The no-lab HTTPException deliberately propagates rather than being
        # caught here: the token was ours and it verified, so falling through
        # to try it as a Supabase token would answer 401 and throw away the
        # real answer.

    if settings.supabase_jwt_secret or settings.supabase_jwks_endpoint:
        try:
            return await asyncio.to_thread(_verify_supabase_blocking, token, settings)
        except TokenError as exc:
            reasons.append(f"supabase: {exc}")

    if not reasons:
        # Nothing was configured to verify against. It fails closed, but say so
        # in the log: from outside it is indistinguishable from a bad token,
        # and somebody will otherwise spend an afternoon on it.
        log.error(
            "no token verification is configured: set ELN_JWT_SECRET or "
            "ELN_SUPABASE_JWT_SECRET / ELN_SUPABASE_URL"
        )
    else:
        log.debug("rejected a bearer token (%s)", "; ".join(reasons))
    raise _UNAUTHENTICATED


CallerDep = Annotated[ApiUser, Depends(current_caller)]
