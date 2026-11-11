#!/usr/bin/env python3
"""Checks for scripts/import_protocols.py.

    python3 -m pip install --user pdfplumber
    python3 scripts/check_import_protocols.py

The fixtures below are invented. No real document, name or account appears in
this file, which is the point: this repository is public, so a check written
against the real thing would publish what the script exists to remove.

Most of the file is about the scrub, and three checks earn the rest of it.
One feeds a finished record a name that should have gone and insists the run
fails. One does the same with a password. One hands the detector a document
whose materials column names its owner and insists that --scrub being
forgotten stops the run instead of quietly letting it through. If any of
those goes green-to-red, protocols with somebody else's confidential
information in them have become one click from being uploaded.
"""
from __future__ import annotations

import pathlib
import sys
import tempfile

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import import_protocols as ip  # noqa: E402

passed = 0
failures: list[str] = []


def check(what: str, fn) -> None:
    global passed
    try:
        fn()
    except AssertionError as exc:
        failures.append(f"{what}: {exc}")
        print(f"  FAIL  {what}\n          {exc}")
        return
    except Exception as exc:  # noqa: BLE001
        failures.append(f"{what}: unexpected {type(exc).__name__}: {exc}")
        print(f"  FAIL  {what}\n          unexpected {type(exc).__name__}: {exc}")
        return
    passed += 1
    print(f"  ok    {what}")


# An invented SOP with the shape of a real one: a running header, an approvals
# table, the numbered sections, a credential written into a step, and a
# materials column headed with the owner's name.
OWNER = "Acme Bio"
SOP = """\
Widget Preparation Department: R&D
SOP-MET-042 Version: 02 Effective date: 05Nov2021 Page 1 of 4
CONFIDENTIAL
Approvals
Title Name Signature Date
Prepared by: Research Associate Dana Fictional 29.09.2021
Reviewed by: Senior Director Robin Invented 03.10.2021
Approved by: QA Director Sam Imaginary 04.10.2021
1. Definitions and Abbreviation
ABS Absolute
DDW Double Distilled Water
2. Scope and Purpose
2.1. This document describes the preparation of widgets.
3. Safety
3.1. Wear a lab coat.
4. Related Documents
4.1. SOP-LAB-031 - Agarose Gel Preparation
4.2. SOP-LAB-028 - NanoDrop Operating Procedure
5. Responsibilities
5.1. R&D personnel are responsible for performing this SOP adequately.
6. Equipment, Materials and Solutions
Material Amount Manufacturer/{owner} Cat#
Ultra-Pure Water As required 457LM
7. Procedure
7.1. Use the vendor's on-line tool: https://example.org/tool. Username: someone,
Password: notarealpassword1.
7.2. Incubate at 37°C for 30 minutes.
8. Document History
Revision No. Date Author Title Main Changes
01 15.10.20 Dana Fictional Research Associate First issue.
""".format(owner=OWNER)


def with_scrub(names, fn):
    """Run fn with SCRUB_NAMES set, and put it back afterwards."""
    old = list(ip.SCRUB_NAMES)
    ip.SCRUB_NAMES[:] = names
    try:
        return fn()
    finally:
        ip.SCRUB_NAMES[:] = old


def scrubbed(text=SOP, names=(OWNER,)):
    return with_scrub(list(names), lambda: ip.scrub(ip.drop_furniture(text, "Widget Preparation")))


def record(text=SOP, names=(OWNER,)):
    return with_scrub(list(names),
                      lambda: ip.build_sop(pathlib.Path("SOP-MET-042 - Widget Preparation.pdf"),
                                           text, "A Scientist")[0])


# ---------------------------------------------------------------------------
print("Nothing is scrubbed by default, because nothing is written down here")


def _the_default_list_is_empty():
    assert ip.SCRUB_NAMES == [], (
        "SCRUB_NAMES must stay empty in the source: a default would publish "
        "the name in this public repository")


def _the_source_names_nobody():
    src = (HERE / "import_protocols.py").read_text(encoding="utf-8")
    assert "SCRUB_NAMES: list[str] = []" in src, "the empty default went missing"


check("the scrub list is empty until the command line fills it",
      _the_default_list_is_empty)
check("the source keeps it that way", _the_source_names_nobody)


# ---------------------------------------------------------------------------
print("\nThe approvals")


def _every_name_in_the_approvals_goes():
    rec = record()
    blob = "\n".join(rec.values())
    for name in ("Dana Fictional", "Robin Invented", "Sam Imaginary"):
        assert name not in blob, f"{name} survived"
    for word in ("Prepared by", "Reviewed by", "Approved by", "Signature",
                 "Research Associate", "Senior Director", "QA Director"):
        assert word not in blob, f"{word} survived"
    # The word "Approvals" itself is in the provenance line, which says they
    # were left out, so the heading is what to look for.
    assert "Approvals\n" not in blob and not blob.startswith("Approvals")


def _the_document_history_goes_with_them():
    rec = record()
    blob = "\n".join(rec.values())
    assert "Document History" not in blob
    assert "First issue" not in blob, "the history's change log names its author"
    assert "Revision No." not in blob


def _a_stray_approval_row_outside_the_region_still_goes():
    text, counts = scrubbed("1. Scope\nPrepared by: QA Director Someone Else 01.01.2020\n")
    assert "Someone Else" not in text
    assert counts["approvals"] >= 1


def _the_sections_around_them_are_kept():
    rec = record()
    assert "preparation of widgets" in rec["summary"]
    assert "Incubate at 37°C for 30 minutes" in rec["steps"]


check("every name in the approvals block goes", _every_name_in_the_approvals_goes)
check("the document history goes with them", _the_document_history_goes_with_them)
check("an approval row outside the block still goes",
      _a_stray_approval_row_outside_the_region_still_goes)
check("the protocol either side of them is kept", _the_sections_around_them_are_kept)


# ---------------------------------------------------------------------------
print("\nThe credentials")


def _the_account_goes():
    rec = record()
    blob = "\n".join(rec.values())
    assert "notarealpassword1" not in blob, "a password reached the record"
    assert "Username" not in blob and "Password" not in blob


def _the_step_still_reads():
    rec = record()
    assert "on-line tool" in rec["steps"], "the step was thrown away with the account"
    assert "https://example.org/tool" in rec["steps"], "the tool's address is the useful part"


def _a_lone_password_goes_too():
    text, counts = scrubbed("7.1. Log in. Password: hunter2\n")
    assert "hunter2" not in text
    assert counts["credentials"] >= 1


check("the username and password go", _the_account_goes)
check("the step that held them still reads", _the_step_still_reads)
check("a password with no username goes too", _a_lone_password_goes_too)


# ---------------------------------------------------------------------------
print("\nThe owner's name")


def _the_name_goes_everywhere():
    rec = record()
    blob = "\n".join(rec.values())
    assert OWNER not in blob
    assert "Acme" not in blob


def _the_column_header_still_makes_sense():
    rec = record()
    assert "Manufacturer Cat#" in rec["materials"], (
        f"expected the slash to go with the name, got: {rec['materials']!r}")
    assert "Manufacturer/ Cat#" not in rec["materials"]


def _the_spelling_without_the_space_goes_as_well():
    text, _ = scrubbed("Material Amount Manufacturer/AcmeBio Cat#\n")
    assert "Acme" not in text, "written solid, the same name has to go"


def _a_suffixed_form_goes_as_well():
    text, _ = scrubbed("The AcmeBiosystems catalogue.\n", names=["Acme"])
    assert "Acme" not in text


def _what_is_not_the_owner_is_kept():
    rec = record()
    assert "457LM" in rec["materials"], "the internal catalogue code is data, not a name"
    assert "Invitrogen" not in rec["materials"] or True  # no supplier in this fixture
    text, _ = scrubbed("Vent Polymerase NEB-M2080S\n")
    assert "NEB-M2080S" in text, "a real supplier's catalogue number must survive"


check("the name goes from every field", _the_name_goes_everywhere)
check("the materials column header still makes sense",
      _the_column_header_still_makes_sense)
check("the same name written without the space goes too",
      _the_spelling_without_the_space_goes_as_well)
check("a longer word built on the name goes too", _a_suffixed_form_goes_as_well)
check("suppliers and catalogue codes are left alone", _what_is_not_the_owner_is_kept)


# ---------------------------------------------------------------------------
print("\nForgetting --scrub is noticed, not trusted")


def _an_unscrubbed_owner_is_reported():
    # The detector reads what the scrub has finished with, so "no --scrub"
    # means the name is still there to be found.
    text, _ = scrubbed(names=[])
    assert ip.owner_candidates(text) == {"Acme"}, ip.owner_candidates(text)


def _scrubbing_it_quietens_the_detector():
    text, _ = scrubbed(names=[OWNER])
    assert ip.owner_candidates(text) == set(), ip.owner_candidates(text)


def _a_two_word_name_can_be_silenced():
    # Asking "does this candidate look like one of the --scrub names?" got
    # "Acme" out of "Manufacturer/Acme Bio" and never matched "Acme Bio", so
    # the run could not be got past at all.
    for names in ([OWNER], ["Acme"], ["acme  bio"]):
        text, _ = scrubbed(names=names)
        assert ip.owner_candidates(text) == set(), f"{names} left {ip.owner_candidates(text)}"


def _the_solid_spelling_is_covered_by_the_spaced_name():
    doc = "Material Amount Manufacturer/AcmeBio Cat#\n"
    text, _ = with_scrub([OWNER], lambda: ip.scrub(doc))
    assert ip.owner_candidates(text) == set()


def _a_column_naming_nobody_is_not_a_finding():
    assert ip.owner_candidates("Material Amount Manufacturer/Cat# \n") == set()


check("a name that was not scrubbed is reported", _an_unscrubbed_owner_is_reported)
check("scrubbing it quietens the detector", _scrubbing_it_quietens_the_detector)
check("a two-word name can be silenced", _a_two_word_name_can_be_silenced)
check("the spaced name covers the solid spelling",
      _the_solid_spelling_is_covered_by_the_spaced_name)
check("a column naming nobody is not a finding", _a_column_naming_nobody_is_not_a_finding)


# ---------------------------------------------------------------------------
print("\nThe run stops rather than writing something it should not")


def _a_leaked_name_fails_the_run():
    bad = [{"title": "T", "summary": f"made by {OWNER}", "materials": "", "steps": "",
            "notes": "", "link": ""}]
    problems = with_scrub([OWNER], lambda: ip.verify(bad))
    assert problems, "a record still naming the owner has to fail the run"
    assert "--scrub" in problems[0]


def _a_leaked_password_fails_the_run():
    bad = [{"title": "T", "summary": "", "materials": "", "notes": "", "link": "",
            "steps": "Password: hunter2"}]
    problems = with_scrub([], lambda: ip.verify(bad))
    assert problems and "credential" in problems[0], problems


def _a_leaked_approval_fails_the_run():
    bad = [{"title": "T", "summary": "", "materials": "", "link": "", "steps": "",
            "notes": "Approved by: QA Director Someone"}]
    problems = with_scrub([], lambda: ip.verify(bad))
    assert problems and "approval" in problems[0], problems


def _a_clean_record_passes():
    assert with_scrub([OWNER], lambda: ip.verify([record()])) == []


def _the_failure_names_the_protocol():
    bad = [{"title": "Widget Preparation", "summary": OWNER, "materials": "",
            "steps": "", "notes": "", "link": ""}]
    problems = with_scrub([OWNER], lambda: ip.verify(bad))
    assert problems[0].startswith("Widget Preparation"), problems


check("a name that survived fails the whole run", _a_leaked_name_fails_the_run)
check("a password that survived fails the whole run", _a_leaked_password_fails_the_run)
check("an approval line that survived fails the whole run", _a_leaked_approval_fails_the_run)
check("a clean record passes", _a_clean_record_passes)
check("the failure says which protocol", _the_failure_names_the_protocol)


# ---------------------------------------------------------------------------
print("\nThe bundle does not get written into a public repository")


def _writing_inside_the_repo_is_refused():
    with tempfile.TemporaryDirectory() as src:
        try:
            ip.main(["--src", src, "--out", str(HERE.parent / "protocols-import.json")])
        except SystemExit as exc:
            assert "public" in str(exc.code), exc.code
            return
        raise AssertionError("it wrote the bundle into the repository")


def _writing_outside_it_is_allowed():
    with tempfile.TemporaryDirectory() as src, tempfile.TemporaryDirectory() as out:
        code = ip.main(["--src", src, "--out", str(pathlib.Path(out) / "b.json")])
        assert code == 0, code
        assert (pathlib.Path(out) / "b.json").exists()


check("a path inside the repository is refused", _writing_inside_the_repo_is_refused)
check("a path outside it is written", _writing_outside_it_is_allowed)


# ---------------------------------------------------------------------------
print("\nWhich section becomes which field")


def _the_sections_land_where_they_belong():
    rec = record()
    assert rec["summary"].startswith("This document describes")
    assert "Ultra-Pure Water" in rec["materials"]
    assert "7.2. Incubate" in rec["steps"]
    assert "Wear a lab coat" in rec["notes"], "safety belongs in the notes"


def _responsibilities_are_dropped():
    rec = record()
    assert "responsible for performing" not in "\n".join(rec.values()), (
        "the org's own boilerplate has no place in another lab's notebook")


def _related_documents_keep_their_titles_and_lose_their_codes():
    rec = record()
    assert "Agarose Gel Preparation" in rec["notes"]
    assert "SOP-LAB-031" not in rec["notes"], "a code for a document this lab lacks is noise"


def _the_glossary_stays_one_per_line():
    rec = record()
    assert "ABS Absolute\nDDW Double Distilled Water" in rec["notes"], (
        f"the glossary was reflowed into prose: {rec['notes']!r}")


def _provenance_names_the_source_document():
    rec = record()
    assert "SOP-MET-042" in rec["notes"]
    assert "version 02" in rec["notes"]
    assert "effective 2021-11-05" in rec["notes"]


def _provenance_can_be_turned_off():
    old = ip.PROVENANCE
    ip.PROVENANCE = False
    try:
        rec = record()
        assert "SOP-MET-042" not in rec["notes"]
    finally:
        ip.PROVENANCE = old


check("each section lands in the right field", _the_sections_land_where_they_belong)
check("responsibilities are dropped", _responsibilities_are_dropped)
check("related documents keep their titles and lose their codes",
      _related_documents_keep_their_titles_and_lose_their_codes)
check("the glossary stays one abbreviation per line", _the_glossary_stays_one_per_line)
check("the notes say which document it came from", _provenance_names_the_source_document)
check("that line can be turned off", _provenance_can_be_turned_off)


# ---------------------------------------------------------------------------
print("\nThe page furniture")


def _the_running_header_and_footer_go():
    rec = record()
    blob = "\n".join(rec.values())
    for word in ("CONFIDENTIAL", "Page 1 of 4", "Department:", "Effective date:"):
        assert word not in blob, f"{word} survived"


def _the_title_repeated_as_a_header_goes():
    text = ip.drop_furniture("Widget Preparation\n7.1. Do the thing.\n", "Widget Preparation")
    assert "Widget Preparation" not in text
    assert "Do the thing" in text


check("the header and the footer go", _the_running_header_and_footer_go)
check("the title repeated as a running header goes", _the_title_repeated_as_a_header_goes)


# ---------------------------------------------------------------------------
print("\nTitles, dates and categories")


def _titles_come_from_the_filename():
    cases = {
        "SOP-MET-005 - IVT of sgRNA": ("SOP-MET-005", "IVT of sgRNA"),
        "SOP-MET-035 - Cell Lysis with QuickExtract - Revision 03 Corrected":
            ("SOP-MET-035", "Cell Lysis with QuickExtract"),
        "SOP-MET-055 - SFEM II Medium Preparation - Revision 02 (1)":
            ("SOP-MET-055", "SFEM II Medium Preparation"),
        "SOP-MET-036 NGS Preparations (AmpliconSeq) (1)":
            ("SOP-MET-036", "NGS Preparations (AmpliconSeq)"),
        "SOP-SOL-001 - Widget Media - R03": ("SOP-SOL-001", "Widget Media"),
        "Appendix 9.1 - 96 well plate template": ("Appendix 9.1", "96 well plate template"),
    }
    for stem, want in cases.items():
        got = ip.title_from_filename(stem)
        assert got == want, f"{stem!r} -> {got!r}, wanted {want!r}"


def _a_name_with_no_code_is_still_a_title():
    code, title = ip.title_from_filename("JetOptimus protocol")
    assert code == ""
    assert title == "JetOptimus protocol"


def _the_effective_date_becomes_a_real_date():
    assert ip.header_facts("Version: 02 Effective date: 05Nov2021") == ("2021-11-05", "02")
    assert ip.header_facts("Version: 03 Effective date: 15OCT2023") == ("2023-10-15", "03")
    assert ip.header_facts("no header here") == ("", "")


def _a_date_that_makes_no_sense_is_left_empty():
    assert ip.header_facts("Effective date: 99Xyz2021")[0] == ""


def _the_title_decides_the_category():
    cases = {
        "Western Blot": "Western Blot",
        "GuideSeq Library Preparation Procedure": "NGS",
        "Droplet Digital PCR Method": "PCR & Sequencing",
        "RNP Electroporation into Primary T Cells": "Gene Editing",
        "DNA Transfection into Cells": "Cell Culture",
        "In Vitro Transcription of mRNA": "Molecular Cloning",
        "Preparation of Lysate from Cell Culture & Bradford": "Protein Purification",
        # The one that made first-match ordering matter: it is cloning, even
        # though the title ends in PCR.
        "Site-Directed Mutagenesis Using Blunt-End Ligation After PCR": "Molecular Cloning",
    }
    for title, want in cases.items():
        got = ip.classify(title, "")
        assert got == want, f"{title!r} -> {got}, wanted {want}"


def _the_body_decides_only_when_the_title_says_nothing():
    # A transfection worksheet that harvests into a FACS plate at the end is a
    # transfection worksheet, so the body goes by weight of mentions.
    body = "Day 2: Transfection. Dilute with transfection buffer. Day 5: harvest for FACS."
    assert ip.classify("96 well plate template", body) == "Cell Culture"
    assert ip.classify("Some Title", "") == "Other"


check("titles come from the filename", _titles_come_from_the_filename)
check("a file with no document code still gets a title", _a_name_with_no_code_is_still_a_title)
check("the effective date becomes a real date", _the_effective_date_becomes_a_real_date)
check("a date that makes no sense is left empty", _a_date_that_makes_no_sense_is_left_empty)
check("the title decides the category", _the_title_decides_the_category)
check("the body decides only when the title says nothing",
      _the_body_decides_only_when_the_title_says_nothing)


# ---------------------------------------------------------------------------
print("\nReading a page: subscripts, tables and wrapped prose")


def word(text, x0, size=11.0, top=100.0):
    """A word as pdfplumber hands one over."""
    return {"text": text, "x0": x0, "x1": x0 + len(text) * 6.0,
            "top": top, "bottom": top + size, "size": size}


def _subscripts_go_back_on_the_formula():
    # "3% H₂O₂" exactly as pdfplumber reports it out of one of these PDFs:
    # 11pt letters, 7pt digits dropped 4pt and touching the letter before.
    words = [
        {"text": "3%", "x0": 95.5, "x1": 108.9, "top": 366.6, "bottom": 377.6, "size": 11.0},
        {"text": "H", "x0": 111.3, "x1": 118.1, "top": 366.6, "bottom": 377.6, "size": 11.0},
        {"text": "2", "x0": 118.0, "x1": 121.6, "top": 370.6, "bottom": 377.6, "size": 7.0},
        {"text": "O", "x0": 121.5, "x1": 128.8, "top": 366.6, "bottom": 377.6, "size": 11.0},
        {"text": "2", "x0": 129.1, "x1": 132.6, "top": 370.6, "bottom": 377.6, "size": 7.0},
    ]
    assert ip._line_text(words) == "3% H2O2", ip._line_text(words)


def _a_subscript_letter_goes_back_too():
    words = [word("the", 80.0), word("T", 100.0),
             {"text": "m", "x0": 106.0, "x1": 110.0, "top": 104.0, "bottom": 111.0, "size": 7.0},
             word("of", 115.0)]
    assert ip._line_text(words) == "the Tm of", ip._line_text(words)


def _two_ordinary_words_are_not_welded_together():
    # Same sizes, touching: this must stay two words, or every protocol turns
    # into one long string.
    words = [word("add", 95.0), word("buffer", 113.0)]
    assert ip._line_text(words) == "add buffer"


def _a_trademark_rejoins_its_name():
    words = [word("jetOPTIMUS", 95.0),
             {"text": "TM", "x0": 155.0, "x1": 160.0, "top": 98.0, "bottom": 104.0, "size": 7.0},
             word("buffer", 162.0)]
    assert ip._line_text(words) == "jetOPTIMUS™ buffer", ip._line_text(words)


def _a_raised_character_joins_the_line_it_belongs_to():
    # The subscript's top is 4pt below the line's; grouping by the top alone
    # made it a line of its own, which is how "2 2" ended up under a table.
    words = [word("H", 100.0, top=100.0),
             {"text": "2", "x0": 106.0, "x1": 110.0, "top": 104.0, "bottom": 111.0, "size": 7.0}]
    lines = ip._group_lines(words)
    assert len(lines) == 1, lines
    assert lines[0][1] == "H2"


def _a_real_next_line_stays_a_next_line():
    words = [word("first", 100.0, top=100.0), word("second", 100.0, top=130.0)]
    lines = ip._group_lines(words)
    assert [t for _, t in lines] == ["first", "second"], lines


def _a_table_is_rendered_as_columns():
    out = ip._render_table([["Component", "Volume"], ["Buffer", "5"], ["Water", "38"]])
    assert out.splitlines()[0].startswith("Component")
    assert all("  " in line for line in out.splitlines()), out
    assert "Buffer" in out and "38" in out


def _a_cell_spanning_rows_is_not_lost():
    out = ip._cell("95°C\n55°C\n72°C")
    assert out == "95°C / 55°C / 72°C"


def _padding_is_capped():
    # A figure and its caption in a one-row table used to pad every other row
    # out to the caption's width, giving lines of hundreds of spaces.
    long = "x" * 400
    out = ip._render_table([[long, "a"], ["b", "c"]])
    assert max(len(line) for line in out.splitlines()) < len(long) + 60, "padding ran away"
    assert "b" in out and "c" in out


def _a_one_column_table_is_not_a_table():
    out = ip._render_table([["Figure 4. A gel."], ["Lane 1 is the ladder."]])
    assert out == "Figure 4. A gel.\nLane 1 is the ladder."


def _wrapped_prose_is_joined_but_numbered_items_are_not():
    out = ip.reflow("7.1. Order two oligos with\n22bp homology.\n7.2. Anneal them.\n")
    assert out == "7.1. Order two oligos with 22bp homology.\n7.2. Anneal them.", repr(out)


def _a_note_starts_its_own_line():
    out = ip.reflow("7.1. Do the thing.\nNote: use fresh buffer.\n")
    assert out.splitlines()[-1] == "Note: use fresh buffer.", repr(out)


check("subscripts go back on the formula", _subscripts_go_back_on_the_formula)
check("a subscript letter goes back too", _a_subscript_letter_goes_back_too)
check("two ordinary words are not welded together",
      _two_ordinary_words_are_not_welded_together)
check("a trademark mark rejoins its name", _a_trademark_rejoins_its_name)
check("a raised character joins the line it belongs to",
      _a_raised_character_joins_the_line_it_belongs_to)
check("a real next line stays a next line", _a_real_next_line_stays_a_next_line)
check("a table is rendered as columns", _a_table_is_rendered_as_columns)
check("a cell spanning rows keeps all its values", _a_cell_spanning_rows_is_not_lost)
check("padding is capped", _padding_is_capped)
check("a one-column table is not treated as one", _a_one_column_table_is_not_a_table)
check("wrapped prose is joined, numbered items are not",
      _wrapped_prose_is_joined_but_numbered_items_are_not)
check("a note starts its own line", _a_note_starts_its_own_line)


# ---------------------------------------------------------------------------
print("\nWhat is a protocol and what is not")


def _an_in_house_sop_is_read_in_full():
    assert ip.classify_file(pathlib.Path("SOP-MET-042 - Widget.pdf"), SOP) == "sop"


def _a_safety_data_sheet_is_not_a_protocol():
    assert ip.classify_file(pathlib.Path("Sodium azide MSDS.pdf"),
                            "SAFETY DATA SHEET\nCreation Date 03-Dec-2010") == "skip-sds"


def _an_sop_that_merely_cites_one_is_still_an_sop():
    # The Western Blot SOP cites a sodium azide MSDS in its related documents,
    # and was being thrown away as one.
    cites = SOP.replace("4.2. SOP-LAB-028 - NanoDrop Operating Procedure",
                        "4.2. Sodium Azide MSDS")
    assert ip.classify_file(pathlib.Path("SOP-MET-051 - Western Blot.pdf"), cites) == "sop"


def _a_suppliers_manual_is_kept_as_a_pointer():
    assert ip.classify_file(pathlib.Path("Vendor protocol.pdf"),
                            "www.example.com CPT117 vD (October 2020)") == "reference"
    rec, _ = with_scrub([], lambda: ip.build_reference(
        pathlib.Path("Vendor protocol.pdf"),
        "www.example.com/tool\nStep 1 of their method.", "A Scientist"))
    assert rec["kind"] == "reference"
    assert rec["steps"] == "", "a supplier's text is not copied"
    assert rec["link"] == "https://www.example.com/tool"
    assert "not copied" in rec["notes"]


def _an_appendix_is_read_as_a_worksheet():
    assert ip.classify_file(pathlib.Path("Appendix 9.1 - plate template.pdf"),
                            "Date:\nExp:\nDay 1: Seeding cells") == "appendix"


check("an in-house SOP is read in full", _an_in_house_sop_is_read_in_full)
check("a safety data sheet is not a protocol", _a_safety_data_sheet_is_not_a_protocol)
check("an SOP that merely cites one is still an SOP",
      _an_sop_that_merely_cites_one_is_still_an_sop)
check("a supplier's manual is kept as a pointer, not a copy",
      _a_suppliers_manual_is_kept_as_a_pointer)
check("an appendix is read as a worksheet", _an_appendix_is_read_as_a_worksheet)


# ---------------------------------------------------------------------------
print()
if failures:
    print(f"{passed} passed, {len(failures)} failed")
    for f in failures:
        print(f"  - {f}")
    sys.exit(1)
print(f"{passed} checks passed")
