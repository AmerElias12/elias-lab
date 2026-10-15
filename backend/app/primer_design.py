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


#: Screening is an index over the background sequence, so it is bounded by
#: memory rather than by patience. Half a megabase covers the realistic cases —
#: a gene locus with flanks, a family of paralogs, a panel of transcripts — and
#: a whole genome is a job for BLAST on a server that has one.
MAX_SCREEN_BP = 500_000

#: How far apart two opposing 3' ends can be and still give a product. Past a
#: few kb a standard extension time will not finish it.
MAX_SPURIOUS_AMPLICON_BP = 5_000

#: The 3' window that decides whether a primer primes. Matching the length the
#: `primers` package screens on, so the two agree about what an off-target is.
SEED_LEN = 10

#: What the design is for. Off-target screening is the difference: amplifying a
#: fragment from a purified plasmid has essentially no background to mis-prime
#: against, while a qRT-PCR or an analytical PCR runs against a whole genome or
#: transcriptome and mis-priming is the usual reason it fails.
PURPOSES = {
    "cloning": {
        "label": "cloning from a plasmid",
        "screen_expected": False,
        "product_range": (100, 20_000),
    },
    "qpcr": {
        "label": "qRT-PCR",
        "screen_expected": True,
        # Short products amplify efficiently and stay quantitative; past about
        # 250 bp the efficiency drops away from the 2× a Cq assumes.
        "product_range": (70, 250),
    },
    "analytical": {
        "label": "analytical PCR on genomic DNA",
        "screen_expected": True,
        "product_range": (150, 3_000),
    },
}

_MUTATIONS = {"A": "TGC", "T": "AGC", "G": "ATC", "C": "ATG"}


def _seed_variants(seed: str) -> list[str]:
    """The seed and every single-substitution neighbour of it.

    One mismatch is the line the `primers` package draws and it is a reasonable
    one: a 3' decamer with a single mismatch still primes, two usually does not.
    """
    out = [seed]
    for i, base in enumerate(seed):
        for other in _MUTATIONS.get(base, ""):
            out.append(seed[:i] + other + seed[i + 1 :])
    return out


class OffTargetIndex:
    """Where else in a background sequence a primer's 3' end could sit.

    The index holds the exact seeds of the background; the mismatches are
    generated from the *primer* at lookup. That is the same question asked the
    other way round, and it is what makes screening a locus practical: the
    `primers` package expands every background position into 31 variants, which
    for 60 kb is 3.3 s and 82 MB and is rebuilt on every call. Inverting it is
    1.25 s and 48 MB for a megabase, built once.

    scripts/check_primer_design.py asserts the two agree site for site, because
    "faster" is only worth having if the answer is the same.

    Positions are kept rather than counts. A primer that binds somewhere else
    is a nuisance; two primers that bind near each other in opposing
    orientations make a product, and that product is what appears on the gel
    instead of the one that was wanted.
    """

    __slots__ = ("length", "name", "_seeds")

    def __init__(self, screen: str, name: str = "screen") -> None:
        if len(screen) > MAX_SCREEN_BP:
            raise DesignError(
                f"the screening sequence is {len(screen):,} bp; this endpoint indexes "
                f"up to {MAX_SCREEN_BP:,}. Screen against the locus and its paralogs, "
                f"or use BLAST for a whole genome."
            )
        self.length = len(screen)
        self.name = name
        seeds: dict[str, list[int]] = {}
        for i in range(len(screen) - SEED_LEN + 1):
            seeds.setdefault(screen[i : i + SEED_LEN], []).append(i)
        self._seeds = seeds

    def sites(self, primer: str) -> tuple[list[int], list[int]]:
        """Where this primer's 3' end could land, as (pointing right, pointing left).

        A hit on the given strand puts the 3' end just past the seed and the
        polymerase extends rightwards; a hit on the reverse strand puts it at
        the left edge, extending leftwards. The two lists are what a product
        is made of.
        """
        if len(primer) < SEED_LEN:
            return [], []
        seed = primer[-SEED_LEN:]
        right: list[int] = []
        for variant in _seed_variants(seed):
            for at in self._seeds.get(variant, ()):
                right.append(at + SEED_LEN)
        left: list[int] = []
        for variant in _seed_variants(revcomp(seed)):
            for at in self._seeds.get(variant, ()):
                left.append(at)
        return sorted(right), sorted(left)

    def site_count(self, primer: str) -> int:
        right, left = self.sites(primer)
        return len(right) + len(left)


@dataclass(slots=True)
class Amplicon:
    """A product the background would give, wanted or not."""

    start: int
    end: int
    length: int
    forward_primer: str   #: "forward" or "reverse" — which oligo primed each end
    reverse_primer: str
    intended: bool


def predicted_amplicons(
    index: OffTargetIndex,
    fwd: str,
    rev: str,
    intended_length: int,
    *,
    max_bp: int = MAX_SPURIOUS_AMPLICON_BP,
    limit: int = 20,
) -> list[Amplicon]:
    """Every product these two oligos could make against the background.

    All four pairings are considered, including each primer with itself: a
    single primer whose 3' end lands in both orientations nearby amplifies
    perfectly well, and that is a classic source of a band nobody ordered.

    A product whose length matches the intended one is marked rather than
    dropped — on a background that contains the target it is the real product,
    and seeing it listed is how somebody knows the screen covered the template
    at all.
    """
    # index.sites() anchors on the 3' end, which is what decides whether a
    # primer primes. A product, though, runs from one primer's 5' end to the
    # other's — the whole oligo ends up in the amplicon. Measuring 3' to 3'
    # makes every product short by the two primer lengths less the two seeds,
    # which misreports the intended product as an unintended one on every
    # single pair. Found by a product coming back 117 bp when 150 was asked for.
    rights: list[tuple[int, str]] = []
    lefts: list[tuple[int, str]] = []
    for seq, name in ((fwd, "forward"), (rev, "reverse")):
        right, left = index.sites(seq)
        rights.extend((at - len(seq), name) for at in right)   # 5' end, upstream
        lefts.extend((at + len(seq), name) for at in left)     # 5' end, downstream

    found: list[Amplicon] = []
    lefts.sort()
    for start, right_name in sorted(rights):
        for end, left_name in lefts:
            if end <= start:
                continue
            size = end - start
            if size > max_bp:
                break
            found.append(
                Amplicon(
                    start=start,
                    end=end,
                    length=size,
                    forward_primer=right_name,
                    reverse_primer=left_name,
                    intended=abs(size - intended_length) <= 2,
                )
            )
            if len(found) >= limit * 4:
                break
        if len(found) >= limit * 4:
            break

    # Smallest first: a short spurious product out-competes the intended one.
    found.sort(key=lambda a: (not a.intended, a.length))
    return found[:limit]


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
    #: Places in the screening background where this primer's 3' end could
    #: sit, counting one mismatch. Zero when nothing was screened.
    binding_sites: int = 0


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
    screened: bool = False
    #: Products the background would give that are not the one asked for.
    spurious_amplicons: int = 0
    amplicons: list[dict[str, Any]] = field(default_factory=list)
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
    screened: bool = False,
    spurious: int = 0,
    screen_name: str = "the background",
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

    # Off-target, weighted above everything else when it was checked at all.
    # A primer with a perfect Tm that also primes in four other places is not
    # a good primer; on a genomic or cDNA template this is the usual reason a
    # reaction fails, and it is the one thing a plasmid prep does not suffer.
    off = 0.0
    if screened:
        for p, name in ((fwd, "forward"), (rev, "reverse")):
            extra = max(0, p.binding_sites - 1)
            if extra:
                off += extra * 4.0
                warnings.append(
                    f"the {name} primer's 3' end matches {extra} other "
                    f"place(s) in {screen_name}"
                )
        if spurious:
            # A product beats a binding site: two off-target ends facing each
            # other within range give a band, and a short one out-competes the
            # intended product for polymerase.
            off += spurious * 10.0
            warnings.append(
                f"{spurious} unintended product(s) predicted against {screen_name}"
            )
    penalties["off_target"] = round(off, 2)

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


def parse_screen(text: str) -> str:
    """Read the background to screen against: FASTA, several records, or bases.

    Records are joined with a run of N. N is not a base, so no seed can span
    the boundary and two transcripts cannot be fused into a site that exists
    in neither — which is the kind of false positive that would teach somebody
    to ignore the warnings.
    """
    cleaned_parts: list[str] = []
    if text.lstrip().startswith(">"):
        for block in text.split(">"):
            if not block.strip():
                continue
            body = "".join(block.splitlines()[1:])
            bases = re.sub(r"[\s\d]", "", body).upper()
            if bases:
                cleaned_parts.append(bases)
    else:
        bases = re.sub(r"[\s\d]", "", text).upper()
        if bases:
            cleaned_parts.append(bases)

    joined = ("N" * SEED_LEN).join(cleaned_parts)
    if not joined:
        raise DesignError("the screening sequence holds no bases")
    if not re.match(r"^[ACGTN]+$", joined):
        bad = "".join(sorted(set(re.sub(r"[ACGTN]", "", joined))))
        raise DesignError(f"the screening sequence has characters that are not DNA: {bad}")
    return joined


def design(
    template: str,
    *,
    product_length: int,
    optimal_tm: float = 60.0,
    max_pairs: int = 3,
    max_windows: int = MAX_WINDOWS,
    purpose: str = "cloning",
    screen_against: str | None = None,
    screen_name: str = "the screening sequence",
) -> dict[str, Any]:
    """Design primer pairs for a product of about `product_length` bases.

    `purpose` decides whether off-target screening is expected. Amplifying a
    fragment from a purified plasmid has almost no background to mis-prime
    against; a qRT-PCR or an analytical PCR runs against a genome or a
    transcriptome, where a primer that is merely thermodynamically good is not
    good enough. For those, pass `screen_against` — the locus with its flanks,
    the paralogs, the transcript panel — and the result says where else each
    primer could sit and what those sites would amplify.
    """
    if purpose not in PURPOSES:
        raise DesignError(
            f"unknown purpose {purpose!r}; use one of {', '.join(sorted(PURPOSES))}"
        )
    spec = PURPOSES[purpose]
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

    index: OffTargetIndex | None = None
    if screen_against and screen_against.strip():
        index = OffTargetIndex(parse_screen(screen_against), screen_name)

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

        amplicons: list[Amplicon] = []
        spurious = 0
        if index is not None:
            fwd.binding_sites = index.site_count(fwd_p.seq)
            rev.binding_sites = index.site_count(rev_p.seq)
            amplicons = predicted_amplicons(index, fwd_p.seq, rev_p.seq, length)
            spurious = sum(1 for a in amplicons if not a.intended)

        score, penalties, warnings = _score(
            fwd, rev, hetero,
            length,
            target_tm=optimal_tm,
            target_length=product_length,
            screened=index is not None,
            spurious=spurious,
            screen_name=screen_name,
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
                screened=index is not None,
                spurious_amplicons=spurious,
                amplicons=[asdict(a) for a in amplicons],
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

    # The point of the purpose switch: say plainly when the check that matters
    # for this kind of PCR was not performed.
    if spec["screen_expected"] and index is None:
        notes.append(
            f"Nothing was screened against. For {spec['label']} the template is a "
            f"genome or a transcriptome, where mis-priming is the usual reason a "
            f"reaction fails — these pairs are thermodynamically sound and "
            f"unproven for specificity. Pass the locus with its flanks, the "
            f"paralogs, or the transcript panel."
        )
    elif index is not None:
        notes.append(
            f"Screened against {index.length:,} bp of {index.name}. A 3' decamer "
            f"with up to one mismatch counts as a site, on either strand; "
            f"specificity beyond that background is not evidence of anything."
        )

    low, high = spec["product_range"]
    if not low <= product_length <= high:
        notes.append(
            f"{product_length} bp is outside the usual {low}–{high} bp for "
            f"{spec['label']}."
            + (
                " Past about 250 bp a qPCR stops being reliably quantitative, "
                "because the efficiency drifts from the doubling a Cq assumes."
                if purpose == "qpcr"
                else ""
            )
        )
    if purpose == "qpcr":
        notes.append(
            "Exon structure is not considered here. A pair that spans an "
            "exon–exon junction is what stops genomic DNA being amplified "
            "alongside the cDNA, and that needs the transcript's exon "
            "boundaries, which this endpoint does not take."
        )

    return {
        "template_length": len(cleaned),
        "target": {"product_length": product_length, "optimal_tm": optimal_tm},
        "purpose": purpose,
        "tm_conditions": TM_CONDITIONS,
        "screen": (
            {"name": index.name, "length_bp": index.length, "seed_len": SEED_LEN,
             "max_mismatches": 1}
            if index is not None
            else None
        ),
        "windows_tried": len(starts),
        "pairs_found": len(pairs),
        "pairs": [p.payload() for p in best],
        "notes": notes,
    }
