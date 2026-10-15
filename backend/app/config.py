"""Settings, read from the environment once at import.

Two of these have no default on purpose. A development default for a signing
key is the kind of convenience that ships to production and makes every token
forgeable by anyone who has read the repository — and this repository is
public. Better a service that refuses to start.
"""
from __future__ import annotations

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

    # --- tokens -----------------------------------------------------------
    jwt_secret: str = Field(min_length=32, description="No default. Generate with `openssl rand -hex 32`.")
    jwt_algorithm: str = "HS256"
    # A lab tool people keep open all day. Short expiry without a refresh flow
    # just means being logged out mid-experiment, so this is deliberately long
    # and the trade-off is written down in README.md.
    access_token_hours: int = 12

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
    def is_production(self) -> bool:
        return self.environment.lower() in {"production", "prod"}


@lru_cache
def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]
