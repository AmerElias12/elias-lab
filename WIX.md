# Putting this site on Wix

Braude uses Wix, so this project ships a **Wix-ready build**. Wix runs custom code
inside a sandboxed iframe with no file system, so relative paths like `css/site.css`
never resolve — everything has to be in **one file**.

Run this any time you change the site:

```bash
python3 build-wix.py
```

It regenerates two files from `index.html` + `css/` + `js/`:

| File | What it's for |
|------|---------------|
| `wix/elias-lab-wix.html` | the **whole site** in one self-contained file (~67 KB) |
| `wix/scanner-embed.html` | just the **att-site scanner** widget (~9 KB) |

> Never hand-edit files in `wix/` — they're generated. Edit `index.html` / `css/` /
> `js/` and re-run the script.

---

# The recommended split

**Build the page natively in Wix. Embed only the scanner.**

This is the important decision, so here's the reasoning plainly:

An embedded HTML block is an **iframe**. Google indexes the *page*, not the iframe's
contents — so if the whole site is one embed, Wix serves a nearly empty page and
**none of your research text, publications, or the Braude affiliation gets indexed**.
For a new lab that needs to be findable by name, that's a real cost. Iframes also
don't resize with the page, can't contribute to Wix's mobile layout, and are awkward
for screen readers.

The scanner is different: it's an *application*, not content. There's nothing to
index, and Wix has no native way to build it. That's exactly what embeds are for.

So:

| Part of the page | How to build it | Why |
|---|---|---|
| Hero, Research, Aims, Applications, Publications, News, Team, Services, Collaborations, Join, Contact | **Native Wix sections** | SEO, mobile, editable by you without code |
| att-site scanner | **Embed** (`wix/scanner-embed.html`) | it's an app; Wix can't build it |
| Lab Notebook | **Separate host** (see below) | needs its own login + Supabase |

---

## Step 1 — Rebuild the page sections in Wix

In the Wix Editor, add a section per block below. Everything you need (text, colors,
fonts, images) is listed so you can copy it across without reading any code.

### Brand settings (do these once)
- **Fonts** — Wix has both in its font list:
  - Headings: **Fraunces** (semi-bold, 600)
  - Body & labels: **IBM Plex Sans**
  - Small mono labels: **IBM Plex Mono**
- **Colors** — add these as your site palette:

  | Name | Hex | Used for |
  |---|---|---|
  | Paper | `#f4f1e8` | page background |
  | Paper 2 | `#ece7d9` | alternating section background |
  | Ink | `#16241f` | body text |
  | Ink soft | `#4a5a52` | secondary text |
  | Teal | `#0c4a44` | headings, buttons |
  | Teal deep | `#072e2a` | dark sections, footer |
  | Emerald | `#10b07e` | accents |
  | Emerald bright | `#1fd197` | highlights on dark |
  | Blue | `#1d5fd4` | gradient accent |

- **Logos** — upload to Wix Media:
  - the Elias Lab mark (it's an inline SVG in `index.html`; export it or ask me for a PNG)
  - `assets/logos/braude-college.png` — put it in the **header, beside the lab logo**
  - the five partner logos from `assets/logos/` for the Collaborations strip
  - `assets/team-photo.jpg` — Team section, set as a **circle, ~151 px (4 cm)**

### Section-by-section

1. **Header** — Elias Lab logo · vertical divider · Braude logo. Menu: Research,
   Publications, Team, Join, Contact, plus a **Lab Notebook** button (links out — see Step 3).
2. **Hero** — H1 *"Engineering Integrases for Gene Therapy"* (with "Integrases" in the
   teal→emerald→blue gradient), the lead paragraph, two buttons, and the three stats
   (~40,000 / 0 / Multi-kb). The animated DNA background is decorative — either use a
   still image export or skip it; the page works fine without it.
3. **Research Overview** — Paper-2 background, "The Challenge" (red-tinted box) and
   "Our Solution" (green-tinted box), plus the Key Advantages list.
4. **Research Aims** — 5 cards, numbered badges.
5. **Therapeutic Applications** — dark teal background, 5 cards.
6. **Publications** — 5 entries, each: year + journal on the left, title/authors/DOI on the right.
7. **News** — 3 dated entries as a vertical timeline.
8. **Team** — circular photo + bio.
9. **Collaborations** — 5 logo cards.
10. **Lab Services** — 5 cards.
11. **Join the Lab** — 3 cards + "Apply / Enquire" mail button.
12. **Contact** — dark panel, the scanner embed (Step 2), email, and CTA.
13. **Footer** — Braude logo on a light plate + "Biotechnology Engineering Department ·
    Braude College of Engineering · Karmiel, Israel", contact, © year.

> Copy all the wording straight out of `index.html` — open it in any text editor, or
> open the site locally and copy from the rendered page.

## Step 2 — Embed the scanner

1. In the Wix Editor: **Add → Embed Code → Embed HTML**.
2. Choose **Code** (not "Website address").
3. Open `wix/scanner-embed.html`, select all, paste it in.
4. Size the box roughly **620 × 480 px**; tick "Scroll" if content is taller.
5. Place it inside the Contact / "Ready to Collaborate?" section.

It needs no configuration — it calls NCBI directly from the visitor's browser.

**One thing to confirm after publishing:** the scanner fetches from
`eutils.ncbi.nlm.nih.gov`. That works from a normal browser, but test it once on the
live Wix URL. If it's blocked, tell me and I'll move the lookup to a small proxy.

## Step 3 — The Lab Notebook (can't live on Wix)

The notebook needs its own login, its own page, and Supabase. Wix embeds can't host it.
Host it free somewhere else and point the Wix button at it:

- **Netlify** — drag the whole `EliasLab website` folder onto <https://app.netlify.com/drop>
- **GitHub Pages** — see [`DEPLOY.md`](DEPLOY.md)

Then set `NOTEBOOK_URL` near the top of `build-wix.py` to that address and re-run the
build, so the generated files link to the right place.

---

## If you'd rather not rebuild by hand (Option B)

Paste `wix/elias-lab-wix.html` into a single full-width **Embed HTML** block on a blank
Wix page. It will look exactly like the local site immediately.

Accept the trade-offs: **weak SEO** (content sits in an iframe), an inner scrollbar,
and edits must happen in this project + a re-paste rather than in the Wix editor.

Reasonable middle ground: launch with Option B so the site is live, then migrate
section by section to native Wix.

---

## Checklist after publishing

- [ ] Braude logo appears in the header and footer
- [ ] All five partner logos load
- [ ] Team photo is circular
- [ ] Publication DOI links open correctly
- [ ] Scanner returns a number for `TP53` (should be **1**) and `BRCA1` (**9**)
- [ ] Lab Notebook button opens the separately-hosted notebook
- [ ] Page looks right on a phone
