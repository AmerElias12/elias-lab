# Elias Lab ELN — backend

FastAPI over PostgreSQL, with the authorisation in the database rather than
only in the application. Serves a small HTML/CSS/JS dashboard from `static/`.

Nothing here touches the live Supabase project or the published GitHub Pages
site. It is a separate stack, for the notebook that replaces them.

## Running it

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements-dev.txt
python scripts/dev_server.py        # http://localhost:8000
```

`dev_server.py` starts an embedded PostgreSQL (a pip wheel — no system install,
no Docker), applies the SQL, and serves the app. Its data directory is
`~/.cache/eln-dev-db`; delete it to start clean.

Against a real database instead:

```bash
cp .env.example .env && $EDITOR .env
alembic upgrade head                                    # as the owner, not eln_app
psql -c "ALTER ROLE eln_app WITH LOGIN PASSWORD '…'"
uvicorn app.main:app
```

## Checking it

```bash
python scripts/check_migrations.py      #  8 checks: the migration, up and down again
python scripts/check_models.py          # 25 checks: models, schemas, LabScope
python scripts/check_api.py             # 36 checks: end to end, against real PostgreSQL
node    scripts/check-vector-viewer.mjs # 19 checks: payloads, coordinates, wrapping
(cd ../docs/checks && npm install && npm run check)   # 68 checks: the SQL itself
```

It spins up its own PostgreSQL, applies the four SQL files, and drives the app
in-process. The app connects as `eln_app`, which neither owns the tables nor
has `BYPASSRLS`, so every assertion about who can see what is answered by
PostgreSQL and not by a mock.

## How a request is authorised

Four steps, three of which are in `app/deps.py`:

1. the bearer token is verified                     → `Identity`
2. a `LabScope` is built from its claims            → the filter
3. `SET LOCAL app.current_user_id` / `app.lab_id`   → the database is told
4. the route queries through the scope              → `WHERE lab_id = …`

Step 3 is the one that is easy to omit, and omitting it fails *closed*: with
no `app.lab_id`, `current_lab()` is NULL, every policy compares against NULL,
and the route returns an empty list. Confusing, but not a leak.

The token carries `lab_id`. That is a claim, not an authorisation — every
policy reads membership from `lab_member`, so a token naming a lab the holder
does not belong to returns nothing. `check_api.py` forges exactly that token
and asserts it reads and writes nothing. It is also why removing somebody from
a lab takes effect on their next request rather than when their token expires.

### Two things the routes must do

**Check row counts on writes.** A policy's `USING` clause filters rather than
raises, so an UPDATE or DELETE the caller is not allowed to make reports zero
rows affected and no exception. Code that only catches exceptions calls that a
successful save. Every write here checks `rowcount` and answers 404.

**Not commit.** One transaction spans the request, because that is what makes
`SET LOCAL` safe on a pooled connection. A commit mid-route drops the identity
and leaves the rest of the handler seeing nothing.

## Layout

```
app/
  config.py    settings; jwt_secret has no default on purpose
  db.py        Base, enums, mixins
  models.py    SQLAlchemy 2.0 models
  schemas.py   Pydantic v2 request/response models
  scoping.py   LabScope — the only place queries are built from
  security.py  Argon2id, JWT, the content hash a signature commits to
  session.py   engine, session factory, the startup RLS check
  deps.py      the four steps above
  routers/     auth, entries, members, dashboard
static/        the dashboard: one HTML file, one CSS file, one JS file
migrations/    alembic: env.py and versions/
scripts/       dev_server.py and the check suites
```

## Migrations

```bash
alembic upgrade head        # apply everything outstanding
alembic current             # what this database is at
alembic upgrade head --sql  # print the SQL instead of running it
```

Run them as a role that can `CREATE ROLE`, set `BYPASSRLS` and change function
ownership. **Not as `eln_app`** — that role exists to be unable to do those
things, and letting it run its own migrations would undo the separation the
policies rest on. Set `ELN_MIGRATION_DATABASE_URL` when that is a different
connection from the application's.

For a database already provisioned by hand, record where it is instead of
re-running: `alembic stamp 0001_initial_schema`.

Revision `0001` applies the four SQL files below; everything after it is
hand-written. **Do not trust `--autogenerate` here.** It compares the database
against SQLAlchemy metadata that has never heard of row-level security, so it
will happily emit a revision that drops every policy — and a schema with the
policies dropped still passes every type check in this repository. Run it for
a second opinion on a column, read it, throw it away.

The SQL lives in `../docs`, applied in this order and no other:

| file | what it adds |
|---|---|
| `eln-schema.sql` | tables, constraints, triggers, views |
| `eln-rls.sql` | roles, helpers, lab isolation |
| `eln-rls-ownership.sql` | per-record ownership and sharing — **replaces** policies from the previous file |
| `eln-auth.sql` | the three operations that precede identity |

## Decisions worth knowing

**The app role must not be able to bypass RLS.** `main.py` checks at startup
and refuses to run in production otherwise. The failure it is guarding against
is silent: an app connected as the table owner works perfectly and shows every
lab's data to everybody.

**Registration grants nothing.** A new account belongs to no lab and therefore
sees nothing — that is the approval step. An administrator adds them.

**Entries are shared by default, private by choice.** `is_shared` defaults to
true so the notebook is a shared lab record; an author can opt a draft out.
Readable is not editable: a shared entry is writable only by its author or a
lab admin.

**Deletes are soft.** `deleted_at` is set and the row stays, with its history
and its audit trail. `plasmid.created_in_entry_id` is `ON DELETE RESTRICT`, so
an entry that produced a plasmid cannot be removed at all.

**A version is a full snapshot**, not just the free-form page — title and the
structured fields too. A signature commits to `content_sha256`, so anything
left out of the snapshot could be changed after signing while the signature
still verified.

## Known gaps

- **No second migration yet.** The pattern is in place and tested both ways,
  but every schema change from here is hand-written — there is no autogenerate
  to lean on, for the reason given above.
- **No refresh tokens.** `ELN_ACCESS_TOKEN_HOURS` (default 12) is therefore
  also how often people sign in again. A refresh flow needs a revocation table
  to be worth anything.
- **No rate limiting on login.** It belongs in front of the API, where the
  client address is known. Argon2 at these parameters costs ~50 ms a try,
  which is a speed bump, not a defence.
- **The token is in `localStorage`**, so any XSS on this origin can read it.
  The frontend never uses `innerHTML`, which is what keeps that side closed; a
  cookie would move the problem to CSRF rather than remove it.
- **`app_user.is_superuser` is unused.** Authorisation comes from
  `lab_member.role`. Note that `app_user_update` currently permits a person to
  update their own row without restricting *which* columns — the API never
  exposes `is_superuser`, so nothing can reach it today, but a column-level
  restriction would make that structural rather than incidental.
- **Plasmids, primers and guides have models and policies but no routes yet.**
  The dashboard counts them; the sidebar entries are disabled.
