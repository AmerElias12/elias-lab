"""The numbers on the landing page.

A view model rather than a domain schema, which is why it lives next to the
route that returns it instead of in schemas.py: it exists to fill a panel, and
it changes when the panel changes.

Every count goes through ctx.scope, so these are counts of what *this* person
can see — a read-only guest and the PI get different totals for the same lab,
which is correct. A dashboard built on unscoped counts tells people how much
work exists that they are not allowed to open.
"""
from __future__ import annotations

import sqlalchemy as sa
from fastapi import APIRouter
from pydantic import BaseModel

from app.deps import CtxDep
from app.models import GuideRNA, LabMember, NotebookEntry, Plasmid, Primer

router = APIRouter(prefix="/api/dashboard", tags=["dashboard"])


class RecentEntry(BaseModel):
    id: str
    title: str
    updated_at: str


class DashboardRead(BaseModel):
    entries: int
    my_entries: int
    drafts: int
    plasmids: int
    primers: int
    guides: int
    members: int
    recent: list[RecentEntry]


@router.get("", response_model=DashboardRead)
async def dashboard(ctx: CtxDep) -> DashboardRead:
    async def count(stmt: sa.Select) -> int:
        # order_by(None) because a COUNT over a subquery carrying an ORDER BY
        # is both pointless and, with some plans, rejected.
        total = await ctx.session.scalar(
            sa.select(sa.func.count()).select_from(stmt.order_by(None).subquery())
        )
        return int(total or 0)

    visible_entries = ctx.scope.visible(NotebookEntry)
    recent_rows = (
        await ctx.session.execute(
            visible_entries.order_by(NotebookEntry.updated_at.desc()).limit(5)
        )
    ).scalars().all()

    return DashboardRead(
        entries=await count(ctx.scope.visible(NotebookEntry)),
        my_entries=await count(ctx.scope.mine(NotebookEntry)),
        drafts=await count(
            ctx.scope.mine(NotebookEntry).where(NotebookEntry.status == "draft")
        ),
        plasmids=await count(ctx.scope.visible(Plasmid)),
        primers=await count(ctx.scope.visible(Primer)),
        guides=await count(ctx.scope.visible(GuideRNA)),
        # lab_member has no deleted_at and no sharing flag, so it is queried
        # directly rather than through visible(); its own policy limits it to
        # the lab the request is scoped to.
        members=await count(
            sa.select(LabMember).where(LabMember.lab_id == ctx.scope.lab_id)
        ),
        recent=[
            RecentEntry(id=str(r.id), title=r.title, updated_at=r.updated_at.isoformat())
            for r in recent_rows
        ],
    )
