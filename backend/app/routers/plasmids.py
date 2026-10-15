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
from app.models import FeatureType, Plasmid, SequenceFeature
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


def _to_read(plasmid: Plasmid, features: list[SequenceFeatureRead]) -> PlasmidRead:
    """Build the response without touching Plasmid.features.

    Every relationship on every model is lazy="raise", so that a forgotten
    join fails loudly instead of quietly issuing one query per row. Pydantic's
    from_attributes reads every field it knows about, and PlasmidRead knows
    about `features` — so validating the ORM object directly walks straight
    into that guard. Correctly: the features it would have lazily loaded are
    the ones _features() already fetched, in one query and in a defined order.

    So the columns are read by name and the features passed in.
    """
    data = {c.name: getattr(plasmid, c.name) for c in Plasmid.__table__.columns}
    return PlasmidRead(**data, features=features)


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
    return _to_read(plasmid, await _features(ctx, plasmid_id))


async def _coerce_feature_types(ctx: Ctx, features: list[dict]) -> None:
    """Map feature keys the vocabulary does not have onto misc_feature.

    sequence_feature.type_key is a foreign key into feature_type, which holds
    fourteen curated keys. Real files do not: GenBank's own key list runs to
    dozens, and `source` — which appears in essentially every GenBank file —
    is not among the fourteen. Without this, importing almost any real file
    fails on a foreign key violation, which is how this was found.

    Coercing rather than rejecting, because the alternative is an import that
    refuses whole plasmids over one annotation nobody was looking at. The
    original key goes into the note, so nothing is actually lost and a later
    pass can promote it if the lab decides it matters.

    Done here rather than in the browser so that every client gets it, and so
    that the vocabulary can change without a frontend release.
    """
    if not features:
        return
    known = set(
        (await ctx.session.execute(sa.select(FeatureType.key))).scalars().all()
    )
    for f in features:
        key = f.get("type_key") or "misc_feature"
        if key in known:
            continue
        note = f.get("note")
        f["note"] = f"original feature key: {key}" + (f" — {note}" if note else "")
        f["type_key"] = "misc_feature"


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
    await _coerce_feature_types(ctx, features)

    values = ctx.scope.stamp(data)
    plasmid = Plasmid(**values)
    ctx.session.add(plasmid)
    await ctx.session.flush()

    for f in features:
        ctx.session.add(SequenceFeature(plasmid_id=plasmid.id, annotated_by=ctx.scope.user_id, **f))
    await ctx.session.flush()
    await ctx.session.refresh(plasmid)

    return _to_read(plasmid, await _features(ctx, plasmid.id))


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
