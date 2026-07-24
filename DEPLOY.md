# Deploying the Elias Lab website

The site is **static** — plain HTML/CSS/JS, no build step. You can host it on
any static host (GitHub Pages, Netlify, Cloudflare Pages). The Lab Notebook
talks directly to **Supabase** from the browser for shared, backed-up data.

There are two independent things to set up:

1. **Supabase** — the shared backend for the Lab Notebook (auth + database + file storage).
2. **A static host** — to serve the site publicly.

You can do (2) first and run the notebook in **local mode** (data saved only in
your browser) until you're ready for (1).

---

## 1 · Supabase backend (shared Lab Notebook)

1. Create a free account at <https://supabase.com> and click **New project**.
   Pick a name, a strong database password, and a region near you.
2. When it finishes provisioning, open **SQL Editor → New query**, paste the
   entire contents of [`supabase/schema.sql`](supabase/schema.sql), and click **Run**.
   This creates the tables, security policies, the sign-up trigger, and the
   `lab-files` storage bucket.
3. Open **Storage** and confirm a bucket named **`lab-files`** exists and is
   marked **Public**. (The SQL creates it; if your project blocks bucket
   creation from SQL, just add it manually: New bucket → name `lab-files` →
   Public ON.)
4. Open **Project Settings → API** and copy:
   - **Project URL** (e.g. `https://abcdxyz.supabase.co`)
   - **anon public** key (a long `eyJ...` string)
5. Edit [`js/config.js`](js/config.js) and paste those two values:
   ```js
   window.ELIAS_CONFIG = {
     SUPABASE_URL: 'https://abcdxyz.supabase.co',
     SUPABASE_ANON_KEY: 'eyJhbGciOi...',
     ADMIN_EMAIL: 'amerelias02@gmail.com'
   };
   ```
   > The anon key is **meant to be public** — Row-Level Security in the schema
   > is what actually protects the data. It is safe to commit.
6. **Create the PI account:** open `notebook.html`, click **Request an account**,
   and sign up with **amerelias02@gmail.com**. The schema auto-approves that
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

## Add the team photo
Drop a portrait JPG named **`team-photo.jpg`** into [`assets/`](assets/).
Until then the About section shows a styled "AE" placeholder (not broken).
Optionally add `assets/og-image.png` (1200×630) for nicer link previews.

## File map
| Path | Purpose |
|------|---------|
| `index.html` | public marketing site |
| `notebook.html` | internal Lab Notebook app |
| `css/` | `tokens.css` (brand vars), `site.css`, `notebook.css` |
| `js/` | `config.js`, `data.js` (backend), `notebook.js`, `tools.js`, `site.js` |
| `tools/genome-scan.html` | bundled GenomeScan tool |
| `supabase/schema.sql` | run once in Supabase |
