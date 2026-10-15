#!/usr/bin/env python3
"""End-to-end checks for the API, against a real PostgreSQL.

    pip install -r requirements-dev.txt
    python scripts/check_api.py

Spins up a throwaway PostgreSQL (pgserver ships the actual binaries as a
wheel), applies the four SQL files, then drives the app in-process over ASGI.

Two things make this worth more than a unit test:

  * the policies are live. The app connects as eln_app, which neither owns the
    tables nor has BYPASSRLS, so every assertion about who can see what is
    answered by PostgreSQL rather than by a mock.

  * the failures it is looking for are the quiet ones. A policy that denies a
    read returns an empty list, not an error, so "a colleague cannot see this"
    has to be checked by looking, and cannot be inferred from the absence of
    an exception.
"""
from __future__ import annotations

import asyncio
import json
import os
import pathlib
import sys
import tempfile

BACKEND = pathlib.Path(__file__).resolve().parent.parent
DOCS = BACKEND.parent / "docs"
sys.path.insert(0, str(BACKEND))

SQL_FILES = ["eln-schema.sql", "eln-rls.sql", "eln-rls-ownership.sql", "eln-auth.sql"]

passed = 0
failures: list[str] = []


def check(what: str):
    """Decorator-free check helper: used as `async with step(...)` would be too
    clever. Each check prints as it passes so a hang is obvious."""
    def wrap(fn):
        return (what, fn)
    return wrap


async def run(what: str, coro) -> None:
    global passed
    try:
        await coro
    except AssertionError as exc:
        failures.append(f"{what}: {exc}")
        print(f"  FAIL  {what}\n          {exc}")
        return
    passed += 1
    print(f"  ok    {what}")


def main() -> int:
    import pgserver

    datadir = pathlib.Path(tempfile.mkdtemp(prefix="eln-check-"))
    print(f"starting postgres in {datadir}")
    srv = pgserver.get_server(datadir)
    try:
        for name in SQL_FILES:
            srv.psql((DOCS / name).read_text())
        # eln_app is NOLOGIN in production, where it authenticates through the
        # pooler. Here it has to connect for itself.
        srv.psql("ALTER ROLE eln_app WITH LOGIN;")
        print(f"applied {len(SQL_FILES)} sql files")

        # Unix socket, so no password and nothing listening on a port.
        os.environ["ELN_DATABASE_URL"] = (
            f"postgresql+asyncpg://eln_app@/postgres?host={datadir}"
        )
        os.environ["ELN_JWT_SECRET"] = "0" * 16 + "test-secret-not-for-real-use"
        os.environ["ELN_ENVIRONMENT"] = "development"

        return asyncio.run(exercise())
    finally:
        srv.cleanup()


async def exercise() -> int:
    import httpx
    from app.main import app
    from app.security import create_access_token
    from app.session import get_engine
    from app.session import dispose_engine

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(
        transport=transport, base_url="http://test"
    ) as c, app.router.lifespan_context(app):

        def auth(tok: str) -> dict[str, str]:
            return {"Authorization": f"Bearer {tok}"}

        async def register(email: str, name: str, pw: str = "correct horse battery staple"):
            r = await c.post(
                "/api/auth/register",
                json={"email": email, "full_name": name, "password": pw},
            )
            assert r.status_code == 201, r.text
            return r.json()

        async def login(email: str, pw: str = "correct horse battery staple") -> str:
            r = await c.post("/api/auth/login", json={"email": email, "password": pw})
            assert r.status_code == 200, r.text
            return r.json()["access_token"]

        # ---------------------------------------------------------------
        # the ground the rest stands on
        # ---------------------------------------------------------------
        async def _health():
            r = await c.get("/api/health")
            assert r.status_code == 200, r.text
            body = r.json()
            assert body["status"] == "ok", body
            assert body["rls_enforced"] is True, (
                "the app is connected as a role that ignores the policies; "
                "every other check below would pass vacuously"
            )
        await run("the app connects as a role the policies actually bind", _health())

        async def _no_drift_between_models_and_schema():
            """Every column the ORM declares must exist in the database, with
            the same name.

            This is worth its own check because the failure is late and
            confusing: the models import fine, the app starts fine, and the
            first request that touches the missing column returns a 500. Two
            real bugs were found this way — guide_rna.owner_id and
            app_user.hashed_password were both declared on a model and absent
            from docs/eln-schema.sql.

            It compares names only. Types, defaults and nullability are not
            checked, because SQLAlchemy and PostgreSQL spell the same type
            several ways and the false alarms would get the check switched off.
            """
            import sqlalchemy as sa
            from app.db import Base
            import app.models  # noqa: F401 — registers the mappings

            async with get_engine().connect() as conn:
                actual = {}
                rows = await conn.execute(
                    sa.text(
                        "SELECT table_name, column_name FROM information_schema.columns "
                        " WHERE table_schema = 'public'"
                    )
                )
                for table, column in rows:
                    actual.setdefault(table, set()).add(column)

            problems = []
            for table in Base.metadata.sorted_tables:
                if table.name not in actual:
                    problems.append(f"{table.name}: the model has no table in the database")
                    continue
                declared = {c.name for c in table.columns}
                missing = declared - actual[table.name]
                if missing:
                    problems.append(
                        f"{table.name}: the model declares {sorted(missing)}, "
                        f"which the database does not have"
                    )
            assert not problems, "\n          ".join(problems)
        await run("every column the models declare exists in the database",
                  _no_drift_between_models_and_schema())

        # ---------------------------------------------------------------
        # registering and logging in
        # ---------------------------------------------------------------
        pi = await register("pi@braude.ac.il", "Dr. Amer Elias")

        async def _no_hash_in_response():
            text = json.dumps(pi)
            assert "hashed" not in text and "password" not in text, text
            assert pi["email"] == "pi@braude.ac.il"
        await run("the registration response carries no password material", _no_hash_in_response())

        async def _duplicate():
            r = await c.post(
                "/api/auth/register",
                json={
                    "email": "PI@braude.ac.il",  # same address, different case
                    "full_name": "Impostor",
                    "password": "another good long passphrase",
                },
            )
            assert r.status_code == 409, f"{r.status_code} {r.text}"
        await run("a duplicate email is refused, case-insensitively", _duplicate())

        async def _weak():
            r = await c.post(
                "/api/auth/register",
                json={"email": "x@y.il", "full_name": "X", "password": "short"},
            )
            assert r.status_code == 422, r.text
        await run("a short password is refused before it reaches the database", _weak())

        async def _wrong_password_and_unknown_email_look_identical():
            bad = await c.post(
                "/api/auth/login",
                json={"email": "pi@braude.ac.il", "password": "not the password"},
            )
            missing = await c.post(
                "/api/auth/login",
                json={"email": "nobody@braude.ac.il", "password": "not the password"},
            )
            assert bad.status_code == missing.status_code == 401, (bad.text, missing.text)
            assert bad.json() == missing.json(), (
                "a different message for an unknown address turns the login form "
                f"into a membership check: {bad.json()} vs {missing.json()}"
            )
        await run("a wrong password and an unknown address are indistinguishable",
                  _wrong_password_and_unknown_email_look_identical())

        pi_token = await login("pi@braude.ac.il")

        async def _unauthenticated():
            for tok in (None, "garbage", pi_token[:-4] + "aaaa"):
                headers = auth(tok) if tok else {}
                r = await c.get("/api/entries", headers=headers)
                assert r.status_code == 401, f"token={tok!r} gave {r.status_code}"
        await run("no token, a malformed token and a tampered signature are all 401",
                  _unauthenticated())

        async def _fresh_account_has_no_lab():
            r = await c.get("/api/auth/me", headers=auth(pi_token))
            assert r.status_code == 200, r.text
            me = r.json()
            assert me["current_lab_id"] is None, me
            assert me["labs"] == [], me
            entries = await c.get("/api/entries", headers=auth(pi_token))
            assert entries.status_code == 403, entries.text
        await run("a new account belongs to no lab and can read nothing",
                  _fresh_account_has_no_lab())

        # ---------------------------------------------------------------
        # starting a lab
        # ---------------------------------------------------------------
        async def _create_lab():
            nonlocal pi_token
            r = await c.post(
                "/api/auth/labs",
                headers=auth(pi_token),
                json={"name": "Elias Lab", "slug": "elias"},
            )
            assert r.status_code == 201, r.text
            lab_id = r.json()["id"]
            sw = await c.post(
                "/api/auth/switch-lab", headers=auth(pi_token), json={"lab_id": lab_id}
            )
            assert sw.status_code == 200, sw.text
            pi_token = sw.json()["access_token"]
            me = (await c.get("/api/auth/me", headers=auth(pi_token))).json()
            assert me["current_lab_id"] == lab_id, me
            assert me["current_role"] == "owner", me
        await run("creating a lab makes you its owner", _create_lab())

        lab_id = (await c.get("/api/auth/me", headers=auth(pi_token))).json()["current_lab_id"]

        # ---------------------------------------------------------------
        # entry CRUD
        # ---------------------------------------------------------------
        entry: dict = {}

        async def _create_entry():
            r = await c.post(
                "/api/entries",
                headers=auth(pi_token),
                json={
                    "title": "Gibson assembly of pLenti-GFP",
                    "hypothesis": "Three fragments will assemble in one step.",
                    "body_text": "Mixed 50 ng backbone with equimolar inserts.",
                    "performed_on": "2026-10-01",
                },
            )
            assert r.status_code == 201, r.text
            entry.update(r.json())
            assert entry["current_version"] == 1, entry
            assert entry["lab_id"] == lab_id, entry
            assert entry["is_shared"] is True, entry
            assert entry["status"] == "draft", entry
        await run("an entry is created, in my lab, under my name", _create_entry())

        async def _first_version():
            r = await c.get(f"/api/entries/{entry['id']}/versions", headers=auth(pi_token))
            assert r.status_code == 200, r.text
            versions = r.json()
            assert len(versions) == 1 and versions[0]["version_no"] == 1, versions
        await run("creating an entry records version 1", _first_version())

        async def _list_and_get():
            page = (await c.get("/api/entries", headers=auth(pi_token))).json()
            assert page["total"] == 1, page
            assert page["items"][0]["id"] == entry["id"], page
            assert "body" not in page["items"][0], "the list view must not carry the document"
            one = await c.get(f"/api/entries/{entry['id']}", headers=auth(pi_token))
            assert one.status_code == 200 and one.json()["body"] == {}, one.text
        await run("it appears in the list, and the list omits the document body",
                  _list_and_get())

        async def _body_text_round_trips():
            """The free-form page is the bulk of most entries. It is checked on
            its own because losing it is silent: the write succeeds, the
            database stores it, and only the read model drops it — which is
            exactly what happened here until the browser showed an empty
            textarea over a full column."""
            got = (await c.get(f"/api/entries/{entry['id']}", headers=auth(pi_token))).json()
            assert "body_text" in got, f"body_text missing from the read model: {sorted(got)}"
            assert got["body_text"] == "Mixed 50 ng backbone with equimolar inserts.", got
        await run("the free-form page comes back out again", _body_text_round_trips())

        async def _patch_bumps_version():
            r = await c.patch(
                f"/api/entries/{entry['id']}",
                headers=auth(pi_token),
                json={"results": "Four of six colonies were correct.",
                      "change_note": "added the colony counts"},
            )
            assert r.status_code == 200, r.text
            entry.update(r.json())
            assert entry["current_version"] == 2, entry
            versions = (
                await c.get(f"/api/entries/{entry['id']}/versions", headers=auth(pi_token))
            ).json()
            assert len(versions) == 2, versions
            assert versions[0]["change_note"] == "added the colony counts", versions
        await run("editing the content appends a version", _patch_bumps_version())

        async def _patch_without_content_change():
            before = entry["current_version"]
            r = await c.patch(
                f"/api/entries/{entry['id']}", headers=auth(pi_token),
                json={"is_shared": True},
            )
            assert r.status_code == 200, r.text
            assert r.json()["current_version"] == before, (
                "flipping a flag is not a new version of the document"
            )
        await run("a save that changes nothing does not pad the history",
                  _patch_without_content_change())

        async def _partial_update_leaves_fields_alone():
            r = await c.patch(
                f"/api/entries/{entry['id']}", headers=auth(pi_token),
                json={"title": "Gibson assembly of pLenti-GFP (repeat)"},
            )
            assert r.status_code == 200, r.text
            got = r.json()
            assert got["hypothesis"] == "Three fragments will assemble in one step.", got
            assert got["results"] == "Four of six colonies were correct.", got
        await run("a PATCH of one field does not blank the others",
                  _partial_update_leaves_fields_alone())

        async def _search():
            hit = (await c.get("/api/entries?q=colonies", headers=auth(pi_token))).json()
            assert hit["total"] == 1, hit
            miss = (await c.get("/api/entries?q=electroporation", headers=auth(pi_token))).json()
            assert miss["total"] == 0, miss
            # The query is data, not SQL: a tsquery operator must not blow up.
            weird = await c.get("/api/entries?q=%27%29%3B--", headers=auth(pi_token))
            assert weird.status_code == 200, weird.text
        await run("full-text search finds it, and takes punctuation as text", _search())

        # ---------------------------------------------------------------
        # sharing, between real people
        # ---------------------------------------------------------------
        await register("student@braude.ac.il", "A Student")
        await register("guest@braude.ac.il", "A Guest")
        await register("rival@elsewhere.edu", "Another Lab")

        async def _add_members():
            for email, role in (("student@braude.ac.il", "member"),
                                ("guest@braude.ac.il", "read_only")):
                r = await c.post("/api/lab/members", headers=auth(pi_token),
                                 json={"email": email, "role": role})
                assert r.status_code == 201, r.text
            roster = (await c.get("/api/lab/members", headers=auth(pi_token))).json()
            assert len(roster) == 3, roster
        await run("an owner adds a member and a read-only guest", _add_members())

        async def _unknown_member():
            r = await c.post("/api/lab/members", headers=auth(pi_token),
                             json={"email": "nobody@nowhere.il", "role": "member"})
            assert r.status_code == 404, r.text
        await run("adding somebody who has not registered is a 404, not a new account",
                  _unknown_member())

        student_token = await login("student@braude.ac.il")
        guest_token = await login("guest@braude.ac.il")
        rival_token = await login("rival@elsewhere.edu")

        async def _member_reads_shared():
            page = (await c.get("/api/entries", headers=auth(student_token))).json()
            assert page["total"] == 1, page
            one = await c.get(f"/api/entries/{entry['id']}", headers=auth(student_token))
            assert one.status_code == 200, one.text
        await run("a member reads the entry the lab shares", _member_reads_shared())

        async def _member_cannot_edit_anothers():
            r = await c.patch(f"/api/entries/{entry['id']}", headers=auth(student_token),
                              json={"results": "I changed your results"})
            assert r.status_code == 403, f"{r.status_code} {r.text}"
            after = (await c.get(f"/api/entries/{entry['id']}", headers=auth(pi_token))).json()
            assert after["results"] == "Four of six colonies were correct.", after
        await run("readable is not editable: a colleague cannot rewrite it",
                  _member_cannot_edit_anothers())

        private: dict = {}

        async def _private_entry():
            r = await c.post("/api/entries", headers=auth(student_token),
                             json={"title": "Unfinished thought", "is_shared": False,
                                   "body_text": "not ready to show anyone"})
            assert r.status_code == 201, r.text
            private.update(r.json())
            assert private["is_shared"] is False, private
            # its author sees it
            mine = (await c.get("/api/entries?mine=true", headers=auth(student_token))).json()
            assert mine["total"] == 1, mine
        await run("a member keeps a draft to themselves", _private_entry())

        async def _colleague_cannot_see_private():
            r = await c.get(f"/api/entries/{private['id']}", headers=auth(guest_token))
            assert r.status_code == 404, f"{r.status_code} {r.text}"
            page = (await c.get("/api/entries", headers=auth(guest_token))).json()
            ids = [i["id"] for i in page["items"]]
            assert private["id"] not in ids, page
        await run("a colleague cannot see it, by list or by id", _colleague_cannot_see_private())

        async def _pi_can_see_private():
            r = await c.get(f"/api/entries/{private['id']}", headers=auth(pi_token))
            assert r.status_code == 200, (
                "the PI must be able to reach every record in the lab, or a "
                "departing student's work becomes unreachable"
            )
        await run("the PI can see it, which is what keeps records reachable",
                  _pi_can_see_private())

        async def _read_only_writes_nothing():
            r = await c.post("/api/entries", headers=auth(guest_token),
                             json={"title": "Guest entry"})
            assert r.status_code == 403, f"{r.status_code} {r.text}"
        await run("a read-only guest cannot create anything", _read_only_writes_nothing())

        async def _guest_cannot_manage_the_lab():
            r = await c.post("/api/lab/members", headers=auth(guest_token),
                             json={"email": "rival@elsewhere.edu", "role": "member"})
            assert r.status_code == 403, r.text
        await run("a guest cannot add members", _guest_cannot_manage_the_lab())

        # ---------------------------------------------------------------
        # the boundary between labs
        # ---------------------------------------------------------------
        async def _outsider_sees_nothing():
            me = (await c.get("/api/auth/me", headers=auth(rival_token))).json()
            assert me["labs"] == [], me
            r = await c.get("/api/entries", headers=auth(rival_token))
            assert r.status_code == 403, r.text
            byid = await c.get(f"/api/entries/{entry['id']}", headers=auth(rival_token))
            assert byid.status_code == 403, byid.text
        await run("somebody outside the lab sees nothing of it", _outsider_sees_nothing())

        async def _cannot_switch_into_a_lab_you_are_not_in():
            r = await c.post("/api/auth/switch-lab", headers=auth(rival_token),
                             json={"lab_id": lab_id})
            assert r.status_code == 403, r.text
        await run("switching into a lab you do not belong to is refused",
                  _cannot_switch_into_a_lab_you_are_not_in())

        async def _a_forged_lab_claim_buys_nothing():
            """The sharpest check here: a token that *says* lab A, held by
            somebody who is not in lab A. The route trusts the claim and scopes
            to it, so only the policies stand in the way."""
            import uuid as _uuid
            rival_id = _uuid.UUID(
                (await c.get("/api/auth/me", headers=auth(rival_token))).json()["user"]["id"]
            )
            from app.db import LabRole
            forged, _ = create_access_token(
                user_id=rival_id, lab_id=_uuid.UUID(lab_id), role=LabRole.owner
            )
            page = await c.get("/api/entries", headers=auth(forged))
            assert page.status_code == 200, page.text
            assert page.json()["total"] == 0, (
                f"a forged lab claim returned {page.json()['total']} entries"
            )
            wrote = await c.post("/api/entries", headers=auth(forged),
                                 json={"title": "Smuggled in"})
            assert wrote.status_code == 403, f"{wrote.status_code} {wrote.text}"
            roster = await c.get("/api/lab/members", headers=auth(forged))
            assert roster.status_code == 200 and roster.json() == [], roster.text
        await run("a token claiming a lab it does not belong to reads and writes nothing",
                  _a_forged_lab_claim_buys_nothing())

        # ---------------------------------------------------------------
        # deleting
        # ---------------------------------------------------------------
        async def _author_deletes_own():
            r = await c.delete(f"/api/entries/{private['id']}", headers=auth(student_token))
            assert r.status_code == 204, r.text
            gone = await c.get(f"/api/entries/{private['id']}", headers=auth(student_token))
            assert gone.status_code == 404, gone.text
            page = (await c.get("/api/entries?mine=true", headers=auth(student_token))).json()
            assert page["total"] == 0, page
        await run("an author deletes their own entry and it leaves the notebook",
                  _author_deletes_own())

        async def _delete_twice():
            r = await c.delete(f"/api/entries/{private['id']}", headers=auth(student_token))
            assert r.status_code == 404, r.text
        await run("deleting it again is a 404 rather than a silent success", _delete_twice())

        async def _member_cannot_delete_anothers():
            r = await c.delete(f"/api/entries/{entry['id']}", headers=auth(student_token))
            assert r.status_code == 403, r.text
            still = await c.get(f"/api/entries/{entry['id']}", headers=auth(pi_token))
            assert still.status_code == 200, still.text
        await run("a member cannot delete a colleague's entry", _member_cannot_delete_anothers())

        # ---------------------------------------------------------------
        # removing somebody
        # ---------------------------------------------------------------
        async def _removed_member_loses_access_with_the_same_token():
            student_id = (
                await c.get("/api/auth/me", headers=auth(student_token))
            ).json()["user"]["id"]
            r = await c.delete(f"/api/lab/members/{student_id}", headers=auth(pi_token))
            assert r.status_code == 204, r.text
            # The token is unchanged and still validly signed. Membership is
            # read from the table on every statement, so it stops working at
            # once rather than when the token expires.
            after = await c.get("/api/entries", headers=auth(student_token))
            assert after.status_code == 200 and after.json()["total"] == 0, after.text
            wrote = await c.post("/api/entries", headers=auth(student_token),
                                 json={"title": "still here?"})
            assert wrote.status_code == 403, f"{wrote.status_code} {wrote.text}"
        await run("removing somebody takes effect immediately, not when their token expires",
                  _removed_member_loses_access_with_the_same_token())

        async def _cannot_remove_self():
            pi_id = (await c.get("/api/auth/me", headers=auth(pi_token))).json()["user"]["id"]
            r = await c.delete(f"/api/lab/members/{pi_id}", headers=auth(pi_token))
            assert r.status_code == 400, r.text
        await run("an owner cannot remove themselves and orphan the lab", _cannot_remove_self())

        # ---------------------------------------------------------------
        # the dashboard counts what you can see, not what exists
        # ---------------------------------------------------------------
        async def _dashboard_is_scoped():
            pi_view = (await c.get("/api/dashboard", headers=auth(pi_token))).json()
            guest_view = (await c.get("/api/dashboard", headers=auth(guest_token))).json()
            assert pi_view["entries"] >= 1, pi_view
            assert pi_view["members"] == 2, pi_view
            assert guest_view["my_entries"] == 0, guest_view
            assert guest_view["entries"] <= pi_view["entries"], (guest_view, pi_view)
        await run("the dashboard counts each person's own view of the lab",
                  _dashboard_is_scoped())

        # ---------------------------------------------------------------
        # the audit trail saw all of it
        # ---------------------------------------------------------------
        async def _audit_names_people():
            import sqlalchemy as sa
            from app.session import get_engine
            async with get_engine().connect() as conn:
                # As eln_app, with no scope set: the audit policy requires
                # can_administer(), so this must come back empty even though
                # rows exist.
                rows = (await conn.execute(sa.text("SELECT count(*) FROM audit_event"))).scalar()
                assert rows == 0, f"the application read {rows} audit rows with no scope set"
        await run("the audit trail is not readable without a scope", _audit_names_people())

        await dispose_engine()

    print(f"\n{passed} checks passed" + (f", {len(failures)} FAILED" if failures else ""))
    for f in failures:
        print(f"  - {f}")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
