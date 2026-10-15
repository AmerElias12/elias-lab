"""Plasmids: enough to put one in and draw it.

Phase 3 is the frontend viewer, and a viewer with nothing to view is a demo.
These routes exist so the map on the Plasmids page is the lab's own data
rather than a hardcoded example — list, read, create, delete, and no more.
Editing a sequence, importing GenBank, annotating, cloning and the rest stay
where they are for now.

`PlasmidRead` is already the shape static/js/vector-viewer.js accepts: a
`sequence`, a `topology`, and `features` carrying start_pos/end_pos/strand.
Nothing translates between them, which is deliberate — a translation layer is
somewhere for the two conventions to drift apart.
"""
from __future__ import annotations

import uuid
from typing import Annotated

import sqlalchemy as sa
from fastapi import APIRouter, HTTPException, Query, Response, status

from app.deps import Ctx, CtxDep, WriterDep
from app.models import Plasmid, SequenceFeature
from app.schemas import (
    Page,
    PlasmidCreate,
    PlasmidRead,
    PlasmidSummary,
    SequenceFeatureRead,
)

router = APIRouter(prefix="/api/plasmids", tags=["plasmids"])

_NOT_FOUND = HTTPException(
    status_code=status.HTTP_404_NOT_FOUND,
    detail="no such plasmid, or it is not shared with you",
)


async def _load_visible(ctx: Ctx, plasmid_id: uuid.UUID) -> Plasmid:
    stmt = ctx.scope.visible(Plasmid).where(Plasmid.id == plasmid_id)
    plasmid = (await ctx.session.execute(stmt)).scalar_one_or_none()
    if plasmid is None:
        raise _NOT_FOUND
    return plasmid


async def _features(ctx: Ctx, plasmid_id: uuid.UUID) -> list[SequenceFeatureRead]:
    """Ordered by position, so the viewer's lanes pack the same way twice and
    a map does not reshuffle itself between reloads."""
    rows = (
        await ctx.session.execute(
            sa.select(SequenceFeature)
            .where(SequenceFeature.plasmid_id == plasmid_id)
            .order_by(SequenceFeature.start_pos, SequenceFeature.end_pos)
        )
    ).scalars().all()
    return [SequenceFeatureRead.model_validate(r) for r in rows]


@router.get("", response_model=Page[PlasmidSummary])
async def list_plasmids(
    ctx: CtxDep,
    limit: Annotated[int, Query(ge=1, le=100)] = 50,
    offset: Annotated[int, Query(ge=0)] = 0,
    q: Annotated[str | None, Query(max_length=200)] = None,
    mine: Annotated[bool, Query()] = False,
) -> Page[PlasmidSummary]:
    base = ctx.scope.mine(Plasmid) if mine else ctx.scope.visible(Plasmid)
    if q:
        # Name and alias only. A sequence search is a different feature with
        # different indexes behind it, and pretending ILIKE is one would be
        # slow and wrong on a 10 kb column.
        like = f"%{q}%"
        base = base.where(sa.or_(Plasmid.name.ilike(like), Plasmid.alias.ilike(like)))

    total = await ctx.session.scalar(
        sa.select(sa.func.count()).select_from(base.order_by(None).subquery())
    )
    rows = (
        await ctx.session.execute(
            base.order_by(Plasmid.updated_at.desc()).limit(limit).offset(offset)
        )
    ).scalars().all()
    return Page(
        items=[PlasmidSummary.model_validate(r) for r in rows],
        total=int(total or 0),
        limit=limit,
        offset=offset,
    )


@router.get("/{plasmid_id}", response_model=PlasmidRead)
async def get_plasmid(plasmid_id: uuid.UUID, ctx: CtxDep) -> PlasmidRead:
    """The whole plasmid, sequence and features — what the map is drawn from."""
    plasmid = await _load_visible(ctx, plasmid_id)
    out = PlasmidRead.model_validate(plasmid)
    out.features = await _features(ctx, plasmid_id)
    return out


@router.post("", response_model=PlasmidRead, status_code=status.HTTP_201_CREATED)
async def create_plasmid(body: PlasmidCreate, ctx: WriterDep) -> PlasmidRead:
    """Create a plasmid and its features in one transaction.

    lab_id and owner_id come from the scope, never the body. The sequence has
    already been through `_clean_dna`, and the `dna_sequence` domain in the
    database will refuse it again if anything got past that — the two checks
    are not redundant, since only one of them is still there when somebody
    inserts a row by hand.
    """
    data = body.model_dump()
    features = data.pop("features", [])

    values = ctx.scope.stamp(data)
    plasmid = Plasmid(**values)
    ctx.session.add(plasmid)
    await ctx.session.flush()

    for f in features:
        ctx.session.add(SequenceFeature(plasmid_id=plasmid.id, annotated_by=ctx.scope.user_id, **f))
    await ctx.session.flush()
    await ctx.session.refresh(plasmid)

    out = PlasmidRead.model_validate(plasmid)
    out.features = await _features(ctx, plasmid.id)
    return out


@router.delete("/{plasmid_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_plasmid(plasmid_id: uuid.UUID, ctx: WriterDep) -> Response:
    """Soft delete, like entries. A plasmid that was made in a notebook entry
    keeps pointing at it either way; the row is what the entry's provenance
    refers to, so it stays."""
    plasmid = await _load_visible(ctx, plasmid_id)
    if not ctx.scope.may_edit(plasmid):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="only the owner, or a lab admin, may delete this plasmid",
        )
    result = await ctx.session.execute(
        sa.update(Plasmid)
        .where(Plasmid.id == plasmid_id, Plasmid.deleted_at.is_(None))
        .values(deleted_at=sa.func.now())
    )
    if result.rowcount == 0:
        raise _NOT_FOUND
    return Response(status_code=status.HTTP_204_NO_CONTENT)
