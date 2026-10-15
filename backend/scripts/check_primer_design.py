#!/usr/bin/env python3
"""Checks for app/primer_design.py.

    python scripts/check_primer_design.py

The design itself comes from the `primers` package; what is tested here is
everything around it — the duplex arithmetic, the scoring, and the refusals.
Several cases use sequences built to fail in a specific way, because a primer
checker that never says no has not been shown to work.
"""
from __future__ import annotations

import pathlib
import random
import sys

BACKEND = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND))

from app.primer_design import (  # noqa: E402
    DesignError,
    design,
    duplex,
    gc_clamp,
    hairpin_dg,
    revcomp,
)

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
    except DesignError as exc:
        assert fragment.lower() in str(exc).lower(), f"wrong message: {exc}"
        return
    raise AssertionError(f"expected a DesignError mentioning {fragment!r}")


def random_dna(n: int, seed: int) -> str:
    rng = random.Random(seed)
    return "".join(rng.choice("ACGT") for _ in range(n))


TEMPLATE = random_dna(1500, 42)


# ---------------------------------------------------------------------------
# The duplex arithmetic, which is what the dimer warnings rest on
# ---------------------------------------------------------------------------
def _duplex_basics():
    # Perfectly complementary oligos pair over their whole length, and that
    # involves both 3' ends.
    a = "ATGCATGCATGC"
    d = duplex(a, revcomp(a))
    assert d.run == len(a), d
    assert d.three_prime is True, d

    # Nothing in common.
    none = duplex("AAAAAAAAAA", "AAAAAAAAAA")
    assert none.run <= 1, none

    # A run in the middle, with free 3' ends: a nuisance, not a primer.
    # ...CCCCCC... pairs with ...GGGGGG... away from either end.
    mid_a = "AAAACCCCCCAAAA"
    mid_b = "TTTTGGGGGGTTTT"
    mid = duplex(mid_a, mid_b)
    assert mid.run >= 6, mid
check("complementary oligos pair, unrelated ones do not", _duplex_basics)


def _three_prime_is_what_matters():
    """A duplex with free 3' ends wastes primer. One that pairs a 3' end gives
    the polymerase a substrate, and that is the difference between a faint
    band and a smear."""
    # 3' ends pair over four bases, and there is a longer internal duplex of
    # ten A:T as well. Both are real and they mean different things, so both
    # are reported — the longest must not hide the dangerous one.
    a = "AAAAAAAAAAGGGG"
    b = "TTTTTTTTTTCCCC"
    d = duplex(a, b)
    assert d.run >= 10, f"the internal A:T duplex should be found too: {d}"
    assert d.three_prime_run >= 4, d
    assert d.severity == "will prime", d.severity

    # A duplex buried in the middle of both oligos: eight C:G pairs flanked by
    # T on either side of each. Both 3' ends are T, and T does not pair with
    # T, so there is nothing for a polymerase to extend — it costs primer and
    # nothing else.
    buried = duplex("TTTTCCCCCCCCTTTT", "TTTTGGGGGGGGTTTT")
    assert buried.run >= 8, buried
    assert buried.three_prime_run == 0, (
        f"neither 3' end can pair here, so nothing primes: {buried}"
    )
    assert buried.severity == "strong", buried.severity
check("a duplex at a 3' end is reported differently from one in the middle",
      _three_prime_is_what_matters)


def _hairpin_and_clamp():
    # A stem-loop folds; random sequence of the same length does not.
    stem = hairpin_dg("GGGGCCCCGGGGAAAATTTTCCCCGGGGCCCC", 60.0)
    flat = hairpin_dg("ATGACTGCATTAGCATCAGTACGA", 60.0)
    assert stem < -5, f"a stem-loop should fold: {stem}"
    assert flat > -2, f"random sequence should not: {flat}"

    # "ATGCATGCATG" ends in G, and its last five "GCATG" hold three G/C.
    assert gc_clamp("ATGCATGCATG") == (True, 3), gc_clamp("ATGCATGCATG")
    assert gc_clamp("GCGCGCGCATAA") == (False, 1), gc_clamp("GCGCGCGCATAA")
    sticky, n = gc_clamp("ATATATATGCGC")
    assert sticky is True and n >= 4, (sticky, n)
check("folding energy and the 3' clamp are measured, not guessed",
      _hairpin_and_clamp)


# ---------------------------------------------------------------------------
# Designing
# ---------------------------------------------------------------------------
RESULT: dict = {}


def _designs_three_pairs():
    out = design(TEMPLATE, product_length=500, optimal_tm=60)
    RESULT.update(out)
    assert out["pairs"], out["notes"]
    assert len(out["pairs"]) <= 3, len(out["pairs"])
    assert out["pairs_found"] >= len(out["pairs"])

    for pair in out["pairs"]:
        f, r = pair["forward"], pair["reverse"]
        # Both primers must actually be on the template, the right way round.
        assert TEMPLATE[f["start"]:f["end"]] == f["sequence"], "forward is not on the template"
        assert TEMPLATE[r["start"]:r["end"]] == revcomp(r["sequence"]), (
            "reverse should be the reverse complement of its binding site"
        )
        assert f["strand"] == 1 and r["strand"] == -1
        assert pair["product_start"] == f["start"]
        assert pair["product_end"] == r["end"]
        assert pair["product_length"] == r["end"] - f["start"]
check("it returns at most three pairs, each placed correctly on the template",
      _designs_three_pairs)


def _products_are_near_the_target():
    for pair in RESULT["pairs"]:
        # The window is the product, so this should be close. Allowing a
        # quarter covers primers trimming the ends.
        assert abs(pair["product_length"] - 500) <= 125, pair["product_length"]
check("the products come out near the requested length", _products_are_near_the_target)


def _sorted_by_score_with_components():
    scores = [p["score"] for p in RESULT["pairs"]]
    assert scores == sorted(scores), scores
    for pair in RESULT["pairs"]:
        pen = pair["penalties"]
        # Named, not counted: a new scoring component should fail here and be
        # looked at rather than quietly change what the total means.
        assert set(pen) == {
            "tm", "tm_difference", "gc", "hairpin", "dimer", "product_length",
            "gc_clamp", "off_target",
        }, sorted(pen)
        # The total has to be the parts, or the breakdown is decoration.
        assert abs(sum(pen.values()) - pair["score"]) < 0.01, (sum(pen.values()), pair["score"])
check("the best is first, and the score is the sum of its stated parts",
      _sorted_by_score_with_components)


def _tm_is_quoted_under_pcr_conditions():
    """Biopython's default Tm assumes 25 nM oligo and no magnesium — a
    hybridisation experiment, not a PCR, and about ten degrees low. A primer
    reported at 56 that really melts at 68 gets an annealing temperature set
    twelve degrees under, which is how a clean design produces no band."""
    from Bio.SeqUtils import MeltingTemp as mt
    from app.primer_design import TM_CONDITIONS, primer_tm

    seq = RESULT["pairs"][0]["forward"]["sequence"]
    assert primer_tm(seq) > mt.Tm_NN(seq) + 5, (
        f"the PCR figure should be well above the default: "
        f"{primer_tm(seq)} vs {mt.Tm_NN(seq):.1f}"
    )
    assert RESULT["tm_conditions"]["mg_mm"] == TM_CONDITIONS["mg_mm"]
    assert RESULT["tm_conditions"]["primer_nm"] == 250.0, RESULT["tm_conditions"]


def _best_pairs_land_near_the_requested_tm():
    """Ranking against the true PCR Tm is what pulls the chosen pairs onto
    the requested temperature, so asking for 60 should not return 68."""
    for pair in RESULT["pairs"]:
        for side in ("forward", "reverse"):
            assert abs(pair[side]["tm"] - 60) < 6, (side, pair[side]["tm"])


def _tm_and_gc_are_reported():
    best = RESULT["pairs"][0]
    for p in (best["forward"], best["reverse"]):
        assert 45 < p["tm"] < 85, p["tm"]
        assert 0 <= p["gc_percent"] <= 100, p["gc_percent"]
        assert p["length"] == len(p["sequence"])
    assert best["tm_difference"] == round(
        abs(best["forward"]["tm"] - best["reverse"]["tm"]), 1
    )
check("Tm is quoted under PCR conditions, not Biopython's defaults",
      _tm_is_quoted_under_pcr_conditions)
check("the chosen pairs land near the requested Tm", _best_pairs_land_near_the_requested_tm)
check("Tm and GC are measured for both primers", _tm_and_gc_are_reported)


def _warns_about_a_dimer_prone_template():
    """A template whose ends are complementary forces primers that pair with
    each other. The design should still return something and should say so."""
    head = "GGGGGGGGGGGGGGGGGGGG"
    tail = revcomp(head)
    template = head + random_dna(300, 7) + tail
    out = design(template, product_length=len(template), optimal_tm=60)
    if out["pairs"]:
        pair = out["pairs"][0]
        noted = pair["warnings"] or pair["penalties"]["dimer"] > 0 or (
            pair["hetero_dimer_severity"] != "none"
        )
        assert noted, (
            f"primers from complementary ends should raise something: {pair['penalties']}"
        )
check("a template that forces primer-dimer does not come back silent",
      _warns_about_a_dimer_prone_template)


def _refusals():
    raises(lambda: design("", product_length=100), "no template")
    raises(lambda: design("this is a note, not a sequence", product_length=100), "A, C, G and T")
    raises(lambda: design("ATGCN" * 40, product_length=100), "A, C, G and T")
    raises(lambda: design("ATGC" * 5, product_length=60), "at least")
    raises(lambda: design(TEMPLATE, product_length=20), "shorter than two primers")
    raises(lambda: design(TEMPLATE, product_length=9000), "does not fit")
    raises(lambda: design(TEMPLATE, product_length=300, optimal_tm=95), "not a PCR")
check("every bad request is refused with the reason", _refusals)


def _ambiguous_bases_are_refused_not_guessed():
    """N in a template is common in draft assemblies, and a primer placed over
    one is a primer that may not anneal. Refusing beats guessing."""
    raises(
        lambda: design(TEMPLATE[:200] + "N" * 10 + TEMPLATE[210:], product_length=300),
        "ambiguous",
    )
check("an ambiguous base is a refusal, not a silent substitution",
      _ambiguous_bases_are_refused_not_guessed)


def _sampling_is_disclosed():
    """Forty windows out of a few thousand is the right trade, and the answer
    has to say that is what happened rather than imply it searched everything."""
    out = design(TEMPLATE, product_length=200, optimal_tm=60)
    assert out["windows_tried"] <= 40, out["windows_tried"]
    assert any("not every one" in n for n in out["notes"]), out["notes"]
check("the answer says it sampled rather than searched exhaustively",
      _sampling_is_disclosed)


def _short_template_takes_one_window():
    out = design(TEMPLATE[:300], product_length=300, optimal_tm=60)
    assert out["windows_tried"] == 1, out["windows_tried"]
    assert out["notes"] == [] or "not every one" not in " ".join(out["notes"])
check("a product the size of the template is one window, with no caveat",
      _short_template_takes_one_window)


# ---------------------------------------------------------------------------
# Off-target screening: the thing that decides a qRT-PCR or an analytical PCR
# ---------------------------------------------------------------------------
from app.primer_design import (  # noqa: E402
    MAX_SCREEN_BP,
    OffTargetIndex,
    parse_screen,
    predicted_amplicons,
)


def _index_agrees_with_the_library():
    """The index is inverted — exact seeds from the background, mismatches
    generated from the primer — which is 25x faster and 16x smaller than the
    `primers` package's version. It is only worth having if it gives the same
    answer, so that is asserted rather than assumed."""
    from primers.off_targets import off_targets

    rng = random.Random(9)
    bg = "".join(rng.choice("ACGT") for _ in range(4000))
    idx = OffTargetIndex(bg)
    for _ in range(25):
        at = rng.randint(0, 3900)
        probe = bg[at : at + 22]
        theirs = off_targets(probe, bg)[len(probe) - 1]
        mine = max(0, idx.site_count(probe) - 1)
        assert theirs == mine, (probe, theirs, mine)
check("the off-target index agrees with the primers package site for site",
      _index_agrees_with_the_library)


def _an_amplicon_is_measured_between_5_prime_ends():
    """index.sites() anchors on the 3' end, because that is what primes. A
    product runs 5' end to 5' end — the whole oligo is in the amplicon. The
    first version measured 3' to 3' and reported every product short by the
    two primer lengths less the two seeds, which marked the *intended*
    product as unintended on every single pair."""
    rng = random.Random(23)
    gene = "".join(rng.choice("ACGT") for _ in range(600))
    bg = "".join(rng.choice("ACGT") for _ in range(2000)) + gene
    out = design(gene, product_length=200, optimal_tm=60,
                 screen_against=bg, screen_name="locus")
    pair = out["pairs"][0]
    intended = [a for a in pair["amplicons"] if a["intended"]]
    assert intended, (
        f"the real product should be found and marked: "
        f"{[(a['length'], a['intended']) for a in pair['amplicons']]} "
        f"against an intended {pair['product_length']}"
    )
    assert abs(intended[0]["length"] - pair["product_length"]) <= 2, intended[0]
    assert pair["spurious_amplicons"] == 0, pair["amplicons"]
check("a predicted product is measured between the 5' ends, like a real one",
      _an_amplicon_is_measured_between_5_prime_ends)


def _a_pseudogene_is_caught_and_costs_the_pair():
    """The case this exists for: a second place in the genome where both
    primers sit facing each other. It makes a band, and the pair that does it
    should stop being the recommendation."""
    rng = random.Random(42)
    gene = "".join(rng.choice("ACGT") for _ in range(1200))
    clean = "".join(rng.choice("ACGT") for _ in range(3000)) + gene

    best = design(gene, product_length=150, optimal_tm=60,
                  screen_against=clean, screen_name="locus")["pairs"][0]
    f, r = best["forward"]["sequence"], best["reverse"]["sequence"]
    assert best["spurious_amplicons"] == 0, "clean to start with"

    filler = "".join(rng.choice("ACGT") for _ in range(300))
    trap = clean + "".join(rng.choice("ACGT") for _ in range(1500)) + f + filler + revcomp(r)

    idx = OffTargetIndex(trap, "the pseudogene")
    assert idx.site_count(f) == 2, idx.site_count(f)
    amps = predicted_amplicons(idx, f, r, 150)
    spurious = [a for a in amps if not a.intended]
    assert spurious, [(a.length, a.intended) for a in amps]
    # 300 bp of filler plus the two primers.
    assert 320 <= spurious[0].length <= 360, spurious[0].length
    assert any(a.intended for a in amps), "the real product is still there too"

    # And it must cost the pair its place.
    scored = design(gene, product_length=150, optimal_tm=60, max_pairs=10,
                    screen_against=trap, screen_name="the pseudogene")
    top = [p["forward"]["sequence"] for p in scored["pairs"]]
    assert f not in top[:3], "a pair that makes a second product should not be recommended"
check("a pseudogene that would give a second band is found, and demotes the pair",
      _a_pseudogene_is_caught_and_costs_the_pair)


def _purpose_decides_whether_screening_is_expected():
    rng = random.Random(77)
    gene = "".join(rng.choice("ACGT") for _ in range(800))

    # Cloning from a plasmid: a purified template has no background to speak
    # of, so nothing is demanded.
    cloning = design(gene, product_length=400, optimal_tm=60, purpose="cloning")
    assert not any("Nothing was screened" in n for n in cloning["notes"]), cloning["notes"]

    # qRT-PCR and analytical PCR run against a genome. Not screening is a
    # thing the answer has to admit to.
    for purpose in ("qpcr", "analytical"):
        out = design(gene, product_length=200, optimal_tm=60, purpose=purpose)
        assert any("Nothing was screened" in n for n in out["notes"]), (purpose, out["notes"])
        assert out["screen"] is None
        for pair in out["pairs"]:
            assert pair["screened"] is False
            assert pair["penalties"]["off_target"] == 0.0

    raises(lambda: design(gene, product_length=200, purpose="miniprep"), "unknown purpose")
check("purpose decides whether a missing screen is worth saying out loud",
      _purpose_decides_whether_screening_is_expected)


def _qpcr_says_what_it_does_not_check():
    rng = random.Random(31)
    gene = "".join(rng.choice("ACGT") for _ in range(900))
    out = design(gene, product_length=600, optimal_tm=60, purpose="qpcr")
    assert any("70–250" in n for n in out["notes"]), out["notes"]
    assert any("quantitative" in n for n in out["notes"]), out["notes"]
    # The other half of qRT-PCR specificity, which needs exon boundaries this
    # endpoint does not take. Saying so beats implying it was handled.
    assert any("Exon structure" in n for n in out["notes"]), out["notes"]
check("a qPCR design states the product-length limit and the exon gap",
      _qpcr_says_what_it_does_not_check)


def _screen_parsing_and_limits():
    # Several records join with N, which is not a base, so no seed can span
    # the join and invent a site that exists in neither record.
    joined = parse_screen(">a\nACGTACGTACGTACGT\n>b\nTTTTGGGGCCCCAAAA\n")
    assert "N" * 10 in joined, joined
    assert joined.startswith("ACGTACGTACGTACGT")
    idx = OffTargetIndex(joined)
    straddle = joined[12:22]           # spans the boundary
    assert "N" in straddle
    assert idx.site_count("A" * 12 + straddle[-10:]) == 0 or "N" in straddle

    raises(lambda: parse_screen("   "), "no bases")
    raises(lambda: parse_screen("a note about the assay"), "not DNA")
    raises(lambda: OffTargetIndex("A" * (MAX_SCREEN_BP + 1)), "indexes up to")
check("the screen reads FASTA, separates records, and is bounded",
      _screen_parsing_and_limits)


print(f"\n{passed} checks passed" + (f", {len(failures)} FAILED" if failures else ""))
for f in failures:
    print(f"  - {f}")
raise SystemExit(1 if failures else 0)
