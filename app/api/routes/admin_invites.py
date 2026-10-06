from datetime import UTC, datetime

from fastapi import APIRouter, Depends, status
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from app.api.deps import require_admin
from app.api.params import ResourceId
from app.db import get_db
from app.errors import ConflictError, NotFoundError
from app.invites import INVITE_LIFETIME, hash_invite_token, new_invite_token
from app.models.invite import Invite
from app.models.user import User
from app.schemas.invite import (
    InviteCreatedResponse,
    InviteCreateRequest,
    InviteListItem,
    InviteUser,
)

router = APIRouter(prefix="/admin/invites", tags=["admin"])


@router.post("", status_code=status.HTTP_201_CREATED, response_model=InviteCreatedResponse)
async def create_invite(
    payload: InviteCreateRequest,
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> InviteCreatedResponse:
    token = new_invite_token()
    now = datetime.now(UTC)
    invite = Invite(
        token_hash=hash_invite_token(token),
        note=payload.note,
        created_by=admin.id,
        created_at=now,
        expires_at=now + INVITE_LIFETIME,
    )
    db.add(invite)
    await db.commit()
    await db.refresh(invite)
    # 明碼只在這個回應裡出現一次（規格 §3.2）：資料庫只有雜湊，之後任何端點都拿不回來。
    return InviteCreatedResponse(
        id=invite.id, token=token, note=invite.note, expires_at=invite.expires_at
    )


@router.get("", response_model=list[InviteListItem])
async def list_invites(
    _: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> list[InviteListItem]:
    redeemer = aliased(User)
    rows = (
        await db.execute(
            select(Invite, redeemer)
            .outerjoin(redeemer, Invite.used_by == redeemer.id)
            # 列出還能用的與已經用掉的；過期沒用的與撤銷的不列（規格 §3.2）。
            .where(
                Invite.revoked_at.is_(None),
                or_(Invite.used_at.is_not(None), Invite.expires_at > func.now()),
            )
            .order_by(Invite.created_at.desc(), Invite.id.desc())
        )
    ).all()

    return [
        InviteListItem(
            id=invite.id,
            note=invite.note,
            status="used" if invite.used_at is not None else "pending",
            created_at=invite.created_at,
            expires_at=invite.expires_at,
            used_at=invite.used_at,
            used_by=(
                InviteUser(display_name=user.display_name, email=user.email)
                if user is not None
                else None
            ),
        )
        for invite, user in rows
    ]


@router.delete("/{invite_id}", status_code=status.HTTP_204_NO_CONTENT)
async def revoke_invite(
    invite_id: ResourceId,
    _: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> None:
    # FOR UPDATE：跟註冊的條件式 UPDATE 搶同一列時排隊。對方先用掉 → 這裡看到
    # used_at（409）；這裡先撤銷 → 對方的條件不成立（INVITE_INVALID）。
    # 資料庫的 CHECK（不會同時用掉又撤銷）是最後一道。
    invite = await db.scalar(
        select(Invite)
        .where(Invite.id == invite_id, Invite.revoked_at.is_(None))
        .with_for_update()
    )
    if invite is None:
        raise NotFoundError("INVITE_NOT_FOUND", "找不到這個邀請")
    if invite.used_at is not None:
        raise ConflictError("INVITE_USED", "這個邀請已經有人用過了，不能撤銷")
    invite.revoked_at = datetime.now(UTC)
    await db.commit()
