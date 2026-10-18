"""Sessions as rows, so that signing out is something the server can do.

Revision ID: 0003_refresh_tokens
Revises: 0002_genbank_feature_keys
Created: 2026-10-15

A JWT cannot be withdrawn — valid until it expires is what "stateless" means —
so until now there was no way to end a session or to kill a stolen one. The
long-lived half of a session now lives in refresh_token, and the access token
is short enough that losing one matters for minutes rather than half a day.

Why this is written to be a no-op on a fresh database
-----------------------------------------------------
docs/*.sql describes the schema as it is now, including this table, and
revision 0001 applies those files. So a database built today gets
refresh_token from 0001 and reaches this revision with the work already done;
a database built last week gets it from here. Every statement below is
therefore IF NOT EXISTS, CREATE OR REPLACE, or a DROP/CREATE pair.

That is the model for every revision in this project: the SQL files describe
head, and each migration brings an older database up to it. The alternative —
freezing the files at 0001 and reading the schema as a pile of diffs — makes
the policies much harder to review, and the policies are the part that has to
be reviewable.
"""
from __future__ import annotations

from alembic import op

revision = "0003_refresh_tokens"
down_revision = "0002_genbank_feature_keys"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS refresh_token (
          id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id       uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
          token_sha256  bytea NOT NULL,
          family_id     uuid NOT NULL,
          replaced_by_id uuid REFERENCES refresh_token(id) ON DELETE SET NULL,
          issued_at     timestamptz NOT NULL DEFAULT now(),
          expires_at    timestamptz NOT NULL,
          last_used_at  timestamptz,
          revoked_at    timestamptz,
          revoked_reason text,
          user_agent    text,
          CONSTRAINT refresh_token_hash_len CHECK (octet_length(token_sha256) = 32),
          CONSTRAINT refresh_token_expires_after_issue CHECK (expires_at > issued_at),
          CONSTRAINT refresh_token_not_its_own_successor CHECK (replaced_by_id IS DISTINCT FROM id)
        )
        """
    )
    op.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS refresh_token_hash_key "
        "  ON refresh_token (token_sha256)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS refresh_token_user_idx "
        "  ON refresh_token (user_id, issued_at DESC)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS refresh_token_family_idx ON refresh_token (family_id)"
    )

    # FORCE as well as ENABLE. Without FORCE the table's owner is exempt, and a
    # table holding live sessions is the last one to leave unguarded.
    op.execute("ALTER TABLE refresh_token ENABLE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE refresh_token FORCE ROW LEVEL SECURITY")

    op.execute("GRANT SELECT, INSERT, UPDATE ON refresh_token TO eln_app")
    op.execute("GRANT SELECT, INSERT, UPDATE ON refresh_token TO eln_auth")

    # Your own sessions, and nobody else's — not even a lab administrator's.
    # No DELETE policy: a session that ended is part of the record of who was
    # signed in when.
    for name, body in (
        (
            "refresh_token_select",
            "FOR SELECT USING (user_id = (SELECT current_user_id()))",
        ),
        (
            "refresh_token_insert",
            "FOR INSERT WITH CHECK (user_id = (SELECT current_user_id()))",
        ),
        (
            "refresh_token_update",
            "FOR UPDATE USING (user_id = (SELECT current_user_id())) "
            "          WITH CHECK (user_id = (SELECT current_user_id()))",
        ),
    ):
        op.execute(f"DROP POLICY IF EXISTS {name} ON refresh_token")
        op.execute(f"CREATE POLICY {name} ON refresh_token {body}")

    # Rotation and reuse detection, in one statement so two refreshes arriving
    # together cannot both mint a successor. CREATE OR REPLACE, so this is the
    # same whether 0001 already defined it or not.
    op.execute(
        """
        CREATE OR REPLACE FUNCTION auth_rotate_refresh_token(
          p_old_sha256 bytea,
          p_new_sha256 bytea,
          p_expires_at timestamptz,
          p_user_agent text DEFAULT NULL
        ) RETURNS TABLE (user_id uuid, family_id uuid, outcome text)
          LANGUAGE plpgsql
          SECURITY DEFINER
          SET search_path = public
        AS $fn$
        DECLARE
          tok    refresh_token%ROWTYPE;
          new_id uuid;
        BEGIN
          SELECT * INTO tok FROM refresh_token t
           WHERE t.token_sha256 = p_old_sha256
           FOR UPDATE;

          IF NOT FOUND THEN
            RETURN QUERY SELECT NULL::uuid, NULL::uuid, 'unknown'::text;
            RETURN;
          END IF;

          IF tok.replaced_by_id IS NOT NULL THEN
            UPDATE refresh_token
               SET revoked_at = now(), revoked_reason = 'refresh token reused'
             WHERE refresh_token.family_id = tok.family_id
               AND refresh_token.revoked_at IS NULL;
            RETURN QUERY SELECT tok.user_id, tok.family_id, 'reused'::text;
            RETURN;
          END IF;

          IF tok.revoked_at IS NOT NULL THEN
            RETURN QUERY SELECT tok.user_id, tok.family_id, 'revoked'::text;
            RETURN;
          END IF;

          IF tok.expires_at <= now() THEN
            RETURN QUERY SELECT tok.user_id, tok.family_id, 'expired'::text;
            RETURN;
          END IF;

          INSERT INTO refresh_token (user_id, token_sha256, family_id, expires_at, user_agent)
          VALUES (tok.user_id, p_new_sha256, tok.family_id, p_expires_at,
                  coalesce(p_user_agent, tok.user_agent))
          RETURNING id INTO new_id;

          UPDATE refresh_token
             SET replaced_by_id = new_id, last_used_at = now()
           WHERE refresh_token.id = tok.id;

          RETURN QUERY SELECT tok.user_id, tok.family_id, 'ok'::text;
        END
        $fn$
        """
    )
    # Signing out, also before anybody is authenticated: the access token has
    # usually expired by the time somebody clicks it.
    op.execute(
        """
        CREATE OR REPLACE FUNCTION auth_revoke_refresh_family(
          p_sha256 bytea,
          p_reason text DEFAULT 'signed out'
        ) RETURNS integer
          LANGUAGE plpgsql
          SECURITY DEFINER
          SET search_path = public
        AS $fn$
        DECLARE
          fam uuid;
          n   integer;
        BEGIN
          SELECT family_id INTO fam FROM refresh_token WHERE token_sha256 = p_sha256;
          IF fam IS NULL THEN
            RETURN 0;
          END IF;
          UPDATE refresh_token
             SET revoked_at = now(), revoked_reason = p_reason
           WHERE family_id = fam AND revoked_at IS NULL;
          GET DIAGNOSTICS n = ROW_COUNT;
          RETURN n;
        END
        $fn$
        """
    )
    op.execute(
        "ALTER FUNCTION auth_revoke_refresh_family(bytea, text) OWNER TO eln_auth"
    )
    op.execute("REVOKE ALL ON FUNCTION auth_revoke_refresh_family(bytea, text) FROM PUBLIC")
    op.execute("GRANT EXECUTE ON FUNCTION auth_revoke_refresh_family(bytea, text) TO eln_app")
    op.execute(
        "ALTER FUNCTION auth_rotate_refresh_token(bytea, bytea, timestamptz, text) "
        "  OWNER TO eln_auth"
    )
    op.execute(
        "REVOKE ALL ON FUNCTION auth_rotate_refresh_token(bytea, bytea, timestamptz, text) "
        "  FROM PUBLIC"
    )
    op.execute(
        "GRANT EXECUTE ON FUNCTION auth_rotate_refresh_token(bytea, bytea, timestamptz, text) "
        "  TO eln_app"
    )


def downgrade() -> None:
    """Drop the table and the function, which signs everybody out.

    Unavoidable and worth saying plainly: the sessions live in this table, so
    removing it ends them. Everyone signs in again afterwards.
    """
    op.execute(
        "DROP FUNCTION IF EXISTS auth_rotate_refresh_token(bytea, bytea, timestamptz, text)"
    )
    op.execute("DROP FUNCTION IF EXISTS auth_revoke_refresh_family(bytea, text)")
    op.execute("DROP TABLE IF EXISTS refresh_token")
