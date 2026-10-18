# Deploying the Elias Lab website

The site is **static** — plain HTML/CSS/JS, no build step. You can host it on
any static host (GitHub Pages, Netlify, Cloudflare Pages). The Lab Notebook
talks directly to **Supabase** from the browser for shared, backed-up data.

There are three things to set up, and only the first two are needed:

1. **Supabase** — the shared backend for the Lab Notebook (auth + database + file storage).
2. **A static host** — to serve the site publicly.
3. **The molecular tools service** *(optional)* — a small Python service for the
   restriction-cloning and primer-design calculations that no browser can do.

You can do (2) first and run the notebook in **local mode** (data saved only in
your browser) until you're ready for (1). (3) can wait indefinitely: until it is
configured the molecular tools do their arithmetic in the browser, exactly as
they did before the service existed.

---

## 1 · Supabase backend (shared Lab Notebook)

1. Create a free account at <https://supabase.com> and click **New project**.
   Pick a name, a strong database password, and a region near you.
   Under **Security**, keep **Enable Data API** on, turn **Automatically
   expose new tables** off, and turn **Enable automatic RLS** on. The schema
   grants table access to signed-in users itself.
2. When it finishes provisioning, open **SQL Editor → New query**, paste the
   entire contents of [`supabase/schema.sql`](supabase/schema.sql), and click **Run**.
   This creates the tables, security policies, the sign-up trigger, and the
   `lab-files` storage bucket.
3. Open **Storage** and confirm a bucket named **`lab-files`** exists and is
   **not** public. (The SQL creates it; if your project blocks bucket
   creation from SQL, add it manually: New bucket → name `lab-files` →
   Public OFF.) Only approved members can open attachments, through links
   that expire after two hours.
4. Open **Project Settings → API** and copy:
   - **Project URL** (e.g. `https://abcdxyz.supabase.co`)
   - **anon public** key (a long `eyJ...` string)
5. Edit [`js/config.js`](js/config.js) and paste those two values:
   ```js
   window.ELIAS_CONFIG = {
     SUPABASE_URL: 'https://abcdxyz.supabase.co',
     SUPABASE_ANON_KEY: 'eyJhbGciOi...',
     ADMIN_EMAIL: 'amere@braude.ac.il'
   };
   ```
   > The anon key is **meant to be public** — Row-Level Security in the schema
   > is what actually protects the data. It is safe to commit.
6. **Create the PI account:** open `notebook.html`, click **Request an account**,
   and sign up with **amere@braude.ac.il**. The schema auto-approves that
   email as the admin. (Supabase may send a confirmation email — confirm it.)
   Everyone else who signs up lands in **pending** until you approve them in
   the **User Management** tab.

### Auth options (optional)
- In **Authentication → Providers → Email**, you can turn "Confirm email"
  off for a smoother internal sign-up, or leave it on for security.
- "Forgot password" uses Supabase's built-in reset email.

### Migrating existing local data
If you already entered protocols/experiments in local mode on a machine, sign
in there as the PI (after configuring Supabase) and click **⇪ Import local data**
in the User Management tab to push that browser's data into the shared database.

---

## 2 · Publish the Lab Notebook on GitHub Pages

The public site goes on **Wix** (see [`WIX.md`](WIX.md)). The **Lab Notebook**
can't live on Wix — it needs its own page, its own login, and Supabase — so it
gets hosted here instead. The lab tools ride along at the same URL.

The repository is already prepared: git is initialised on branch `main` and
everything is committed. Two steps remain, and both need your GitHub account.

### Step 1 — create the empty repo (in your browser)

1. Go to <https://github.com/new>
2. **Repository name:** `elias-lab` (any name works — it becomes part of the URL)
3. **Visibility: Public.** GitHub Pages on a free account only works for public
   repos. This is fine: the notebook holds no secrets — the Supabase anon key is
   designed to be public, and Row-Level Security is what protects the data.
4. **Do not** tick "Add a README", ".gitignore", or a licence — the repo already
   has commits, and an extra file causes a conflict on first push.
5. Click **Create repository**.

### Step 2 — push (in Terminal)

The `origin` remote is **already configured** to
`https://github.com/AmerElias12/elias-lab.git`, so this is all that's left:

```bash
cd "/Users/amerelias/Library/CloudStorage/GoogleDrive-amerelias02@gmail.com/Other computers/USB and External Devices/AMER BACKUP/BRAUDE/Elias Lab/EliasLab website"
git push -u origin main
```

Git will ask for a username (`AmerElias12`) and a **password** — GitHub no longer
accepts your account password here. Create a token instead: **GitHub → Settings →
Developer settings → Personal access tokens → Tokens (classic) → Generate new
token**, tick the **`repo`** scope, and paste that token as the password.

> Set your commit identity first if git complains:
> ```bash
> git config --global user.name "Amer Elias"
> git config --global user.email "amerelias02@gmail.com"
> ```

### Step 3 — turn on Pages

In the repo: **Settings → Pages → Source: Deploy from a branch → Branch: `main`,
folder `/ (root)` → Save.** Give it a minute, then your notebook is live at:

```
https://amerelias12.github.io/elias-lab/notebook.html
```

The lab tools ride along at the same host:

| Tool | URL |
|------|-----|
| Primer Generator | `https://amerelias12.github.io/elias-lab/tools/grna-primer-generator.html` |
| Gibson Calculator | `https://amerelias12.github.io/elias-lab/tools/gibson-calculator.html` |
| GenomeScan | `https://amerelias12.github.io/elias-lab/tools/genome-scan.html` |

`build-wix.py` already points the Wix "Lab Notebook" button at the notebook URL,
so the generated files in `wix/` are correct — just point the Wix button there too.

### What's published, and what isn't

`robots.txt` tells search engines to skip this copy, so it won't compete with the
Wix site for your lab's name. The notebook page also carries `noindex`.

Until you configure Supabase the notebook runs in **local mode**: each visitor
gets an empty notebook stored only in their own browser, and no lab data exists
on the server at all. The demo PI password is only ever displayed when running
locally — never on the published URL.

> **Google Drive note:** this folder lives in Google Drive. Git works there, but
> Drive can fight with the `.git` folder during sync. Treat **GitHub as the
> source of truth**, and avoid editing the same file on two machines at once.

### Updating later
```bash
git add -A
git commit -m "describe the change"
git push
```
Pages redeploys within a minute or two.

### Alternative — Netlify (no GitHub account needed)
Drag-and-drop the whole `EliasLab website` folder onto
<https://app.netlify.com/drop>. Instant URL; re-drop to update.

### After deploying
- Add your production URL to **Supabase → Authentication → URL Configuration →
  Site URL / Redirect URLs** so auth emails link back correctly.
- Test the smoke path on the live URL: sign up → approve → sign in → add a
  protocol → upload a file → open it in a second browser to confirm it's shared.

---

## 3 · The molecular tools service (optional)

The Gibson and gRNA tools can do two things a browser cannot: a restriction
digest against the full REBASE enzyme set, and primer design with real melting
temperatures and off-target screening. Both need **pydna** and **Biopython**,
which are Python, so they run in a small service of their own —
`backend/app/science.py`.

Supabase cannot host it (Edge Functions are Deno) and nor can GitHub Pages
(static files only), so it needs somewhere to run. It holds **no data**: no
database, no files, no sessions. Sequence goes in, an answer comes back, and
what the lab chooses to keep is saved through the notebook as usual. A restart
loses nothing, which is why it is safe to run on something that sleeps.

> **The service is on the `eln-backend` branch, not `main`.** `main` is what
> GitHub Pages publishes and carries no Python. The commands below clone that
> branch into a separate folder; nothing about your website checkout changes.

### Where to run it

**Google Cloud Run** is the recommendation. It scales to zero, so you pay
nothing for the hours nobody is cloning; it takes the Dockerfile as it is; and
it gives you an HTTPS URL with a managed certificate.

That last one is a requirement rather than a convenience: the notebook is
served over HTTPS, and a browser **will not let an HTTPS page call an `http://`
endpoint**. A service on a lab machine without a certificate fails in the
console with nothing useful on screen. Whatever you choose, it must be HTTPS.

At this lab's volume it is free. The Cloud Run free tier is 2 million requests,
180,000 vCPU-seconds and 360,000 GiB-seconds a month, renewing monthly
(<https://cloud.google.com/run/pricing> — worth a glance, since the rates move).
A primer design costs a second or two of CPU, so that allowance is on the order
of 90,000 calls a month, and a busy lab might make a few hundred.

### Steps

You need the `gcloud` CLI (<https://cloud.google.com/sdk/docs/install>) and a
Google account with billing enabled — Google asks for a card even for the free
tier.

**1 — Set up the project and turn on the APIs.**

```bash
gcloud auth login
gcloud projects create eliaslab-tools --name="Elias Lab tools"
gcloud config set project eliaslab-tools
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com
```

Then link a billing account to the project in the console
(**Billing → Link a billing account**), and set a **budget alert** at a couple
of dollars while you are there — Cloud Run has no hard spending cap, and an
alert is the only thing that will tell you if something is misconfigured.

**2 — Get the service.**

```bash
git clone -b eln-backend https://github.com/AmerElias12/elias-lab.git eliaslab-service
cd eliaslab-service/backend
cp Dockerfile.science Dockerfile
```

The copy is not cosmetic: `gcloud run deploy --source` hands the folder to
Cloud Build, which looks for a file named exactly `Dockerfile`. Without it,
Cloud Build falls back to Python buildpacks, installs the full
`requirements.txt` — database drivers and all — and builds the wrong thing.

**3 — Deploy.**

Take the **JWT Secret** from Supabase → **Project Settings → API**. That is not
the publishable (anon) key: the anon key is public, it is in this repository,
and the service rejects it on purpose.

```bash
gcloud run deploy eliaslab-tools \
  --source . \
  --region europe-west1 \
  --port 8000 \
  --allow-unauthenticated \
  --memory 1Gi \
  --set-env-vars 'ELN_MODE=science,ELN_ENVIRONMENT=production,ELN_SUPABASE_JWT_SECRET=PASTE_IT_HERE,ELN_CORS_ORIGINS=["https://amerelias12.github.io"]'
```

Four of those flags are load-bearing:

| flag | why |
|---|---|
| `--port 8000` | the container listens on 8000; Cloud Run assumes 8080 and would report the service as failing to start |
| `--allow-unauthenticated` | the service checks the Supabase token itself. Cloud Run's own IAM auth would reject the browser before it ever got there |
| `--memory 1Gi` | numpy and Biopython do not fit comfortably in the 512 MiB default |
| `ELN_CORS_ORIGINS` | your Pages origin. Without it every response is discarded by the browser and the service looks like it is down — so in production it refuses to start rather than pretend |

`--set-env-vars` splits on commas, so the single-origin JSON above is safe as
written. For two origins use a different delimiter:
`--set-env-vars '^##^ELN_CORS_ORIGINS=["https://a","https://b"]##ELN_MODE=science'`.

If your project signs tokens with a published key rather than a shared secret,
set `ELN_SUPABASE_URL=https://<ref>.supabase.co` instead of the secret and the
service will fetch the keys itself.

> Putting the JWT secret in a plain environment variable means anyone with
> console access to the project can read it. For a lab that is usually fine; if
> you would rather it were not, put it in **Secret Manager** and swap
> `--set-env-vars` for `--set-secrets ELN_SUPABASE_JWT_SECRET=eln-jwt:latest`.

**4 — Check it answers.**

```bash
curl https://eliaslab-tools-XXXXXX.europe-west1.run.app/api/health
```

```json
{"status":"ok","mode":"science","accepts":["supabase"]}
```

`accepts` is the useful part: `["supabase"]` means it can verify your tokens.
An empty list means neither the secret nor the URL reached it, and every real
request would come back 401.

**5 — Point the site at it.** Edit [`js/config.js`](js/config.js) on `main`:

```js
SCIENCE_API_URL: 'https://eliaslab-tools-XXXXXX.europe-west1.run.app'
```

Commit and push. Pages redeploys in a minute or two, and the server panels in
the Gibson and gRNA tools come on by themselves. Leave it blank to turn them
off again — the tools keep working in the browser.

### What to expect

**The first request each morning is slow.** The image is about 400 MB, mostly
numpy and Biopython, so a cold start takes a few seconds. After that it is
quick until the service goes back to sleep. If it annoys you, add
`--min-instances 1`, which keeps one warm and takes you off the free tier to a
few dollars a month.

`europe-west1` (Belgium) is the nearest Tier 1 region. Google also has
`me-west1` (Tel Aviv), which would shave latency, but it is priced differently
and may not sit in the free tier — check before switching, since a one-second
calculation makes the round trip hardly matter.

### Updating it later

```bash
cd eliaslab-service && git pull && cd backend
cp Dockerfile.science Dockerfile
gcloud run deploy eliaslab-tools --source . --region europe-west1
```

Environment variables set on a previous deploy are kept, so they do not need
repeating.

---

## Add the team photo
Drop a portrait JPG named **`team-photo.jpg`** into [`assets/`](assets/).
Until then the About section shows a styled "AE" placeholder (not broken).
Optionally add `assets/og-image.png` (1200×630) for nicer link previews.

## File map
| Path | Purpose |
|------|---------|
| `index.html` | public marketing site |
| `notebook.html` | internal Lab Notebook app |
| `css/` | `tokens.css` (brand vars), `site.css`, `notebook.css`, `plasmid.css` |
| `js/config.js` | Supabase keys and `SCIENCE_API_URL` — the one file to edit |
| `js/data.js` | the backend: Supabase, or localStorage in local mode |
| `js/notebook.js` | the notebook itself — entries, inventory, dashboard |
| `js/tabs.js` | several pages open at once, inside the notebook |
| `js/plasmid.js`, `js/plasmid-ui.js` | sequence maths, and the plasmid page |
| `js/plates.js`, `js/mentions.js` | culture plates and @-mentions on a page |
| `js/science-api.js` | calls the molecular tools service, when one is configured |
| `tools/` | GenomeScan, the Gibson calculator, the gRNA primer generator |
| `supabase/schema.sql` | run once in Supabase |
| `backend/` | the Python service — **on the `eln-backend` branch**, not here |
| `scripts/*.mjs`, `scripts/test-plasmid.js` | the checks; `node scripts/<name>` runs one |
