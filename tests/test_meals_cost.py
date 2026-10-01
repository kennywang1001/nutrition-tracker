"""記一餐時順手記下餐費（規格 §4）。

**這裡不測「支出插入失敗時餐點會回滾」**，理由見檔尾的說明——
那條路徑從 API 打不到，硬要測只能 mock，而 mock 出來的綠燈
證明的是 mock，不是交易。
"""

from decimal import Decimal

from sqlalchemy import func, select

from app.models.expense import Expense, ExpenseCategory
from app.models.meal import Meal
from app.security.tokens import create_access_token
from tests.factories import create_user


def auth(user):
    return {"Authorization": f"Bearer {create_access_token(user.id)}"}


async def test_creating_a_meal_with_cost_creates_a_linked_expense(client, db_session):
    user = await create_user(db_session)

    response = await client.post(
        "/api/meals",
        headers=auth(user),
        json={"eaten_at": "2026-12-15T12:00:00+08:00", "meal_type": "lunch", "cost": "180"},
    )

    assert response.status_code == 201
    meal_id = response.json()["id"]

    expense = await db_session.scalar(select(Expense))
    assert expense is not None
    assert expense.meal_id == meal_id
    assert expense.amount == Decimal("180.00")
    assert expense.category is ExpenseCategory.FOOD
    # spent_at 跟著 eaten_at 走，不是「現在」——否則跨月補記一餐會把錢
    # 記到這個月
    assert expense.spent_at.isoformat() == "2026-12-15T04:00:00+00:00"


async def test_creating_a_meal_without_cost_creates_no_expense(client, db_session):
    """cost 是選填的。沒帶就不建支出——自己煮的一餐沒有花錢（規格 §2.2）。"""
    user = await create_user(db_session)

    response = await client.post(
        "/api/meals",
        headers=auth(user),
        json={"eaten_at": "2026-12-15T12:00:00+08:00", "meal_type": "lunch"},
    )

    assert response.status_code == 201
    assert await db_session.scalar(select(func.count()).select_from(Expense)) == 0


async def test_meal_response_does_not_include_cost(client, db_session):
    """**刻意不在 MealResponse 裡回 cost。**

    要在回應裡帶 cost，讀取路徑（GET /api/meals、GET /api/meals/{id}）
    就得 LEFT JOIN expenses。不做的話，同一個 MealResponse 型別會在
    建立時有值、在讀取時永遠是 null——一個永遠說謊的欄位比沒有這個欄位更糟。

    金額的確認在 /expenses 頁看。真的需要每一餐都顯示金額時，
    那是一次獨立的改動（把 LEFT JOIN 加進三條讀取路徑），不是順手加一個欄位。
    """
    user = await create_user(db_session)

    response = await client.post(
        "/api/meals",
        headers=auth(user),
        json={"eaten_at": "2026-12-15T12:00:00+08:00", "meal_type": "lunch", "cost": "180"},
    )

    assert "cost" not in response.json()


async def test_rejected_cost_creates_neither_meal_nor_expense(client, db_session):
    """cost = 0 被 Pydantic 擋下來時，餐點也不能留下。

    這是「同一個交易」在 API 層唯一打得到的失敗路徑：驗證發生在
    任何寫入之前，所以兩者都不存在。

    **這條測試守的不是 rollback，是「驗證在寫入之前」。**
    真正的 DB 層交易回滾由結構保證（create_meal 只有一次 commit），
    不是由錯誤處理保證。
    """
    user = await create_user(db_session)

    response = await client.post(
        "/api/meals",
        headers=auth(user),
        json={"eaten_at": "2026-12-15T12:00:00+08:00", "meal_type": "lunch", "cost": "0"},
    )

    assert response.status_code == 422
    assert await db_session.scalar(select(func.count()).select_from(Meal)) == 0
    assert await db_session.scalar(select(func.count()).select_from(Expense)) == 0


async def test_create_meal_commits_exactly_once(client, db_session):
    """原始碼掃描：`create_meal` 裡只能有一次 `await db.commit()`。

    這是「餐點與支出要嘛都在、要嘛都不在」的**實際**保證。
    從 API 打不到「支出寫入失敗」那條路徑（amount 被 Pydantic 的 gt=0
    先擋掉），所以沒有辦法用行為測試證明回滾——能證明的只有結構：
    兩次寫入之間沒有 commit，就不可能有一半成功。

    **這條測試會在有人「順手」加第二次 commit 時變紅**，
    而那正是這個保證被破壞的方式。
    """
    import inspect

    from app.api.routes.meals import create_meal

    source = inspect.getsource(create_meal)
    assert source.count("await db.commit()") == 1
