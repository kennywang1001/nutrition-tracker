from collections.abc import Sequence
from datetime import UTC, datetime
from decimal import Decimal
from itertools import count

from sqlalchemy.ext.asyncio import AsyncSession

from app.models.food import BaseUnit, Food, FoodPortion, FoodRevision, RevisionStatus
from app.models.meal import Meal, MealItem, MealType
from app.models.user import User, UserRole
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
) -> Meal:
    """建立一餐，items 收 (food_revision, quantity_g) 序列，直接寫入 quantity_g。

    這裡繞過 API 的 food_id -> current_revision_id 解析與份量換算 ——
    工廠的目的是佈置測試資料，不是重新驗證 POST /api/meals 的安全邏輯。
    quantity 欄位（只用於顯示）在這裡跟 quantity_g 給同一個值，因為工廠
    呼叫端關心的是換算結果，不是「使用者當時輸入的份量數字」。
    """
    meal = Meal(
        user_id=user.id,
        eaten_at=eaten_at or _DEFAULT_EATEN_AT,
        meal_type=meal_type,
        note=note,
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
