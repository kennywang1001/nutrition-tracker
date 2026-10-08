from datetime import date

from fastapi import APIRouter, Depends, Query, status
from sqlalchemy import func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.api.params import ResourceId
from app.days import today_in_timezone
from app.db import get_db
from app.errors import ConflictError, NotFoundError, UnprocessableEntityError
from app.models.target import UserTarget
from app.models.user import User
from app.schemas.target import (
    TargetCreateRequest,
    TargetResponse,
    TargetTodayRequest,
    TargetUpdateRequest,
)

router = APIRouter(prefix="/targets", tags=["targets"])


def _to_response(target: UserTarget) -> TargetResponse:
    return TargetResponse(
        id=target.id,
        kcal=target.kcal,
        protein_g=target.protein_g,
        fat_g=target.fat_g,
        carb_g=target.carb_g,
        label=target.label,
        effective_from=target.effective_from,
        effective_to=target.effective_to,
    )


@router.post("", status_code=status.HTTP_201_CREATED, response_model=TargetResponse)
async def create_target(
    payload: TargetCreateRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> TargetResponse:
    target = UserTarget(
        user_id=user.id,
        kcal=payload.kcal,
        protein_g=payload.protein_g,
        fat_g=payload.fat_g,
        carb_g=payload.carb_g,
        label=payload.label,
        effective_from=payload.effective_from,
        effective_to=payload.effective_to,
    )
    db.add(target)
    try:
        await db.commit()
    except IntegrityError as exc:
        # ex_user_targets_no_overlap（決定 1）：同一個使用者的目標期間重疊。
        # rollback 是必要的（繼承規矩第 3 條）——少了它，這個 session 之後
        # 所有操作都會拋 PendingRollbackError。
        await db.rollback()
        raise ConflictError("TARGET_OVERLAPS", "這段期間已經有重疊的目標") from exc

    await db.refresh(target)
    return _to_response(target)


@router.get("", response_model=list[TargetResponse] | TargetResponse | None)
async def list_or_get_target(
    date: date | None = Query(default=None),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[TargetResponse] | TargetResponse | None:
    """規格第 7.6 節的兩行合在同一個路由裡，用 `date` 有沒有帶區分：

    - 沒帶 `date`：`GET /api/targets` 列出我所有的期間（陣列，含已關閉的）。
    - 帶了 `date`：`GET /api/targets?date=` 回那一天生效的那一筆，
      沒有則回 `null`——**200，不是 404**。「沒設目標」是正常狀態，不是
      「目標不存在所以出錯」；4b 的統計端點要能分辨「沒設目標」跟
      「這筆目標 id 不存在」，是完全不同的兩件事。

    「那一天生效」用半開區間判斷（`effective_from <= date < effective_to`，
    `effective_to IS NULL` 視為無窮遠的未來）——跟資料庫 EXCLUDE 約束用的
    `daterange(..., '[)')` 是同一個邊界規則，兩處不能有一處用 `<=`。
    """
    if date is None:
        targets = (
            await db.scalars(
                select(UserTarget)
                .where(UserTarget.user_id == user.id)
                .order_by(UserTarget.effective_from.desc(), UserTarget.id.desc())
            )
        ).all()
        return [_to_response(t) for t in targets]

    target = await db.scalar(
        select(UserTarget).where(
            UserTarget.user_id == user.id,
            UserTarget.effective_from <= date,
            or_(UserTarget.effective_to.is_(None), UserTarget.effective_to > date),
        )
    )
    return _to_response(target) if target is not None else None


async def _new_period_end(
    db: AsyncSession, user_id: int, today: date, current: UserTarget | None
) -> date | None:
    """新期間在哪一天結束（帳號設定規格決定 3）：有目前的期間就沿用它的結束日；沒有就是
    下一筆未來期間的開始日，再沒有就開放式。

    抽成函式也是測試的接縫：讓它回 None 就造得出「插入撞上別的期間」——平常只有兩台裝置
    同時存才會發生（`test_a_clash_is_409_and_writes_nothing`）。"""
    if current is not None:
        return current.effective_to
    next_start: date | None = await db.scalar(
        select(func.min(UserTarget.effective_from)).where(
            UserTarget.user_id == user_id, UserTarget.effective_from > today
        )
    )
    return next_start


@router.put("/today", response_model=TargetResponse)
async def set_target_from_today(
    payload: TargetTodayRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> TargetResponse:
    """從使用者的今天起，目標是這四個值；過去的日子維持原本的目標（帳號設定規格 §3.1）。

    「今天」由後端算（`today_in_timezone`）——前端不能自己算日界線。三種狀態一個端點：

    - **今天才開始的那一筆：原地改。** 期間是 `[from, to)`，它還沒有任何「過去的一天」，
      改它不會改寫歷史（§4.4 的「舊列數值永遠不動」保護的是過去的日子）。`PATCH` 做不到
      這件事——新的生效日 ≤ 舊的生效日會 422。
    - **更早開始的：關閉＋開新**，順序同 `update_target`（先 flush 關閉，EXCLUDE 才看得到）。
    - **沒有：開一筆新的。**

    並行不加鎖：資料庫的 EXCLUDE 保證不重疊，輸的一方整筆 rollback、409，重存一次就會走
    「原地改」（規格決定 5）。
    """
    today = today_in_timezone(user.timezone)

    current = await db.scalar(
        select(UserTarget).where(
            UserTarget.user_id == user.id,
            UserTarget.effective_from <= today,
            or_(UserTarget.effective_to.is_(None), UserTarget.effective_to > today),
        )
    )

    if current is not None and current.effective_from == today:
        current.kcal = payload.kcal
        current.protein_g = payload.protein_g
        current.fat_g = payload.fat_g
        current.carb_g = payload.carb_g
        await db.commit()
        await db.refresh(current)
        return _to_response(current)

    new_effective_to = await _new_period_end(db, user.id, today, current)
    label = current.label if current is not None else None
    if current is not None:
        current.effective_to = today
        await db.flush()  # 1. 先關舊的——順序不能換，見 update_target

    new_target = UserTarget(
        user_id=user.id,
        kcal=payload.kcal,
        protein_g=payload.protein_g,
        fat_g=payload.fat_g,
        carb_g=payload.carb_g,
        label=label,
        effective_from=today,
        effective_to=new_effective_to,
    )
    db.add(new_target)
    try:
        await db.flush()  # 2. 再開新的
    except IntegrityError as exc:
        # rollback 連上面的關閉一起復原：不會留下「舊的關了、新的沒開」。
        await db.rollback()
        raise ConflictError(
            "TARGET_CONFLICT", "目標剛被另一台裝置改過，請重新整理再試"
        ) from exc

    await db.commit()
    await db.refresh(new_target)
    return _to_response(new_target)


async def _load_owned_target(db: AsyncSession, target_id: int, user: User) -> UserTarget:
    """依擁有權載入一筆目標；不存在或不是自己的，一律回同一種 404
    （繼承規矩第 1 條），比照 `supplement_plans._load_owned_plan`。
    """
    target = await db.scalar(
        select(UserTarget).where(UserTarget.id == target_id, UserTarget.user_id == user.id)
    )
    if target is None:
        raise NotFoundError("TARGET_NOT_FOUND", "找不到該目標")
    return target


@router.patch("/{target_id}", response_model=TargetResponse)
async def update_target(
    target_id: ResourceId,
    payload: TargetUpdateRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> TargetResponse:
    """修改一筆目標 —— 決定 1：不是原地修改，是「關閉舊期間、開新期間」。

    舊列的四個營養素、label 完全不動，只有 effective_to 被設成新期間的
    起始日。這正是有效期間制的意義：三月的目標值必須維持「三月當時設的值」，
    `/stats/range`（Task 8）才能用「當天生效的目標」算歷史達成率，不能用
    改完之後的最新值重算過去。

    **順序不能換**（陷阱 3 已在 supplement_plans 實測、這裡同構）：
    EXCLUDE 約束逐列立即檢查，UPDATE 舊列一定要先 flush，INSERT 新列的
    檢查才看得到已經關閉的舊期間；反過來的話新舊兩列會重疊，直接違反約束。
    """
    target = await _load_owned_target(db, target_id, user)

    updates = payload.model_dump(exclude_unset=True)
    new_effective_from = updates.pop("effective_from", None) or today_in_timezone(user.timezone)
    # 省略跟顯式 null 對 effective_to 而言效果相同（都合法、都代表開放式），
    # `.pop(key, None)` 剛好兩種情況都回傳 None，不需要另外分支處理。
    new_effective_to = updates.pop("effective_to", None)

    # 跟資料庫的 effective_range CHECK（effective_to > effective_from）同一條
    # 規則：這個生效日會變成舊列的 effective_to。
    if new_effective_from <= target.effective_from:
        raise UnprocessableEntityError(
            "EFFECTIVE_DATE_TOO_EARLY", "生效日必須晚於目前這筆目標的生效日"
        )
    # effective_from 省略時要到這裡才算出最終值（today_in_timezone），
    # TargetUpdateRequest 的驗證器只能擋「兩個都明確送」的情況，這裡補上
    # 涵蓋「effective_from 省略、effective_to 明確送」的組合。
    if new_effective_to is not None and new_effective_to <= new_effective_from:
        raise UnprocessableEntityError(
            "EFFECTIVE_RANGE_INVALID", "effective_to 必須晚於 effective_from"
        )

    kcal = updates.get("kcal", target.kcal)
    protein_g = updates.get("protein_g", target.protein_g)
    fat_g = updates.get("fat_g", target.fat_g)
    carb_g = updates.get("carb_g", target.carb_g)
    label = updates.get("label", target.label)

    target.effective_to = new_effective_from
    await db.flush()  # 1. UPDATE 舊列 —— 必須先執行，見上面的說明

    new_target = UserTarget(
        user_id=user.id,
        kcal=kcal,
        protein_g=protein_g,
        fat_g=fat_g,
        carb_g=carb_g,
        label=label,
        effective_from=new_effective_from,
        effective_to=new_effective_to,
    )
    db.add(new_target)
    try:
        await db.flush()  # 2. INSERT 新列
    except IntegrityError as exc:
        # 新期間撞上另一筆既有目標。rollback 是必要的（繼承規矩第 3 條）：
        # 這裡兩個 flush 都還沒 commit，rollback 會把上面那個 UPDATE 也一併
        # 復原——交易要嘛整筆成功、要嘛完全不留下「舊列已關閉但新列沒開成」
        # 的半吊子狀態。
        await db.rollback()
        raise ConflictError("TARGET_OVERLAPS", "這段期間已經有重疊的目標") from exc

    await db.commit()
    await db.refresh(new_target)
    return _to_response(new_target)
