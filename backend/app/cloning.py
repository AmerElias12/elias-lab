"""In-silico restriction cloning, on pydna and Biopython.

Digest two molecules, find the ends that can actually be joined, ligate them,
and hand back constructs in the shape the viewer draws.

Why this is in Python when js/plasmid.js already digests
--------------------------------------------------------
It is a second implementation, and that is a cost worth naming. The reason to
pay it is the enzyme set: js/plasmid.js carries 81 enzymes written out by
hand, Biopython carries REBASE — about 1,090, maintained by people whose job
that is. For drawing sites on a map while somebody scrolls, the hand-written
set is fine and fast and runs with no round trip. For deciding what to order,
it is not.

So the two are not peers. The browser's digest is a preview; this one is what
a result gets saved from. scripts/check_cloning.py asserts they agree on the
enzymes both know, which is how a drift between them gets noticed rather than
discovered by a cloning that fails at the bench.

What "compatible" means here
----------------------------
pydna decides, and it refuses a join it cannot make. Two things follow that
are worth stating because they surprise people:

  * Blunt ends ligate to any other blunt end. That is chemistry, not a
    shortcut, and it is why a blunt digest of two plasmids yields a great many
    products — all of them real, most of them unwanted.
  * Different enzymes can leave the same overhang. BamHI and BglII both leave
    GATC, so their fragments join happily and the junction is neither a BamHI
    site nor a BglII site afterwards. That is often the point, and it is
    occasionally a nasty surprise, so every junction below reports whether the
    site survives.
"""
from __future__ import annotations

import io
import re
from dataclasses import dataclass, field
from typing import Any, Iterable, Sequence

from Bio import SeqIO
from Bio.Restriction import AllEnzymes, RestrictionBatch
from Bio.SeqFeature import SeqFeature
from pydna.dseqrecord import Dseqrecord

#: Past this the pairing is combinatorial and the answer stops being useful:
#: a digest giving dozens of pieces is a question about the digest, not about
#: which two of them to join.
MAX_FRAGMENTS = 25

#: Guards the request body rather than the maths. Two plasmids of 300 kb are
#: not a cloning, they are a mistake.
MAX_SEQUENCE_BP = 500_000

IUPAC = re.compile(r"^[ACGTURYSWKMBDHVN]+$")


class CloningError(ValueError):
    """Something about the request cannot work. The message is for the caller:
    it names the enzyme, the sequence or the end that is the problem."""


# ---------------------------------------------------------------------------
# Reading what was sent
# ---------------------------------------------------------------------------
def parse_record(text: str, fallback_name: str = "sequence") -> Dseqrecord:
    """Read GenBank, FASTA or bare bases into a Dseqrecord.

    Topology comes from the file when the file says — GenBank's LOCUS line
    carries it — and otherwise defaults to circular, because the things people
    paste into a cloning tool are overwhelmingly plasmids. Getting this wrong
    matters: a circular molecule cut once gives one fragment, a linear one
    gives two, and the ligation that follows is a different question.
    """
    if not text or not text.strip():
        raise CloningError("no sequence given")
    if len(text) > MAX_SEQUENCE_BP * 3:          # generous: GenBank is verbose
        raise CloningError("that sequence is larger than this endpoint accepts")

    stripped = text.lstrip()

    if stripped.upper().startswith("LOCUS"):
        record = _read_one(text, "genbank")
        circular = str(record.annotations.get("topology", "")).lower() == "circular"
        name = record.name or record.id or fallback_name
    elif stripped.startswith(">"):
        record = _read_one(text, "fasta")
        circular = True
        name = (record.description or record.id or fallback_name).split()[0]
    else:
        bases = re.sub(r"[\s\d]", "", stripped).upper()
        if not bases:
            raise CloningError("no sequence given")
        if not IUPAC.match(bases):
            bad = "".join(sorted(set(re.sub(r"[ACGTURYSWKMBDHVN]", "", bases))))
            raise CloningError(f"not a DNA sequence; unexpected characters: {bad}")
        return _as_dseqrecord(bases, circular=True, name=fallback_name, features=[])

    if len(record.seq) > MAX_SEQUENCE_BP:
        raise CloningError(f"sequences over {MAX_SEQUENCE_BP:,} bp are not accepted here")
    return _as_dseqrecord(
        str(record.seq).upper(), circular=circular, name=name, features=list(record.features)
    )


def _read_one(text: str, fmt: str):
    try:
        records = list(SeqIO.parse(io.StringIO(text), fmt))
    except Exception as exc:  # noqa: BLE001 — Biopython raises several types
        raise CloningError(f"could not read that as {fmt}: {exc}") from exc
    if not records:
        raise CloningError(f"no {fmt} record found")
    if len(records) > 1:
        # Silently taking the first is how somebody clones the wrong thing.
        raise CloningError(
            f"that file holds {len(records)} records; send one sequence per field"
        )
    return records[0]


def _as_dseqrecord(
    bases: str, *, circular: bool, name: str, features: list[SeqFeature]
) -> Dseqrecord:
    record = Dseqrecord(bases, circular=circular)
    record.name = (name or "sequence")[:40]
    record.features = features
    return record


# ---------------------------------------------------------------------------
# Enzymes
# ---------------------------------------------------------------------------
def resolve_enzymes(names: Sequence[str]) -> RestrictionBatch:
    """Look names up in REBASE, and say plainly which ones are not there.

    Case matters to REBASE — EcoRI, not ECORI — so a near miss is matched
    case-insensitively and reported with the right spelling rather than
    rejected as unknown.
    """
    if not names:
        raise CloningError("name at least one enzyme")

    known = {str(e): e for e in AllEnzymes}
    lowered = {k.lower(): k for k in known}

    found, missing = [], []
    for raw in names:
        wanted = str(raw).strip()
        if wanted in known:
            found.append(known[wanted])
        elif wanted.lower() in lowered:
            correct = lowered[wanted.lower()]
            raise CloningError(f"no enzyme called {wanted!r} — did you mean {correct!r}?")
        else:
            missing.append(wanted)

    if missing:
        raise CloningError(f"unknown enzyme(s): {', '.join(sorted(missing))}")
    return RestrictionBatch(found)


def describe_end(end: tuple) -> dict[str, Any]:
    """pydna reports an end as ('blunt', '') or ("5'", 'aatt')."""
    kind = end[0]
    overhang = (end[1] if len(end) > 1 else "").upper()
    return {
        "kind": "blunt" if kind == "blunt" else f"{kind} overhang",
        "overhang": overhang,
    }


# ---------------------------------------------------------------------------
# Digest
# ---------------------------------------------------------------------------
@dataclass(slots=True)
class Fragment:
    source: str
    index: int
    record: Dseqrecord

    @property
    def length(self) -> int:
        return len(self.record)

    def summary(self) -> dict[str, Any]:
        return {
            "source": self.source,
            "index": self.index,
            "length_bp": self.length,
            "five_prime": describe_end(self.record.seq.five_prime_end()),
            "three_prime": describe_end(self.record.seq.three_prime_end()),
            "features": features_of(self.record),
        }


def digest(record: Dseqrecord, enzymes: RestrictionBatch, source: str) -> list[Fragment]:
    """Cut, and refuse clearly when nothing was cut.

    An enzyme that does not cut is the single most common reason a cloning
    plan does not work, and the useful answer names it rather than returning
    an empty list that reads like a server fault.
    """
    try:
        pieces = record.cut(enzymes)
    except Exception as exc:  # noqa: BLE001 — Biopython/pydna raise broadly
        raise CloningError(f"could not digest {source}: {exc}") from exc

    if not pieces:
        names = ", ".join(sorted(str(e) for e in enzymes))
        raise CloningError(
            f"none of {names} cuts {record.name or source}, so there is nothing to ligate"
        )
    if len(pieces) > MAX_FRAGMENTS:
        raise CloningError(
            f"{record.name or source} falls into {len(pieces)} pieces; "
            f"that is past what this endpoint will pair up ({MAX_FRAGMENTS})"
        )
    return [Fragment(source=source, index=i, record=p) for i, p in enumerate(pieces)]


def features_of(record: Dseqrecord) -> list[dict[str, Any]]:
    """Biopython features in the shape static/js/vector-viewer.js accepts.

    Features that straddled a cut are already gone — pydna drops what no
    longer fits — so everything here is intact rather than truncated, which
    is the right way round for a map somebody will trust.
    """
    out = []
    for f in record.features:
        if f.location is None:
            continue
        label = (
            f.qualifiers.get("label")
            or f.qualifiers.get("gene")
            or f.qualifiers.get("product")
            or f.qualifiers.get("note")
            or [f.type]
        )
        out.append(
            {
                "name": str(label[0])[:120],
                "type": f.type or "misc_feature",
                "start": int(f.location.start),
                "end": int(f.location.end),
                "strand": -1 if f.location.strand == -1 else 1,
            }
        )
    return out


# ---------------------------------------------------------------------------
# Ligation
# ---------------------------------------------------------------------------
@dataclass(slots=True)
class Construct:
    record: Dseqrecord
    parts: list[dict[str, Any]]
    junctions: list[dict[str, Any]] = field(default_factory=list)

    def payload(self, name: str) -> dict[str, Any]:
        return {
            "name": name,
            "sequence": str(self.record.seq).upper(),
            "topology": "circular" if self.record.circular else "linear",
            "length_bp": len(self.record),
            "features": features_of(self.record),
            "parts": self.parts,
            "junctions": self.junctions,
        }


def _junctions(record: Dseqrecord, enzymes: RestrictionBatch) -> list[dict[str, Any]]:
    """Which of the enzymes can still cut the product.

    The question behind it: did the junction regenerate the site. Two EcoRI
    ends rebuild GAATTC and the insert can be cut back out; a BamHI end joined
    to a BglII end rebuilds neither, which is usually deliberate and
    occasionally a surprise when somebody tries to excise the insert later.
    """
    out = []
    for enzyme in sorted(enzymes, key=str):
        try:
            sites = enzyme.search(record.seq, linear=not record.circular)
        except Exception:  # noqa: BLE001
            sites = []
        out.append(
            {
                "enzyme": str(enzyme),
                "site": str(enzyme.site),
                "sites_in_product": len(sites),
                "regenerated": bool(sites),
            }
        )
    return out


def _try_join(left: Fragment, right: Fragment, flipped: bool) -> Dseqrecord | None:
    piece = right.record.rc() if flipped else right.record
    try:
        return left.record + piece
    except TypeError:
        # pydna's way of saying the ends do not fit. Not an error: most pairs
        # in a digest do not, and that is the question being asked.
        return None


def ligate(
    fragments_a: list[Fragment],
    fragments_b: list[Fragment],
    enzymes: RestrictionBatch,
    *,
    circular_only: bool = True,
) -> tuple[list[Construct], list[str]]:
    """Join every fragment of A to every fragment of B that will take it.

    Both orientations of B are tried, and that is not a formality: cutting
    with one enzyme leaves identical ends, so the insert goes in either way
    round and both products are real. Cutting with two different enzymes
    leaves ends that only fit one way, which is the whole reason directional
    cloning is done with two. Each construct below says which orientation it
    used, so the difference is visible rather than implied.

    Returns the constructs and any notes worth showing beside them.
    """
    constructs: list[Construct] = []
    notes: list[str] = []
    seen: set[str] = set()

    for a in fragments_a:
        for b in fragments_b:
            for flipped in (False, True):
                joined = _try_join(a, b, flipped)
                if joined is None:
                    continue

                looped = None
                try:
                    looped = joined.looped()
                except Exception:  # noqa: BLE001 — outer ends simply do not meet
                    looped = None

                product = looped if looped is not None else joined
                if circular_only and looped is None:
                    continue

                # The same circle can be found from several starting points;
                # compare rotations so it is reported once.
                key = _canonical(product)
                if key in seen:
                    continue
                seen.add(key)

                constructs.append(
                    Construct(
                        record=product,
                        parts=[
                            {
                                "source": a.source,
                                "fragment": a.index,
                                "length_bp": a.length,
                                "orientation": "forward",
                            },
                            {
                                "source": b.source,
                                "fragment": b.index,
                                "length_bp": b.length,
                                "orientation": "reverse" if flipped else "forward",
                            },
                        ],
                        junctions=_junctions(product, enzymes),
                    )
                )

    if not constructs:
        if circular_only:
            notes.append(
                "No circular product: the fragments that join leave outer ends that "
                "do not meet. Try the other enzyme pair, or ask for linear products."
            )
        else:
            notes.append("No pair of fragments has compatible ends.")

    blunt = [e for e in enzymes if e.is_blunt()]
    if blunt and len(constructs) > 2:
        notes.append(
            f"{', '.join(sorted(str(e) for e in blunt))} leaves blunt ends, which join "
            f"to any other blunt end — several of these products are real but unwanted, "
            f"and the ligation will give a mixture."
        )

    constructs.sort(key=lambda c: len(c.record), reverse=True)
    return constructs, notes


def _canonical(record: Dseqrecord) -> str:
    """A rotation-independent key for a circular molecule.

    Two fragments joined in a ring can be written starting anywhere, and the
    same product found twice from different starting fragments should be
    reported once. The smallest rotation of the sequence, and of its reverse
    complement, is the same for all of them.
    """
    seq = str(record.seq).upper()
    if not record.circular:
        return f"L:{seq}"
    doubled = seq + seq
    best = min(doubled[i : i + len(seq)] for i in range(len(seq))) if seq else ""
    rc = str(record.seq.reverse_complement()).upper()
    doubled_rc = rc + rc
    best_rc = min(doubled_rc[i : i + len(rc)] for i in range(len(rc))) if rc else ""
    return "C:" + min(best, best_rc)


# ---------------------------------------------------------------------------
# The whole operation
# ---------------------------------------------------------------------------
def digest_and_ligate(
    sequence_a: str,
    sequence_b: str,
    enzyme_names: Sequence[str],
    *,
    name_a: str = "insert source",
    name_b: str = "vector source",
    circular_only: bool = True,
) -> dict[str, Any]:
    """The endpoint's work, with no FastAPI in sight so it can be tested."""
    enzymes = resolve_enzymes(enzyme_names)

    record_a = parse_record(sequence_a, name_a)
    record_b = parse_record(sequence_b, name_b)

    frags_a = digest(record_a, enzymes, source=record_a.name or name_a)
    frags_b = digest(record_b, enzymes, source=record_b.name or name_b)

    constructs, notes = ligate(frags_a, frags_b, enzymes, circular_only=circular_only)

    return {
        "enzymes": sorted(str(e) for e in enzymes),
        "inputs": {
            "a": {
                "name": record_a.name,
                "length_bp": len(record_a),
                "topology": "circular" if record_a.circular else "linear",
                "fragments": [f.summary() for f in frags_a],
            },
            "b": {
                "name": record_b.name,
                "length_bp": len(record_b),
                "topology": "circular" if record_b.circular else "linear",
                "fragments": [f.summary() for f in frags_b],
            },
        },
        "constructs": [
            c.payload(f"{record_a.name} × {record_b.name} #{i + 1}")
            for i, c in enumerate(constructs)
        ],
        "notes": notes,
    }
