from collections.abc import Sequence
from datetime import UTC, date, datetime
from decimal import Decimal
from itertools import count

from sqlalchemy.ext.asyncio import AsyncSession

from app.invites import INVITE_LIFETIME, hash_invite_token, new_invite_token
from app.models.expense import Expense, ExpenseCategory
from app.models.food import BaseUnit, Food, FoodPortion, FoodRevision, RevisionStatus
from app.models.friendship import Friendship, FriendshipStatus
from app.models.invite import Invite
from app.models.meal import Meal, MealItem, MealType
from app.models.password_reset import PasswordResetToken
from app.models.supplement import Supplement, SupplementIntake, SupplementPlan, TimeOfDay
from app.models.target import UserTarget
from app.models.user import User, UserRole
from app.password_resets import RESET_LIFETIME, hash_reset_token, new_reset_token
from app.security.password import hash_password

DEFAULT_PASSWORD = "correct-horse-battery"

_email_counter = count(1)


def _next_email() -> str:
    return f"user{next(_email_counter)}@example.com"


async def create_user(
    db_session: AsyncSession,
    *,
    email: str | None = None,
    password: str = DEFAULT_PASSWORD,
    display_name: str = "測試使用者",
    role: UserRole = UserRole.USER,
) -> User:
    user = User(
        email=email or _next_email(),
        password_hash=hash_password(password),
        display_name=display_name,
        role=role,
    )
    db_session.add(user)
    await db_session.commit()
    # 嚴格來說這行是多餘的：測試 session 設了 expire_on_commit=False，屬性不會過期，
    # 而 PostgreSQL 的 INSERT 走 RETURNING，id / created_at 在 commit 當下就填好了。
    # 保留是為了穩健 —— 日後若有欄位是靠 trigger 或 generated column 產生的，
    # RETURNING 不一定涵蓋得到，那時這行就有意義了。測試工廠寧可多一次查詢。
    await db_session.refresh(user)
    return user


_food_counter = count(1)


async def create_food(
    db_session: AsyncSession,
    *,
    created_by: User,
    name: str | None = None,
    brand: str | None = None,
    owner: User | None = None,
    kcal: Decimal | int = 100,
    protein_g: Decimal | int = 10,
    fat_g: Decimal | int = 5,
    carb_g: Decimal | int = 20,
    base_unit: BaseUnit = BaseUnit.G,
) -> Food:
    """建立食物與它的第一版營養素，並把指標指過去。

    owner=None 代表全域食物。第一版一律是 approved —— 未審核的食物
    連 current_revision_id 都沒有，等於不存在。
    """
    food = Food(
        name=name or f"測試食物{next(_food_counter)}",
        brand=brand,
        owner_id=owner.id if owner is not None else None,
        created_by=created_by.id,
    )
    db_session.add(food)
    await db_session.flush()

    revision = FoodRevision(
        food_id=food.id,
        base_unit=base_unit,
        kcal=Decimal(kcal),
        protein_g=Decimal(protein_g),
        fat_g=Decimal(fat_g),
        carb_g=Decimal(carb_g),
        status=RevisionStatus.APPROVED,
        created_by=created_by.id,
        reviewed_by=created_by.id,
        reviewed_at=datetime.now(UTC),
    )
    db_session.add(revision)
    await db_session.flush()

    food.current_revision_id = revision.id
    await db_session.commit()
    await db_session.refresh(food)
    return food


async def create_pending_revision(
    db_session: AsyncSession,
    *,
    food: Food,
    created_by: User,
    kcal: Decimal | int = 999,
    protein_g: Decimal | int = 99,
    fat_g: Decimal | int = 99,
    carb_g: Decimal | int = 99,
    change_note: str | None = "測試用的編輯提案",
) -> FoodRevision:
    revision = FoodRevision(
        food_id=food.id,
        kcal=Decimal(kcal),
        protein_g=Decimal(protein_g),
        fat_g=Decimal(fat_g),
        carb_g=Decimal(carb_g),
        status=RevisionStatus.PENDING,
        change_note=change_note,
        created_by=created_by.id,
    )
    db_session.add(revision)
    await db_session.commit()
    await db_session.refresh(revision)
    return revision


async def create_portion(
    db_session: AsyncSession,
    *,
    food: Food,
    label: str = "1 碗",
    grams: Decimal | int = 200,
    owner: User | None = None,
    is_default: bool = False,
) -> FoodPortion:
    portion = FoodPortion(
        food_id=food.id,
        owner_id=owner.id if owner is not None else None,
        label=label,
        grams=Decimal(grams),
        is_default=is_default,
    )
    db_session.add(portion)
    await db_session.commit()
    await db_session.refresh(portion)
    return portion


# 固定時刻，不用 datetime.now()：依賴日界線的測試會因為「現在幾點」隨機失敗，
# 而且失敗的樣子像 flaky，不像 bug，很難查（見計畫 3 Task 6）。
_DEFAULT_EATEN_AT = datetime(2026, 1, 1, 12, 0, tzinfo=UTC)


async def create_meal(
    db_session: AsyncSession,
    *,
    user: User,
    eaten_at: datetime | None = None,
    meal_type: MealType = MealType.LUNCH,
    items: Sequence[tuple[FoodRevision, Decimal | int]] | None = None,
    note: str | None = None,
    description: str | None = None,
    photo_path: str | None = None,
) -> Meal:
    """建立一餐，items 收 (food_revision, quantity_g) 序列，直接寫入 quantity_g。

    這裡繞過 API 的 food_id -> current_revision_id 解析與份量換算 ——
    工廠的目的是佈置測試資料，不是重新驗證 POST /api/meals 的安全邏輯。
    quantity 欄位（只用於顯示）在這裡跟 quantity_g 給同一個值，因為工廠
    呼叫端關心的是換算結果，不是「使用者當時輸入的份量數字」。

    `photo_path`：直接寫進 `meals.photo_path`，不經過 `save_photo()` ——
    P4 Task 6 的孤兒照片清理測試需要「DB 引用一個相對路徑」而不在乎那個
    路徑背後的檔案內容是什麼。
    """
    meal = Meal(
        user_id=user.id,
        eaten_at=eaten_at or _DEFAULT_EATEN_AT,
        meal_type=meal_type,
        note=note,
        description=description,
        photo_path=photo_path,
    )
    db_session.add(meal)
    await db_session.flush()

    for revision, quantity_g in items or []:
        db_session.add(
            MealItem(
                meal_id=meal.id,
                food_revision_id=revision.id,
                quantity=Decimal(quantity_g),
                quantity_g=Decimal(quantity_g),
            )
        )

    await db_session.commit()
    await db_session.refresh(meal)
    return meal


_supplement_counter = count(1)


async def create_supplement(
    db_session: AsyncSession,
    *,
    created_by: User,
    name: str | None = None,
    brand: str | None = None,
    owner: User | None = None,
    serving_unit: str = "capsule",
    serving_size: Decimal | int = 1,
    kcal: Decimal | int = 0,
    protein_g: Decimal | int = 0,
    fat_g: Decimal | int = 0,
    carb_g: Decimal | int = 0,
) -> Supplement:
    """owner=None 代表全域補劑（比照 create_food）。

    四個營養素預設為 0：魚油那種「只記錄吃了沒，不記熱量」的補劑就是這個形狀
    （計畫決定 1 附帶的情境），不用每次呼叫都特地餵值。
    """
    supplement = Supplement(
        name=name or f"測試補劑{next(_supplement_counter)}",
        brand=brand,
        owner_id=owner.id if owner is not None else None,
        serving_unit=serving_unit,
        serving_size=Decimal(serving_size),
        kcal=Decimal(kcal),
        protein_g=Decimal(protein_g),
        fat_g=Decimal(fat_g),
        carb_g=Decimal(carb_g),
        created_by=created_by.id,
    )
    db_session.add(supplement)
    await db_session.commit()
    await db_session.refresh(supplement)
    return supplement


# 固定值，不用 date.today()：依賴日界線的測試會因為「今天是哪天」隨機失敗
# （見計畫 Task 3 的說明，跟 _DEFAULT_EATEN_AT 是同一個理由）。
_DEFAULT_EFFECTIVE_FROM = date(2026, 1, 1)


async def create_plan(
    db_session: AsyncSession,
    *,
    user: User,
    supplement: Supplement,
    dose: Decimal | int = 1,
    time_of_day: TimeOfDay = TimeOfDay.MORNING,
    effective_from: date | None = None,
    effective_to: date | None = None,
) -> SupplementPlan:
    plan = SupplementPlan(
        user_id=user.id,
        supplement_id=supplement.id,
        dose=Decimal(dose),
        time_of_day=time_of_day,
        effective_from=effective_from or _DEFAULT_EFFECTIVE_FROM,
        effective_to=effective_to,
    )
    db_session.add(plan)
    await db_session.commit()
    await db_session.refresh(plan)
    return plan


_DEFAULT_TAKEN_AT = datetime(2026, 1, 1, 8, 0, tzinfo=UTC)


async def create_intake(
    db_session: AsyncSession,
    *,
    user: User,
    supplement: Supplement,
    plan: SupplementPlan | None = None,
    dose: Decimal | int = 1,
    taken_at: datetime | None = None,
    kcal: Decimal | int = 0,
    protein_g: Decimal | int = 0,
    fat_g: Decimal | int = 0,
    carb_g: Decimal | int = 0,
) -> SupplementIntake:
    """四個營養素欄位直接收值，不在工廠裡幫忙乘 dose ——

    工廠的目的是佈置測試資料，不是重新驗證 POST /api/supplement-intakes 的
    快照邏輯（計畫決定 3）。呼叫端要「已乘過 dose 的總量」就自己算好傳進來，
    跟 create_meal 對 quantity_g 的取捨一致。
    """
    intake = SupplementIntake(
        user_id=user.id,
        supplement_id=supplement.id,
        plan_id=plan.id if plan is not None else None,
        dose=Decimal(dose),
        taken_at=taken_at or _DEFAULT_TAKEN_AT,
        kcal=Decimal(kcal),
        protein_g=Decimal(protein_g),
        fat_g=Decimal(fat_g),
        carb_g=Decimal(carb_g),
    )
    db_session.add(intake)
    await db_session.commit()
    await db_session.refresh(intake)
    return intake


async def create_target(
    db_session: AsyncSession,
    *,
    user: User,
    kcal: Decimal | int | None = 2000,
    protein_g: Decimal | int | None = None,
    fat_g: Decimal | int | None = None,
    carb_g: Decimal | int | None = None,
    label: str | None = None,
    effective_from: date | None = None,
    effective_to: date | None = None,
) -> UserTarget:
    """四個營養素皆可為 NULL（陷阱 3：規格第 6.5 節允許只設熱量目標）——

    預設只給 kcal，其餘三個留 None，剛好對應「只設熱量目標」這個最常見的
    測試情境；呼叫端要三大營養素的話自己餵值。

    effective_from 沿用 create_plan 的 _DEFAULT_EFFECTIVE_FROM（固定值，不用
    date.today()）——依賴日界線的測試會因為「今天是哪天」隨機失敗。
    """
    target = UserTarget(
        user_id=user.id,
        kcal=Decimal(kcal) if kcal is not None else None,
        protein_g=Decimal(protein_g) if protein_g is not None else None,
        fat_g=Decimal(fat_g) if fat_g is not None else None,
        carb_g=Decimal(carb_g) if carb_g is not None else None,
        label=label,
        effective_from=effective_from or _DEFAULT_EFFECTIVE_FROM,
        effective_to=effective_to,
    )
    db_session.add(target)
    await db_session.commit()
    await db_session.refresh(target)
    return target


# 固定時刻，不用 datetime.now()：依賴月界線的測試會因為「現在是幾月」
# 隨機失敗，跟 _DEFAULT_EATEN_AT 是同一個理由。
# 刻意挑 12 月：12 月進位是 month_bounds 唯一會寫錯的地方（見 app/days.py）。
_DEFAULT_SPENT_AT = datetime(2026, 12, 15, 12, 0, tzinfo=UTC)


async def create_expense(
    db_session: AsyncSession,
    *,
    user: User,
    amount: Decimal | int = 100,
    category: ExpenseCategory = ExpenseCategory.OTHER,
    spent_at: datetime | None = None,
    note: str | None = None,
    meal: Meal | None = None,
) -> Expense:
    """建立一筆支出。

    `category` 預設 OTHER 而不是 FOOD：FOOD 是「從記一餐建出來的」那條路徑
    的專屬分類，工廠預設用它會讓「手動記的花費」與「餐費」在測試裡混在一起。
    """
    expense = Expense(
        user_id=user.id,
        meal_id=meal.id if meal is not None else None,
        category=category,
        amount=Decimal(amount),
        spent_at=spent_at or _DEFAULT_SPENT_AT,
        note=note,
    )
    db_session.add(expense)
    await db_session.commit()
    await db_session.refresh(expense)
    return expense


async def create_invite(
    db_session: AsyncSession,
    *,
    created_by: User,
    note: str | None = None,
    created_at: datetime | None = None,
    expires_at: datetime | None = None,
    used_by: User | None = None,
    revoked: bool = False,
) -> tuple[Invite, str]:
    """建立一張邀請，回傳（邀請, 明碼邀請碼）——跟正式流程一樣，明碼只存在回傳值裡。

    過期的邀請要連 `created_at` 一起往前推：`CHECK (expires_at > created_at)`
    不讓「剛建立就已經過期」成立。
    """
    token = new_invite_token()
    created = created_at or datetime.now(UTC)
    invite = Invite(
        token_hash=hash_invite_token(token),
        note=note,
        created_by=created_by.id,
        created_at=created,
        expires_at=expires_at or created + INVITE_LIFETIME,
        used_at=created if used_by is not None else None,
        used_by=used_by.id if used_by is not None else None,
        revoked_at=created if revoked else None,
    )
    db_session.add(invite)
    await db_session.commit()
    await db_session.refresh(invite)
    return invite, token


async def create_password_reset(
    db_session: AsyncSession,
    *,
    user: User,
    created_by: User,
    created_at: datetime | None = None,
    expires_at: datetime | None = None,
    used: bool = False,
    revoked: bool = False,
) -> tuple[PasswordResetToken, str]:
    """建立一條重設連結，回傳（連結, 明碼）——同 `create_invite`，明碼只存在回傳值裡。

    過期的連結要連 `created_at` 一起往前推：`CHECK (expires_at > created_at)`。"""
    token = new_reset_token()
    created = created_at or datetime.now(UTC)
    reset = PasswordResetToken(
        user_id=user.id,
        token_hash=hash_reset_token(token),
        created_by=created_by.id,
        created_at=created,
        expires_at=expires_at or created + RESET_LIFETIME,
        used_at=created if used else None,
        revoked_at=created if revoked else None,
    )
    db_session.add(reset)
    await db_session.commit()
    await db_session.refresh(reset)
    return reset, token


async def create_friendship(
    db_session: AsyncSession,
    first: User,
    second: User,
    *,
    status: FriendshipStatus = FriendshipStatus.ACCEPTED,
    requested_by: User | None = None,
) -> Friendship:
    """一對朋友（預設已接受）。`requested_by` 省略時是 `first`。"""
    user_a, user_b = sorted((first.id, second.id))
    friendship = Friendship(
        user_a=user_a,
        user_b=user_b,
        requested_by=(requested_by or first).id,
        status=status,
        accepted_at=datetime.now(UTC) if status is FriendshipStatus.ACCEPTED else None,
    )
    db_session.add(friendship)
    await db_session.commit()
    await db_session.refresh(friendship)
    return friendship
