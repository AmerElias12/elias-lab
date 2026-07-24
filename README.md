# Elias Lab Website

Public marketing site **+** internal **Lab Notebook** web app for the Elias Lab
(molecular biology & gene therapy — tyrosine integrase engineering).

Static site — **no build step, no server to run**. Open `index.html` in a
browser and it works. The Lab Notebook can run fully offline (local mode) or
against a shared **Supabase** backend (see [`DEPLOY.md`](DEPLOY.md)).

## Project structure

```
EliasLab website/
├── index.html            # public marketing site
├── notebook.html         # internal Lab Notebook app (login-gated)
├── css/
│   ├── tokens.css        # shared brand variables (single source of truth)
│   ├── site.css          # public site styles
│   └── notebook.css      # notebook + tools styles
├── js/
│   ├── config.js         # Supabase URL + anon key (blank = local mode)
│   ├── config.example.js # template for config.js
│   ├── data.js           # data layer: Supabase OR localStorage, auth, uploads
│   ├── notebook.js       # notebook UI logic
│   ├── tools.js          # built-in gRNA / Gibson / att-finder tools
│   └── site.js           # public-site interactions
├── tools/
│   └── genome-scan.html  # bundled GenomeScan tool (consensus / att finder)
├── assets/               # team-photo.jpg, logos/, og-image.png
├── supabase/schema.sql   # run once in your Supabase project
├── build-wix.py          # generates the Wix-ready single-file builds
├── wix/                  # GENERATED — do not edit by hand
│   ├── elias-lab-wix.html  # whole site, self-contained (paste into Wix)
│   └── scanner-embed.html  # just the att-site scanner widget
├── DEPLOY.md             # Supabase + static hosting guide
├── WIX.md                # how to publish on Wix
└── README.md
```

## Publishing on Wix

The lab sits in the **Biotechnology Engineering Department, Braude College of
Engineering (Karmiel)**, and Braude uses Wix. Run `python3 build-wix.py` to
regenerate the self-contained files in `wix/`, then follow [`WIX.md`](WIX.md).
The multi-file site here stays the single source of truth.

## Public site

One page with: hero → research overview → aims → applications → methodology →
**publications** → **news** → **team** → collaborations → core competencies →
**join the lab** → contact. The Publications / News / Team / Join sections ship
with **clearly-marked placeholder content** — replace it with the real thing
(each section has an HTML comment showing where).

To add the PI photo: drop `assets/team-photo.jpg` (portrait). Until then a
styled "AE" tile shows instead.

## Lab Notebook

Open via the **Lab Notebook** button in the nav (`notebook.html`). Modules:
Dashboard, Protocols, Experiment Notebooks (with editable data tables &
attachments), Presentations, Webapps & Tools, Inventory (enzymes / primers /
plasmids / glycerol stocks / kits), and User Management (admin).

### Local vs. shared mode
- **Local mode** (default, `js/config.js` blank): all data lives in the current
  browser's `localStorage` — not shared, not backed up. A banner reminds you.
  Demo PI login: `amerelias02@gmail.com` / `eliaslab`.
- **Shared mode** (Supabase configured): real email/password auth, a shared
  Postgres database, and file storage — data syncs across devices and is backed
  up. New members sign up and the PI approves them in User Management. See
  [`DEPLOY.md`](DEPLOY.md).

### Built-in tools
The Webapps tab includes three in-browser tools (gRNA primer generator, Gibson
assembly calculator, att-like site finder) plus the bundled **GenomeScan** tool
and links to common external resources. No external files required.

## Deploying
See [`DEPLOY.md`](DEPLOY.md) for Supabase setup and publishing to GitHub Pages /
Netlify / Cloudflare Pages.
