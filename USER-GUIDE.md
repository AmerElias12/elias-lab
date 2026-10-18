# Lab Notebook — user guide

Everything the lab holds, where it is, and what was done with it.

This is the quick-reference manual. It covers the same ground as the
[video tutorial](VIDEO-SCRIPT.md), field by field, so you can look something up
without rewatching.

---

## Before anything else

**Signing in.** Ask the PI for an account, or open the notebook and click
**Request an account**. New sign-ups sit in *pending* until approved — that is
the approval step, not a bug. Until you are approved you will see nothing,
because there is nothing you are allowed to see yet.

**The sidebar is the whole app.** Four groups:

| Group | What is in it |
|---|---|
| **Overview** | Dashboard — counts of everything, broken down by person |
| **Research** | Protocols, Experiment Notebooks, Presentations, Webapps & Tools |
| **Inventory** | Storage Boxes, Restriction Enzymes, Primers, Plasmids, Glycerol Stocks, Tissue Culture, Kits & Reagents |
| **Admin** | User Management — PI only |

**Tabs.** Opening a plasmid, an entry or a list adds a **tab** across the top,
the way a browser does. Several stay open at once, each keeping its own
unsaved edits, selection and undo history. Switching away loses nothing;
**closing** a tab with unsaved work asks first.

> **Note:** "Open in a browser window ↗" is a different thing — it opens a real
> browser tab. The internal tabs are the ones you want when comparing a vector
> against a donor against the construct you just made.

---

## 📦 Module 1 — Inventory documentation

Six categories, one shared design. **Restriction Enzymes** and **Kits &
Reagents** are covered here; the other four have sections of their own below.

### 💡 Purpose

To answer *where is it and how much is left* without anybody having to
remember. Every category is a table you can search, add to, upload in bulk, and
export.

### 🛠️ Key fields & actions

Every inventory page has the same three buttons in the top right:

| Button | What it does |
|---|---|
| **+ Add …** | one item, through a form |
| **⇪ Bulk upload** | a spreadsheet of them at once — download the template first so the columns match |
| **↓ CSV** | everything on the page, out to a file |

The search box filters **across every column** as you type, and remembers what
you typed if you leave the page and come back.

**Restriction Enzymes** — *Name · Supplier · Catalog # · Cut Site · Conc. ·
Qty · Storage*

- Write the cut site the way the supplier does, arrow included: `G↓AATTC`.
- **Storage** is the field people skip and the one that saves the most time.

**Kits & Reagents** — *Kit Name · Supplier · Catalog # · Qty Left · Expiry ·
Storage*

- **Expiry** drives a banner at the top of the page counting what has expired
  and what expires within 30 days, and marks the row.

### 🚀 Pro-tip

**Standardise the `Box` field before you have fifty rows, not after.**

For plasmids, glycerol stocks and tissue culture, a box name is a **link** —
click it and the notebook draws that box with every occupied position labelled.
It builds that map by matching the box name exactly, so `Box 2A`, `box2a` and
`Box-2A` become three different boxes that each look half empty.

Agree a format on day one — `Freezer2-ShelfB-Box03` or whatever suits — and the
box maps come free for the rest of the lab's life.

---

## 🧬 Module 2 — Primers & oligos

### 💡 Purpose

Not just a list of oligos, but the tool that designs them. The **Primers** page
is the lab's Primer Generator, and what you save there becomes the library that
the cloning tools search.

### 🛠️ Key fields & actions

The generator runs in three modes:

| Mode | For |
|---|---|
| **Cloning** | amplifying from a plasmid, with restriction tails |
| **qRT-PCR** | cDNA, with genomic DNA about — includes exon-exon junction guidance |
| **Analytical** | screening a genomic template |

It also designs **gRNA cloning primers** alongside regular ones.

Stored primers carry: *Name · Sequence (5'→3') · Tm (°C) · Application ·
Storage*.

Primers reach the library from three places, all of which the cloning tools
search together:

- saved from the Primer Generator
- attached to a plasmid on its page (**+ Attach primer**)
- added to the Primers inventory directly

### 🚀 Pro-tip

**Store the whole oligo, tail and all — and name it after what it does.**

When you build a PCR product inside the cloning dialog, the primer search ranks
primers that **actually anneal to your chosen template** above the ones that do
not, and tells you where they land and how long the 5′ tail is. That only works
on the real ordered sequence. A primer saved as just its annealing region will
silently look like a different oligo from the one in your freezer.

Name them so the search finds them: `GFP-F-EcoRI` beats `primer7`. You will be
typing three letters into a search box, not reading a list.

---

## ⭕ Module 3 — Plasmids & cloning vectors

The largest module, and the reason most people open the notebook.

### 💡 Purpose

Every construct with its sequence, its map, its features and its history — plus
the molecular tools to plan the next one against it.

### 🛠️ Key fields & actions

**The list** — *Name · Backbone · Insert · Resistance · Size (bp) · Conc. ·
Owner · Freezer · Box · Position · Location*. Click a name to open its page.

**Getting a sequence in.** **⇪ Import sequence file**, or drag the file onto
the page. It reads GenBank (`.gb`, `.gbk`, `.genbank`, `.ape`), **SnapGene**
(`.dna`), FASTA (`.fa`, `.fasta`, `.fna`, `.fsa`) and plain sequence (`.seq`,
`.txt`) — features and colours come across with it.

**The page itself:**

- **The map** — circular for a plasmid, linear below the sequence. Click any
  feature to see what it is and its exact coordinates. A reverse-strand feature
  reads as the gene, not as the rest of the plasmid.
- **The sequence** — editable, searchable, with enzyme sites marked. Drag to
  select. **Copy** gives you the bases; **Copy as ▾** gives DNA, RNA or protein,
  on either strand. Protein translation starts at the first base you selected,
  and tells you how many bases were left over.
- **Features** — click **+ Add feature** from a selection, or **✨ Annotate** to
  search the lab's other plasmids and a built-in library for things it
  recognises.

**The molecular tools**, along the top:

| Button | What it does |
|---|---|
| **Enzymes…** | how often each of 81 common enzymes cuts, and a **map split into fragments** by the ones you tick |
| **✂ Clone** | simulate a restriction digest and ligation, and save the construct |
| **Gibson assembly** | design the overlaps for up to seven inserts |
| **⟶ Expected PCR** | the product two attached primers would give |
| **Find ORFs** | open reading frames above a length you choose |
| **CRISPR** | guide RNAs with their PAMs, and pegRNA design |

**Cloning, specifically.** Either side — vector or insert — can be a **plasmid**
or a **PCR product**. Choose a PCR product and you pick a template and two
primers from the library; the sites ride in on the 5′ tails. Every junction is
checked, so an end that cannot ligate is caught before you order anything. When
it works, **Create the plasmid** saves the construct with its features carried
across.

### 🚀 Pro-tip

**Attach primers to the plasmid rather than only filing them in the library.**

Binding is recalculated from the sequence every time the page opens, not stored
as a position. Edit the plasmid and the primer positions follow. A coordinate
written down by hand is correct exactly until somebody inserts 40 bases
upstream, and then it is wrong and nothing says so.

The same reasoning applies to naming constructs: **date or number them rather
than describing them.** `pEL-041` with the description in the Insert field ages
better than `pUC19-GFP-new-FINAL`, which stops being informative the moment
somebody makes a second one.

---

## 🧫 Module 4 — Tissue culture logs

### 💡 Purpose

To find a vial in liquid nitrogen without phoning the person who froze it, and
to know what passage it was at when they did.

### 🛠️ Key fields & actions

*Cell Line · Passage · Source · Liquid N₂ Tank · Rack · Box · Position · Added by*

- **Cell Line** — the name as the repository writes it: `HEK293T`, not `293`.
- **Passage** — the number **at the moment of freezing**.
- **Source** — where it came from, with the catalogue number if it has one:
  `ATCC CRL-3216`. This is the line between a cell line and a rumour.
- **Tank / Rack / Box / Position** — the four coordinates. All four, every time.
  Three of them is the same as none.

Box names link to the **storage box map**, same as the rest of the inventory.

### 🚀 Pro-tip

**Record the passage at freeze, and never update it.**

It is tempting to keep the number current as you culture. Don't — the row
describes *the vial in the tank*, not the flask on your bench. A frozen vial's
passage cannot change; if you edit it, the next person thaws P12 believing it
is P4.

When you thaw and refreeze, that is a **new row**, with the new passage and its
own position. Two rows is the honest record of two vials.

---

## 🧊 Module 5 — Glycerol stocks & sample archiving

### 💡 Purpose

The long-term archive. What is in each stock, where it is at −80 °C, and
whether anybody ever checked it was right.

### 🛠️ Key fields & actions

*Serial # · Description · Resistance · Sequenced (QC) · Strain · Freezer (−80 °C)
· Rack_Shelf · Position on Drawer · Box · Position · Owner · Map · Notes*

- **Serial #** — the identifier, e.g. `GS-0007`.
- **Description** — what is actually in it: `pVEC-test in DH5α`.
- **Sequenced (QC)** — whether the insert was verified.
- **Strain** — `DH5α`, `NEB Stable`, `Stbl3`, or type your own.
- **Map** — a link to a map file, if there is one.
- The location fields are deliberately granular: a −80 freezer is a filing
  cabinet, and "somewhere in freezer 2" is not a location.

### 🚀 Pro-tip

**Your serial number scheme matters more here than anywhere else in the
notebook.**

A glycerol stock has no *Name* field. The **Serial #** is its name everywhere
else in the app — it is what the search matches, and it is what appears when
you `@`-mention the stock in an experiment entry. A stock filed as `1` or
`amer's prep` is one you will never find again from a notebook page.

Use a zero-padded running serial — `GS-0001`, `GS-0002` — so they sort
correctly and so the number is never ambiguous when it is read off a frozen lid
with frost on it.

**And fill in Sequenced (QC) even when the answer is no.** A stock that was
never sequenced and a stock whose field was left blank look identical, which
means every unverified stock has to be treated as unverified forever.

---

## Tying it together: experiment entries

The inventory says what you have. **Experiment Notebooks** says what you did
with it, and links the two.

A new entry gives you a page to write on, plus a toolbar:

| Tool | What it inserts |
|---|---|
| **🧮 Calc table** | PCR, qPCR, transfection or electroporation mixes that recompute as you change the sample count |
| **▦ Plate** | a culture plate — 1, 6, 12, 24, 48 or 96 wells — with a box per well to write in |
| **📅 New day** | a date and a line, to split a page between days |
| **📎 File** | images on the page, other files as a link. Paste or drop works too |

### @-mentions

Type **`@`** and a search opens over everything the lab holds — plasmids,
primers, enzymes, kits and reagents, glycerol stocks, tissue culture, and the
people in the lab. Pick one and it becomes a chip in your text.

- **Click a mention** and that item opens in a tab. A plasmid opens its own
  page; anything else opens its inventory page with the row highlighted.
- **Mention a person** and the entry appears in their **Mentions** list on the
  Dashboard. Nothing is emailed — their card has an email button if you want to
  tell them now.
- A mention stores *what it points at*, never the name. Rename a plasmid and
  every entry that ever mentioned it updates. Delete one and the mention says
  `(removed)` rather than naming something that no longer exists.

### 🚀 Pro-tip

**Mention the stock, don't retype its number.**

Writing "used GS-0007" is a dead string that will not survive a renumbering and
cannot be clicked. `@`-mentioning the same stock gives you a link into the
inventory, keeps up with renames, and tells you plainly if the stock has since
been thrown away. It is the same number of keystrokes.

---

## Getting help

- **The data is shared.** Everything you add is visible to the lab immediately,
  and backed up. Local mode — a banner at the top says so — means data is saved
  only in that browser and is **not** shared.
- **Unsaved work** is kept per tab while you move around, but a reload loses
  it. The notebook warns you before that happens.
- **Something looks wrong in a map or a calculation?** Say so rather than
  working around it. The scientific parts have test suites behind them, and a
  wrong answer is a bug worth fixing, not a quirk to learn.
- **Ask the PI** for accounts, approvals and anything to do with the shared
  database.
