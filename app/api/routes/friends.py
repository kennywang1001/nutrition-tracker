"""好友（好友規格）。

**好友的讀取全部在這個檔案，經過 `app/friend_visibility.py`。** 既有的端點
（`/api/meals`、`/api/expenses`…）的讀取一個都不放寬——它們照舊只回自己的資料
（規格 §1.2：放寬舊規則會讓好友看到生活花費與目標，而既有的 38 條隔離測試
照樣全綠）。`tests/test_friend_meals.py` 的掃描測試守著這件事。
"""

import base64
import binascii
import json
from collections import defaultdict
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date, datetime

from fastapi import APIRouter, Depends, Query, Response, status
from sqlalchemy import delete, func, literal, select, tuple_, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.concurrency import run_in_threadpool

from app.api.deps import get_current_user
from app.api.params import ResourceId
from app.days import day_bounds, today_in_timezone
from app.db import get_db
from app.errors import ConflictError, NotFoundError, UnprocessableEntityError
from app.friend_codes import format_friend_code, new_friend_code, normalize_friend_code
from app.friend_visibility import (
    friend_ids,
    involves,
    load_visible_friend,
    ordered_pair,
    other_side,
    shared_meals,
)
from app.meal_reads import item_join_query
from app.models.food import Food, FoodRevision
from app.models.friendship import Friendship, FriendshipStatus
from app.models.meal import Meal, MealItem
from app.models.user import User
from app.nutrition import Macros, scale, total
from app.schemas.friend import (
    FriendCodeResponse,
    FriendDayResponse,
    FriendFeedResponse,
    FriendMeal,
    FriendMealItem,
    FriendRequestCreate,
    FriendRequestItem,
    FriendRequestResult,
    FriendRequestsResponse,
    FriendResponse,
    PersonResponse,
)
from app.storage.photos import PhotoSize, read_photo_as

router = APIRouter(prefix="/friends", tags=["friends"])


@router.get("/me/code", response_model=FriendCodeResponse)
async def read_my_code(user: User = Depends(get_current_user)) -> FriendCodeResponse:
    return FriendCodeResponse(code=format_friend_code(user.friend_code))


@router.post("/me/code/reset", response_model=FriendCodeResponse)
async def reset_my_code(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> FriendCodeResponse:
    # 舊碼立刻失效：users 只有這一個欄位，沒有舊碼可查。已經成立的好友關係
    # 與還在等的邀請不受影響（它們存的是使用者 id，不是碼）。
    user.friend_code = new_friend_code()
    await db.commit()
    return FriendCodeResponse(code=format_friend_code(user.friend_code))


def _person(user: User) -> PersonResponse:
    return PersonResponse(id=user.id, display_name=user.display_name)


async def _load_pair(db: AsyncSession, user_a: int, user_b: int) -> Friendship | None:
    row: Friendship | None = await db.scalar(
        select(Friendship).where(Friendship.user_a == user_a, Friendship.user_b == user_b)
    )
    return row


@dataclass(frozen=True)
class _Accepted:
    since: datetime
    other_id: int


async def _accept(db: AsyncSession, friendship_id: int, receiver_id: int) -> _Accepted | None:
    """把一個**別人送給 `receiver_id`** 的邀請改成好友。條件寫在 UPDATE 裡：
    已經是好友、不是收件人、不存在 → 0 列 → None（同 `redeem_invite` 的寫法）。

    回應要用的值由 RETURNING 一起帶回：commit 之後再 join 回那一列，對方可能
    已經解除或刪了帳號，查不到就是 500。"""
    row = (
        await db.execute(
            update(Friendship)
            .where(
                Friendship.id == friendship_id,
                Friendship.status == FriendshipStatus.PENDING,
                Friendship.requested_by != receiver_id,
                involves(receiver_id),
            )
            .values(status=FriendshipStatus.ACCEPTED, accepted_at=func.now())
            .returning(Friendship.accepted_at, Friendship.user_a, Friendship.user_b)
        )
    ).one_or_none()
    if row is None:
        return None
    accepted_at, user_a, user_b = row
    assert accepted_at is not None
    return _Accepted(since=accepted_at, other_id=user_b if user_a == receiver_id else user_a)


@router.post("/requests", response_model=FriendRequestResult)
async def send_request(
    payload: FriendRequestCreate,
    response: Response,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> FriendRequestResult:
    target = await db.scalar(
        select(User).where(User.friend_code == normalize_friend_code(payload.code))
    )
    # 自己的碼與不存在的碼同一個錯誤（規格 §4.2）。
    if target is None or target.id == user.id:
        raise NotFoundError("FRIEND_CODE_NOT_FOUND", "找不到這個好友碼")

    # commit／rollback 之後 ORM 物件會過期：要用的值先存起來。
    user_id = user.id
    person = _person(target)
    user_a, user_b = ordered_pair(user_id, target.id)
    existing = await _load_pair(db, user_a, user_b)
    if existing is None:
        existing = await _insert_request(db, user_a, user_b, user_id)
        if existing is None:
            response.status_code = status.HTTP_201_CREATED
            return FriendRequestResult(status="pending", person=person)

    _refuse_if_settled(existing, user_id)
    # 對方已經邀過我：直接成為好友。
    if await _accept(db, existing.id, user_id) is not None:
        await db.commit()
        return FriendRequestResult(status="accepted", person=person)

    # 接受落空：對方剛好收回了邀請。重看那一對——沒有了就照新邀請建立；
    # 不能直接說「已經是好友」。
    await db.rollback()
    existing = await _load_pair(db, user_a, user_b)
    if existing is None:
        existing = await _insert_request(db, user_a, user_b, user_id)
        if existing is None:
            response.status_code = status.HTTP_201_CREATED
            return FriendRequestResult(status="pending", person=person)
    _refuse_if_settled(existing, user_id)
    # 對方收回之後又立刻重送：兩邊來回搶，請使用者再按一次。
    raise ConflictError("FRIEND_REQUEST_CHANGED", "對方剛好也在操作，請再試一次")


async def _insert_request(
    db: AsyncSession, user_a: int, user_b: int, requested_by: int
) -> Friendship | None:
    """新增一筆邀請並 commit → None。對方剛好同時送了邀請給我：唯一約束擋住
    這一列 → 回那一列（改走「既有那一列」）。"""
    db.add(
        Friendship(
            user_a=user_a,
            user_b=user_b,
            requested_by=requested_by,
            status=FriendshipStatus.PENDING,
        )
    )
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        existing = await _load_pair(db, user_a, user_b)
        if existing is None:
            raise
        return existing
    return None


def _refuse_if_settled(existing: Friendship, user_id: int) -> None:
    if existing.status is FriendshipStatus.ACCEPTED:
        raise ConflictError("ALREADY_FRIENDS", "你們已經是好友了")
    if existing.requested_by == user_id:
        raise ConflictError("REQUEST_PENDING", "已經送出邀請，等對方回應")


@router.get("/requests", response_model=FriendRequestsResponse)
async def list_requests(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> FriendRequestsResponse:
    rows = (
        await db.execute(
            select(Friendship, User)
            .join(User, User.id == other_side(user.id))
            .where(involves(user.id), Friendship.status == FriendshipStatus.PENDING)
            .order_by(Friendship.created_at.desc(), Friendship.id.desc())
        )
    ).all()
    incoming: list[FriendRequestItem] = []
    outgoing: list[FriendRequestItem] = []
    for friendship, other in rows:
        item = FriendRequestItem(
            id=friendship.id, person=_person(other), created_at=friendship.created_at
        )
        (outgoing if friendship.requested_by == user.id else incoming).append(item)
    return FriendRequestsResponse(incoming=incoming, outgoing=outgoing)


@router.post("/requests/{request_id}/accept", response_model=FriendResponse)
async def accept_request(
    request_id: ResourceId,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> FriendResponse:
    accepted = await _accept(db, request_id, user.id)
    if accepted is None:
        raise NotFoundError("FRIEND_REQUEST_NOT_FOUND", "找不到這個邀請")
    await db.commit()
    # 不 join 回 friendships：commit 之後對方可能已經解除（那一列沒了）。
    # 對方的帳號剛好刪掉 → 跟邀請不存在同一個 404。
    other = await db.get(User, accepted.other_id)
    if other is None:
        raise NotFoundError("FRIEND_REQUEST_NOT_FOUND", "找不到這個邀請")
    return FriendResponse(id=other.id, display_name=other.display_name, since=accepted.since)


@router.delete("/requests/{request_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_request(
    request_id: ResourceId,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> None:
    """收到的人＝拒絕、送出的人＝收回：同一個動作，刪掉那一列。"""
    deleted = await db.scalar(
        delete(Friendship)
        .where(
            Friendship.id == request_id,
            Friendship.status == FriendshipStatus.PENDING,
            involves(user.id),
        )
        .returning(Friendship.id)
    )
    if deleted is None:
        raise NotFoundError("FRIEND_REQUEST_NOT_FOUND", "找不到這個邀請")
    await db.commit()


@router.get("", response_model=list[FriendResponse])
async def list_friends(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[FriendResponse]:
    rows = (
        await db.execute(
            select(Friendship, User)
            .join(User, User.id == other_side(user.id))
            .where(involves(user.id), Friendship.status == FriendshipStatus.ACCEPTED)
            .order_by(User.display_name, User.id)
        )
    ).all()
    return [
        FriendResponse(id=other.id, display_name=other.display_name, since=friendship.accepted_at)
        for friendship, other in rows
        if friendship.accepted_at is not None
    ]


@router.delete("/{friend_id}", status_code=status.HTTP_204_NO_CONTENT)
async def unfriend(
    friend_id: ResourceId,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> None:
    user_a, user_b = ordered_pair(user.id, friend_id)
    deleted = await db.scalar(
        delete(Friendship)
        .where(
            Friendship.user_a == user_a,
            Friendship.user_b == user_b,
            Friendship.status == FriendshipStatus.ACCEPTED,
        )
        .returning(Friendship.id)
    )
    if deleted is None:
        raise NotFoundError("FRIEND_NOT_FOUND", "找不到這個好友")
    await db.commit()


def _encode_cursor(meal: Meal) -> str:
    raw = json.dumps({"t": meal.eaten_at.isoformat(), "id": meal.id}).encode()
    return base64.urlsafe_b64encode(raw).decode()


_MAX_BIGINT = 2**63 - 1


def _decode_cursor(cursor: str) -> tuple[datetime, int]:
    """分頁位置是用戶端送回來的：任何看不懂的形狀都是 422，不能變成 500。
    `json.loads` 收 `Infinity`（`int()` 會 OverflowError）、id 可能超出 bigint、
    時間可能沒有時區（跟 timestamptz 比會被當成別的時區）。"""
    invalid = UnprocessableEntityError("INVALID_CURSOR", "分頁位置看不懂，請重新整理")
    try:
        data = json.loads(base64.urlsafe_b64decode(cursor.encode()))
        eaten_at, meal_id = datetime.fromisoformat(data["t"]), int(data["id"])
    except (binascii.Error, ValueError, KeyError, TypeError, OverflowError) as exc:
        raise invalid from exc
    if eaten_at.tzinfo is None or not 0 < meal_id <= _MAX_BIGINT:
        raise invalid
    return eaten_at, meal_id


async def _friend_meals(
    db: AsyncSession, meals: Sequence[Meal], people: dict[int, User]
) -> list[FriendMeal]:
    """組 `FriendMeal`。營養素用跟 `MealResponse` 同一套（`scale`／`total`，釘住
    當時的 revision）。一次查完所有項目（`meal_id IN (...)`）。"""
    if not meals:
        return []
    rows = (
        await db.execute(
            item_join_query()
            .where(MealItem.meal_id.in_([meal.id for meal in meals]))
            .order_by(MealItem.id)
        )
    ).all()
    by_meal: dict[int, list[tuple[MealItem, FoodRevision, Food]]] = defaultdict(list)
    for item, revision, food in rows:
        by_meal[item.meal_id].append((item, revision, food))

    result: list[FriendMeal] = []
    for meal in meals:
        items: list[FriendMealItem] = []
        macros_list: list[Macros] = []
        for item, revision, food in by_meal[meal.id]:
            macros = scale(revision, item.quantity_g)
            macros_list.append(macros)
            items.append(
                FriendMealItem(food_name=food.name, quantity_g=item.quantity_g, kcal=macros.kcal)
            )
        totals = total(macros_list)
        result.append(
            FriendMeal(
                id=meal.id,
                user=_person(people[meal.user_id]),
                eaten_at=meal.eaten_at,
                meal_type=meal.meal_type,
                items=items,
                kcal=totals.kcal,
                protein_g=totals.protein_g,
                fat_g=totals.fat_g,
                carb_g=totals.carb_g,
                has_photo=meal.photo_path is not None,
            )
        )
    return result


@router.get("/feed", response_model=FriendFeedResponse)
async def friend_feed(
    before: str | None = Query(default=None, max_length=200),
    limit: int = Query(default=20, ge=1, le=50),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> FriendFeedResponse:
    ids = await friend_ids(db, user)
    if not ids:
        return FriendFeedResponse(meals=[], next_cursor=None)

    query = shared_meals(ids)
    if before is not None:
        eaten_at, meal_id = _decode_cursor(before)
        # (eaten_at, id) 一起比：同一個時間的兩餐跨頁不重複也不漏。
        query = query.where(
            tuple_(Meal.eaten_at, Meal.id)
            < tuple_(literal(eaten_at, Meal.eaten_at.type), literal(meal_id, Meal.id.type))
        )
    meals = (
        await db.scalars(query.order_by(Meal.eaten_at.desc(), Meal.id.desc()).limit(limit + 1))
    ).all()
    page = meals[:limit]
    people = {
        person.id: person
        for person in await db.scalars(select(User).where(User.id.in_({m.user_id for m in page})))
    }
    return FriendFeedResponse(
        meals=await _friend_meals(db, page, people),
        next_cursor=_encode_cursor(page[-1]) if len(meals) > limit else None,
    )


@router.get("/{friend_id}/meals", response_model=FriendDayResponse)
async def friend_day(
    friend_id: ResourceId,
    date: date | None = Query(default=None),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> FriendDayResponse:
    friend = await load_visible_friend(db, user, friend_id)
    # 「一天」照好友的時區切（規格 §4.3）——跟他自己看飲食頁同一條日界線。
    day = date or today_in_timezone(friend.timezone)
    start, end = day_bounds(day, friend.timezone)
    meals = (
        await db.scalars(
            shared_meals([friend.id])
            .where(Meal.eaten_at >= start, Meal.eaten_at < end)
            .order_by(Meal.eaten_at, Meal.id)
        )
    ).all()
    return FriendDayResponse(
        friend=_person(friend),
        day=day,
        meals=await _friend_meals(db, meals, {friend.id: friend}),
    )


@router.get("/{friend_id}/meals/{meal_id}/photo")
async def friend_meal_photo(
    friend_id: ResourceId,
    meal_id: ResourceId,
    size: PhotoSize = Query(default="full"),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> Response:
    """好友的照片。好友 id 與餐點 id 兩個都要對上：餐要屬於那個好友、而且不是
    「只有我看得到」——任何一項不成立都是同一個 MEAL_NOT_FOUND，不透露是哪一項。

    `size=thumb` 是縮圖（第一次可能要補做，所以在執行緒池裡跑）；授權規則不變。"""
    friend = await load_visible_friend(db, user, friend_id)
    meal = await db.scalar(shared_meals([friend.id]).where(Meal.id == meal_id))
    if meal is None:
        raise NotFoundError("MEAL_NOT_FOUND", "找不到該餐點")
    if meal.photo_path is None:
        raise NotFoundError("MEAL_PHOTO_NOT_FOUND", "這一餐沒有照片")
    try:
        content = await run_in_threadpool(read_photo_as, meal.photo_path, size)
    except FileNotFoundError as exc:
        raise NotFoundError("MEAL_PHOTO_NOT_FOUND", "這一餐沒有照片") from exc
    return Response(content=content, media_type="image/jpeg")
