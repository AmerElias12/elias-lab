"""${message}

Revision ID: ${up_revision}
Revises: ${down_revision | comma,n}
Created: ${create_date}

Write this by hand. See migrations/env.py for why autogenerate must not be
trusted here: it does not know the policies exist and will drop them.

If this revision changes a policy, remember that PostgreSQL has no ALTER
POLICY for the predicate — it is DROP then CREATE, and both belong in
upgrade() so a failure rolls the pair back together.
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa
${imports if imports else ""}

revision = ${repr(up_revision)}
down_revision = ${repr(down_revision)}
branch_labels = ${repr(branch_labels)}
depends_on = ${repr(depends_on)}


def upgrade() -> None:
    ${upgrades if upgrades else "pass"}


def downgrade() -> None:
    ${downgrades if downgrades else "pass"}
