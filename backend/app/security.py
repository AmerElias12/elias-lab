"""Passwords and tokens.

Argon2id for hashing, because it is the one password hash whose cost you can
raise in memory as well as time, which is what makes a GPU farm a poor
investment. The parameters below are the argon2-cffi defaults, which track the
RFC 9106 second recommended option; they are named explicitly so that raising
them later is a visible change rather than a library upgrade nobody noticed.

Nothing here reads the database and nothing here reads a request. That is what
makes it testable on its own, and it is why the only thing that can go wrong
is arithmetic rather than wiring.
"""
from __future__ import annotations

import datetime as dt
import hashlib
import json
import uuid
from collections.abc import Mapping
from typing import Any

import jwt
from argon2 import PasswordHasher
from argon2.exceptions import InvalidHash, VerifyMismatchError

from app.config import get_settings
from app.db import LabRole

_hasher = PasswordHasher(
    time_cost=3,         # passes over memory
    memory_cost=65536,   # 64 MiB, the part a GPU cannot cheaply parallelise
    parallelism=4,
    hash_len=32,
    salt_len=16,
)


# ---------------------------------------------------------------------------
# Passwords
# ---------------------------------------------------------------------------
def hash_password(password: str) -> str:
    """The returned string carries its own parameters and salt, so a future
    change to the costs above does not invalidate existing hashes."""
    return _hasher.hash(password)


def verify_password(hashed: str, password: str) -> bool:
    """False rather than an exception for a wrong password: a caller that has
    to catch an exception to handle the ordinary case tends to catch too much
    and treat a corrupt hash as a successful login."""
    try:
        return _hasher.verify(hashed, password)
    except (VerifyMismatchError, InvalidHash, ValueError):
        return False


def needs_rehash(hashed: str) -> bool:
    """True once the stored hash is weaker than the parameters above. Call on a
    successful login, when the plaintext is in hand and can be re-hashed."""
    try:
        return _hasher.check_needs_rehash(hashed)
    except (InvalidHash, ValueError):
        return False


# ---------------------------------------------------------------------------
# Tokens
# ---------------------------------------------------------------------------
class TokenError(Exception):
    """Any reason a token is not usable: malformed, expired, wrong signature."""


def create_access_token(
    *,
    user_id: uuid.UUID,
    lab_id: uuid.UUID | None,
    role: LabRole | None,
) -> tuple[str, int]:
    """Returns the token and its lifetime in seconds.

    lab_id travels in the token so a request does not need a membership query
    before it can be scoped. It is a *claim*, not an authorisation: the
    policies in docs/eln-rls.sql read membership from lab_member, so a token
    naming a lab the holder does not belong to yields nothing. That is what
    makes it safe to put here, and it is why switching labs is a new token
    rather than a request parameter.
    """
    settings = get_settings()
    now = dt.datetime.now(tz=dt.timezone.utc)
    lifetime = dt.timedelta(hours=settings.access_token_hours)
    payload: dict[str, Any] = {
        "sub": str(user_id),
        "lab_id": str(lab_id) if lab_id else None,
        "role": role.value if role else None,
        "iat": int(now.timestamp()),
        "exp": int((now + lifetime).timestamp()),
        "jti": uuid.uuid4().hex,
    }
    token = jwt.encode(payload, settings.jwt_secret, algorithm=settings.jwt_algorithm)
    return token, int(lifetime.total_seconds())


def decode_access_token(token: str) -> dict[str, Any]:
    """Raises TokenError for anything that is not a currently valid token.

    The algorithm is pinned to the configured one. Accepting whatever the
    token's own header asks for is how "alg": "none" works, and passing a list
    that includes an asymmetric algorithm alongside an HMAC one is how a public
    key gets used as an HMAC secret.
    """
    settings = get_settings()
    try:
        return jwt.decode(
            token,
            settings.jwt_secret,
            algorithms=[settings.jwt_algorithm],
            options={"require": ["exp", "sub", "jti"]},
        )
    except jwt.PyJWTError as exc:
        raise TokenError(str(exc)) from exc


# ---------------------------------------------------------------------------
# Content hashing for entry versions
# ---------------------------------------------------------------------------
#: The fields a version snapshots, and therefore the fields a signature
#: commits to. Adding one here changes every future hash, which is why it is a
#: named constant and not a literal buried in the function.
SNAPSHOT_FIELDS = (
    "title",
    "hypothesis",
    "methods",
    "results",
    "conclusions",
    "next_steps",
    "performed_on",
    "body",
    "body_text",
)


def content_hash(snapshot: Mapping[str, Any]) -> bytes:
    """The 32 bytes stored on notebook_entry_version.content_sha256.

    A signature names an (entry, version) pair, so what is signed has to be
    reproducible from the stored row years later. Sorted keys and no
    incidental whitespace are what make that true: the same snapshot hashes
    the same on a different machine, a different Python, or after a round trip
    through jsonb, which does not preserve key order. Dates go through str, so
    a date and its ISO form cannot hash differently.

    Only SNAPSHOT_FIELDS are hashed, and missing ones are hashed as null, so
    adding a column to the table does not silently change what a stored hash
    means. If this function ever has to change, it changes by bumping the
    version marker below and keeping the old branch — editing the format in
    place would make every existing signature unverifiable.
    """
    canonical = json.dumps(
        {k: snapshot.get(k) for k in SNAPSHOT_FIELDS},
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        default=str,
    )
    digest = hashlib.sha256()
    digest.update(b"eln-entry-v1\x00")
    digest.update(canonical.encode("utf-8"))
    return digest.digest()
