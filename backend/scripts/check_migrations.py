#!/usr/bin/env python3
"""Checks that the migration produces the schema the application expects.

    python scripts/check_migrations.py

Runs `alembic upgrade head` against a throwaway PostgreSQL and asserts what
came out, then downgrades to nothing and upgrades again. The round trip is the
point: a downgrade that half-works leaves a database that cannot be upgraded,
and nobody discovers that until the day they need to roll back.

This is a separate suite from check_api.py on purpose. That one applies the
SQL files directly and asks "does the application work against this schema";
this one asks "does the migration produce that schema". Keeping them apart
means a broken migration cannot make the API checks fail for reasons that have
nothing to do with the API.
"""
from __future__ import annotations

import os
import pathlib
import sys
import tempfile

BACKEND = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND))

passed = 0
failures: list[str] = []


def check(what: str, fn) -> None:
    global passed
    try:
        fn()
    except AssertionError as exc:
        failures.append(f"{what}: {exc}")
        print(f"  FAIL  {what}\n          {exc}")
        return
    passed += 1
    print(f"  ok    {what}")


def main() -> int:
    import pgserver
    from alembic import command
    from alembic.config import Config

    datadir = pathlib.Path(tempfile.mkdtemp(prefix="eln-migrate-"))
    print(f"starting postgres in {datadir}")
    srv = pgserver.get_server(datadir)

    url = f"postgresql+psycopg://postgres@/postgres?host={datadir}"
    os.environ["ELN_MIGRATION_DATABASE_URL"] = url
    os.environ["ELN_DATABASE_URL"] = f"postgresql+asyncpg://eln_app@/postgres?host={datadir}"
    os.environ["ELN_JWT_SECRET"] = "x" * 40

    cfg = Config(str(BACKEND / "alembic.ini"))
    cfg.set_main_option("script_location", str(BACKEND / "migrations"))

    import psycopg

    def q(sql: str, *args):
        with psycopg.connect(f"host={datadir} dbname=postgres user=postgres") as conn:
            with conn.cursor() as cur:
                cur.execute(sql, args or None)
                return cur.fetchall()

    try:
        # ---- up -------------------------------------------------------
        command.upgrade(cfg, "head")
        print("alembic upgrade head: done")

        def _stamped():
            rows = q("SELECT version_num FROM alembic_version")
            assert rows == [("0004_constructions",)], rows
        check("the database records which revision it is at", _stamped)

        def _feature_vocabulary():
            keys = {r[0] for r in q("SELECT key FROM feature_type")}
            # The fourteen curated ones, plus the INSDC keys 0002 adds.
            assert "misc_feature" in keys and "promoter" in keys
            assert "source" in keys, (
                "source appears in essentially every GenBank file; without it "
                "every import coerces at least one feature"
            )
            for key in ("5'UTR", "RBS", "sig_peptide", "intron", "enhancer"):
                assert key in keys, f"{key} is missing from the vocabulary"
            assert len(keys) >= 36, len(keys)
        check("the feature vocabulary covers what real files carry", _feature_vocabulary)

        def _sessions_are_revocable_rows():
            cols = {r[0] for r in q(
                "SELECT column_name FROM information_schema.columns "
                " WHERE table_name = 'refresh_token'"
            )}
            for needed in ("token_sha256", "family_id", "replaced_by_id", "revoked_at"):
                assert needed in cols, f"refresh_token has no {needed}"
            forced = q(
                "SELECT relrowsecurity, relforcerowsecurity FROM pg_class "
                " WHERE oid = 'refresh_token'::regclass"
            )
            assert forced == [(True, True)], forced
            # No administrator branch, and no DELETE policy at all.
            pols = {(r[0], r[1]) for r in q(
                "SELECT policyname, cmd FROM pg_policies WHERE tablename = 'refresh_token'"
            )}
            assert ("refresh_token_select", "SELECT") in pols, pols
            assert not any(cmd == "DELETE" for _, cmd in pols), (
                "a session that ended is part of the record of who was signed in when"
            )
        check("sessions are rows that can be revoked, behind forced RLS",
              _sessions_are_revocable_rows)

        def _designs_are_storable():
            cols = {r[0] for r in q(
                "SELECT column_name FROM information_schema.columns "
                " WHERE table_name = 'primer_pair'"
            )}
            assert {"product_sequence", "product_start", "deleted_at"} <= cols, sorted(cols)
            frag = {r[0] for r in q(
                "SELECT column_name FROM information_schema.columns "
                " WHERE table_name = 'assembly_fragment'"
            )}
            assert {"ordinal", "overlap_sequence", "forward_primer_id"} <= frag, sorted(frag)
            # The ordering constraint is the design, so it is a unique index
            # rather than a convention.
            idx = {r[0] for r in q(
                "SELECT indexname FROM pg_indexes WHERE tablename = 'assembly_fragment'"
            )}
            assert "assembly_fragment_order_key" in idx, idx
            for table in ("assembly", "assembly_fragment"):
                forced = q(
                    f"SELECT relrowsecurity, relforcerowsecurity FROM pg_class "
                    f" WHERE oid = '{table}'::regclass"
                )
                assert forced == [(True, True)], (table, forced)
        check("PCR products and assembly designs have somewhere to go",
              _designs_are_storable)

        def _second_revision_steps_down_on_its_own():
            command.downgrade(cfg, "0001_initial_schema")
            keys = {r[0] for r in q("SELECT key FROM feature_type")}
            assert "source" not in keys, "0002 did not undo itself"
            assert "misc_feature" in keys, "and it took the original fourteen with it"
            assert len(keys) == 14, len(keys)
            command.upgrade(cfg, "head")
            assert "source" in {r[0] for r in q("SELECT key FROM feature_type")}
            # And 0003 came back with it: stepping down two and up two is the
            # path a rollback actually takes.
            assert q("SELECT to_regclass('refresh_token')") != [(None,)]
            assert q("SELECT to_regclass('assembly')") != [(None,)]
        check("a single revision can be stepped down and up again", _second_revision_steps_down_on_its_own)

        def _tables_exist():
            from app.db import Base
            import app.models  # noqa: F401
            actual = {r[0] for r in q(
                "SELECT tablename FROM pg_tables WHERE schemaname = 'public'"
            )}
            declared = {t.name for t in Base.metadata.sorted_tables}
            missing = declared - actual
            assert not missing, f"the migration did not create {sorted(missing)}"
        check("every table the models declare was created", _tables_exist)

        def _rls_forced():
            rows = q(
                "SELECT relname FROM pg_class "
                " WHERE relnamespace = 'public'::regnamespace AND relkind = 'r' "
                "   AND NOT (relrowsecurity AND relforcerowsecurity)"
            )
            # alembic_version is ours, not the application's, and is not
            # reachable by eln_app at all.
            offenders = [r[0] for r in rows if r[0] != "alembic_version"]
            assert not offenders, (
                f"RLS is not enabled and forced on {offenders} — a policy on a "
                f"table without FORCE is never consulted"
            )
        check("row-level security is enabled and forced on every table", _rls_forced)

        def _roles():
            rows = dict(q(
                "SELECT rolname, rolbypassrls FROM pg_roles "
                " WHERE rolname IN ('eln_app', 'eln_auth')"
            ))
            assert rows.get("eln_app") is False, "eln_app must not bypass RLS"
            assert rows.get("eln_auth") is True, "eln_auth owns the pre-identity functions"
            owned = q(
                "SELECT tablename FROM pg_tables "
                " WHERE schemaname = 'public' AND tableowner = 'eln_app'"
            )
            assert not owned, f"eln_app owns {len(owned)} tables; FORCE is then the only guard"
        check("the two roles exist, with the right powers and no others", _roles)

        def _definer_functions():
            rows = q(
                "SELECT p.proname, r.rolname FROM pg_proc p "
                "  JOIN pg_roles r ON r.oid = p.proowner "
                " WHERE p.pronamespace = 'public'::regnamespace AND p.prosecdef "
                " ORDER BY p.proname"
            )
            by_name = dict(rows)
            # Every name here is a line past the policies, so the list is
            # short on purpose and adding to it is meant to be a decision.
            expected = {
                "auth_create_lab", "auth_find_user_by_email",
                "auth_lookup_credentials", "auth_register_user",
                # Refreshing happens before anybody is authenticated, so the
                # policies on refresh_token cannot see the row that is about
                # to establish who the caller is.
                "auth_rotate_refresh_token",
                # And signing out, for the same reason: by the time somebody
                # clicks it the access token has usually expired.
                "auth_revoke_refresh_family",
            }
            assert expected <= set(by_name), f"missing: {sorted(expected - set(by_name))}"
            for name in expected:
                assert by_name[name] == "eln_auth", (
                    f"{name} is owned by {by_name[name]}, so it does not get the exemption"
                )
            # Anything else running as its definer is a privilege path nobody
            # asked for. current_lab_role and the audit trigger are the two
            # that belong to the policy layer.
            unexpected = set(by_name) - expected - {"current_lab_role", "record_audit_event"}
            assert not unexpected, f"unexpected SECURITY DEFINER functions: {sorted(unexpected)}"
        check("exactly the expected functions run as their definer", _definer_functions)

        def _policies_present():
            (count,) = q("SELECT count(*) FROM pg_policies WHERE schemaname = 'public'")[0]
            assert count >= 30, f"only {count} policies; the ownership layer did not apply"
            restrictive = {r[0] for r in q(
                "SELECT tablename FROM pg_policies "
                " WHERE schemaname = 'public' AND permissive = 'RESTRICTIVE'"
            )}
            # One floor per owned table. Named rather than counted, so adding a
            # table without its floor fails here instead of shifting a number.
            assert restrictive == {
                "notebook_entry", "plasmid", "primer", "primer_pair",
                "guide_rna", "assembly",
            }, sorted(restrictive)
        check("the policies from all three files are present", _policies_present)

        # ---- down and up again ----------------------------------------
        def _downgrade_is_clean():
            command.downgrade(cfg, "base")
            # alembic_version is Alembic's own, not the application's, and is
            # meant to outlive a downgrade — emptied, not dropped. Dropping it
            # is what the first version of this migration did, and it left the
            # database unable to record that it had been downgraded at all.
            left = q(
                "SELECT tablename FROM pg_tables "
                " WHERE schemaname = 'public' AND tablename <> 'alembic_version'"
            )
            assert not left, f"downgrade left {[r[0] for r in left]} behind"
            stamped = q("SELECT version_num FROM alembic_version")
            assert not stamped, f"the database still claims to be at {stamped}"
            views = q("SELECT viewname FROM pg_views WHERE schemaname = 'public'")
            assert not views, f"downgrade left the views {[r[0] for r in views]} behind"
            funcs = q(
                "SELECT proname FROM pg_proc WHERE pronamespace = 'public'::regnamespace"
            )
            assert not funcs, f"downgrade left {len(funcs)} functions behind"
            types = q(
                "SELECT typname FROM pg_type "
                " WHERE typnamespace = 'public'::regnamespace AND typtype IN ('e','d')"
            )
            assert not types, f"downgrade left the types {[r[0] for r in types]} behind"
            roles = q("SELECT rolname FROM pg_roles WHERE rolname IN ('eln_app','eln_auth')")
            assert not roles, f"downgrade left the roles {[r[0] for r in roles]} behind"
        check("downgrade removes the schema and the roles it created", _downgrade_is_clean)

        def _upgrade_again():
            command.upgrade(cfg, "head")
            rows = q("SELECT version_num FROM alembic_version")
            assert rows == [("0004_constructions",)], rows
            (count,) = q("SELECT count(*) FROM pg_policies WHERE schemaname = 'public'")[0]
            assert count >= 30, f"only {count} policies after the second upgrade"
            from app.db import Base
            import app.models  # noqa: F401
            actual = {r[0] for r in q(
                "SELECT tablename FROM pg_tables WHERE schemaname = 'public'"
            )}
            assert {t.name for t in Base.metadata.sorted_tables} <= actual
        check("and upgrading again rebuilds it exactly", _upgrade_again)

    finally:
        srv.cleanup()

    print(f"\n{passed} checks passed" + (f", {len(failures)} FAILED" if failures else ""))
    for f in failures:
        print(f"  - {f}")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
