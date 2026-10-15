"""Guide RNAs: sgRNAs, pegRNAs, and the oligos that clone them.

Same shape as primers, and for the same reason — the lab designs guides in the
notebook, and the molecular tool should be able to find them again rather than
have somebody retype a 20-mer.

The finding is in js/plasmid.js (findGuides, designPegRNA, off-target
scoring). This stores what was designed and chosen: the spacer, the PAM, where
it cuts, and for a pegRNA the extension that was ordered.

A guide must target something — a plasmid we hold, a genomic locus, or both.
GuideRNACreate refuses one that does not, so the caller gets 422 and a sentence
naming the rule; the CHECK in the schema is the backstop for anything that does
not arrive through this API. Two copies of the rule, deliberately: the one that
produces a good error message and the one that cannot be bypassed.
"""
from __future__ import annotations

import uuid
from typing import Annotated

import sqlalchemy as sa
from fastapi import APIRouter, HTTPException, Query, Response, status

from app.deps import Ctx, CtxDep, WriterDep
from app.models import GuideOffTarget, GuideRNA, PegRNADetail
from app.schemas import (
    GuideOffTargetRead,
    GuideRNACreate,
    GuideRNARead,
    GuideRNASummary,
    GuideRNAUpdate,
    Page,
    PegRNADetailRead,
)

router = APIRouter(prefix="/api/guides", tags=["guides"])

_NOT_FOUND = HTTPException(
    status_code=status.HTTP_404_NOT_FOUND,
    detail="no such guide, or it is not shared with you",
)


async def _load_visible(ctx: Ctx, guide_id: uuid.UUID) -> GuideRNA:
    stmt = ctx.scope.visible(GuideRNA).where(GuideRNA.id == guide_id)
    guide = (await ctx.session.execute(stmt)).scalar_one_or_none()
    if guide is None:
        raise _NOT_FOUND
    return guide


def _to_read(
    guide: GuideRNA,
    pegrna: PegRNADetailRead | None,
    off_targets: list[GuideOffTargetRead],
) -> GuideRNARead:
    """Build the response without touching the relationships.

    Every relationship is lazy="raise", and GuideRNARead names both `pegrna`
    and `off_targets`, so validating the ORM object directly walks into that
    guard — the same way it did on plasmids, where it reached production code
    before a test caught it.
    """
    data = {c.name: getattr(guide, c.name) for c in GuideRNA.__table__.columns}
    return GuideRNARead(**data, pegrna=pegrna, off_targets=off_targets)


async def _detail(ctx: Ctx, guide_id: uuid.UUID) -> tuple:
    peg = (
        await ctx.session.execute(
            sa.select(PegRNADetail).where(PegRNADetail.guide_id == guide_id)
        )
    ).scalar_one_or_none()
    offs = (
        await ctx.session.execute(
            sa.select(GuideOffTarget)
            .where(GuideOffTarget.guide_id == guide_id)
            # Worst first: the one that matters is the off-target with fewest
            # mismatches, and a list sorted by insertion order buries it.
            .order_by(GuideOffTarget.mismatches)
        )
    ).scalars().all()
    return (
        PegRNADetailRead.model_validate(peg) if peg else None,
        [GuideOffTargetRead.model_validate(o) for o in offs],
    )


@router.get("", response_model=Page[GuideRNASummary])
async def list_guides(
    ctx: CtxDep,
    limit: Annotated[int, Query(ge=1, le=500)] = 100,
    offset: Annotated[int, Query(ge=0)] = 0,
    q: Annotated[str | None, Query(max_length=200, description="name, locus or notes")] = None,
    spacer: Annotated[str | None, Query(max_length=40, description="exact spacer")] = None,
    target_plasmid_id: Annotated[uuid.UUID | None, Query()] = None,
    mine: Annotated[bool, Query()] = False,
) -> Page[GuideRNASummary]:
    """The guide library.

    `target_plasmid_id` is what the molecular tool uses: with a plasmid open,
    show the guides already designed against it. `spacer` answers the same
    question primers' `sequence` does — have we already made this one — and
    there is an index on (lab_id, spacer) for it.
    """
    base = ctx.scope.mine(GuideRNA) if mine else ctx.scope.visible(GuideRNA)

    if spacer:
        base = base.where(GuideRNA.spacer == "".join(spacer.split()).upper())
    if target_plasmid_id:
        base = base.where(GuideRNA.target_plasmid_id == target_plasmid_id)
    if q:
        like = f"%{q}%"
        base = base.where(
            sa.or_(
                GuideRNA.name.ilike(like),
                GuideRNA.target_locus.ilike(like),
                GuideRNA.target_genome.ilike(like),
                GuideRNA.notes.ilike(like),
            )
        )

    total = await ctx.session.scalar(
        sa.select(sa.func.count()).select_from(base.order_by(None).subquery())
    )
    rows = (
        await ctx.session.execute(
            base.order_by(GuideRNA.name).limit(limit).offset(offset)
        )
    ).scalars().all()
    return Page(
        items=[GuideRNASummary.model_validate(r) for r in rows],
        total=int(total or 0),
        limit=limit,
        offset=offset,
    )


@router.get("/{guide_id}", response_model=GuideRNARead)
async def get_guide(guide_id: uuid.UUID, ctx: CtxDep) -> GuideRNARead:
    guide = await _load_visible(ctx, guide_id)
    peg, offs = await _detail(ctx, guide_id)
    return _to_read(guide, peg, offs)


@router.post("", response_model=GuideRNARead, status_code=status.HTTP_201_CREATED)
async def create_guide(body: GuideRNACreate, ctx: WriterDep) -> GuideRNARead:
    """Create a guide, and its prime-editing extension if it has one.

    pegrna_detail is a separate table with NOT NULL columns rather than a
    handful of nullable ones here, so the two are written together or not at
    all — which the single transaction around the request already guarantees.
    """
    data = body.model_dump()
    peg = data.pop("pegrna", None)

    guide = GuideRNA(**ctx.scope.stamp(data))
    ctx.session.add(guide)
    await ctx.session.flush()

    if peg:
        ctx.session.add(PegRNADetail(guide_id=guide.id, **peg))
        await ctx.session.flush()

    await ctx.session.refresh(guide)
    peg_read, offs = await _detail(ctx, guide.id)
    return _to_read(guide, peg_read, offs)


@router.patch("/{guide_id}", response_model=GuideRNARead)
async def update_guide(
    guide_id: uuid.UUID, body: GuideRNAUpdate, ctx: WriterDep
) -> GuideRNARead:
    guide = await _load_visible(ctx, guide_id)
    if not ctx.scope.may_edit(guide):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="only the owner, or a lab admin, may change this guide",
        )
    for field, value in body.model_dump(exclude_unset=True).items():
        setattr(guide, field, value)
    await ctx.session.flush()
    await ctx.session.refresh(guide)
    peg, offs = await _detail(ctx, guide_id)
    return _to_read(guide, peg, offs)


@router.delete("/{guide_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_guide(guide_id: uuid.UUID, ctx: WriterDep) -> Response:
    guide = await _load_visible(ctx, guide_id)
    if not ctx.scope.may_edit(guide):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="only the owner, or a lab admin, may delete this guide",
        )
    result = await ctx.session.execute(
        sa.update(GuideRNA)
        .where(GuideRNA.id == guide_id, GuideRNA.deleted_at.is_(None))
        .values(deleted_at=sa.func.now())
    )
    if result.rowcount == 0:
        raise _NOT_FOUND
    return Response(status_code=status.HTTP_204_NO_CONTENT)
