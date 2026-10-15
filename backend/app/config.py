"""Settings, read from the environment once at import.

Two of these have no default on purpose. A development default for a signing
key is the kind of convenience that ships to production and makes every token
forgeable by anyone who has read the repository — and this repository is
public. Better a service that refuses to start.
"""
from __future__ import annotations

import os
import pathlib
from functools import lru_cache

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

BACKEND_DIR = pathlib.Path(__file__).resolve().parent.parent


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env", env_prefix="ELN_", extra="ignore", case_sensitive=False
    )

    # --- database ---------------------------------------------------------
    # Must connect as a role that is neither superuser nor BYPASSRLS, or every
    # policy in docs/eln-rls.sql is decoration. main.py checks this at startup.
    database_url: str = Field(
        default="postgresql+asyncpg://eln_app@localhost:5432/eln",
        description="SQLAlchemy async URL. The role must be eln_app, not the owner.",
    )
    db_echo: bool = False
    db_pool_size: int = 5
    db_max_overflow: int = 5

    # Migrations connect as a different role, for two reasons. They create
    # roles, set BYPASSRLS and change function ownership, none of which
    # eln_app may do — and eln_app must stay unable to do them, or the
    # separation the policies rest on is nominal. Left unset, this falls back
    # to database_url with the driver swapped, which is right for a local
    # database where one role does everything and wrong everywhere else.
    migration_database_url: str | None = None

    # --- tokens -----------------------------------------------------------
    jwt_secret: str = Field(min_length=32, description="No default. Generate with `openssl rand -hex 32`.")
    jwt_algorithm: str = "HS256"
    # Short, because it can no longer be withdrawn once issued and because
    # there is now a refresh flow to renew it quietly. This is the window in
    # which a stolen access token is still worth something.
    access_token_minutes: int = 15
    # How long somebody stays signed in without touching the app. Rotation
    # means a session in daily use renews indefinitely; this is the idle limit.
    refresh_token_days: int = 30
    # The refresh cookie is Secure in production and not in development, where
    # localhost is http and a Secure cookie would simply never be sent.
    cookie_secure: bool | None = None

    # --- http -------------------------------------------------------------
    # Empty by default: the API serves its own frontend from the same origin,
    # so there is no cross-origin request to allow. Only add an origin when a
    # separate frontend host genuinely needs one.
    cors_origins: list[str] = Field(default_factory=list)
    static_dir: pathlib.Path = BACKEND_DIR / "static"
    environment: str = "development"

    @field_validator("jwt_secret")
    @classmethod
    def secret_is_not_a_placeholder(cls, v: str) -> str:
        if v.strip().lower() in {"change-me", "changeme", "secret", "dev", "development"}:
            raise ValueError("set ELN_JWT_SECRET to a real random value")
        return v

    @property
    def refresh_cookie_secure(self) -> bool:
        if self.cookie_secure is not None:
            return self.cookie_secure
        return self.is_production

    @property
    def is_production(self) -> bool:
        return self.environment.lower() in {"production", "prod"}

    @property
    def sync_migration_url(self) -> str:
        """The URL Alembic connects with — synchronous, always.

        The migration applies the SQL files in docs/, which are multi-statement
        scripts full of dollar-quoted function bodies. asyncpg drives those
        through the extended query protocol, which takes one statement at a
        time; psycopg sends the script as-is. Alembic is also a command people
        run and wait for, so there is nothing for async to overlap with.
        """
        if self.migration_database_url:
            return self.migration_database_url
        return self.database_url.replace("postgresql+asyncpg://", "postgresql+psycopg://")

    # migration_url_from_env() below is the same rule without a Settings
    # instance; alembic uses that one.


@lru_cache
def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]


DEFAULT_DATABASE_URL = "postgresql+asyncpg://eln_app@localhost:5432/eln"


def migration_url_from_env() -> str:
    """The migration URL, without building a Settings.

    Deliberately standalone: `alembic upgrade head` is a thing a DBA runs, and
    it should not fail because ELN_JWT_SECRET is unset. Migrations do not sign
    tokens. Coupling them to the application's whole configuration means the
    person least able to supply a signing key is the one being asked for it.
    """
    url = os.environ.get("ELN_MIGRATION_DATABASE_URL")
    if url:
        return url
    url = os.environ.get("ELN_DATABASE_URL", DEFAULT_DATABASE_URL)
    return url.replace("postgresql+asyncpg://", "postgresql+psycopg://")
