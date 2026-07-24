# Putting this site on Wix

Braude uses Wix, so this project now ships a **Wix-ready build**. Wix runs custom
code inside a sandboxed iframe with no file system, so relative paths like
`css/site.css` never resolve. Everything therefore has to be in **one file**.

Run this any time you change the site:

```bash
python3 build-wix.py
```

It regenerates two files from `index.html` + `css/` + `js/`:

| File | What it's for |
|------|---------------|
| `wix/elias-lab-wix.html` | the **whole site** in one self-contained file (~61 KB) |
| `wix/scanner-embed.html` | just the **att-site scanner** widget (~7 KB) |

> Don't hand-edit files in `wix/` — they're generated. Edit `index.html` / `css/` /
> `js/` and re-run the script.

---

## Two ways to do this — pick one

### Option A (recommended): build the page natively in Wix, embed only the scanner

Rebuild the sections (hero, research, publications, team, services…) using Wix's
own editor, then drop in the scanner as a small embed.

**Why this is better:** Wix indexes your text for SEO, the page is responsive the
way Wix expects, and you can edit copy yourself without touching code. The only
thing Wix genuinely *can't* do is the interactive scanner — so that's the only
piece that needs to be custom code.

To add the scanner:
1. In the Wix editor: **Add → Embed Code → Embed HTML**.
2. Choose **Code** and paste the entire contents of `wix/scanner-embed.html`.
3. Resize the element to roughly **620 × 420 px** (it's responsive; give it room
   for the result box to appear).

Use `index.html` as your visual reference for colors, fonts and wording. The
brand values are in `css/tokens.css` (teal `#0c4a44`, emerald `#10b07e`, bright
`#1fd197`, paper `#f4f1e8`; fonts Fraunces + IBM Plex Sans + IBM Plex Mono).

### Option B (fastest): embed the whole site as one block

1. **Add → Embed Code → Embed HTML → Code**.
2. Paste the entire contents of `wix/elias-lab-wix.html`.
3. Stretch the element to full width and give it a tall fixed height.

**Trade-offs, honestly:** the page lives in an iframe, so Wix won't index its text
for search, you'll get an inner scrollbar unless the height is generous, and the
in-page anchor links (Research, Team…) scroll *within* the iframe rather than the
Wix page. Fine for getting online quickly; not ideal long-term.

---

## Things to set after you paste

**Images.** The generated file still points at `assets/…` paths, which won't
resolve inside Wix. Every image falls back to a styled text badge, so nothing
looks broken — but to show the real ones: upload each image to **Wix Media**,
copy its URL, and replace the matching `src="assets/…"` in the pasted code.
That applies to:
- `assets/logos/braude-college.png` — Braude College logo (footer affiliation)
- `assets/logos/*.png` — the five collaborator logos
- `assets/team-photo.jpg` — your portrait (the 4 cm circle)

**The Lab Notebook.** Wix can't host it — it's a separate app with its own login
and Supabase backend. Keep deploying `notebook.html` somewhere static (GitHub
Pages, Netlify — see `DEPLOY.md`) and point the nav button at it by editing
`NOTEBOOK_URL` near the top of `build-wix.py`, then rebuilding:

```python
NOTEBOOK_URL = "https://your-notebook-host.example/notebook.html"
```

**Scanner numbers.** The scanner only ever shows a site count when it has a real
one — see `js/scan-widget.js`, the `GENE_SITES` table:

```js
var GENE_SITES = {
  'BRCA1': 128,
  'TP53':  96,
};
```

Add gene symbols with the real counts from your GenomeScan runs. Genes not in the
table show a "let's scan it for you" invitation instead of an invented number.
Pasting an actual DNA sequence always computes a real count live in the browser.
