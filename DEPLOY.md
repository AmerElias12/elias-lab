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

## 2 · Publish the site

### Option A — GitHub Pages
```bash
# from inside the "EliasLab website" folder
git init
git add -A
git commit -m "Elias Lab website"
gh repo create elias-lab-website --public --source=. --push
# enable Pages on the default branch:
gh api -X POST repos/:owner/elias-lab-website/pages -f source.branch=main -f source.path=/ || \
  echo "If that fails, enable Pages in the repo: Settings → Pages → Branch: main / root"
```
Your site will be at `https://<your-user>.github.io/elias-lab-website/`.

> **Google Drive note:** this folder lives in Google Drive. Git works there but
> Drive can fight with the `.git` folder during sync. Treat **GitHub as the
> source of truth** — once pushed, prefer editing via the repo, or pause Drive
> sync while running git commands.

### Option B — Netlify / Cloudflare Pages (no git needed)
Drag-and-drop the whole `EliasLab website` folder onto
<https://app.netlify.com/drop>. Done. (Re-drop to update.)

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
