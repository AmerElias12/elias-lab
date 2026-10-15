"""Who is in the lab, and what they may do.

Not in the original brief for this phase, but without it the sharing model has
no way to be used: every policy keys off lab_member, and nothing could write a
row to it. One PI with a notebook nobody else can reach is not the shared lab
record this was built for.

Roles, as the policies read them:
    owner      everything, including managing members
    admin      everything, including managing members
    member     create and edit their own records; read what the lab shares
    read_only  read what the lab shares; write nothing
"""
from __future__ import annotations

import uuid

import sqlalchemy as sa
from fastapi import APIRouter, HTTPException, Response, status
from sqlalchemy.exc import DBAPIError, IntegrityError

from app.db import LabRole
from app.deps import AdminDep, CtxDep
from app.schemas import MemberAdd, MemberRead, MemberRoleUpdate

router = APIRouter(prefix="/api/lab/members", tags=["lab"])


@router.get("", response_model=list[MemberRead])
async def list_members(ctx: CtxDep) -> list[MemberRead]:
    """Everyone in the lab this request is scoped to.

    Any member may see the roster — knowing who you share a notebook with is
    part of using it. The policies allow exactly this and no more: app_user
    rows are visible for people in your lab, not for the whole installation.
    """
    rows = (
        await ctx.session.execute(
            sa.text(
                "SELECT m.user_id, m.role, m.joined_at, u.full_name, u.email "
                "  FROM lab_member m JOIN app_user u ON u.id = m.user_id "
                " WHERE m.lab_id = :lab "
                " ORDER BY m.role, u.full_name"
            ),
            {"lab": ctx.scope.lab_id},
        )
    ).mappings().all()
    return [MemberRead.model_validate(dict(r)) for r in rows]


@router.post("", response_model=MemberRead, status_code=status.HTTP_201_CREATED)
async def add_member(body: MemberAdd, ctx: AdminDep) -> MemberRead:
    """Add an existing account to this lab.

    The person must have registered already — this does not create accounts,
    so an administrator cannot set someone's password for them and then know
    it. They sign up themselves and wait; this is the step that lets them in.
    """
    found = (
        await ctx.session.execute(
            sa.text("SELECT id, full_name, email FROM auth_find_user_by_email(:email)"),
            {"email": body.email},
        )
    ).mappings().one_or_none()
    if found is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="no active account with that email — ask them to register first",
        )
    if body.role is LabRole.owner:
        # Transferring ownership is a different operation with different
        # consequences; it is not a side effect of adding somebody.
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="add as admin, member or read_only; ownership is transferred separately",
        )

    try:
        await ctx.session.execute(
            sa.text(
                "INSERT INTO lab_member (lab_id, user_id, role) VALUES (:lab, :uid, :role)"
            ),
            {"lab": ctx.scope.lab_id, "uid": found["id"], "role": body.role.value},
        )
    except (IntegrityError, DBAPIError) as exc:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="that person is already in this lab",
        ) from exc

    row = (
        await ctx.session.execute(
            sa.text(
                "SELECT m.user_id, m.role, m.joined_at, u.full_name, u.email "
                "  FROM lab_member m JOIN app_user u ON u.id = m.user_id "
                " WHERE m.lab_id = :lab AND m.user_id = :uid"
            ),
            {"lab": ctx.scope.lab_id, "uid": found["id"]},
        )
    ).mappings().one()
    return MemberRead.model_validate(dict(row))


@router.patch("/{user_id}", response_model=MemberRead)
async def set_role(user_id: uuid.UUID, body: MemberRoleUpdate, ctx: AdminDep) -> MemberRead:
    """Change what somebody may do.

    An administrator may not change their own role. Otherwise the last owner
    can demote themselves and leave a lab that nobody can administer — and
    since only an administrator can promote, that state is unrecoverable
    without database access.
    """
    if user_id == ctx.scope.user_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="you cannot change your own role; ask another owner or admin",
        )
    if body.role is LabRole.owner:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="ownership is transferred separately",
        )

    result = await ctx.session.execute(
        sa.text(
            "UPDATE lab_member SET role = :role WHERE lab_id = :lab AND user_id = :uid"
        ),
        {"role": body.role.value, "lab": ctx.scope.lab_id, "uid": user_id},
    )
    if result.rowcount == 0:
        # Zero rows means either no such membership or a policy refusal, and a
        # USING clause refuses silently. Checking the count is what turns that
        # into an answer instead of a false success.
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="not a member of this lab")

    row = (
        await ctx.session.execute(
            sa.text(
                "SELECT m.user_id, m.role, m.joined_at, u.full_name, u.email "
                "  FROM lab_member m JOIN app_user u ON u.id = m.user_id "
                " WHERE m.lab_id = :lab AND m.user_id = :uid"
            ),
            {"lab": ctx.scope.lab_id, "uid": user_id},
        )
    ).mappings().one()
    return MemberRead.model_validate(dict(row))


@router.delete("/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
async def remove_member(user_id: uuid.UUID, ctx: AdminDep) -> Response:
    """Remove somebody from the lab.

    Their records stay. owner_id and author_id are ON DELETE SET NULL and
    RESTRICT respectively, and nothing here touches either — a departing
    student's entries remain the lab's record of what was done, which is the
    whole reason owner_id is nullable.
    """
    if user_id == ctx.scope.user_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="you cannot remove yourself from the lab",
        )
    result = await ctx.session.execute(
        sa.text("DELETE FROM lab_member WHERE lab_id = :lab AND user_id = :uid"),
        {"lab": ctx.scope.lab_id, "uid": user_id},
    )
    if result.rowcount == 0:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="not a member of this lab")
    return Response(status_code=status.HTTP_204_NO_CONTENT)
