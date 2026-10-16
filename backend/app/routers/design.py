"""POST /api/primers/design — propose primer pairs for a template.

Its own module, rather than a route in routers/primers.py, for one reason:
design needs no database. Primer design and restriction cloning are the two
endpoints that take sequence in and send an answer back, and keeping them out
of the modules that query means they can be served on their own, beside a lab
whose records live in Supabase. app/science.py is that deployment.

It is still mounted into the full application, at the same path as before. The
only thing that changed there is which dependency authenticates it: no
transaction is opened and no `SET LOCAL` is issued, because nothing here
reads a row that a policy could filter.

Both apps include this router before routers/primers.py. Nothing collides as
things stand — this is a POST and `/{primer_id}` has no POST — but that router
does carry `GET /{primer_id}`, so a GET added here later would otherwise be
matched as a UUID and answered 422.
"""
from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException, status

from app import primer_design
from app.auth_light import CallerDep
from app.schemas import PrimerDesignRequest, PrimerDesignResponse

log = logging.getLogger("eln.primers")

router = APIRouter(prefix="/api/primers", tags=["primers"])


@router.post("/design", response_model=PrimerDesignResponse)
async def design_primers(
    body: PrimerDesignRequest, caller: CallerDep
) -> PrimerDesignResponse:
    """Propose primer pairs for a product of about the requested length.

    Nothing is stored. The pairs come back ranked with the score broken into
    its parts, and whichever one the lab picks is saved through POST
    /api/primers afterwards — a design somebody is still comparing should not
    be filling the oligo library with rows nobody ordered.

    Authenticated, even though there is nothing to authorise against: the
    template is unpublished sequence, and an endpoint that will design against
    anything for anybody is a free compute service with the lab's name on it.
    """
    try:
        result = primer_design.design(
            body.template,
            product_length=body.product_length,
            optimal_tm=body.optimal_tm,
            max_pairs=body.max_pairs,
            purpose=body.purpose,
            screen_against=body.screen_against,
            screen_name=body.screen_name,
        )
    except primer_design.DesignError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001 — the design libraries raise broadly
        log.exception("primer design failed for %s", caller.label)
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"the design could not be run: {exc}",
        ) from exc

    return PrimerDesignResponse.model_validate(result)
