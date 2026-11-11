#!/usr/bin/env python3
"""Turn a folder of protocol PDFs into a bundle the notebook can import.

    python3 scripts/import_protocols.py --src <folder of PDFs> \
        --out ~/protocols-import.json --scrub "<name to remove>"

Then, in the notebook: Protocols → Import from file → pick the .json → review
the list → Add protocols.

This was written for in-house SOPs carried over from a previous workplace, and
those documents hold three things that should not travel into another lab's
notebook:

  * the approvals block — who prepared, reviewed and approved the document,
    with their job titles and dates — and the document history, which is the
    same information for every past revision;
  * the name of the organisation that owns the document, in the page
    furniture and in the "Manufacturer/<owner> Cat#" column of every
    materials table;
  * anything that was written into a procedure and should never have been, in
    this case a live-looking web account for an instrument vendor's design
    tool — a username and a password, in the middle of step 7.1.

The approvals and the credentials are cut by shape, which needs no
configuration. The owner's name is given on the command line with --scrub,
and deliberately not written down here: this repository is public, so a
default naming the previous employer would publish the very thing the scrub
exists to remove.

Forgetting the flag is caught rather than trusted. The materials tables name
their owner in a column header, so the run looks for that name, and stops
without writing anything if it finds one that --scrub does not cover.
Afterwards `verify()` reads the finished records back and fails the run if any
of it survived, because a scrub that quietly stops working is worse than none:
nobody re-reads twenty protocols to check.

What is deliberately kept: the SOP number, version and effective date, as one
provenance line at the end of the notes. They name no person and no company,
and they are how you find the original PDF on disk again. Pass
--no-provenance if you would rather they went too.

What is deliberately NOT cut: product and platform names, and the internal
catalogue codes in the materials tables. They are not the owner's name, and
removing them turns the title of a media recipe into "Media". Add one to
--scrub if you decide otherwise.

Third-party documents (supplier manuals, safety data sheets) are not copied
either. A supplier's protocol belongs to them, their current version is the
one you should be following, and a text dump of a 23-page manual in a
notebook field goes stale the day they revise it. Those become a short record
pointing at the supplier instead; attach the PDF itself in the notebook if you
want the copy you have on hand.

Needs pdfplumber:  python3 -m pip install --user pdfplumber
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import pathlib
import re
import subprocess
import sys

try:
    import pdfplumber
except ModuleNotFoundError:  # pragma: no cover - environment, not logic
    sys.exit("pdfplumber is missing. Install it with:\n"
             "  python3 -m pip install --user pdfplumber")

# ── what gets cut ───────────────────────────────────────────────────────────

# Where a materials table names whoever owns the document: the column is
# headed "Manufacturer/<owner> Cat#", meaning either the manufacturer's
# catalogue number or the owner's internal one. It is also the hook used to
# notice that --scrub was forgotten.
OWNER_COLUMN = re.compile(r"Manufacturer\s*/\s*([A-Za-z][\w&.\-]{2,})", re.I)

# Page furniture, repeated on all 8 or 19 pages of every SOP.
FURNITURE = [
    re.compile(r"^\s*CONFIDENTIAL\s*$", re.I),
    re.compile(r"Page\s+\d+\s+of\s+\d+", re.I),
    re.compile(r"Effective\s+date\s*:", re.I),
    # Not anchored: the running header is itself a borderless table, so it
    # arrives as one line reading "<title>   Department: / R&D".
    re.compile(r"\bDepartment\s*:", re.I),
    re.compile(r"^\s*SOP-[A-Z]{3}-\d+\s+Version\s*:", re.I),
]

# Belt and braces around the approvals block, which is cut wholesale as a
# region: any stray row of it that escapes the region goes here.
# re.M because this is used twice: line by line while cutting, and over a
# finished record while checking. Without it the check only ever looked at the
# record's first line, and an approval row anywhere below it passed.
APPROVAL_LINE = re.compile(
    r"^\s*(prepared|written|reviewed|approved|checked|authorised|authorized)\s+by\s*:",
    re.I | re.M)
SIGNATURE_ROW = re.compile(r"\bsignature\b", re.I)

# The Bio-Rad account in SOP-MET-025 §7.1. Matched as a pair and separately,
# so a lone one still goes.
CREDENTIALS = [
    re.compile(r"\buser\s*name\s*:\s*\S+\s*,?\s*password\s*:\s*\S+", re.I),
    re.compile(r"\bpassword\s*:\s*\S+", re.I),
    re.compile(r"\buser\s*name\s*:\s*\S+", re.I),
]

# Both set once, from the command line, and read by everything below. The
# names are not written down in this file on purpose — see the module
# docstring.
SCRUB_NAMES: list[str] = []
PROVENANCE = True

# ── the shape of an SOP ─────────────────────────────────────────────────────

# Top-level headings, in the order they appear, and where each one lands in a
# notebook protocol. Matched on the heading's first words, so "Definitions and
# Abbreviation" and "Definitions and Abbreviations" are the same section.
SECTIONS = [
    ("definitions", "Definitions and Abbreviation", "notes"),
    ("scope", "Scope and Purpose", "summary"),
    ("safety", "Safety", "notes"),
    ("related", "Related Documents", "notes"),
    ("responsibilities", "Responsibilities", "drop"),
    ("materials", "Equipment, Materials and Solutions", "materials"),
    ("procedure", "Procedure", "steps"),
    ("troubleshooting", "Troubleshooting", "notes"),
    ("attachments", "Attachments", "notes"),
    ("documentation", "Documentation", "notes"),
    ("history", "Document History", "drop"),
    ("appendices", "Appendices", "notes"),
]
SECTION_BY_KEY = {k: (label, dest) for k, label, dest in SECTIONS}

# Which heading a numbered line starts, by its leading words.
HEADING_WORDS = [
    ("definitions", r"definitions?\b"),
    ("scope", r"scope\b"),
    ("safety", r"safety\b"),
    ("related", r"related\s+document"),
    ("responsibilities", r"responsibilit"),
    ("materials", r"equipment\b|materials\b"),
    ("procedure", r"procedure\b"),
    ("troubleshooting", r"troubleshoot"),
    ("attachments", r"attachment"),
    ("documentation", r"documentation\b"),
    ("history", r"document\s+history"),
    ("appendices", r"appendi"),
]

# The notebook's own category list (js/notebook.js, openModal 'protocol').
# First rule that matches the title wins; the body is only consulted when the
# title says nothing. Order matters: "Site-Directed Mutagenesis ... After PCR"
# is cloning, not PCR.
CATEGORIES = [
    ("Western Blot", r"western\s+blot"),
    ("Flow Cytometry", r"flow\s+cytometry|facs\b"),
    ("NGS", r"\bngs\b|ampliconseq|guideseq|library\s+prep|tapestation"),
    ("Molecular Cloning", r"mutagenesis|cloning|ligation|gibson|\bivt\b|in\s*-?\s*vitro\s+transcription"),
    ("PCR & Sequencing", r"\bpcr\b|sequencing|quickextract|sanger"),
    ("Gene Editing", r"electroporation|\brnp\b|crispr|editing|nuclease|txtl|\bomni\b"),
    ("Cell Culture", r"transfection|medium|media|thaw|culturing|freezing|differentiation|\bhscs?\b|cell\s+lines?"),
    ("Protein Purification", r"lysate|bradford|purification|protein"),
]

URL = re.compile(r"(?:https?://|www\.)[^\s,;)\]]+")

NOT_A_PROTOCOL = re.compile(r"safety\s+data\s+sheet|\bmsds\b", re.I)


# ── reading a page ──────────────────────────────────────────────────────────

# A raised or dropped scrap of a word: the 2s of H₂O₂, the m of Tm, and the ™
# or ® that supplier names are full of. A single letter only counts when it is
# both in a smaller font and hard against its neighbour, which no ordinary
# word is.
SUBSCRIPT = re.compile(r"^(?:[0-9+\-]{1,3}|[a-z]|TM|™|®)$")
MARKS = {"TM": "™"}


def _line_text(words: list[dict]) -> str:
    """One visual line of words as text, putting subscripts back where they
    belong.

    In "3% H₂O₂" the two 2s are separate 7pt words sitting 4pt lower than the
    11pt text, which is a line of its own to anything that groups by the top
    of a word: the materials table came out reading "3% H O" and, somewhere
    below it, "2 2". They share a baseline with the text and sit hard against
    the letter before them, which is what identifies them.
    """
    words = sorted(words, key=lambda w: w["x0"])
    if not words:
        return ""
    body = max(w["size"] for w in words)
    out: list[str] = []
    was_small = False
    for i, w in enumerate(words):
        text = MARKS.get(w["text"], w["text"])
        small = w["size"] < body * 0.85 and bool(SUBSCRIPT.match(w["text"]))
        tight = i > 0 and w["x0"] - words[i - 1]["x1"] < 1.5
        # Either side of the join may be the subscript: "H₂O₂" is H, 2, O, 2,
        # and the O has to go back on as tightly as the 2s do.
        if out and tight and (small or was_small):
            out[-1] += text
        else:
            out.append(text)
        was_small = small
    return re.sub(r"[ \t]+", " ", " ".join(out)).strip()


def _group_lines(words: list[dict]) -> list[tuple[float, str]]:
    """Words grouped into visual lines by how much of a word's height falls
    inside a line's own span, so a raised or dropped character joins the line
    it belongs to instead of starting one."""
    lines: list[list[dict]] = []
    spans: list[list[float]] = []
    for w in sorted(words, key=lambda w: (round(w["top"], 1), w["x0"])):
        height = max(0.1, w["bottom"] - w["top"])
        placed = False
        for line, span in zip(lines, spans):
            overlap = min(w["bottom"], span[1]) - max(w["top"], span[0])
            if overlap / height > 0.6:
                line.append(w)
                span[0], span[1] = min(span[0], w["top"]), max(span[1], w["bottom"])
                placed = True
                break
        if not placed:
            lines.append([w])
            spans.append([w["top"], w["bottom"]])
    out = []
    for line, span in sorted(zip(lines, spans), key=lambda ls: ls[1][0]):
        text = _line_text(line)
        if text:
            out.append((span[0], text))
    return out


def _cell(value: str | None) -> str:
    """One table cell as a single line. Cells wrap, and a cell spanning rows
    holds a whole column of values, so those become ' / ' runs rather than
    vanishing."""
    text = re.sub(r"\s*\n\s*", " / ", (value or "").strip())
    return re.sub(r"[ \t]+", " ", text)


# Pad a column no wider than this. One SOP wraps a figure and its caption in a
# one-row table, and padding every other row out to the caption's width gave
# lines of 700 spaces.
PAD_LIMIT = 40


def _render_table(rows: list[list[str | None]]) -> str:
    """A table as aligned columns. The notebook shows materials and steps in a
    <pre>, so alignment survives; a reaction mix is unreadable without it."""
    grid = [[_cell(c) for c in row] for row in rows]
    grid = [row for row in grid if any(row)]
    if not grid:
        return ""
    width = max(len(row) for row in grid)
    if width < 2:
        return "\n".join(row[0] for row in grid)   # a figure box, not a table
    grid = [row + [""] * (width - len(row)) for row in grid]
    cols = [min(PAD_LIMIT, max(len(row[i]) for row in grid)) for i in range(width)]
    out = []
    for row in grid:
        cells = [row[i].ljust(cols[i]) for i in range(width - 1)] + [row[width - 1]]
        out.append("  ".join(cells).rstrip())
    return "\n".join(out)


def _inside(w: dict, box) -> bool:
    x0, top, x1, bottom = box
    cx, cy = (w["x0"] + w["x1"]) / 2, (w["top"] + w["bottom"]) / 2
    return x0 <= cx <= x1 and top <= cy <= bottom


def _cell_words(words: list[dict], box) -> str:
    inner = [w for w in words if _inside(w, box)]
    return "\n".join(text for _, text in _group_lines(inner))


def page_blocks(page) -> list[tuple[float, str]]:
    """A page as (vertical position, text) blocks in reading order: its tables
    rendered as tables, and everything outside them as lines.

    Taking the page in the order its content stream happens to be written puts
    a bordered table after the prose that follows it, so a reaction mix lands
    under the wrong step — "mix the following components" with nothing beneath
    it, and the components two steps further down. Ordering by position is what
    keeps each table under the step that introduces it.

    The cells are read word by word here rather than through pdfplumber's own
    extraction, so that a cell gets the same subscript handling as a sentence.
    """
    words = page.extract_words(keep_blank_chars=False, extra_attrs=["size"])
    blocks: list[tuple[float, str]] = []
    boxes = []
    for table in page.find_tables():
        boxes.append(table.bbox)
        grid: list[list[str]] = []
        seen: set = set()
        for row in table.rows:
            cells = []
            for box in row.cells:
                if box is None or box in seen:
                    cells.append("")       # a cell spanning rows is written once
                    continue
                seen.add(box)
                cells.append(_cell_words(words, box))
            grid.append(cells)
        rendered = _render_table(grid)
        if rendered:
            blocks.append((table.bbox[1], rendered))

    free = [w for w in words if not any(_inside(w, b) for b in boxes)]
    blocks.extend(_group_lines(free))
    blocks.sort(key=lambda b: b[0])
    return blocks


def read_pdf(path: pathlib.Path) -> tuple[str, int]:
    """The document as text, and how many figures it has. The figures do not
    come across — several procedures point at a gel photograph or a plate
    diagram, and the report has to say so, or the protocol arrives quietly
    missing a part of itself."""
    out: list[str] = []
    spots: dict[tuple, int] = {}
    pages = 0
    with pdfplumber.open(str(path)) as pdf:
        for page in pdf.pages:
            pages += 1
            for im in page.images:
                spot = (round(im["x0"]), round(im["top"]),
                        round(im["x1"] - im["x0"]), round(im["bottom"] - im["top"]))
                spots[spot] = spots.get(spot, 0) + 1
            for _, text in page_blocks(page):
                out.append(text)
    # An image in the same place on most pages is the letterhead, not a figure.
    figures = sum(n for spot, n in spots.items() if n <= max(1, pages // 2))
    return "\n".join(out), figures


# ── cleaning ────────────────────────────────────────────────────────────────

def drop_furniture(text: str, title: str) -> str:
    kept = []
    for line in text.splitlines():
        if any(p.search(line) for p in FURNITURE):
            continue
        if line.strip() and line.strip().rstrip(":") == title.strip():
            continue  # the title, repeated as a running header
        kept.append(line)
    return "\n".join(kept)


def cut_region(text: str, start: re.Pattern, stop: re.Pattern) -> tuple[str, int]:
    """Everything from `start` up to the next `stop` (or the end), removed.
    Returns the text and how many lines went, so the report can say so."""
    lines = text.splitlines()
    out, cut, dropping = [], 0, False
    for line in lines:
        if dropping:
            if stop.search(line):
                dropping = False
            else:
                cut += 1
                continue
        if not dropping and start.search(line):
            dropping, cut = True, cut + 1
            continue
        out.append(line)
    return "\n".join(out), cut


TOP_HEADING = re.compile(r"^\s*\d{1,2}\.\s*[A-Z]")


def name_pattern(name: str) -> str:
    """A name as a pattern: spacing inside it is optional, since the same
    organisation is written both "Acme Bio" and "AcmeBio"."""
    return r"\s*".join(re.escape(part) for part in name.split())


def owner_candidates(text: str) -> set[str]:
    """Names still sitting in a "Manufacturer/<owner> Cat#" column header. This
    is how a forgotten --scrub is noticed instead of being published.

    It reads text that has already been through the scrub, so there is nothing
    to compare against a list: whatever the scrub was asked to remove is gone
    by now, and anything left is a name nobody accounted for. Asking the
    question the other way round — does this candidate look like one of the
    --scrub names? — got "Acme" out of "Manufacturer/Acme Bio" and never
    matched "Acme Bio", so a two-word name could not be silenced at all.
    """
    found = set()
    for m in OWNER_COLUMN.finditer(text):
        word = m.group(1)
        if word.lower().rstrip("#") == "cat":
            continue            # "Manufacturer/Cat#" names nobody
        found.add(word)
    return found


def scrub(text: str) -> tuple[str, dict]:
    """Cut the approvals, the document history, the owner's name and the
    credentials. Returns the text and a count of what went, by kind."""
    counts = {"approvals": 0, "history": 0, "company": 0, "credentials": 0}

    text, counts["approvals"] = cut_region(
        text, re.compile(r"^\s*Approvals\s*$", re.I), TOP_HEADING)
    text, counts["history"] = cut_region(
        text, re.compile(r"^\s*\d{1,2}\.?\s*Document\s+History\b", re.I), TOP_HEADING)

    kept = []
    for line in text.splitlines():
        if APPROVAL_LINE.search(line) or SIGNATURE_ROW.search(line):
            counts["approvals"] += 1
            continue
        kept.append(line)
    text = "\n".join(kept)

    for pattern in CREDENTIALS:
        text, n = pattern.subn("", text)
        counts["credentials"] += n

    for name in SCRUB_NAMES:
        # "Manufacturer/<owner> Cat#" is the common case: the slash and the
        # spacing have to come out with the name, or the column header is left
        # reading "Manufacturer/ Cat#".
        pattern = name_pattern(name)
        text, n = re.subn(r"\s*/\s*" + pattern + r"\b", "", text, flags=re.I)
        counts["company"] += n
        text, n = re.subn(pattern + r"\s*/\s*", "", text, flags=re.I)
        counts["company"] += n
        text, n = re.subn(r"\b" + pattern + r"\w*", "", text, flags=re.I)
        counts["company"] += n

    text = re.sub(r"[ \t]+([,.;:])", r"\1", text)
    # A mark that drifted too far from its name to be joined by position.
    text = re.sub(r"[ \t]+([®™])", r"\1", text)
    text = re.sub(r"[ \t]*/[ \t]*([®™])(?=[ \t]|$)", r"\1", text)
    return text, counts


def reflow(block: str) -> str:
    """Join a section's wrapped prose back into paragraphs, leaving numbered
    items, notes and table rows where they are."""
    out: list[str] = []
    for line in block.splitlines():
        stripped = line.strip()
        if not stripped:
            if out and out[-1] != "":
                out.append("")
            continue
        starts_item = bool(re.match(
            r"^(\d{1,2}(\.\d{1,2})*\.?\s|[-•▪]\s|Note\s*:|Notes\s*:|Important\s*:)",
            stripped, re.I))
        is_table_row = "  " in line.rstrip()
        if out and out[-1] and not starts_item and not is_table_row \
                and "  " not in out[-1] and not out[-1].endswith(":"):
            out[-1] = out[-1] + " " + stripped
        else:
            out.append(line.rstrip() if is_table_row else stripped)
    while out and not out[-1]:
        out.pop()
    return "\n".join(out)


# ── splitting into sections ─────────────────────────────────────────────────

def split_sections(text: str) -> dict[str, str]:
    """The numbered top-level sections, keyed by SECTIONS key."""
    found: dict[str, list[str]] = {}
    current: str | None = None
    for line in text.splitlines():
        m = re.match(r"^\s*(\d{1,2})\.\s*(.+?)\s*$", line)
        key = None
        if m:
            head = m.group(2).lower()
            for candidate, words in HEADING_WORDS:
                if re.match(r"^\s*(" + words + ")", head) and len(head) < 60:
                    key = candidate
                    break
        if key:
            current = key
            found.setdefault(key, [])
            continue
        if current:
            found[current].append(line)
    out = {}
    for key, lines in found.items():
        if key == "definitions":
            # A glossary is a borderless two-column table, so it arrives as
            # one short line per abbreviation and reflow would run the lot
            # into a single paragraph. One per line is the whole point of it.
            out[key] = "\n".join(l.strip() for l in lines if l.strip())
        else:
            out[key] = reflow("\n".join(lines))
    return out


def strip_numbering(block: str) -> str:
    """Drop the "2.1." from a one-item section like Scope and Purpose, where
    the numbering carries nothing."""
    lines = []
    for line in block.splitlines():
        lines.append(re.sub(r"^\s*\d{1,2}(\.\d{1,2})*\.?\s+", "", line))
    return "\n".join(lines).strip()


def related_titles(block: str) -> str:
    """Related Documents, as titles only. The codes point at documents this lab
    does not have; "Agarose Gel Preparation" still tells you what to go and
    find."""
    out = []
    for line in block.splitlines():
        line = re.sub(r"^\s*\d{1,2}(\.\d{1,2})*\.?\s+", "", line).strip()
        line = re.sub(r"^SOP-[A-Z]{3}-\d+\s*[–—-]\s*", "", line)
        line = re.sub(r"\bSOP-[A-Z]{3}-\d+\b", "", line).strip(" -–—")
        if line:
            out.append("- " + line)
    return "\n".join(out)


# ── building a record ───────────────────────────────────────────────────────

def classify(title: str, body: str) -> str:
    """The title decides when it says anything at all. Otherwise the body does,
    by weight of mentions rather than by the first rule to match: a
    transfection worksheet that harvests into a FACS plate at the end is a
    transfection worksheet."""
    for category, pattern in CATEGORIES:
        if re.search(pattern, title, re.I):
            return category
    best, score = "Other", 0
    for category, pattern in CATEGORIES:
        n = len(re.findall(pattern, body, re.I))
        if n > score:
            best, score = category, n
    return best


def title_from_filename(stem: str) -> tuple[str, str]:
    """(document code, title). The filenames are clean and consistent; the
    header line is not — it wraps mid-title across two lines."""
    m = re.match(r"^\s*(SOP-[A-Z]{3}-\d+)\s*[-–]?\s*(.*)$", stem)
    code, rest = (m.group(1), m.group(2)) if m else ("", stem)
    if not m:
        m2 = re.match(r"^\s*(Appendix\s+[\d.]+)\s*[-–]?\s*(.*)$", stem, re.I)
        if m2:
            code, rest = m2.group(1), m2.group(2)
    rest = re.sub(r"\s*[-–]\s*(?:Revision|Rev\.?|R)\s*0?\d+\b", "", rest, flags=re.I)
    rest = re.sub(r"\s*\bCorrected\b\s*$", "", rest, flags=re.I)
    rest = re.sub(r"\s*\(\d+\)\s*$", "", rest)
    rest = rest.strip(" -–—_")
    rest = re.sub(r"\s{2,}", " ", rest)
    return code, rest or stem


MONTH_DATE = re.compile(r"Effective\s+date\s*:\s*(\d{1,2})\s*([A-Za-z]{3})[a-z]*\s*(\d{4})", re.I)
VERSION = re.compile(r"Version\s*:\s*(\d+)", re.I)


def header_facts(raw: str) -> tuple[str, str]:
    """(ISO effective date, version) from the running header."""
    date = ""
    m = MONTH_DATE.search(raw)
    if m:
        try:
            date = dt.datetime.strptime(
                f"{int(m.group(1)):02d}{m.group(2).title()}{m.group(3)}", "%d%b%Y"
            ).date().isoformat()
        except ValueError:
            date = ""
    v = VERSION.search(raw)
    return date, (v.group(1) if v else "")


def build_notes(sections: dict[str, str], code: str, version: str, date: str) -> str:
    parts = []
    order = [("safety", "Safety"), ("troubleshooting", "Troubleshooting"),
             ("definitions", "Abbreviations"), ("attachments", "Attachments"),
             ("documentation", "Documentation"), ("appendices", "Appendices")]
    for key, label in order:
        block = sections.get(key, "").strip()
        if not block:
            continue
        parts.append(label + "\n" + strip_numbering(block))
    related = related_titles(sections.get("related", ""))
    if related:
        parts.append("Related protocols referred to by the original\n" + related)
    if PROVENANCE and code:
        bits = [code]
        if version:
            bits.append("version " + version)
        if date:
            bits.append("effective " + date)
        parts.append("Adapted from an in-house SOP from previous work (" +
                     ", ".join(bits) + "). Approvals, document history and the "
                     "owner's name were left out on import.")
    return "\n\n".join(parts).strip()


def build_sop(path: pathlib.Path, raw: str, author: str) -> tuple[dict, dict]:
    code, title = title_from_filename(path.stem)
    date, version = header_facts(raw)
    text = drop_furniture(raw, title)
    text, counts = scrub(text)
    sections = split_sections(text)

    summary = strip_numbering(sections.get("scope", ""))
    materials = strip_numbering(sections.get("materials", ""))
    steps = sections.get("procedure", "").strip()
    record = {
        "kind": "protocol",
        "title": title,
        "category": classify(title, text),
        "author": author,
        "date": date,
        "link": "",
        "summary": summary,
        "materials": materials,
        "steps": steps,
        "notes": build_notes(sections, code, version, date),
    }
    counts["sections"] = sorted(sections)
    counts["missing"] = [k for k in ("scope", "materials", "procedure")
                         if not sections.get(k, "").strip()]
    return record, counts


def build_appendix(path: pathlib.Path, raw: str, author: str) -> tuple[dict, dict]:
    code, title = title_from_filename(path.stem)
    text, counts = scrub(drop_furniture(raw, title))
    body = reflow(text)
    record = {
        "kind": "protocol",
        "title": title,
        "category": classify(title, body),
        "author": author,
        "date": "",
        "link": "",
        "summary": "A bench worksheet from previous work: the plate layout and "
                   "the dilutions to fill in on the day.",
        "materials": "",
        "steps": body,
        "notes": ("Adapted from an appendix to an in-house SOP from previous work"
                  + (" (" + code + ")" if code and PROVENANCE else "") + ".")
        if PROVENANCE else "",
    }
    counts["sections"] = ["freeform"]
    counts["missing"] = []
    return record, counts


def build_reference(path: pathlib.Path, raw: str, author: str) -> tuple[dict, dict]:
    _, title = title_from_filename(path.stem)
    urls = URL.findall(raw)
    link = ""
    for u in urls:
        if "bio-rad.com/digital-assays" in u:
            continue
        link = u if u.startswith("http") else "https://" + u
        break
    text, counts = scrub(raw)
    record = {
        "kind": "reference",
        "title": title,
        "category": classify(title, text),
        "author": author,
        "date": "",
        "link": link.rstrip("."),
        "summary": ("A supplier's own document, kept as a pointer rather than a "
                    "copy: follow their current version, and attach the PDF here "
                    "if you want the one you have on hand."),
        "materials": "",
        "steps": "",
        "notes": "Third-party document. Its text was not copied on import.",
    }
    counts["sections"] = ["reference"]
    counts["missing"] = []
    return record, counts


# ── the check that the scrub worked ─────────────────────────────────────────

def verify(records: list[dict]) -> list[str]:
    """Read the finished records back and look for anything that should have
    gone. A scrub nobody checks is a scrub that stops working quietly."""
    problems = []
    checks = [("a name that --scrub should have removed",
               [re.compile(name_pattern(n), re.I) for n in SCRUB_NAMES]),
              ("credentials", CREDENTIALS),
              ("approval line", [APPROVAL_LINE, SIGNATURE_ROW])]
    for rec in records:
        blob = "\n".join(str(rec.get(f, "")) for f in
                         ("title", "summary", "materials", "steps", "notes", "link"))
        for label, patterns in checks:
            for pattern in patterns:
                if pattern.search(blob):
                    problems.append(f"{rec['title']}: {label} survived the scrub "
                                    f"({pattern.pattern})")
    return problems


# ── main ────────────────────────────────────────────────────────────────────

def classify_file(path: pathlib.Path, raw: str) -> str:
    """An in-house SOP first, and only then the question of what else it is.
    The Western Blot SOP cites a sodium azide MSDS in its related documents,
    and was being thrown away as one."""
    if re.search(r"^\s*Approvals\s*$", raw, re.I | re.M) and \
            re.search(r"SOP-[A-Z]{3}-\d+", raw):
        return "sop"
    if path.stem.lower().startswith("appendix"):
        return "appendix"
    if NOT_A_PROTOCOL.search(raw[:4000]):
        return "skip-sds"
    return "reference"


def inside_repo(out: pathlib.Path) -> bool:
    try:
        root = subprocess.run(["git", "rev-parse", "--show-toplevel"],
                              cwd=pathlib.Path(__file__).resolve().parent,
                              capture_output=True, text=True, check=True).stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        return False
    try:
        out.resolve().relative_to(pathlib.Path(root).resolve())
        return True
    except ValueError:
        return False


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--src", required=True, help="folder holding the PDFs")
    ap.add_argument("--out", required=True, help="bundle to write (.json)")
    ap.add_argument("--author", default="Amer Elias",
                    help="who is importing them (the notebook's Author field)")
    ap.add_argument("--scrub", action="append", default=[], metavar="NAME",
                    help="a name to remove everywhere, e.g. the organisation that "
                         "owns the documents. Repeatable, or comma-separated.")
    ap.add_argument("--scrub-ok", action="append", default=[], metavar="NAME",
                    help="a name found in a 'Manufacturer/<owner>' column that is "
                         "meant to stay, so the run does not stop for it")
    ap.add_argument("--no-provenance", action="store_true",
                    help="leave out the 'adapted from SOP-xxx-nnn' line in the notes")
    ap.add_argument("--text-dir", help="also write the cleaned text, to read through")
    ap.add_argument("--force", action="store_true",
                    help="allow writing the bundle inside the repository")
    args = ap.parse_args(argv)

    global PROVENANCE
    PROVENANCE = not args.no_provenance
    for value in args.scrub:
        for part in value.split(","):
            if part.strip():
                SCRUB_NAMES.append(part.strip())
    allowed = {n.strip().lower() for v in args.scrub_ok for n in v.split(",") if n.strip()}

    src = pathlib.Path(args.src).expanduser()
    out = pathlib.Path(args.out).expanduser()
    if not src.is_dir():
        sys.exit(f"not a folder: {src}")
    if inside_repo(out) and not args.force:
        sys.exit(f"refusing to write {out} inside the repository: it holds lab "
                 "protocol text and this repo is public. Pick a path outside it, "
                 "or pass --force if you are sure.")

    records: list[dict] = []
    report: list[str] = []
    skipped: list[str] = []
    seen: dict[str, str] = {}
    unscrubbed: dict[str, list[str]] = {}

    files = sorted(p for p in src.iterdir()
                   if p.is_file() and not p.name.startswith("."))
    for path in files:
        if path.suffix.lower() != ".pdf":
            skipped.append(f"{path.name} — not a PDF")
            continue
        digest = hashlib.sha256(path.read_bytes()).hexdigest()[:12]
        if digest in seen:
            skipped.append(f"{path.name} — identical to {seen[digest]}")
            continue
        seen[digest] = path.name

        try:
            raw, figures = read_pdf(path)
        except Exception as exc:  # noqa: BLE001 - one bad file must not stop the run
            skipped.append(f"{path.name} — could not be read ({exc})")
            continue
        if len(raw.strip()) < 200:
            skipped.append(f"{path.name} — almost no text (a scan?)")
            continue

        what = classify_file(path, raw)
        if what == "skip-sds":
            skipped.append(f"{path.name} — a safety data sheet, not a protocol")
            continue
        builder = {"sop": build_sop, "appendix": build_appendix,
                   "reference": build_reference}[what]
        record, counts = builder(path, raw, args.author)
        records.append(record)

        # Asked of the finished record, not the PDF: by here the scrub has
        # run, so a name still standing in a materials column is one nobody
        # accounted for.
        for word in owner_candidates("\n".join(
                str(record.get(f, "")) for f in ("materials", "steps", "notes"))):
            if word.lower() not in allowed:
                unscrubbed.setdefault(word, []).append(path.name)

        notes = []
        if counts.get("missing"):
            notes.append("EMPTY: " + ", ".join(counts["missing"]))
        if figures:
            notes.append(f"{figures} figure(s) stayed in the PDF")
        if counts.get("credentials"):
            notes.append(f"{counts['credentials']} credential(s) removed")
        if counts.get("approvals"):
            notes.append(f"{counts['approvals']} approval line(s) removed")
        if counts.get("history"):
            notes.append(f"{counts['history']} history line(s) removed")
        if counts.get("company"):
            notes.append(f"company name removed {counts['company']}×")
        report.append(f"  {record['category']:<22} {record['title']}"
                      + (f"\n      {'; '.join(notes)}" if notes else ""))

        if args.text_dir:
            tdir = pathlib.Path(args.text_dir).expanduser()
            tdir.mkdir(parents=True, exist_ok=True)
            (tdir / (path.stem + ".txt")).write_text(
                "\n\n".join(f"== {f} ==\n{record[f]}" for f in
                            ("summary", "materials", "steps", "notes")),
                encoding="utf-8")

    if unscrubbed:
        print("These documents name their owner in a materials column, and "
              "--scrub does not cover it. Nothing was written.", file=sys.stderr)
        for word, where in sorted(unscrubbed.items()):
            print(f'  "{word}" — in {len(where)} file(s), e.g. {where[0]}', file=sys.stderr)
        print("\nRemove it with   --scrub " + " --scrub ".join(
            f'"{w}"' for w in sorted(unscrubbed)), file=sys.stderr)
        print("or keep it with  --scrub-ok " + " --scrub-ok ".join(
            f'"{w}"' for w in sorted(unscrubbed)), file=sys.stderr)
        return 2

    problems = verify(records)
    if problems:
        print("The scrub did not hold. Nothing was written.", file=sys.stderr)
        for p in problems:
            print("  " + p, file=sys.stderr)
        return 2

    full = [r for r in records if r["kind"] == "protocol"]
    refs = [r for r in records if r["kind"] == "reference"]
    bundle = {
        "kind": "elias-lab-protocols",
        "version": 1,
        "generated": dt.datetime.now().replace(microsecond=0).isoformat(),
        "protocols": records,
    }
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(bundle, ensure_ascii=False, indent=1), encoding="utf-8")

    print(f"{len(full)} protocol(s) and {len(refs)} reference(s) from {len(files)} file(s):")
    for line in report:
        print(line)
    if skipped:
        print("\nLeft out:")
        for line in skipped:
            print("  " + line)
    print(f"\nWrote {out}")
    print("Import it in the notebook: Protocols → Import from file.")
    print("The bundle holds lab protocol text — keep it out of the repository.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
