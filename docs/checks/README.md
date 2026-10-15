# SQL checks

Applies the files in `../` to a real PostgreSQL and asserts that the
constraints and the policies behave. PGlite is PostgreSQL compiled to
WebAssembly, so there is no server to install and no SQLite approximation —
generated columns, `tsvector`, domains and row-level security are all the real
implementations.

```bash
npm install
npm run check
```

| script | asserts |
|---|---|
| `check-schema.mjs` | constraints, triggers, generated columns, the provenance views |
| `check-rls.mjs` | one lab cannot see another's records |
| `check-ownership.mjs` | within a lab: own records, shared records, administrators |

Each runs its assertions as `eln_app`, which neither owns the tables nor has
`BYPASSRLS`, so the answers come from PostgreSQL rather than from the test.

Two kinds of denial, and the checks test for both — see `../eln-rls.sql` §11:

* a read, update or delete refused by a `USING` clause **raises nothing** and
  matches no rows, so it is checked by counting rows
* an insert, or an update that would move a row to another lab, raises `42501`

The API checks are separate and live in `../../backend/scripts/`:
`check_models.py` for the ORM and Pydantic layer, `check_api.py` for the
running application.
