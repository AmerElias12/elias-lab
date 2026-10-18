"""/api/cloning — simulate a restriction cloning and hand the result to the viewer.

Stateless and read-only: nothing is written, nothing is looked up. Two
sequences and a list of enzymes go in, constructs come out, and what the lab
chooses to keep goes through /api/plasmids or /api/assemblies afterwards. That
separation is deliberate — a simulation somebody is still fiddling with should
not be leaving rows behind.

It is still authenticated, though there is nothing here to authorise against:
the payload is unpublished sequence belonging to the lab, and an endpoint that
will digest anything for anybody is a free compute service with the lab's name
on it. The check is app/auth_light.py, which verifies a token without opening
a transaction — which is what lets this router be served on its own, beside a
lab whose records live in Supabase. See app/science.py.
"""
from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException, status

from app.auth_light import CallerDep
from app.cloning import CloningError, MAX_SEQUENCE_BP, digest_and_ligate
from app.schemas import CloningRequest, CloningResponse

log = logging.getLogger("eln.cloning")

router = APIRouter(prefix="/api/cloning", tags=["cloning"])


@router.post("/digest-ligation", response_model=CloningResponse)
async def digest_ligation(body: CloningRequest, caller: CallerDep) -> CloningResponse:
    """Digest two molecules, join the ends that fit, and return the constructs.

    The response is shaped so the viewer can draw a construct without
    translating anything: each one carries `sequence`, `topology` and
    `features` exactly as static/js/vector-viewer.js expects.

    Every failure here is the caller's: an enzyme that does not cut, a
    sequence that is not DNA, a file holding two records. They come back as
    400 with the sentence that says which, because "try another enzyme" is
    advice only if the answer says which enzyme.
    """
    try:
        result = digest_and_ligate(
            body.sequence_a,
            body.sequence_b,
            body.enzymes,
            name_a=body.name_a,
            name_b=body.name_b,
            circular_only=body.circular_only,
        )
    except CloningError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        # pydna and Biopython raise their own types for malformed input, and a
        # traceback in the log is more use than a 500 with no clue in it.
        log.exception("cloning simulation failed for %s", caller.label)
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"the simulation could not be run: {exc}",
        ) from exc

    return CloningResponse.model_validate(result)


@router.get("/enzymes", response_model=list[str])
async def list_enzymes(caller: CallerDep, q: str = "", limit: int = 50) -> list[str]:
    """Enzyme names, for a picker that should not make people guess spelling.

    REBASE is particular about case — EcoRI, not ECORI or ecori — and it holds
    about 1,090 names, so the list is searched rather than sent.
    """
    from Bio.Restriction import AllEnzymes

    needle = q.strip().lower()
    names = sorted(str(e) for e in AllEnzymes)
    if needle:
        names = [n for n in names if needle in n.lower()]
    return names[: max(1, min(limit, 200))]
