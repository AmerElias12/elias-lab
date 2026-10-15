"""Amplifications and assemblies: the designs, kept.

js/plasmid.js works out the product of a PCR and the primers for a Gibson;
until now that work lived for as long as the tab stayed open. These routes
store the result.

What is stored, and what is not
-------------------------------
Not the arithmetic. The product sequence arrives already computed, including
the awkward case where an amplicon runs across the origin of a circular
plasmid, and recomputing it here would be a second answer to the same
question — with the usual consequence that the two eventually disagree and
nobody can say which is right.

What is stored is the design as it was at the time: the primers, the template,
the expected product, the overlaps. The template can be edited afterwards, and
then the same primers no longer give the same product — which is exactly why
this is a row and not a function. A gel that disagrees with the row is the
interesting case, and it only exists if the row does.

Provenance stays where it was. plasmid_lineage already records that a
construct came from its parents; an assembly records how it was *meant* to be
made. The two answer different questions: what happened, and what was planned.
"""
from __future__ import annotations

import uuid
from typing import Annotated

import sqlalchemy as sa
from fastapi import APIRouter, HTTPException, Query, Response, status

from app.deps import Ctx, CtxDep, WriterDep
from app.models import Assembly, AssemblyFragment, Plasmid, Primer, PrimerPair
from app.schemas import (
    AssemblyCreate,
    AssemblyFragmentRead,
    AssemblyRead,
    AssemblySummary,
    AssemblyUpdate,
    Page,
    PcrCreate,
    PcrRead,
    PcrUpdate,
)

pcr_router = APIRouter(prefix="/api/pcr", tags=["constructions"])
assembly_router = APIRouter(prefix="/api/assemblies", tags=["constructions"])


async def _owned_primer(ctx: Ctx, primer_id: uuid.UUID) -> Primer:
    """Primers are referenced by id from the body, so each one is checked
    against the scope. The policies would refuse a cross-lab reference anyway,
    but with a silent zero-row refusal rather than something a person reads."""
    primer = (
        await ctx.session.execute(ctx.scope.visible(Primer).where(Primer.id == primer_id))
    ).scalar_one_or_none()
    if primer is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"no primer {primer_id}, or it is not shared with you",
        )
    return primer


async def _visible_plasmid_or_404(ctx: Ctx, plasmid_id: uuid.UUID | None) -> None:
    if plasmid_id is None:
        return
    found = (
        await ctx.session.execute(ctx.scope.visible(Plasmid).where(Plasmid.id == plasmid_id))
    ).scalar_one_or_none()
    if found is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="no such plasmid, or it is not shared with you",
        )


# ---------------------------------------------------------------------------
# PCR
# ---------------------------------------------------------------------------
@pcr_router.get("", response_model=Page[PcrRead])
async def list_pcr(
    ctx: CtxDep,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    offset: Annotated[int, Query(ge=0)] = 0,
    template_plasmid_id: Annotated[uuid.UUID | None, Query()] = None,
    q: Annotated[str | None, Query(max_length=200)] = None,
) -> Page[PcrRead]:
    """Amplifications, newest first.

    `template_plasmid_id` is what the map asks: with this plasmid open, which
    reactions were designed against it.
    """
    base = ctx.scope.visible(PrimerPair)
    if template_plasmid_id:
        base = base.where(PrimerPair.template_plasmid_id == template_plasmid_id)
    if q:
        like = f"%{q}%"
        base = base.where(sa.or_(PrimerPair.name.ilike(like), PrimerPair.notes.ilike(like)))

    total = await ctx.session.scalar(
        sa.select(sa.func.count()).select_from(base.order_by(None).subquery())
    )
    rows = (
        await ctx.session.execute(
            base.order_by(PrimerPair.updated_at.desc()).limit(limit).offset(offset)
        )
    ).scalars().all()
    return Page(
        items=[PcrRead.model_validate(r) for r in rows],
        total=int(total or 0),
        limit=limit,
        offset=offset,
    )


@pcr_router.get("/{pcr_id}", response_model=PcrRead)
async def get_pcr(pcr_id: uuid.UUID, ctx: CtxDep) -> PcrRead:
    row = (
        await ctx.session.execute(ctx.scope.visible(PrimerPair).where(PrimerPair.id == pcr_id))
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="no such PCR")
    return PcrRead.model_validate(row)


@pcr_router.post("", response_model=PcrRead, status_code=status.HTTP_201_CREATED)
async def create_pcr(body: PcrCreate, ctx: WriterDep) -> PcrRead:
    await _owned_primer(ctx, body.forward_primer_id)
    await _owned_primer(ctx, body.reverse_primer_id)
    await _visible_plasmid_or_404(ctx, body.template_plasmid_id)

    data = body.model_dump()
    # Filling this in is a courtesy, not a computation: if the caller sent the
    # product it already knows how long it is, and if it sent neither there is
    # nothing to infer.
    if data.get("expected_bp") is None and data.get("product_sequence"):
        data["expected_bp"] = len(data["product_sequence"])

    pcr = PrimerPair(**ctx.scope.stamp(data))
    ctx.session.add(pcr)
    await ctx.session.flush()
    await ctx.session.refresh(pcr)
    return PcrRead.model_validate(pcr)


@pcr_router.patch("/{pcr_id}", response_model=PcrRead)
async def update_pcr(pcr_id: uuid.UUID, body: PcrUpdate, ctx: WriterDep) -> PcrRead:
    row = (
        await ctx.session.execute(ctx.scope.visible(PrimerPair).where(PrimerPair.id == pcr_id))
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="no such PCR")
    if not ctx.scope.may_edit(row):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="only the owner, or a lab admin, may change this",
        )
    changes = body.model_dump(exclude_unset=True)
    if "product_plasmid_id" in changes:
        await _visible_plasmid_or_404(ctx, changes["product_plasmid_id"])
    for field, value in changes.items():
        setattr(row, field, value)
    await ctx.session.flush()
    await ctx.session.refresh(row)
    return PcrRead.model_validate(row)


@pcr_router.delete("/{pcr_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_pcr(pcr_id: uuid.UUID, ctx: WriterDep) -> Response:
    result = await ctx.session.execute(
        sa.update(PrimerPair)
        .where(PrimerPair.id == pcr_id, PrimerPair.deleted_at.is_(None))
        .values(deleted_at=sa.func.now())
    )
    if result.rowcount == 0:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="no such PCR")
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ---------------------------------------------------------------------------
# Assemblies
# ---------------------------------------------------------------------------
async def _fragments(ctx: Ctx, assembly_id: uuid.UUID) -> list[AssemblyFragmentRead]:
    rows = (
        await ctx.session.execute(
            sa.select(AssemblyFragment)
            .where(AssemblyFragment.assembly_id == assembly_id)
            .order_by(AssemblyFragment.ordinal)
        )
    ).scalars().all()
    return [AssemblyFragmentRead.model_validate(r) for r in rows]


def _to_read(assembly: Assembly, fragments: list[AssemblyFragmentRead]) -> AssemblyRead:
    """Built from columns, not from the ORM object: Assembly.fragments is
    lazy="raise" and AssemblyRead names it."""
    data = {c.name: getattr(assembly, c.name) for c in Assembly.__table__.columns}
    return AssemblyRead(**data, fragments=fragments, fragment_count=len(fragments))


@assembly_router.get("", response_model=Page[AssemblySummary])
async def list_assemblies(
    ctx: CtxDep,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    offset: Annotated[int, Query(ge=0)] = 0,
    product_plasmid_id: Annotated[uuid.UUID | None, Query()] = None,
    uses_plasmid_id: Annotated[
        uuid.UUID | None, Query(description="assemblies with this plasmid as a fragment")
    ] = None,
    q: Annotated[str | None, Query(max_length=200)] = None,
) -> Page[AssemblySummary]:
    """Assemblies, newest first.

    Two different questions about one plasmid, and both get asked: what was
    this construct built by (`product_plasmid_id`), and what has it been used
    to build (`uses_plasmid_id`).
    """
    base = ctx.scope.visible(Assembly)
    if product_plasmid_id:
        base = base.where(Assembly.product_plasmid_id == product_plasmid_id)
    if uses_plasmid_id:
        base = base.where(
            sa.exists().where(
                sa.and_(
                    AssemblyFragment.assembly_id == Assembly.id,
                    AssemblyFragment.source_plasmid_id == uses_plasmid_id,
                )
            )
        )
    if q:
        like = f"%{q}%"
        base = base.where(sa.or_(Assembly.name.ilike(like), Assembly.notes.ilike(like)))

    total = await ctx.session.scalar(
        sa.select(sa.func.count()).select_from(base.order_by(None).subquery())
    )
    rows = (
        await ctx.session.execute(
            base.order_by(Assembly.updated_at.desc()).limit(limit).offset(offset)
        )
    ).scalars().all()

    counts = dict(
        (
            await ctx.session.execute(
                sa.select(AssemblyFragment.assembly_id, sa.func.count())
                .where(AssemblyFragment.assembly_id.in_([r.id for r in rows] or [uuid.uuid4()]))
                .group_by(AssemblyFragment.assembly_id)
            )
        ).all()
    )
    items = []
    for r in rows:
        summary = AssemblySummary.model_validate(r)
        summary.fragment_count = counts.get(r.id, 0)
        items.append(summary)
    return Page(items=items, total=int(total or 0), limit=limit, offset=offset)


@assembly_router.get("/{assembly_id}", response_model=AssemblyRead)
async def get_assembly(assembly_id: uuid.UUID, ctx: CtxDep) -> AssemblyRead:
    row = (
        await ctx.session.execute(
            ctx.scope.visible(Assembly).where(Assembly.id == assembly_id)
        )
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="no such assembly")
    return _to_read(row, await _fragments(ctx, assembly_id))


@assembly_router.post("", response_model=AssemblyRead, status_code=status.HTTP_201_CREATED)
async def create_assembly(body: AssemblyCreate, ctx: WriterDep) -> AssemblyRead:
    """Store a design and its ordered fragments in one transaction.

    Every plasmid and primer a fragment names is checked against the scope
    first. A design is only useful if the things it points at are things the
    reader can also open.
    """
    data = body.model_dump()
    fragments = data.pop("fragments", [])

    await _visible_plasmid_or_404(ctx, data.get("product_plasmid_id"))
    for f in fragments:
        await _visible_plasmid_or_404(ctx, f.get("source_plasmid_id"))
        for key in ("forward_primer_id", "reverse_primer_id"):
            if f.get(key):
                await _owned_primer(ctx, f[key])

    if data.get("product_bp") is None and data.get("product_sequence"):
        data["product_bp"] = len(data["product_sequence"])

    assembly = Assembly(**ctx.scope.stamp(data))
    ctx.session.add(assembly)
    await ctx.session.flush()
    for f in fragments:
        ctx.session.add(AssemblyFragment(assembly_id=assembly.id, **f))
    await ctx.session.flush()
    await ctx.session.refresh(assembly)
    return _to_read(assembly, await _fragments(ctx, assembly.id))


@assembly_router.patch("/{assembly_id}", response_model=AssemblyRead)
async def update_assembly(
    assembly_id: uuid.UUID, body: AssemblyUpdate, ctx: WriterDep
) -> AssemblyRead:
    row = (
        await ctx.session.execute(
            ctx.scope.visible(Assembly).where(Assembly.id == assembly_id)
        )
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="no such assembly")
    if not ctx.scope.may_edit(row):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="only the owner, or a lab admin, may change this",
        )
    changes = body.model_dump(exclude_unset=True)
    if "product_plasmid_id" in changes:
        await _visible_plasmid_or_404(ctx, changes["product_plasmid_id"])
    for field, value in changes.items():
        setattr(row, field, value)
    await ctx.session.flush()
    await ctx.session.refresh(row)
    return _to_read(row, await _fragments(ctx, assembly_id))


@assembly_router.delete("/{assembly_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_assembly(assembly_id: uuid.UUID, ctx: WriterDep) -> Response:
    """Soft delete. The fragments stay attached — an assembly without its
    pieces is not a record of anything."""
    result = await ctx.session.execute(
        sa.update(Assembly)
        .where(Assembly.id == assembly_id, Assembly.deleted_at.is_(None))
        .values(deleted_at=sa.func.now())
    )
    if result.rowcount == 0:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="no such assembly")
    return Response(status_code=status.HTTP_204_NO_CONTENT)
