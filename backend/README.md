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
python scripts/check_migrations.py      # 12 checks: the migrations, up and down again
python scripts/check_models.py          # 25 checks: models, schemas, LabScope
python scripts/check_api.py             # 75 checks: end to end, against real PostgreSQL
node    scripts/check-vector-viewer.mjs # 19 checks: payloads, coordinates, wrapping
node    scripts/check-plasmid-import.mjs # 17 checks: GenBank in, API payload out
python  scripts/check_cloning.py        # 13 checks: the digest and ligation biology
python  scripts/check_primer_design.py  # 20 checks: duplexes, scoring, off-target, refusals
node    ../scripts/test-plasmid.js       # 73 checks: the parser itself
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

## Importing files

GenBank, SnapGene `.dna` and FASTA, parsed **in the browser** — drop a file on
the map, or use *Import file…*. Only the resulting JSON is posted; no file ever
reaches the server.

Three reasons, in order of weight: a `.dna` is an untrusted binary from a
colleague or a vendor, and parsing it in a tab costs an error message where
parsing it in the API process is a different risk for the same upside; the
parser already exists in JavaScript with 73 checks behind it, and a Python
port would be a second implementation of the GenBank location grammar; and
there is no upload endpoint, no temp files, nothing to clean up.

The cost is that an import needs a browser — there is no server-side bulk
import, which is the thing to revisit if the lab ever wants to ingest a
directory.

`static/js/plasmid.js` is a copy of `../js/plasmid.js`, which the old site
still serves. `check-plasmid-import.mjs` asserts the two are byte-identical,
so the duplication cannot drift; it ends when the old site is retired.

Two details that bite:

- **Unknown feature keys are coerced, not refused.** `sequence_feature.type_key`
  is a foreign key into a controlled vocabulary, and real files carry keys that
  are not in it. An unknown key becomes `misc_feature` with the original kept
  in the note — refusing a whole plasmid over one annotation is the wrong
  answer. Revision `0002` added the standard GenBank keys so this happens
  rarely.
- **Only colours the file specified are stored.** `plasmid.js` always sets one,
  falling back to its own pale defaults; storing those makes every imported map
  a single wash of colour and suppresses the type-based palette. The import
  keeps a colour only when it differs from what `plasmid.js` would have
  invented.

## Sessions

A JWT cannot be withdrawn — valid until it expires is what "stateless" means —
so the long-lived half of a session is a row in `refresh_token` and the access
token is short enough that losing one matters for minutes.

| | where it lives | how long |
|---|---|---|
| access token | a variable in the page, never stored | 15 minutes |
| refresh token | httpOnly, SameSite=strict cookie on `/api/auth` | 30 days, rotated on use |

**The access token is never written to storage.** A reload has none and asks
`/api/auth/refresh` for a new one, which is why the session survives a reload
without anything being readable by script. An XSS on this origin can act while
the page is open; it cannot walk away with the session.

**Rotation with reuse detection.** Every refresh mints a successor and links
the two. Presenting a token that has already been replaced means somebody kept
a copy — and there is no way to tell the thief from the owner, so the whole
family is revoked and both sign in again. That is the only reason rotation is
worth the complexity; without it, a stolen refresh token renews forever.

Three consequences worth knowing:

- **Signing out ends the session on the server.** It revokes the family, so the
  successor dies too. It is deliberately unauthenticated: by the time somebody
  clicks it the access token has usually expired, and a sign-out that only
  works while you are signed in is not one.
- **`GET /api/auth/sessions`** lists where the account is signed in, and
  `DELETE` one to sign out from somewhere else. Your own only — the policy has
  no administrator branch, because whoever can read a session can become its
  owner.
- **The client refreshes once per 401, and only one refresh at a time.** Three
  requests failing together must not start three rotations; the second would
  present a token the first already replaced, which the server would correctly
  read as a theft.

What is stored is a SHA-256, not the token. Unlike a password there is nothing
to guess — it is 256 bits from the CSPRNG — so argon2 would cost 50 ms per
refresh for no gain; the hash is there so a leaked backup holds no live
sessions.

## The oligo and guide library

`/api/primers` and `/api/guides` are the lab's library, and the Plasmids page
searches them beside the map: open a plasmid, switch to **Primers**, and each
one says whether it anneals and where.

**Which primers bind is worked out in the browser.** `js/plasmid.js` already
matches both strands, grows the anneal back from the 3′ end and reports the 5′
tail separately, with tests behind it. The API hands over the library and the
client matches — which is why `limit` goes to 500 on these two endpoints and
100 elsewhere: binding needs the whole library, not a page of it. A few hundred
oligos of 25 bases is tens of kilobytes. Past a few thousand, add a server-side
prefilter on the 3′ end rather than a second matcher.

What the server stores is the *result*: a `primer_binding` row saying this
oligo was used with that construct, at those coordinates. Those are redrawn
whenever the plasmid is opened, and they do not move if the plasmid is later
edited, because what happened at the bench did not change.

Searching:

| query | question it answers |
|---|---|
| `?q=` | what was this oligo for — covers name, purpose and notes, so "gRNA cloning" finds the cloning oligos |
| `?sequence=` | have we already made this one (exact match, indexed) |
| `?target_plasmid_id=` | which guides has the lab designed against the plasmid that is open |
| `?spacer=` | the same duplicate question, for guides |

A primer's **sequence cannot be edited**. An ordered oligo is a tube in a
freezer; if the sequence is wrong the answer is a new primer, not an edit that
leaves every experiment citing this one describing something else.

## Primer design

`POST /api/primers/design` takes a template and a target product length and
Tm, and returns the best pairs ranked, with the score broken into its parts.
The **Design primers…** button on the Primers tab opens the table; **Save
pair** writes both oligos to the library and the PCR record that links them.

`primers` proposes a pair for a sequence; it has no notion of "find me a
500 bp product somewhere in this 3 kb template". So the template is cut into
candidate windows of about the requested length, one pair is designed into
each, and the results are ranked — which is why the answer is a list. The
windows are **sampled, not exhaustive** (forty, evenly spaced), and the
response says so rather than implying a global optimum.

**Tm is quoted at 250 nM primer, 50 mM Na⁺ and 1.5 mM Mg²⁺.** Biopython's
defaults assume 25 nM oligo and no magnesium, which is a hybridisation
experiment rather than a PCR — the difference is 9–12 °C, enough to set an
annealing temperature ten degrees too low and get no band from a good design.
The conditions travel with every response so the number can be read rather
than guessed at. Ranking against the true figure is also what pulls the chosen
pairs onto the requested temperature: ask for 60 °C and they come back at
59–61, not 68.

### Off-target screening

`purpose` decides whether it happens, and that is the whole distinction:

| purpose | background | screening |
|---|---|---|
| `cloning` | a purified plasmid | not expected — there is nothing to mis-prime against |
| `qpcr` | a transcriptome | expected |
| `analytical` | genomic DNA | expected |

Pass `screen_against` — the locus with its flanks, the paralogs, a transcript
panel. Each primer then reports how many other places its 3′ end could sit,
and the pair reports **what those sites would amplify**: two opposing 3′ ends
within a few kb make a band, and a short one out-competes the product you
wanted. A pair that would amplify a pseudogene loses its place in the ranking.

A missing screen is stated rather than passed over — for qPCR or analytical
work the answer says the pairs are *thermodynamically sound and unproven for
specificity*, because silence there reads like a clean result.

The index is inverted relative to the one in `primers`: exact 10-mers come
from the background and the mismatches are generated from the primer at
lookup. Same question, asked the other way round — **25× faster and 16× less
memory** (a megabase in 1.25 s and 48 MB, against 60 kb in 3.3 s and 82 MB),
which is what makes screening a locus practical rather than theoretical. The
checks assert the two agree site for site. Capped at 500 kb; a whole genome is
a job for BLAST on a server that has one.

**Not checked:** exon structure. A pair spanning an exon–exon junction is what
stops genomic DNA amplifying alongside cDNA, and that needs the transcript's
exon boundaries, which this endpoint does not take. The response says so on
every qPCR design.

### Dimers

Counted two ways, because the two failures are different:

| | what it costs |
|---|---|
| long **internal** duplex | sequesters primer — lower yield |
| short duplex at a **3′ end** | the polymerase extends it — primer-dimer, a smear |

Reporting only the longest hides the second behind the first, so both come
back. `primers` checks each oligo's own folding; the two primers **against
each other** are checked here, and that is the classic failure it does not
cover.

## In-silico cloning

`POST /api/cloning/digest-ligation` takes two sequences — GenBank, FASTA or
bare bases — and a list of enzymes; digests both, joins the ends that fit, and
returns the constructs in the shape `static/js/vector-viewer.js` draws, so the
result goes straight into the viewer with nothing translated. Stateless: it
writes nothing, and what the lab keeps goes through `/api/plasmids`
afterwards. The **Clone** tab on the Plasmids page is the frontend for it.

**This is a second digest implementation, deliberately.** `js/plasmid.js`
carries 81 enzymes written out by hand; Biopython carries REBASE, about 1,090,
maintained by people whose job that is. The two are not peers — the browser's
digest is a preview for drawing sites while somebody scrolls, this one is what
a result gets saved from — and `check_cloning.py` asserts they agree on where
an enzyme cuts, so a drift between them shows up here rather than at the
bench.

Three things the response says that a sequence alone does not:

- **Which junctions regenerated their site.** Two EcoRI ends rebuild GAATTC
  and the insert can be cut back out; a BamHI end joined to a BglII end
  rebuilds neither, which is usually the point and occasionally a nasty
  surprise six months later.
- **Which orientation each fragment went in.** One enzyme leaves identical
  ends, so the insert goes in either way round and both products are real —
  showing one would be lying about what comes out of the ligation. Two
  different enzymes leave ends that fit one way, which is why directional
  cloning uses two.
- **When the answer is a mixture.** Blunt ends join to any other blunt end,
  so a blunt digest gives many products, all real and most unwanted. The notes
  say so rather than presenting the first one as the answer.

An enzyme that does not cut is named — the commonest reason a cloning plan
fails, and an empty result with no explanation reads like a server fault.

## Designs: PCR products and assemblies

`js/plasmid.js` computes the product of an amplification and the primers for a
Gibson. Those results are now stored, so the work survives the tab closing.

- **`/api/pcr`** — `primer_pair` grew the product it was always implying:
  `product_start`, `product_end`, `product_sequence`, and the construct it
  became if it was kept. Mark two primers that face each other on the map and
  the expected size appears; **Save PCR** records it.
- **`/api/assemblies`** — `assembly` plus `assembly_fragment`: the method, the
  overlap, and the ordered pieces with the primers worked out for each.

**The arithmetic is not repeated here.** The product arrives already computed,
including the case where an amplicon runs across the origin of a circular
plasmid. What is stored is the design *as it was*: the template can be edited
afterwards, and then the same primers no longer give the same product — which
is exactly why this is a row and not a function. A gel that disagrees with the
row is the interesting case, and it only exists if the row does.

**Fragment order is the design, not a display choice.** In a Gibson each
fragment's forward primer carries the previous fragment's end as its 5′ tail,
so fragment 3 is only correct after fragment 2. The API refuses ordinals with
a gap, and the uniqueness of `(assembly_id, ordinal)` is an index rather than
a convention.

`plasmid_lineage` still records that a construct came from its parents. The
two answer different questions: lineage is what happened, an assembly is what
was planned.

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
- **No rate limiting on `/refresh`.** The token is unguessable, so this is
  about load rather than guessing, but it belongs in front of the API with the
  login limiter.
- **`app_user.is_superuser` is unused.** Authorisation comes from
  `lab_member.role`. Note that `app_user_update` currently permits a person to
  update their own row without restricting *which* columns — the API never
  exposes `is_superuser`, so nothing can reach it today, but a column-level
  restriction would make that structural rather than incidental.
- **No Gibson *designer* in this dashboard.** Designs can be stored and read
  through `/api/assemblies`, and the old site still has the UI that works them
  out; porting that interface is the remaining piece.
- **Digests and restriction cloning are not stored.** `js/plasmid.js` computes
  them; `assembly` would hold the result with `method` set to
  `restriction_ligation`, but nothing writes it yet.
