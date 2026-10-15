"""Primer design: pick candidate amplicons, design into each, rank what comes back.

Built on `primers` (which uses seqfold for folding energy) and Biopython for
Tm and GC. Neither of those decides which pair is best, and that is most of
what this module is: choosing where to try, checking the things that make a
PCR fail, and scoring.

How a target product length is honoured
---------------------------------------
primers.create() designs a pair that amplifies exactly the sequence handed to
it — it has no notion of "find me a 500 bp product somewhere in this 3 kb
template". So the template is cut into candidate windows of about the
requested length, a pair is designed into each, and the results are ranked.
That is the whole trick, and it is why the answer is a *list*: several windows
give usable primers and they differ in ways worth seeing.

The windows are sampled rather than exhaustive. A 3 kb template with a 500 bp
target has 2,500 possible start positions and designing into all of them would
take twenty seconds to tell somebody what the best forty already said. The
number is capped, the sampling is even, and the response says how many were
tried so the answer is not mistaken for a guarantee of the global optimum.

What is checked beyond Tm and GC
--------------------------------
`primers` reports a folding energy per primer, which covers a primer tying
itself in a knot. It does not check the two primers against *each other*, and
primer-dimer between the forward and reverse is the classic way a PCR turns
into a smear at the bottom of the gel. So heterodimer and self-dimer are
checked here, with the 3' ends weighted heavily: a duplex that leaves a free
3' end is a nuisance, a duplex that pairs the 3' ends is a substrate, and the
polymerase will happily extend it in preference to the template.
"""
from __future__ import annotations

import re
from dataclasses import asdict, dataclass, field
from typing import Any

import seqfold
from Bio.SeqUtils import MeltingTemp as mt
from Bio.SeqUtils import gc_fraction
from primers import create as design_pair

#: Designing into every possible window is slower than it is useful. Forty
#: evenly spaced attempts across a template find the good regions; the rest is
#: arithmetic nobody reads.
MAX_WINDOWS = 40

#: Tm is quoted under conditions a PCR actually runs at. Biopython's defaults
#: assume 25 nM oligo, 50 mM Na+ and no magnesium, which is a hybridisation
#: experiment, not a PCR — and the difference is 9–12 °C, enough to set an
#: annealing temperature a full ten degrees too low. These are the usual
#: numbers for a standard reaction, and they are reported with every result so
#: the figure can be read rather than guessed at.
TM_CONDITIONS = {
    "na_mm": 50.0,
    "mg_mm": 1.5,
    "dntps_mm": 0.2,
    "primer_nm": 250.0,
    "salt_correction": "Owczarzy 2008",
}

MIN_TEMPLATE_BP = 60
MAX_TEMPLATE_BP = 50_000
MIN_PRODUCT_BP = 50

IUPAC_DNA = re.compile(r"^[ACGT]+$")
_COMPLEMENT = str.maketrans("ACGT", "TGCA")


class DesignError(ValueError):
    """Something about the request cannot work, phrased for the caller."""


def revcomp(seq: str) -> str:
    return seq.translate(_COMPLEMENT)[::-1]


# ---------------------------------------------------------------------------
# The checks that decide whether a PCR works
# ---------------------------------------------------------------------------
@dataclass(slots=True)
class Duplex:
    """The complementary stretches between two oligos, counted two ways.

    Both numbers are kept because the longest duplex is not the dangerous one.
    A long internal duplex sequesters primer — it costs yield. A short duplex
    that pairs a 3' end is a substrate: the polymerase extends it in
    preference to the template, and that is where a smear at the bottom of the
    gel comes from.

    Reporting only the longest hides the second behind the first. Two oligos
    ending ...GGGG and ...CCCC on a poly-A/poly-T backbone pair over ten bases
    internally and four at the 3' ends, and it is the four that ruin the PCR.
    """

    run: int               #: longest run anywhere
    three_prime_run: int   #: longest run that reaches a 3' end of either oligo

    @property
    def three_prime(self) -> bool:
        return self.three_prime_run >= 3

    @property
    def severity(self) -> str:
        if self.three_prime_run >= 4:
            return "will prime"
        if self.run >= 7:
            return "strong"
        if self.run >= 5:
            return "moderate"
        return "none"


def duplex(a: str, b: str) -> Duplex:
    """Longest runs of consecutive base pairs between two oligos.

    The two anneal antiparallel, so `a` is compared against the reverse
    complement of `b`: a match there is a base pair. Every offset is tried —
    a dimer does not care that it is out of register.
    """
    bc = revcomp(b)
    best = 0
    best_3p = 0

    for offset in range(-(len(bc) - 1), len(a)):
        run = 0
        run_3p = False
        for i in range(max(0, offset), min(len(a), offset + len(bc))):
            j = i - offset
            if a[i] == bc[j]:
                run += 1
                # a's 3' end is its last base; b's 3' end is the first base of
                # its reverse complement. A run touching either can extend.
                if i == len(a) - 1 or j == 0:
                    run_3p = True
                best = max(best, run)
                if run_3p:
                    best_3p = max(best_3p, run)
            else:
                run, run_3p = 0, False
    return Duplex(run=best, three_prime_run=best_3p)


def hairpin_dg(seq: str, temp_c: float) -> float:
    """Folding energy of the oligo on its own, in kcal/mol.

    Negative means it folds. Around −2 is noise; past about −4 a primer spends
    its time annealed to itself at the annealing temperature instead of to the
    template.
    """
    try:
        return round(float(seqfold.dg(seq, temp=temp_c)), 2)
    except Exception:  # noqa: BLE001 — seqfold raises on odd inputs
        return 0.0


def primer_tm(seq: str) -> float:
    """Melting temperature under the conditions in TM_CONDITIONS.

    Nearest-neighbour, with the magnesium correction — leaving Mg out is what
    makes the default number ten degrees low, and ten degrees is the
    difference between a clean band and nothing.
    """
    return round(
        float(
            mt.Tm_NN(
                seq,
                Na=TM_CONDITIONS["na_mm"],
                Mg=TM_CONDITIONS["mg_mm"],
                dNTPs=TM_CONDITIONS["dntps_mm"],
                dnac1=TM_CONDITIONS["primer_nm"],
                dnac2=0,          # the template is in vast excess
                saltcorr=7,       # Owczarzy 2008, the one that handles Mg
            )
        ),
        1,
    )


def gc_clamp(seq: str) -> tuple[bool, int]:
    """A G or C at the 3' end helps the last base stay put; four or five of
    them in the last five make the 3' end stick where it should not. Both are
    worth knowing, so both come back."""
    if not seq:
        return False, 0
    tail = seq[-5:]
    return seq[-1] in "GC", sum(1 for b in tail if b in "GC")


# ---------------------------------------------------------------------------
# Results
# ---------------------------------------------------------------------------
@dataclass(slots=True)
class PrimerResult:
    sequence: str
    length: int
    tm: float
    gc_percent: float
    start: int
    end: int
    strand: int
    hairpin_dg: float
    self_dimer_run: int
    self_dimer_3prime_run: int
    gc_clamp: bool
    gc_in_last_five: int


@dataclass(slots=True)
class PairResult:
    forward: PrimerResult
    reverse: PrimerResult
    product_start: int
    product_end: int
    product_length: int
    tm_difference: float
    hetero_dimer_run: int
    hetero_dimer_3prime_run: int
    hetero_dimer_severity: str
    score: float
    penalties: dict[str, float]
    warnings: list[str] = field(default_factory=list)

    def payload(self) -> dict[str, Any]:
        out = asdict(self)
        out["forward"] = asdict(self.forward)
        out["reverse"] = asdict(self.reverse)
        return out


# ---------------------------------------------------------------------------
# Scoring
# ---------------------------------------------------------------------------
def _score(
    fwd: PrimerResult,
    rev: PrimerResult,
    hetero: Duplex,
    product_length: int,
    *,
    target_tm: float,
    target_length: int,
) -> tuple[float, dict[str, float], list[str]]:
    """Lower is better, and every component is reported.

    A single number tells somebody which pair to pick and nothing about why.
    The components are what lets them disagree: a lab amplifying something
    GC-rich may accept a Tm penalty that would be wrong elsewhere.
    """
    penalties: dict[str, float] = {}
    warnings: list[str] = []

    penalties["tm"] = round(abs(fwd.tm - target_tm) + abs(rev.tm - target_tm), 2)

    # The pair has to anneal at one temperature. A big gap means one primer is
    # loose at the temperature the other needs, and that is worse than both
    # being a few degrees off together.
    tm_diff = abs(fwd.tm - rev.tm)
    penalties["tm_difference"] = round(tm_diff * 3, 2)
    if tm_diff > 5:
        warnings.append(f"the two primers differ by {tm_diff:.1f} °C — pick one annealing temperature and one will be wrong")

    gc_pen = 0.0
    for p, name in ((fwd, "forward"), (rev, "reverse")):
        drift = max(0.0, abs(p.gc_percent - 50) - 10)
        gc_pen += drift * 0.2
        if p.gc_percent < 35 or p.gc_percent > 70:
            warnings.append(f"the {name} primer is {p.gc_percent:.0f}% GC")
    penalties["gc"] = round(gc_pen, 2)

    hairpin = 0.0
    for p, name in ((fwd, "forward"), (rev, "reverse")):
        if p.hairpin_dg < -2:
            hairpin += (abs(p.hairpin_dg) - 2) * 1.0
            if p.hairpin_dg < -4:
                warnings.append(f"the {name} primer folds on itself ({p.hairpin_dg} kcal/mol)")
    penalties["hairpin"] = round(hairpin, 2)

    # Scored twice over, because the two failures are different. An internal
    # duplex costs yield; a 3'-anchored one gets extended and becomes the
    # product. The second is weighted far more heavily and is the only one
    # that earns a warning.
    dimer = 0.0
    for run, run_3p, what in (
        (hetero.run, hetero.three_prime_run, "the two primers"),
        (fwd.self_dimer_run, fwd.self_dimer_3prime_run, "the forward primer"),
        (rev.self_dimer_run, rev.self_dimer_3prime_run, "the reverse primer"),
    ):
        if run >= 5:
            dimer += (run - 4) * 1.0
        if run_3p >= 4:
            dimer += (run_3p - 3) * 3.0
            warnings.append(
                f"{what} pair over {run_3p} bases at a 3' end — the polymerase can extend that"
            )
    penalties["dimer"] = round(dimer, 2)

    drift = abs(product_length - target_length) / max(1, target_length)
    penalties["product_length"] = round(drift * 10, 2)

    clamp = 0.0
    for p, name in ((fwd, "forward"), (rev, "reverse")):
        if not p.gc_clamp:
            clamp += 0.5
        if p.gc_in_last_five >= 4:
            clamp += 1.0
            warnings.append(f"the {name} primer ends in {p.gc_in_last_five} G/C of five — a sticky 3' end mis-primes")
    penalties["gc_clamp"] = round(clamp, 2)

    total = round(sum(penalties.values()), 2)
    return total, penalties, warnings


# ---------------------------------------------------------------------------
# The design itself
# ---------------------------------------------------------------------------
def _primer_result(
    seq: str, template: str, *, strand: int, anneal_temp: float
) -> PrimerResult | None:
    """Locate the oligo on the template and measure it.

    Tm comes from Biopython's nearest-neighbour model rather than from
    `primers`, so the number in the table is the one a thermocycler protocol
    would be written from, and it is computed the same way for every primer
    here regardless of which library proposed it.
    """
    binding = seq if strand == 1 else revcomp(seq)
    at = template.find(binding)
    if at < 0:
        return None

    self_d = duplex(seq, seq)
    clamp, in_five = gc_clamp(seq)
    return PrimerResult(
        sequence=seq,
        length=len(seq),
        tm=primer_tm(seq),
        gc_percent=round(gc_fraction(seq) * 100, 1),
        start=at,
        end=at + len(binding),
        strand=strand,
        hairpin_dg=hairpin_dg(seq, anneal_temp),
        self_dimer_run=self_d.run,
        self_dimer_3prime_run=self_d.three_prime_run,
        gc_clamp=clamp,
        gc_in_last_five=in_five,
    )


def design(
    template: str,
    *,
    product_length: int,
    optimal_tm: float = 60.0,
    max_pairs: int = 3,
    max_windows: int = MAX_WINDOWS,
) -> dict[str, Any]:
    """Design primer pairs for a product of about `product_length` bases."""
    cleaned = re.sub(r"[\s\d]", "", template or "").upper()
    if not cleaned:
        raise DesignError("no template given")
    if not IUPAC_DNA.match(cleaned):
        bad = "".join(sorted(set(re.sub(r"[ACGT]", "", cleaned))))
        raise DesignError(
            f"the template must be unambiguous A, C, G and T; found {bad}. "
            "Primer design cannot place an oligo against an ambiguous base."
        )
    if len(cleaned) < MIN_TEMPLATE_BP:
        raise DesignError(f"the template is {len(cleaned)} bp; design needs at least {MIN_TEMPLATE_BP}")
    if len(cleaned) > MAX_TEMPLATE_BP:
        raise DesignError(f"templates over {MAX_TEMPLATE_BP:,} bp are not accepted here")
    if product_length < MIN_PRODUCT_BP:
        raise DesignError(f"a {product_length} bp product is shorter than two primers")
    if product_length > len(cleaned):
        raise DesignError(
            f"a {product_length} bp product does not fit in a {len(cleaned)} bp template"
        )
    if not 40 <= optimal_tm <= 75:
        raise DesignError("an annealing temperature outside 40–75 °C is not a PCR")

    span = len(cleaned) - product_length
    if span <= 0:
        starts = [0]
    else:
        step = max(1, span // max(1, min(max_windows, span)))
        starts = list(range(0, span + 1, step))[:max_windows]

    pairs: list[PairResult] = []
    seen: set[tuple[str, str]] = set()

    for start in starts:
        window = cleaned[start : start + product_length]
        try:
            fwd_p, rev_p = design_pair(window, optimal_tm=optimal_tm)
        except Exception:  # noqa: BLE001 — a window with no usable primer
            continue

        key = (fwd_p.seq, rev_p.seq)
        if key in seen:
            continue
        seen.add(key)

        fwd = _primer_result(fwd_p.seq, cleaned, strand=1, anneal_temp=optimal_tm)
        rev = _primer_result(rev_p.seq, cleaned, strand=-1, anneal_temp=optimal_tm)
        if fwd is None or rev is None:
            # primers occasionally returns an oligo with an added tail that is
            # not on the template. Nothing to place, so nothing to report.
            continue
        if rev.end <= fwd.start:
            continue

        hetero = duplex(fwd_p.seq, rev_p.seq)
        length = rev.end - fwd.start
        score, penalties, warnings = _score(
            fwd, rev, hetero,
            length,
            target_tm=optimal_tm,
            target_length=product_length,
        )
        pairs.append(
            PairResult(
                forward=fwd,
                reverse=rev,
                product_start=fwd.start,
                product_end=rev.end,
                product_length=length,
                tm_difference=round(abs(fwd.tm - rev.tm), 1),
                hetero_dimer_run=hetero.run,
                hetero_dimer_3prime_run=hetero.three_prime_run,
                hetero_dimer_severity=hetero.severity,
                score=score,
                penalties=penalties,
                warnings=warnings,
            )
        )

    pairs.sort(key=lambda p: p.score)
    best = pairs[:max_pairs]

    notes: list[str] = []
    if not pairs:
        notes.append(
            "No usable pair. A template that is very repetitive, or very high or "
            "low in GC, can leave no window where both primers work."
        )
    elif len(starts) >= max_windows:
        notes.append(
            f"{len(starts)} positions were tried across the template, not every one — "
            f"these are the best of those, not the best possible."
        )

    return {
        "template_length": len(cleaned),
        "target": {"product_length": product_length, "optimal_tm": optimal_tm},
        "tm_conditions": TM_CONDITIONS,
        "windows_tried": len(starts),
        "pairs_found": len(pairs),
        "pairs": [p.payload() for p in best],
        "notes": notes,
    }
