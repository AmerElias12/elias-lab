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
        # sessions: the part a JWT cannot do on its own
        # ---------------------------------------------------------------
        async def refresh_with(cookie: str | None):
            """Refresh carrying exactly one cookie, and no jar.

            httpx merges a per-request `cookies=` with the client's own jar
            rather than replacing it, so the live session cookie went along
            for the ride and every negative case here passed when it should
            have failed. A throwaway client with an explicit header is the
            only way to be sure what was sent.
            """
            headers = {"Cookie": f"eln_refresh={cookie}"} if cookie is not None else {}
            fresh = httpx.AsyncClient(transport=transport, base_url="http://test")
            try:
                return await fresh.post("/api/auth/refresh", headers=headers)
            finally:
                await fresh.aclose()

        async def _login_sets_an_httponly_cookie():
            r = await c.post("/api/auth/login",
                             json={"email": "pi@braude.ac.il",
                                   "password": "correct horse battery staple"})
            assert r.status_code == 200, r.text
            assert r.json()["refresh_token"] is None, (
                "the refresh token must not come back in the body as well; that "
                "hands it to the script it is being hidden from"
            )
            raw = r.headers.get("set-cookie", "")
            assert "eln_refresh=" in raw, raw
            assert "HttpOnly" in raw, raw
            assert "SameSite=strict" in raw.replace("samesite", "SameSite"), raw
            assert "Path=/api/auth" in raw, raw
        await run("signing in sets an httpOnly, same-site refresh cookie",
                  _login_sets_an_httponly_cookie())

        async def _refresh_rotates():
            before = c.cookies.get("eln_refresh")
            assert before, "the client is holding the cookie"
            r = await c.post("/api/auth/refresh")
            assert r.status_code == 200, r.text
            assert r.json()["access_token"], r.text
            after = c.cookies.get("eln_refresh")
            assert after and after != before, "each refresh must mint a new token"
        await run("a refresh returns a new access token and rotates the cookie",
                  _refresh_rotates())

        async def _a_spent_token_kills_the_family():
            """The reason rotation is worth having. A refresh token that has
            already been replaced is one somebody kept a copy of; there is no
            way to tell the thief from the owner, so both are signed out."""
            spent = c.cookies.get("eln_refresh")
            r1 = await c.post("/api/auth/refresh")
            assert r1.status_code == 200, r1.text
            live = c.cookies.get("eln_refresh")
            assert live != spent

            # Present the one that was already used.
            replay = await refresh_with(spent)
            assert replay.status_code == 401, f"{replay.status_code} {replay.text}"

            # And the successor the honest holder had is now dead too.
            after = await refresh_with(live)
            assert after.status_code == 401, (
                f"the family should have been revoked: {after.status_code} {after.text}"
            )
        await run("replaying a spent refresh token revokes the whole family",
                  _a_spent_token_kills_the_family())

        async def _every_failure_looks_the_same():
            for cookie in ("not-a-token", "", "x" * 60):
                r = await refresh_with(cookie)
                assert r.status_code == 401, f"{cookie!r} gave {r.status_code}"
            bare = await refresh_with(None)
            assert bare.status_code == 401, bare.text
        await run("an unknown, empty or malformed refresh token is the same 401",
                  _every_failure_looks_the_same())

        # Sign in again: the family above was deliberately destroyed.
        pi_token = await login("pi@braude.ac.il")

        async def _logout_ends_the_session():
            held = c.cookies.get("eln_refresh")
            r = await c.post("/api/auth/logout")
            assert r.status_code == 204, r.text
            dead = await refresh_with(held)
            assert dead.status_code == 401, (
                f"signing out must end the session, not just clear the cookie: {dead.text}"
            )
        await run("signing out ends the session on the server, not just in the browser",
                  _logout_ends_the_session())

        pi_token = await login("pi@braude.ac.il")

        async def _sessions_are_listed_and_revocable():
            # A second sign-in, as if from another machine.
            other = httpx.AsyncClient(transport=transport, base_url="http://test")
            try:
                await other.post("/api/auth/login",
                                 json={"email": "pi@braude.ac.il",
                                       "password": "correct horse battery staple"})
                sessions = (await c.get("/api/auth/sessions", headers=auth(pi_token))).json()
                assert len(sessions) >= 2, sessions
                assert sum(1 for s in sessions if s["current"]) == 1, (
                    "exactly one session is the one asking"
                )
                elsewhere = next(s for s in sessions if not s["current"])
                gone = await c.delete(f"/api/auth/sessions/{elsewhere['id']}",
                                      headers=auth(pi_token))
                assert gone.status_code == 204, gone.text
                # That other browser can no longer refresh.
                still = await other.post("/api/auth/refresh")
                assert still.status_code == 401, still.text
            finally:
                await other.aclose()
        await run("sessions can be listed and signed out from somewhere else",
                  _sessions_are_listed_and_revocable())

        async def _sessions_are_private_even_from_admins():
            """A session is not lab data: whoever can read one can become its
            owner. The policy has no administrator branch."""
            import sqlalchemy as sa
            from app.session import get_engine
            async with get_engine().connect() as conn:
                n = (await conn.execute(sa.text("SELECT count(*) FROM refresh_token"))).scalar()
                assert n == 0, f"the application read {n} sessions with no scope set"
        await run("nobody reads somebody else's sessions, administrators included",
                  _sessions_are_private_even_from_admins())

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
        # plasmids, which is what the map draws
        # ---------------------------------------------------------------
        plasmid: dict = {}

        async def _create_plasmid_with_features():
            """The shape an import produces: a sequence plus features, one of
            which crosses the origin."""
            r = await c.post(
                "/api/plasmids",
                headers=auth(pi_token),
                json={
                    "name": "pTEST-GFP",
                    "sequence": "ATGC" * 120,          # 480 bp
                    "topology": "circular",
                    "external_source": "GenBank file: pTEST-GFP.gb",
                    "features": [
                        {"name": "EGFP", "type_key": "CDS", "start_pos": 0,
                         "end_pos": 240, "strand": 1, "color": "#2f9e44"},
                        {"name": "source", "type_key": "source", "start_pos": 0,
                         "end_pos": 480, "strand": 1},
                        {"name": "wrapper", "type_key": "misc_feature", "start_pos": 459,
                         "end_pos": 20, "strand": 1, "wraps_origin": True},
                    ],
                },
            )
            assert r.status_code == 201, r.text
            plasmid.update(r.json())
            assert plasmid["length_bp"] == 480, plasmid
            assert len(plasmid["features"]) == 3, plasmid["features"]
        await run("a plasmid is created with its features in one request",
                  _create_plasmid_with_features())

        async def _read_it_back():
            """This is the check that was missing: every relationship is
            lazy="raise", so building the response from the ORM object walks
            into that guard and returns 500."""
            r = await c.get(f"/api/plasmids/{plasmid['id']}", headers=auth(pi_token))
            assert r.status_code == 200, r.text
            got = r.json()
            assert got["sequence"].startswith("ATGC"), got["sequence"][:10]
            assert len(got["features"]) == 3, got["features"]
            by = {f["name"]: f for f in got["features"]}
            assert by["EGFP"]["color"] == "#2f9e44"
            assert by["wrapper"]["wraps_origin"] is True
            assert by["wrapper"]["start_pos"] == 459 and by["wrapper"]["end_pos"] == 20
        await run("and read back whole, features and all", _read_it_back())

        async def _unknown_feature_key_is_coerced_not_refused():
            """sequence_feature.type_key is a foreign key into a controlled
            vocabulary. Real files carry keys that are not in it, and refusing
            a whole plasmid over one annotation is the wrong answer."""
            r = await c.post(
                "/api/plasmids",
                headers=auth(pi_token),
                json={
                    "name": "pOddKeys", "sequence": "ATGC" * 60,
                    "external_source": "test",
                    "features": [
                        {"name": "strange", "type_key": "not_a_real_key",
                         "start_pos": 0, "end_pos": 30, "strand": 1},
                    ],
                },
            )
            assert r.status_code == 201, r.text
            f = r.json()["features"][0]
            assert f["type_key"] == "misc_feature", f
            assert "not_a_real_key" in (f["note"] or ""), (
                "the original key must survive in the note, or the import is lossy"
            )
        await run("an unknown feature key is coerced, and recorded in the note",
                  _unknown_feature_key_is_coerced_not_refused())

        async def _list_omits_the_sequence():
            page = (await c.get("/api/plasmids", headers=auth(pi_token))).json()
            assert page["total"] == 2, page
            assert "sequence" not in page["items"][0], "a page of 10 kb plasmids is not a list"
            hit = (await c.get("/api/plasmids?q=pTEST", headers=auth(pi_token))).json()
            assert hit["total"] == 1, hit
        await run("the list omits sequences and can be searched by name",
                  _list_omits_the_sequence())

        # ---------------------------------------------------------------
        # the oligo library, and finding it again
        # ---------------------------------------------------------------
        primer: dict = {}

        async def _create_primers():
            for name, seq, purpose in (
                ("pTEST-F", "ATGAGCAAAGGCGAAGAACTG", "colony PCR of the GFP insert"),
                ("pTEST-R", "GGTCGCATCGCCTTCGCCTTC", "colony PCR of the GFP insert"),
                ("gRNA-site1-top", "CACCGACGTTGCAACGTTGCAAGG", "gRNA cloning oligo, BsmBI"),
            ):
                r = await c.post("/api/primers", headers=auth(pi_token),
                                 json={"name": name, "sequence": seq, "purpose": purpose})
                assert r.status_code == 201, r.text
                if name == "pTEST-F":
                    primer.update(r.json())
            assert primer["length_nt"] == 21, primer
        await run("primers are created, and the database computes their length",
                  _create_primers())

        async def _search_the_library():
            # The search people use: what was this oligo for.
            hits = (await c.get("/api/primers?q=colony", headers=auth(pi_token))).json()
            assert hits["total"] == 2, hits
            # The one the molecular tool needs: gRNA-cloning oligos.
            grna = (await c.get("/api/primers?q=gRNA%20cloning", headers=auth(pi_token))).json()
            assert grna["total"] == 1, grna
            assert grna["items"][0]["name"] == "gRNA-site1-top"
        await run("the library is searchable by what a primer was for", _search_the_library())

        async def _have_we_made_this_already():
            """Ordering a duplicate of an oligo already in the freezer is the
            waste this answers."""
            dup = (await c.get(
                "/api/primers?sequence=ATGAGCAAAGGCGAAGAACTG", headers=auth(pi_token)
            )).json()
            assert dup["total"] == 1, dup
            assert dup["items"][0]["name"] == "pTEST-F"
            none = (await c.get(
                "/api/primers?sequence=TTTTTTTTTTTTTTTTTTTT", headers=auth(pi_token)
            )).json()
            assert none["total"] == 0, none
        await run("an exact sequence search says whether we already have it",
                  _have_we_made_this_already())

        async def _sequence_cannot_be_edited():
            """An ordered oligo is a tube in a freezer. Editing its sequence
            would leave every experiment citing it describing something else."""
            r = await c.patch(f"/api/primers/{primer['id']}", headers=auth(pi_token),
                              json={"sequence": "ACGTACGTACGTACGTACGT"})
            assert r.status_code == 422, f"{r.status_code} {r.text}"
            still = (await c.get(f"/api/primers/{primer['id']}", headers=auth(pi_token))).json()
            assert still["sequence"] == "ATGAGCAAAGGCGAAGAACTG"
        await run("a primer's sequence is not editable", _sequence_cannot_be_edited())

        async def _attach_to_a_plasmid():
            r = await c.post(
                f"/api/primers/{primer['id']}/bindings",
                headers=auth(pi_token),
                json={"plasmid_id": plasmid["id"], "start_pos": 0, "end_pos": 21,
                      "strand": 1, "annealed_nt": 21, "tail_sequence": ""},
            )
            assert r.status_code == 201, r.text

            listed = (await c.get(
                f"/api/primers/bindings?plasmid_id={plasmid['id']}", headers=auth(pi_token)
            )).json()
            assert len(listed) == 1, listed
            # The map needs the sequence to draw it; a request per primer would
            # be a round trip per arrow.
            assert listed[0]["primer_name"] == "pTEST-F", listed[0]
            assert listed[0]["primer_sequence"] == "ATGAGCAAAGGCGAAGAACTG", listed[0]
        await run("a primer is attached to a plasmid and comes back with it",
                  _attach_to_a_plasmid())

        async def _cannot_attach_across_labs():
            import uuid as _uuid
            r = await c.post(
                f"/api/primers/{primer['id']}/bindings",
                headers=auth(pi_token),
                json={"plasmid_id": str(_uuid.uuid4()), "start_pos": 0, "end_pos": 21,
                      "strand": 1, "annealed_nt": 21},
            )
            assert r.status_code == 404, f"{r.status_code} {r.text}"
        await run("a primer cannot be filed against a plasmid you cannot see",
                  _cannot_attach_across_labs())

        # ---------------------------------------------------------------
        # the designs the molecular tool works out
        # ---------------------------------------------------------------
        pcr: dict = {}

        async def _store_a_pcr_product():
            fwd = (await c.get("/api/primers?sequence=ATGAGCAAAGGCGAAGAACTG",
                               headers=auth(pi_token))).json()["items"][0]
            rev = (await c.get("/api/primers?q=pTEST-R", headers=auth(pi_token))).json()["items"][0]
            r = await c.post(
                "/api/pcr",
                headers=auth(pi_token),
                json={
                    "name": "colony PCR across the insert",
                    "forward_primer_id": fwd["id"],
                    "reverse_primer_id": rev["id"],
                    "template_plasmid_id": plasmid["id"],
                    "product_start": 0, "product_end": 222,
                    "product_sequence": "ATGC" * 55 + "AT",
                    "annealing_temp_c": 58.0,
                },
            )
            assert r.status_code == 201, r.text
            pcr.update(r.json())
            assert pcr["expected_bp"] == 222, (
                "the length should follow from the product rather than be asked for twice"
            )
            assert pcr["product_sequence"].startswith("ATGC")
        await run("a PCR product is stored with its template and primers",
                  _store_a_pcr_product())

        async def _pcr_is_found_from_the_template():
            """What the map asks: with this plasmid open, what has been
            amplified off it."""
            hits = (await c.get(f"/api/pcr?template_plasmid_id={plasmid['id']}",
                                headers=auth(pi_token))).json()
            assert hits["total"] == 1, hits
            assert hits["items"][0]["id"] == pcr["id"]
        await run("and found again from the plasmid it was run on",
                  _pcr_is_found_from_the_template())

        async def _one_primer_is_not_a_pcr():
            fwd = pcr["forward_primer_id"]
            r = await c.post("/api/pcr", headers=auth(pi_token),
                             json={"name": "nonsense", "forward_primer_id": fwd,
                                   "reverse_primer_id": fwd})
            assert r.status_code == 422, f"{r.status_code} {r.text}"
            assert "two different primers" in r.text, r.text
        await run("the same primer twice is refused, with the reason",
                  _one_primer_is_not_a_pcr())

        assembly: dict = {}

        async def _store_a_gibson_design():
            """Three fragments, in order, each with the overlap that joins it
            to the one before. The order is the design, not a display choice."""
            r = await c.post(
                "/api/assemblies",
                headers=auth(pi_token),
                json={
                    "name": "pTEST-GFP v2 by Gibson",
                    "method": "gibson",
                    "overlap_bp": 25,
                    "product_bp": 5200,
                    "fragments": [
                        {"ordinal": 1, "name": "backbone", "source_plasmid_id": plasmid["id"],
                         "start_pos": 0, "end_pos": 240, "length_bp": 240,
                         "overlap_sequence": "ACGTACGTACGTACGTACGTACGTA"},
                        {"ordinal": 2, "name": "GFP insert", "length_bp": 720,
                         "overlap_sequence": "TTGCAACGTTGCAACGTTGCAACGT"},
                        {"ordinal": 3, "name": "terminator", "length_bp": 300,
                         "overlap_sequence": "GGCCGGCCGGCCGGCCGGCCGGCCG"},
                    ],
                },
            )
            assert r.status_code == 201, r.text
            assembly.update(r.json())
            assert assembly["fragment_count"] == 3, assembly
            assert [f["ordinal"] for f in assembly["fragments"]] == [1, 2, 3]
            assert assembly["fragments"][0]["name"] == "backbone"
        await run("a Gibson design is stored with its fragments in order",
                  _store_a_gibson_design())

        async def _fragments_come_back_in_order():
            """AssemblyRead names `fragments`, which is lazy="raise" — the trap
            the plasmid and guide routes both fell into."""
            r = await c.get(f"/api/assemblies/{assembly['id']}", headers=auth(pi_token))
            assert r.status_code == 200, r.text
            got = r.json()
            assert [f["ordinal"] for f in got["fragments"]] == [1, 2, 3], got["fragments"]
            assert got["fragments"][1]["overlap_sequence"] == "TTGCAACGTTGCAACGTTGCAACGT"
            assert got["overlap_bp"] == 25
        await run("and read back in order, without a lazy-load", _fragments_come_back_in_order())

        async def _a_gap_in_the_order_is_refused():
            """In a Gibson each fragment's forward primer carries the previous
            one's end, so a missing ordinal is not cosmetic — it is a design
            that cannot assemble."""
            r = await c.post("/api/assemblies", headers=auth(pi_token),
                             json={"name": "broken", "fragments": [
                                 {"ordinal": 1, "name": "a"},
                                 {"ordinal": 3, "name": "c"}]})
            assert r.status_code == 422, f"{r.status_code} {r.text}"
            assert "no gaps" in r.text, r.text
            lonely = await c.post("/api/assemblies", headers=auth(pi_token),
                                  json={"name": "one piece", "fragments": [
                                      {"ordinal": 1, "name": "a"}]})
            assert lonely.status_code == 422, lonely.text
            assert "vector and at least one insert" in lonely.text, lonely.text
        await run("a design with a gap, or with nothing to join, is refused",
                  _a_gap_in_the_order_is_refused())

        async def _assemblies_are_found_from_either_end():
            used = (await c.get(f"/api/assemblies?uses_plasmid_id={plasmid['id']}",
                                headers=auth(pi_token))).json()
            assert used["total"] == 1, used
            assert used["items"][0]["fragment_count"] == 3, used["items"][0]
            made = (await c.get(f"/api/assemblies?product_plasmid_id={plasmid['id']}",
                                headers=auth(pi_token))).json()
            assert made["total"] == 0, "this plasmid was a source, not the product"
        await run("assemblies are findable by what they used and by what they made",
                  _assemblies_are_found_from_either_end())

        async def _a_design_cannot_point_outside_the_lab():
            import uuid as _uuid
            r = await c.post("/api/assemblies", headers=auth(pi_token),
                             json={"name": "smuggled", "fragments": [
                                 {"ordinal": 1, "name": "a",
                                  "source_plasmid_id": str(_uuid.uuid4())},
                                 {"ordinal": 2, "name": "b"}]})
            assert r.status_code == 404, f"{r.status_code} {r.text}"
        await run("a fragment cannot name a plasmid you cannot see",
                  _a_design_cannot_point_outside_the_lab())

        # ---------------------------------------------------------------
        # primer design
        # ---------------------------------------------------------------
        async def _design_route_is_not_eaten_by_the_id_route():
            """/api/primers/design sits beside /api/primers/{primer_id}.
            Declared the wrong way round, "design" is handed to the UUID
            parser and the endpoint 422s for everyone, forever."""
            import random as _r
            rng = _r.Random(5)
            template = "".join(rng.choice("ACGT") for _ in range(900))
            r = await c.post(
                "/api/primers/design",
                headers=auth(pi_token),
                json={"template": template, "product_length": 400, "optimal_tm": 60},
            )
            assert r.status_code == 200, f"{r.status_code} {r.text[:300]}"
            out = r.json()
            assert out["pairs"], out["notes"]
            assert len(out["pairs"]) <= 3
            best = out["pairs"][0]
            # Everything the table shows has to be in the payload.
            for side in ("forward", "reverse"):
                p = best[side]
                assert {"sequence", "tm", "gc_percent", "hairpin_dg", "length"} <= set(p), p
                assert template[p["start"]:p["end"]], "the primer should be placed on the template"
            assert set(best["penalties"]) >= {"tm", "gc", "dimer", "hairpin"}, best["penalties"]
            assert abs(sum(best["penalties"].values()) - best["score"]) < 0.01
        await run("primer design returns ranked pairs with their scores broken down",
                  _design_route_is_not_eaten_by_the_id_route())

        async def _design_refuses_what_cannot_work():
            import random as _r
            rng = _r.Random(6)
            template = "".join(rng.choice("ACGT") for _ in range(600))
            cases = [
                ({"template": "a note about the PCR", "product_length": 200},
                 "A, C, G and T"),
                ({"template": template, "product_length": 5000}, "does not fit"),
                ({"template": template[:200] + "N" * 20 + template[220:],
                  "product_length": 300}, "ambiguous"),
            ]
            for body, fragment in cases:
                r = await c.post("/api/primers/design", headers=auth(pi_token), json=body)
                assert r.status_code == 400, f"{body['product_length']}: {r.status_code} {r.text[:200]}"
                assert fragment.lower() in r.text.lower(), (fragment, r.text[:200])
            # And the schema catches the ones it can before any work is done.
            short = await c.post("/api/primers/design", headers=auth(pi_token),
                                 json={"template": template, "product_length": 10})
            assert short.status_code == 422, short.text
        await run("a design that cannot work says which part cannot",
                  _design_refuses_what_cannot_work())

        async def _design_needs_a_lab():
            r = await c.post("/api/primers/design",
                             json={"template": "ATGC" * 50, "product_length": 100})
            assert r.status_code == 401, f"{r.status_code} {r.text}"
        await run("primer design is not an open compute service", _design_needs_a_lab())

        # ---------------------------------------------------------------
        # in-silico cloning
        # ---------------------------------------------------------------
        ECORI, BAMHI = "GAATTC", "GGATCC"
        PAYLOAD = "ACGTACGTACGTACGTACGTACGTACGTACGTACGTACGT"
        VECTOR_SEQ = ("ATGC" * 10) + ECORI + ("T" * 20) + BAMHI + ("CGCG" * 10)
        INSERT_SEQ = ("A" * 30) + ECORI + PAYLOAD + BAMHI + ("C" * 30)

        async def _cloning_needs_a_lab():
            r = await c.post(
                "/api/cloning/digest-ligation",
                json={"sequence_a": VECTOR_SEQ, "sequence_b": INSERT_SEQ,
                      "enzymes": ["EcoRI", "BamHI"]},
            )
            assert r.status_code == 401, f"{r.status_code} {r.text}"
        await run("the cloning endpoint is not an open compute service",
                  _cloning_needs_a_lab())

        async def _simulate_a_cloning():
            r = await c.post(
                "/api/cloning/digest-ligation",
                headers=auth(pi_token),
                json={"sequence_a": VECTOR_SEQ, "sequence_b": INSERT_SEQ,
                      "enzymes": ["EcoRI", "BamHI"],
                      "name_a": "vector", "name_b": "insert"},
            )
            assert r.status_code == 200, r.text
            out = r.json()
            assert out["enzymes"] == ["BamHI", "EcoRI"], out["enzymes"]
            assert len(out["inputs"]["a"]["fragments"]) == 2, out["inputs"]["a"]
            wanted = [k for k in out["constructs"] if PAYLOAD in k["sequence"]]
            assert wanted, [k["length_bp"] for k in out["constructs"]]
            got = wanted[0]
            # The response has to be drawable without translation: this is the
            # shape static/js/vector-viewer.js takes.
            assert got["topology"] == "circular"
            assert set(["name", "sequence", "topology", "features"]) <= set(got)
            assert all(
                {"name", "type", "start", "end", "strand"} <= set(f) for f in got["features"]
            ), got["features"]
            by = {j["enzyme"]: j for j in got["junctions"]}
            assert by["EcoRI"]["regenerated"] is True, by["EcoRI"]
        await run("two plasmids and two enzymes come back as a construct the viewer can draw",
                  _simulate_a_cloning())

        async def _cloning_failures_are_the_callers():
            """An enzyme that does not cut, a sequence that is not DNA, a
            misspelled name. All 400 with a sentence saying which."""
            cases = [
                ({"sequence_a": "ATGC" * 40, "sequence_b": "ATGC" * 40,
                  "enzymes": ["EcoRI"]}, "nothing to ligate"),
                ({"sequence_a": "a note about the cloning", "sequence_b": INSERT_SEQ,
                  "enzymes": ["EcoRI"]}, "not a DNA sequence"),
                ({"sequence_a": VECTOR_SEQ, "sequence_b": INSERT_SEQ,
                  "enzymes": ["ecori"]}, "did you mean"),
            ]
            for body, fragment in cases:
                r = await c.post("/api/cloning/digest-ligation",
                                 headers=auth(pi_token), json=body)
                assert r.status_code == 400, f"{body['enzymes']}: {r.status_code} {r.text}"
                assert fragment.lower() in r.text.lower(), (fragment, r.text)
        await run("a cloning that cannot work says which part cannot",
                  _cloning_failures_are_the_callers())

        async def _enzyme_names_are_searchable():
            r = await c.get("/api/cloning/enzymes?q=bam", headers=auth(pi_token))
            assert r.status_code == 200, r.text
            names = r.json()
            assert "BamHI" in names, names[:10]
            assert all("bam" in n.lower() for n in names), names[:10]
        await run("enzyme names can be searched, so nobody guesses the spelling",
                  _enzyme_names_are_searchable())

        # ---------------------------------------------------------------
        # guides
        # ---------------------------------------------------------------
        guide: dict = {}

        async def _create_guide_with_pegrna():
            r = await c.post(
                "/api/guides",
                headers=auth(pi_token),
                json={
                    "name": "g-GFP-1", "kind": "pegRNA",
                    "spacer": "ACGTTGCAACGTTGCAAGGT",
                    "pam_sequence": "AGG", "pam_pattern": "NGG",
                    "target_plasmid_id": plasmid["id"],
                    "target_strand": 1, "target_start": 40, "cut_position": 57,
                    "pegrna": {
                        "pbs": "GCAACGTTGC", "rt_template": "ATGCATGCAT",
                        "extension": "ATGCATGCATGCAACGTTGC",
                        "edit_type": "substitution", "edit_position": 60,
                        "edit_size_bp": 1, "nick_position": 57,
                    },
                },
            )
            assert r.status_code == 201, r.text
            guide.update(r.json())
            assert guide["pegrna"] is not None, guide
            assert guide["pegrna"]["pbs"] == "GCAACGTTGC", guide["pegrna"]
        await run("a pegRNA is stored with its extension", _create_guide_with_pegrna())

        async def _read_guide_back():
            """GuideRNARead names pegrna and off_targets, both lazy="raise" —
            the same trap the plasmid routes fell into."""
            r = await c.get(f"/api/guides/{guide['id']}", headers=auth(pi_token))
            assert r.status_code == 200, r.text
            got = r.json()
            assert got["spacer"] == "ACGTTGCAACGTTGCAAGGT"
            assert got["pegrna"]["extension"] == "ATGCATGCATGCAACGTTGC"
            assert got["off_targets"] == []
        await run("and read back with its extension, without a lazy-load", _read_guide_back())

        async def _guides_for_the_open_plasmid():
            """What the molecular tool asks: with this plasmid open, which
            guides has the lab already designed against it?"""
            hits = (await c.get(
                f"/api/guides?target_plasmid_id={plasmid['id']}", headers=auth(pi_token)
            )).json()
            assert hits["total"] == 1, hits
            got = hits["items"][0]
            assert got["name"] == "g-GFP-1"
            # The list view has to carry the position, or the map can say a
            # guide targets this plasmid and still not be able to draw it.
            assert got["target_start"] == 40, got
            assert got["target_strand"] == 1, got
            assert got["cut_position"] == 57, got
            dup = (await c.get(
                "/api/guides?spacer=ACGTTGCAACGTTGCAAGGT", headers=auth(pi_token)
            )).json()
            assert dup["total"] == 1, dup
        await run("guides can be found by the plasmid they target, or by spacer",
                  _guides_for_the_open_plasmid())

        async def _a_guide_must_target_something():
            """Refused by the schema before it reaches the database, with a
            message naming the rule. The CHECK is still there as the backstop
            for anything that does not come through this API."""
            r = await c.post("/api/guides", headers=auth(pi_token),
                             json={"name": "g-nowhere", "spacer": "ACGTTGCAACGTTGCAAGGA",
                                   "pam_sequence": "AGG", "pam_pattern": "NGG"})
            assert r.status_code == 422, f"{r.status_code} {r.text}"
            assert "needs a target" in r.text, r.text
        await run("a guide with nothing to target is refused, with the reason",
                  _a_guide_must_target_something())

        async def _a_broken_reference_is_a_bad_request():
            """A foreign key the schema cannot check: the entry id is a valid
            UUID and simply does not exist. Postgres raises 23503, and the
            caller should hear 400 rather than "database error" — answering
            500 sends whoever reads the logs hunting a fault that is not
            there."""
            import uuid as _uuid
            r = await c.post(
                "/api/plasmids", headers=auth(pi_token),
                json={"name": "pGhost", "sequence": "ATGC" * 30,
                      "created_in_entry_id": str(_uuid.uuid4())},
            )
            assert r.status_code == 400, f"{r.status_code} {r.text}"
            assert "does not exist" in r.text, r.text
        await run("a reference to something that is not there reads as a bad request",
                  _a_broken_reference_is_a_bad_request())

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
