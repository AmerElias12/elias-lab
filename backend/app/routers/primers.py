"""Primers: the lab's oligo library, and where each one anneals.

Two things this is for. One is documentation — an oligo was designed, ordered
and used, and the notebook should say so. The other is reuse: when somebody
opens a plasmid in the molecular tool, the primers the lab already owns should
be findable without anybody retyping a sequence from a spreadsheet.

Where the annealing is worked out
---------------------------------
In the browser, not here. js/plasmid.js already matches primers against a
sequence — both strands, 5' tails and mismatches included — with tests behind
it, and that is the hard part. Reimplementing it in Python would give the lab
two answers to "does this primer bind", which is worse than either answer.

So the list endpoint hands over the library and the client matches, which is
why `limit` goes to 500 here rather than the 100 used elsewhere: binding needs
the whole library, not a page of it. A few hundred oligos of 25 bases is tens
of kilobytes. If a lab ever passes a few thousand, the thing to add is a
server-side prefilter on the 3' end — not a second matcher.

What *is* stored is the result: a primer_binding row saying this oligo was
used with that construct, at those coordinates. That is a fact about the work,
and it should not change because somebody later edited the plasmid.
"""
from __future__ import annotations

import logging
import uuid
from typing import Annotated

import sqlalchemy as sa
from fastapi import APIRouter, HTTPException, Query, Response, status

from app.deps import Ctx, CtxDep, WriterDep
from app import primer_design
from app.models import Plasmid, Primer, PrimerBinding
from app.schemas import (
    Page,
    PrimerBindingCreate,
    PrimerBindingDetail,
    PrimerBindingRead,
    PrimerCreate,
    PrimerDesignRequest,
    PrimerDesignResponse,
    PrimerRead,
    PrimerSummary,
    PrimerUpdate,
)

log = logging.getLogger("eln.primers")

router = APIRouter(prefix="/api/primers", tags=["primers"])

_NOT_FOUND = HTTPException(
    status_code=status.HTTP_404_NOT_FOUND,
    detail="no such primer, or it is not shared with you",
)


async def _load_visible(ctx: Ctx, primer_id: uuid.UUID) -> Primer:
    stmt = ctx.scope.visible(Primer).where(Primer.id == primer_id)
    primer = (await ctx.session.execute(stmt)).scalar_one_or_none()
    if primer is None:
        raise _NOT_FOUND
    return primer


# ---------------------------------------------------------------------------
# Bindings
#
# Declared before /{primer_id}: FastAPI matches in declaration order, and
# "bindings" would otherwise be handed to the UUID parser and 422.
# ---------------------------------------------------------------------------
@router.get("/bindings", response_model=list[PrimerBindingDetail])
async def list_bindings(
    ctx: CtxDep,
    plasmid_id: Annotated[uuid.UUID, Query(description="the plasmid to list bindings for")],
) -> list[PrimerBindingDetail]:
    """Every primer recorded against this plasmid, with enough of each one to
    draw it on the map without a request per primer.

    Reachable only if the plasmid is: the policy on primer_binding is an
    EXISTS against primer, and the join below is to plasmids this scope can
    see, so an id from another lab returns an empty list rather than an error.
    """
    rows = (
        await ctx.session.execute(
            sa.select(
                PrimerBinding.id,
                PrimerBinding.primer_id,
                PrimerBinding.plasmid_id,
                PrimerBinding.start_pos,
                PrimerBinding.end_pos,
                PrimerBinding.strand,
                PrimerBinding.annealed_nt,
                PrimerBinding.tail_sequence,
                PrimerBinding.tm_annealed_c,
                Primer.name.label("primer_name"),
                Primer.sequence.label("primer_sequence"),
            )
            .join(Primer, Primer.id == PrimerBinding.primer_id)
            .where(
                PrimerBinding.plasmid_id == plasmid_id,
                Primer.deleted_at.is_(None),
            )
            .order_by(PrimerBinding.start_pos)
        )
    ).mappings().all()
    return [PrimerBindingDetail.model_validate(dict(r)) for r in rows]


@router.delete("/bindings/{binding_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_binding(binding_id: uuid.UUID, ctx: WriterDep) -> Response:
    """Detach a primer from a plasmid. The primer itself stays."""
    result = await ctx.session.execute(
        sa.delete(PrimerBinding).where(PrimerBinding.id == binding_id)
    )
    if result.rowcount == 0:
        # Either it is gone or a policy refused, and a USING clause refuses in
        # silence. Checking the count is what turns that into an answer.
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="no such binding")
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ---------------------------------------------------------------------------
# Design
#
# Also before /{primer_id}, for the same reason as /bindings: "design" is not
# a UUID and the path parameter would reject it.
# ---------------------------------------------------------------------------
@router.post("/design", response_model=PrimerDesignResponse)
async def design_primers(body: PrimerDesignRequest, ctx: CtxDep) -> PrimerDesignResponse:
    """Propose primer pairs for a product of about the requested length.

    Nothing is stored. The pairs come back ranked with the score broken into
    its parts, and whichever one the lab picks is saved through POST
    /api/primers afterwards — a design somebody is still comparing should not
    be filling the oligo library with rows nobody ordered.

    Authenticated and lab-scoped like everything else: the template is
    unpublished sequence, and an endpoint that will design against anything
    for anybody is a free compute service with the lab's name on it.
    """
    try:
        result = primer_design.design(
            body.template,
            product_length=body.product_length,
            optimal_tm=body.optimal_tm,
            max_pairs=body.max_pairs,
        )
    except primer_design.DesignError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001 — the design libraries raise broadly
        log.exception("primer design failed for lab %s", ctx.scope.lab_id)
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"the design could not be run: {exc}",
        ) from exc

    return PrimerDesignResponse.model_validate(result)


# ---------------------------------------------------------------------------
# The library
# ---------------------------------------------------------------------------
@router.get("", response_model=Page[PrimerSummary])
async def list_primers(
    ctx: CtxDep,
    limit: Annotated[int, Query(ge=1, le=500)] = 100,
    offset: Annotated[int, Query(ge=0)] = 0,
    q: Annotated[str | None, Query(max_length=200, description="name, purpose or notes")] = None,
    sequence: Annotated[str | None, Query(max_length=200, description="exact sequence")] = None,
    mine: Annotated[bool, Query()] = False,
) -> Page[PrimerSummary]:
    """The library, searchable three ways.

    `q` is the one people use: it covers name, purpose and notes, so "gRNA
    cloning" or "colony PCR" finds the oligos somebody labelled that way.

    `sequence` is an exact match, and answers a different question — have we
    already made this one? Ordering a duplicate of a primer that is already in
    the freezer is a common and annoying waste, and there is an index on
    (lab_id, sequence) precisely so this is cheap.
    """
    base = ctx.scope.mine(Primer) if mine else ctx.scope.visible(Primer)

    if sequence:
        cleaned = "".join(sequence.split()).upper()
        base = base.where(Primer.sequence == cleaned)
    if q:
        like = f"%{q}%"
        base = base.where(
            sa.or_(
                Primer.name.ilike(like),
                Primer.purpose.ilike(like),
                Primer.notes.ilike(like),
            )
        )

    total = await ctx.session.scalar(
        sa.select(sa.func.count()).select_from(base.order_by(None).subquery())
    )
    rows = (
        await ctx.session.execute(
            base.order_by(Primer.name).limit(limit).offset(offset)
        )
    ).scalars().all()
    return Page(
        items=[PrimerSummary.model_validate(r) for r in rows],
        total=int(total or 0),
        limit=limit,
        offset=offset,
    )


@router.get("/{primer_id}", response_model=PrimerRead)
async def get_primer(primer_id: uuid.UUID, ctx: CtxDep) -> PrimerRead:
    return PrimerRead.model_validate(await _load_visible(ctx, primer_id))


@router.post("", response_model=PrimerRead, status_code=status.HTTP_201_CREATED)
async def create_primer(body: PrimerCreate, ctx: WriterDep) -> PrimerRead:
    primer = Primer(**ctx.scope.stamp(body.model_dump()))
    ctx.session.add(primer)
    await ctx.session.flush()
    # length_nt is a generated column, so the database is the only place that
    # knows it until we ask.
    await ctx.session.refresh(primer)
    return PrimerRead.model_validate(primer)


@router.patch("/{primer_id}", response_model=PrimerRead)
async def update_primer(
    primer_id: uuid.UUID, body: PrimerUpdate, ctx: WriterDep
) -> PrimerRead:
    primer = await _load_visible(ctx, primer_id)
    if not ctx.scope.may_edit(primer):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="only the owner, or a lab admin, may change this primer",
        )
    changes = body.model_dump(exclude_unset=True)
    for field, value in changes.items():
        setattr(primer, field, value)
    await ctx.session.flush()
    await ctx.session.refresh(primer)
    return PrimerRead.model_validate(primer)


@router.post(
    "/{primer_id}/bindings",
    response_model=PrimerBindingRead,
    status_code=status.HTTP_201_CREATED,
)
async def add_binding(
    primer_id: uuid.UUID, body: PrimerBindingCreate, ctx: WriterDep
) -> PrimerBindingRead:
    """Record that this primer is used with that plasmid.

    Both ends are checked against the scope rather than trusted from the body:
    a binding is a row that joins two tables, and without checking the plasmid
    the request could file one of our primers against another lab's construct
    — which the policies would refuse, but with a silent zero-row refusal
    rather than something a person can read.
    """
    primer = await _load_visible(ctx, primer_id)
    if not ctx.scope.may_edit(primer):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="only the owner, or a lab admin, may attach this primer",
        )

    plasmid = (
        await ctx.session.execute(
            ctx.scope.visible(Plasmid).where(Plasmid.id == body.plasmid_id)
        )
    ).scalar_one_or_none()
    if plasmid is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="no such plasmid, or it is not shared with you",
        )

    binding = PrimerBinding(primer_id=primer.id, **body.model_dump())
    ctx.session.add(binding)
    await ctx.session.flush()
    return PrimerBindingRead.model_validate(binding)


@router.delete("/{primer_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_primer(primer_id: uuid.UUID, ctx: WriterDep) -> Response:
    """Soft delete. The bindings stay in the table and stop being returned,
    because the experiments that cite this oligo still happened."""
    primer = await _load_visible(ctx, primer_id)
    if not ctx.scope.may_edit(primer):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="only the owner, or a lab admin, may delete this primer",
        )
    result = await ctx.session.execute(
        sa.update(Primer)
        .where(Primer.id == primer_id, Primer.deleted_at.is_(None))
        .values(deleted_at=sa.func.now())
    )
    if result.rowcount == 0:
        raise _NOT_FOUND
    return Response(status_code=status.HTTP_204_NO_CONTENT)
