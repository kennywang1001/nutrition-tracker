import logging
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import require_admin
from app.api.params import ResourceId
from app.db import get_db
from app.errors import NotFoundError, UnprocessableEntityError
from app.models.password_reset import PasswordResetToken
from app.models.user import User, UserRole
from app.password_resets import (
    RESET_LIFETIME,
    hash_reset_token,
    new_reset_token,
    revoke_live_resets,
)
from app.schemas.password_reset import PasswordResetCreatedResponse
from app.schemas.user import AdminUserItem

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/admin/users", tags=["admin"])


@router.get("", response_model=list[AdminUserItem])
async def list_users(
    _: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> list[AdminUserItem]:
    """所有帳號（帳號設定規格 §3.3）。帳號只有個位數，不分頁。"""
    users = (await db.scalars(select(User).order_by(User.id))).all()
    return [
        AdminUserItem(id=u.id, email=u.email, display_name=u.display_name, role=u.role)
        for u in users
    ]


@router.post(
    "/{user_id}/password-reset",
    status_code=status.HTTP_201_CREATED,
    response_model=PasswordResetCreatedResponse,
)
async def create_password_reset(
    user_id: ResourceId,
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> PasswordResetCreatedResponse:
    """替一般使用者產生一次性重設密碼連結（帳號設定規格 §3.4）。

    **FOR UPDATE 那個使用者列**：同一個人的兩次「產生」排隊，後到的看得到先到的那一列並把它
    撤銷——不然兩邊各自撤銷「看得到的」舊連結、各插一條，留下兩條活的。真正的最後一道是
    部分唯一索引 `uq_password_reset_tokens_one_live_per_user`（搶輸會是 IntegrityError）。
    這段 FOR UPDATE 沒有並行測試（要兩條真的連線搶鎖；同 revoke_invite 的取捨）。

    **只給一般使用者**（規格決定 12）：偷到管理員 access token 的人不能用它接管管理員帳號；
    管理員改自己的密碼用 `/api/me/password`，別的管理員用 CLI。
    """
    target = await db.scalar(select(User).where(User.id == user_id).with_for_update())
    if target is None:
        raise NotFoundError("USER_NOT_FOUND", "找不到這個帳號")
    if target.role is UserRole.ADMIN:
        raise UnprocessableEntityError(
            "RESET_NOT_FOR_ADMINS",
            "管理員帳號不能用重設連結：自己的密碼請用「修改密碼」，其他管理員請用命令列",
        )

    # 先撤銷再插入：過期但沒撤銷的那條也算「活的」（部分唯一索引不看時間），不撤銷就插不進去。
    await revoke_live_resets(db, target.id)
    token = new_reset_token()
    now = datetime.now(UTC)
    reset = PasswordResetToken(
        user_id=target.id,
        token_hash=hash_reset_token(token),
        created_by=admin.id,
        created_at=now,
        expires_at=now + RESET_LIFETIME,
    )
    db.add(reset)
    await db.commit()
    await db.refresh(reset)
    # 稽核：只寫 id，**不寫碼、不寫 email**（規格 §6）。
    logger.info(
        "管理員 %s 產生了使用者 %s 的重設密碼連結（reset_id=%s）", admin.id, target.id, reset.id
    )
    return PasswordResetCreatedResponse(token=token, expires_at=reset.expires_at)
