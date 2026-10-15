"""Notebook entry CRUD.

Two habits run through this module, both of them consequences of row-level
security rather than style preferences:

  * Reads go through ctx.scope, never through a bare select(). The scope adds
    the lab filter and the ownership filter; the database would apply its own
    regardless, but a query that disagrees with the policy returns a short page
    with no error, which is worse to debug than a refusal.

  * A write that matches no rows is a 404, not a success. A policy's USING
    clause filters rather than raises, so an UPDATE the caller is not allowed
    to make reports zero rows affected and no exception. Code that only
    catches exceptions calls that a successful save. See docs/eln-rls.sql §11.

Nothing here commits. The transaction opened in deps.get_ctx holds the
`SET LOCAL` identity, and committing mid-request would drop it and leave the
rest of the handler unable to see anything.
"""
from __future__ import annotations

import uuid
from typing import Annotated, Any

import sqlalchemy as sa
from fastapi import APIRouter, HTTPException, Query, Response, status

from app.deps import Ctx, CtxDep, WriterDep
from app.models import NotebookEntry, NotebookEntryVersion
from app.schemas import (
    EntryVersionRead,
    NotebookEntryCreate,
    NotebookEntryRead,
    NotebookEntrySummary,
    NotebookEntryUpdate,
    Page,
)
from app.security import SNAPSHOT_FIELDS, content_hash

router = APIRouter(prefix="/api/entries", tags=["notebook"])

# One message for both "no such entry" and "not yours to see". Separating them
# would let someone probe for the existence of another group's work by id.
_NOT_FOUND = HTTPException(
    status_code=status.HTTP_404_NOT_FOUND,
    detail="no such entry, or it is not shared with you",
)


def _snapshot(entry: NotebookEntry) -> dict[str, Any]:
    return {field: getattr(entry, field) for field in SNAPSHOT_FIELDS}


async def _append_version(ctx: Ctx, entry: NotebookEntry, change_note: str | None) -> None:
    """Record the entry as it now stands.

    Append-only by construction: notebook_entry_version has an INSERT policy
    and no UPDATE or DELETE policy, and the grants were revoked as well, so
    this is the only thing that can happen to a version row.
    """
    snapshot = _snapshot(entry)
    await ctx.session.execute(
        sa.insert(NotebookEntryVersion).values(
            entry_id=entry.id,
            version_no=entry.current_version,
            change_note=change_note,
            content_sha256=content_hash(snapshot),
            created_by=ctx.scope.user_id,
            **snapshot,
        )
    )


async def _load_visible(ctx: Ctx, entry_id: uuid.UUID) -> NotebookEntry:
    stmt = ctx.scope.visible(NotebookEntry).where(NotebookEntry.id == entry_id)
    entry = (await ctx.session.execute(stmt)).scalar_one_or_none()
    if entry is None:
        raise _NOT_FOUND
    return entry


def _require_editable(ctx: Ctx, entry: NotebookEntry) -> None:
    """Readable is not editable.

    A shared entry is readable by the whole lab and writable only by its author
    (or a lab admin). Checked here so the caller gets 403 with a reason —
    without it the database would simply match zero rows and the honest answer
    would be an indistinguishable 404.
    """
    if not ctx.scope.may_edit(entry):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="only the author, or a lab admin, may change this entry",
        )


# ---------------------------------------------------------------------------
# Read
# ---------------------------------------------------------------------------
@router.get("", response_model=Page[NotebookEntrySummary])
async def list_entries(
    ctx: CtxDep,
    limit: Annotated[int, Query(ge=1, le=100)] = 25,
    offset: Annotated[int, Query(ge=0)] = 0,
    q: Annotated[str | None, Query(max_length=200, description="full-text search")] = None,
    mine: Annotated[bool, Query(description="only entries I authored")] = False,
) -> Page[NotebookEntrySummary]:
    base = ctx.scope.mine(NotebookEntry) if mine else ctx.scope.visible(NotebookEntry)

    if q:
        # search_tsv is a generated column, so it is not on the model. The
        # query text stays a bound parameter: websearch_to_tsquery takes
        # whatever the user typed, including quotes and operators, as data.
        tsv = sa.literal_column("notebook_entry.search_tsv")
        base = base.where(tsv.op("@@")(sa.func.websearch_to_tsquery("english", q)))

    total = await ctx.session.scalar(
        sa.select(sa.func.count()).select_from(base.order_by(None).subquery())
    )
    rows = (
        await ctx.session.execute(
            base.order_by(
                # Most recently worked on first. performed_on is the date the
                # bench work happened and is often blank, so it cannot be the
                # primary sort.
                NotebookEntry.updated_at.desc()
            )
            .limit(limit)
            .offset(offset)
        )
    ).scalars().all()

    return Page(
        items=[NotebookEntrySummary.model_validate(r) for r in rows],
        total=int(total or 0),
        limit=limit,
        offset=offset,
    )


@router.get("/{entry_id}", response_model=NotebookEntryRead)
async def get_entry(entry_id: uuid.UUID, ctx: CtxDep) -> NotebookEntryRead:
    return NotebookEntryRead.model_validate(await _load_visible(ctx, entry_id))


@router.get("/{entry_id}/versions", response_model=list[EntryVersionRead])
async def list_versions(entry_id: uuid.UUID, ctx: CtxDep) -> list[EntryVersionRead]:
    """The entry's history. Reachable only if the entry itself is: the policy
    on notebook_entry_version is an EXISTS against notebook_entry, so this
    needs no lab filter of its own."""
    await _load_visible(ctx, entry_id)  # 404 before revealing a version count
    rows = (
        await ctx.session.execute(
            sa.select(NotebookEntryVersion)
            .where(NotebookEntryVersion.entry_id == entry_id)
            .order_by(NotebookEntryVersion.version_no.desc())
        )
    ).scalars().all()
    return [EntryVersionRead.model_validate(r) for r in rows]


# ---------------------------------------------------------------------------
# Write
# ---------------------------------------------------------------------------
@router.post("", response_model=NotebookEntryRead, status_code=status.HTTP_201_CREATED)
async def create_entry(body: NotebookEntryCreate, ctx: WriterDep) -> NotebookEntryRead:
    """Create an entry and its first version.

    lab_id and author_id come from the authenticated scope, not from the
    request body — NotebookEntryCreate has no field for either, so a client
    cannot file an entry into another lab or under a colleague's name.
    """
    values = ctx.scope.stamp(body.model_dump(), owner=False)
    entry = NotebookEntry(**values, author_id=ctx.scope.user_id)
    ctx.session.add(entry)
    # Flush to get the id and the server-side defaults, then refresh so the
    # response carries status, current_version and the timestamps as the
    # database set them rather than as Python guessed.
    await ctx.session.flush()
    await ctx.session.refresh(entry)
    await _append_version(ctx, entry, change_note="created")
    return NotebookEntryRead.model_validate(entry)


@router.patch("/{entry_id}", response_model=NotebookEntryRead)
async def update_entry(
    entry_id: uuid.UUID, body: NotebookEntryUpdate, ctx: WriterDep
) -> NotebookEntryRead:
    """Apply a partial update, and append a version if the content moved.

    exclude_unset is what makes this a PATCH: a field the client did not send
    is left alone, while a field sent as null is set to null. Conflating those
    two is how a form that only edits the title wipes everything else.
    """
    entry = await _load_visible(ctx, entry_id)
    _require_editable(ctx, entry)

    changes = body.model_dump(exclude_unset=True)
    change_note = changes.pop("change_note", None)
    if not changes:
        return NotebookEntryRead.model_validate(entry)

    before = _snapshot(entry)
    for field, value in changes.items():
        setattr(entry, field, value)

    # A new version only when something a signature would commit to actually
    # changed. Flipping is_shared, or saving a form unchanged, should not pad
    # the history with identical snapshots.
    content_moved = _snapshot(entry) != before
    if content_moved:
        entry.current_version = entry.current_version + 1

    await ctx.session.flush()
    if content_moved:
        await _append_version(ctx, entry, change_note=change_note)

    await ctx.session.refresh(entry)  # updated_at is set by a trigger
    return NotebookEntryRead.model_validate(entry)


@router.delete("/{entry_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_entry(entry_id: uuid.UUID, ctx: WriterDep) -> Response:
    """Soft delete: set deleted_at and leave the row.

    An ELN that can actually erase an entry is not a lab record, and the
    database agrees — plasmid.created_in_entry_id is ON DELETE RESTRICT, so an
    entry that produced a plasmid could not be removed even if this route
    tried. Everything reads through LabScope.select(), which filters
    deleted_at IS NULL, so a deleted entry disappears from the API while
    remaining in the history and the audit trail.
    """
    entry = await _load_visible(ctx, entry_id)
    _require_editable(ctx, entry)

    result = await ctx.session.execute(
        sa.update(NotebookEntry)
        .where(NotebookEntry.id == entry_id, NotebookEntry.deleted_at.is_(None))
        .values(deleted_at=sa.func.now())
    )
    if result.rowcount == 0:
        # Either it was deleted between the read and the write, or a policy
        # refused the update and said nothing. Both are a 404 to the caller,
        # and this is the check that turns a silent refusal into one.
        raise _NOT_FOUND
    return Response(status_code=status.HTTP_204_NO_CONTENT)
