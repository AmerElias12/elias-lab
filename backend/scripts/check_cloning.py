#!/usr/bin/env python3
"""Checks for app/cloning.py — the digest, the ligation, and the biology.

    python scripts/check_cloning.py

No database and no HTTP: this is the science on its own. The cases are the
ones that go wrong at the bench rather than in the code — an enzyme that does
not cut, a single-enzyme cloning that goes in backwards, a junction that
cannot be cut back out.

The last check runs the same digest through js/plasmid.js and compares. The
two implementations exist for different jobs (the browser draws a map, this
decides what to order) and they must still agree about where an enzyme cuts.
"""
from __future__ import annotations

import json
import pathlib
import subprocess
import sys

BACKEND = pathlib.Path(__file__).resolve().parent.parent
REPO = BACKEND.parent
sys.path.insert(0, str(BACKEND))

from app.cloning import (  # noqa: E402
    CloningError,
    digest_and_ligate,
    parse_record,
    resolve_enzymes,
)


def genbank(seq: str, name: str, *, circular: bool, features=()) -> str:
    """A GenBank string written by Biopython rather than by hand.

    The LOCUS line is column-sensitive, and a hand-written one that happens to
    parse still makes Biopython warn that it is malformed. A fixture a standard
    parser calls malformed is not testing what it claims to.
    """
    import io as _io

    from Bio.Seq import Seq
    from Bio.SeqRecord import SeqRecord
    from Bio.SeqFeature import SeqFeature, FeatureLocation
    from Bio import SeqIO as _SeqIO

    record = SeqRecord(Seq(seq), id=name, name=name, description=f"{name} test construct")
    record.annotations["molecule_type"] = "DNA"
    record.annotations["topology"] = "circular" if circular else "linear"
    for start, end, label, kind in features:
        record.features.append(
            SeqFeature(FeatureLocation(start, end), type=kind, qualifiers={"label": [label]})
        )
    handle = _io.StringIO()
    _SeqIO.write(record, handle, "genbank")
    return handle.getvalue()

# A Biopython parser warning means the fixture is not the format it claims to
# be. Promoting them to errors is what stopped this file testing against
# GenBank that a standard parser considers malformed.
import warnings  # noqa: E402

from Bio import BiopythonParserWarning  # noqa: E402

warnings.simplefilter("error", BiopythonParserWarning)

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
        failures.append(f"{what}: {type(exc).__name__}: {exc}")
        print(f"  FAIL  {what}\n          {type(exc).__name__}: {exc}")
        return
    passed += 1
    print(f"  ok    {what}")


def raises(fn, fragment: str) -> None:
    try:
        fn()
    except CloningError as exc:
        assert fragment.lower() in str(exc).lower(), f"wrong message: {exc}"
        return
    raise AssertionError(f"expected a CloningError mentioning {fragment!r}")


# ---------------------------------------------------------------------------
# Two constructs designed so the cloning is unambiguous.
#
# VECTOR: a circular backbone with an EcoRI site and a BamHI site flanking a
# short stuffer. INSERT: a circular donor with the same two sites around a
# different payload. Cut both, and the vector backbone takes the insert in
# exactly one orientation — which is what cutting with two enzymes buys.
# ---------------------------------------------------------------------------
ECORI, BAMHI = "GAATTC", "GGATCC"

VECTOR = (
    "ATGCATGCATGCATGCATGCATGCATGCATGCATGCATGC"          # backbone 1
    + ECORI
    + "TTTTTTTTTTTTTTTTTTTT"                            # stuffer
    + BAMHI
    + "CGCGCGCGCGCGCGCGCGCGCGCGCGCGCGCGCGCGCGCG"        # backbone 2
)
INSERT = (
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
    + ECORI
    + "ACGTACGTACGTACGTACGTACGTACGTACGTACGTACGT"        # the payload
    + BAMHI
    + "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCC"
)
PAYLOAD = "ACGTACGTACGTACGTACGTACGTACGTACGTACGTACGT"


def _parsing():
    fasta = ">pTest a description\n" + VECTOR[:60] + "\n" + VECTOR[60:] + "\n"
    r = parse_record(fasta)
    assert str(r.seq).upper() == VECTOR, "FASTA round trip"
    assert r.circular, "a pasted plasmid is circular unless the file says otherwise"

    g = parse_record(genbank(VECTOR[:40], "pLin", circular=False,
                             features=[(0, 20, "thing", "CDS")]))
    assert not g.circular, "GenBank said linear, and that changes the digest"
    assert len(g.features) == 1 and g.features[0].qualifiers["label"] == ["thing"]

    raw = parse_record("  1 atgcatgc atgcatgc\n 17 atgcatgc")
    assert str(raw.seq).upper() == "ATGCATGCATGCATGCATGCATGC"
check("GenBank, FASTA and pasted bases all read, topology included", _parsing)


def _parsing_refuses():
    raises(lambda: parse_record("this is a note about cloning, not a sequence"), "not a DNA")
    raises(lambda: parse_record(""), "no sequence")
    raises(
        lambda: parse_record(">one\nACGTACGTACGT\n>two\nTTTTTTTTTTTT\n"),
        "one sequence per field",
    )
check("prose, nothing, and a multi-record file are each refused by name",
      _parsing_refuses)


def _enzyme_names():
    batch = resolve_enzymes(["EcoRI", "BamHI"])
    assert {str(e) for e in batch} == {"EcoRI", "BamHI"}
    raises(lambda: resolve_enzymes(["EcoR1"]), "unknown enzyme")
    # REBASE spelling is particular, and a near miss should say so rather than
    # read as "no such enzyme".
    raises(lambda: resolve_enzymes(["ecori"]), "did you mean 'EcoRI'")
    raises(lambda: resolve_enzymes([]), "at least one enzyme")
check("enzymes resolve against REBASE, and a near miss is corrected", _enzyme_names)


def _does_not_cut():
    raises(
        lambda: digest_and_ligate("ATGC" * 40, "ATGC" * 40, ["EcoRI"]),
        "nothing to ligate",
    )
check("an enzyme that does not cut is named, not returned as an empty result",
      _does_not_cut)


RESULT: dict = {}


def _directional_cloning():
    out = digest_and_ligate(VECTOR, INSERT, ["EcoRI", "BamHI"],
                            name_a="vector", name_b="insert")
    RESULT.update(out)
    assert out["enzymes"] == ["BamHI", "EcoRI"], out["enzymes"]
    assert len(out["inputs"]["a"]["fragments"]) == 2, out["inputs"]["a"]
    assert len(out["inputs"]["b"]["fragments"]) == 2, out["inputs"]["b"]

    constructs = out["constructs"]
    assert constructs, "two enzymes and matching ends should give a product"
    # Cutting with two different enzymes leaves ends that fit one way only.
    orientations = {
        tuple(p["orientation"] for p in c["parts"]) for c in constructs
    }
    assert all(o[0] == "forward" for o in orientations), orientations

    wanted = next(
        (c for c in constructs if PAYLOAD in c["sequence"] and len(c["sequence"]) < 150),
        None,
    )
    assert wanted is not None, [c["length_bp"] for c in constructs]
    assert wanted["topology"] == "circular"
    assert PAYLOAD in wanted["sequence"], "the payload should be in the product"
check("two enzymes give a circular product carrying the insert", _directional_cloning)


def _junctions_report_whether_the_site_survives():
    wanted = next(c for c in RESULT["constructs"] if PAYLOAD in c["sequence"])
    by = {j["enzyme"]: j for j in wanted["junctions"]}
    # EcoRI joined to EcoRI rebuilds GAATTC, so the insert can be cut back out.
    assert by["EcoRI"]["regenerated"] is True, by["EcoRI"]
    assert by["BamHI"]["regenerated"] is True, by["BamHI"]
    assert by["EcoRI"]["sites_in_product"] >= 1
check("a junction says whether its site came back", _junctions_report_whether_the_site_survives)


def _single_enzyme_is_not_directional():
    """One enzyme leaves identical ends, so the insert goes in either way
    round. Both products are real, and a tool that showed one would be lying
    about which clone comes out of the ligation."""
    out = digest_and_ligate(VECTOR, INSERT, ["EcoRI"])
    assert out["constructs"], out["notes"]
    orientations = {
        tuple(p["orientation"] for p in c["parts"]) for c in out["constructs"]
    }
    assert ("forward", "forward") in orientations, orientations
    assert ("forward", "reverse") in orientations, (
        "with one enzyme the insert can go in backwards, and that has to be shown"
    )
check("one enzyme gives both orientations, because the ligation does",
      _single_enzyme_is_not_directional)


def _compatible_but_not_regenerating():
    """BamHI and BglII both leave GATC. Their ends ligate; the junction is
    neither site afterwards. Usually the point, occasionally a surprise when
    somebody later tries to excise the insert."""
    bgl = "AGATCT"
    vec = "ATGC" * 10 + ECORI + "TTTT" * 5 + BAMHI + "CGCG" * 10
    ins = "AAAA" * 8 + ECORI + PAYLOAD + bgl + "CCCC" * 8
    out = digest_and_ligate(vec, ins, ["EcoRI", "BamHI", "BglII"])
    joined = [c for c in out["constructs"] if PAYLOAD in c["sequence"]]
    assert joined, out["notes"]
    by = {j["enzyme"]: j for j in joined[0]["junctions"]}
    assert by["EcoRI"]["regenerated"] is True, "the EcoRI end was joined to an EcoRI end"
    assert by["BamHI"]["regenerated"] is False, (
        "a BamHI end joined to a BglII end rebuilds neither site"
    )
    assert by["BglII"]["regenerated"] is False, by["BglII"]
check("BamHI and BglII ends join, and neither site survives it",
      _compatible_but_not_regenerating)


def _incompatible_ends_give_nothing():
    """HindIII leaves AGCT, EcoRI leaves AATT. Nothing joins, and the answer
    should say so rather than return an empty list with no explanation."""
    vec = "ATGC" * 10 + ECORI + "TTTT" * 5 + ECORI + "CGCG" * 10
    ins = "AAAA" * 8 + "AAGCTT" + PAYLOAD + "AAGCTT" + "CCCC" * 8
    out = digest_and_ligate(vec, ins, ["EcoRI", "HindIII"])
    assert out["constructs"] == [], [c["length_bp"] for c in out["constructs"]]
    assert out["notes"], "a result with nothing in it has to explain itself"
check("ends that cannot join produce no product, and a note saying why",
      _incompatible_ends_give_nothing)


def _blunt_ends_are_promiscuous():
    """SmaI leaves blunt ends, which join to any other blunt end. The products
    are all real; most are unwanted, and the answer says so."""
    vec = "ATGC" * 10 + "CCCGGG" + "TTTT" * 5 + "CCCGGG" + "CGCG" * 10
    ins = "AAAA" * 8 + "CCCGGG" + PAYLOAD + "CCCGGG" + "GGTT" * 8
    out = digest_and_ligate(vec, ins, ["SmaI"])
    assert out["constructs"], out["notes"]
    assert any("blunt" in n for n in out["notes"]), out["notes"]
check("a blunt digest warns that the ligation gives a mixture",
      _blunt_ends_are_promiscuous)


def _features_ride_along():
    start = INSERT.index(PAYLOAD)
    gb = genbank(INSERT, "pFeat", circular=True,
                 features=[(start, start + len(PAYLOAD), "payload", "CDS")])
    out = digest_and_ligate(VECTOR, gb, ["EcoRI", "BamHI"])
    wanted = next(c for c in out["constructs"] if PAYLOAD in c["sequence"])
    names = [f["name"] for f in wanted["features"]]
    assert "payload" in names, (
        f"the insert's annotation should survive into the construct; got {names}"
    )
    # And it should still point at the payload after the coordinate shift.
    f = next(f for f in wanted["features"] if f["name"] == "payload")
    assert wanted["sequence"][f["start"]:f["end"]] == PAYLOAD, (
        f"the feature moved: {wanted['sequence'][f['start']:f['end']][:20]}…"
    )
check("an annotation on the insert arrives on the construct, still in place",
      _features_ride_along)


def _one_product_reported_once():
    """The same circle can be built starting from either fragment. Reporting
    it twice would make a clean two-enzyme cloning look ambiguous."""
    out = digest_and_ligate(VECTOR, INSERT, ["EcoRI", "BamHI"])
    seqs = [c["sequence"] for c in out["constructs"]]
    assert len(seqs) == len(set(seqs)), "the same sequence came back more than once"
    rotations = {min((s + s)[i:i + len(s)] for i in range(len(s))) for s in seqs}
    assert len(rotations) == len(seqs), "the same circle came back in two rotations"
check("each distinct product is reported once", _one_product_reported_once)


# ---------------------------------------------------------------------------
# The two implementations have to agree
# ---------------------------------------------------------------------------
def _agrees_with_the_browser():
    """js/plasmid.js digests for the map; this digests for what gets ordered.
    They are allowed to know different numbers of enzymes. They are not
    allowed to disagree about where one of them cuts.
    """
    script = """
const P = require(process.argv[1]);
const seq = process.argv[2], enzymes = process.argv.slice(3);
const out = P.digest({ seq: seq, topology: 'circular', features: [] }, enzymes);
console.log(JSON.stringify(out.fragments.map(f => f.len).sort((a, b) => a - b)));
"""
    proc = subprocess.run(
        ["node", "-e", script, str(REPO / "js" / "plasmid.js"), VECTOR, "EcoRI", "BamHI"],
        capture_output=True, text=True, timeout=60,
    )
    assert proc.returncode == 0, f"the browser digest failed: {proc.stderr[:300]}"
    js_lengths = json.loads(proc.stdout)

    out = digest_and_ligate(VECTOR, VECTOR, ["EcoRI", "BamHI"], circular_only=False)
    py_lengths = sorted(f["length_bp"] for f in out["inputs"]["a"]["fragments"])

    # pydna counts the single-stranded overhang on both ends of a fragment;
    # js/plasmid.js measures the top strand between cut points. The difference
    # is a constant 4 per end for a 4-base overhang, so compare the totals and
    # the piece count rather than the raw numbers.
    assert len(js_lengths) == len(py_lengths), (
        f"different number of fragments: js {js_lengths} vs python {py_lengths}"
    )
    assert sum(js_lengths) == len(VECTOR), f"js fragments do not re-form the plasmid: {js_lengths}"
    for a, b in zip(js_lengths, py_lengths):
        assert abs(a - b) <= 8, (
            f"a fragment differs by more than the overhangs explain: js {a} vs python {b}"
        )
check("the browser digest and this one find the same cuts",
      _agrees_with_the_browser)


print(f"\n{passed} checks passed" + (f", {len(failures)} FAILED" if failures else ""))
for f in failures:
    print(f"  - {f}")
raise SystemExit(1 if failures else 0)
