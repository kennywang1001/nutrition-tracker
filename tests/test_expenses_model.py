"""資料庫層的約束與外鍵行為。

刻意不透過 API：這裡測的是 **PostgreSQL 真的會不會擋**，而 API 層的
Pydantic 驗證會在請求到達資料庫之前就攔下大部分非法值——透過 API 測
約束，測到的是 Pydantic，不是約束。
"""

from datetime import UTC, datetime
from decimal import Decimal

import pytest
from sqlalchemy import select, text
from sqlalchemy.exc import IntegrityError

from app.models.expense import Expense, ExpenseCategory
from tests.factories import create_expense, create_meal, create_user


async def test_amount_must_be_positive(db_session):
    """ck_expenses_amount_positive 真的擋得住 0。

    注意這裡繞過了 Pydantic（直接建 ORM 物件）——那正是重點：
    約束是第二道防線，第二道防線要能獨立成立。
    """
    user = await create_user(db_session)
    db_session.add(
        Expense(
            user_id=user.id,
            category=ExpenseCategory.OTHER,
            amount=Decimal("0"),
            spent_at=datetime(2026, 12, 15, 12, 0, tzinfo=UTC),
        )
    )

    with pytest.raises(IntegrityError):
        await db_session.commit()

    await db_session.rollback()


async def test_amount_must_not_be_negative(db_session):
    user = await create_user(db_session)
    db_session.add(
        Expense(
            user_id=user.id,
            category=ExpenseCategory.OTHER,
            amount=Decimal("-1"),
            spent_at=datetime(2026, 12, 15, 12, 0, tzinfo=UTC),
        )
    )

    with pytest.raises(IntegrityError):
        await db_session.commit()

    await db_session.rollback()


async def test_category_check_constraint_rejects_unknown_value(db_session):
    """用原生 SQL 塞一個不在清單裡的分類。

    **不能用 ORM 塞**：SQLAlchemy 的 Enum 型別會在送出之前就自己擋下來，
    那樣測到的是 SQLAlchemy，不是資料庫的 CHECK——而 create_constraint=False
    的情況下，「忘記手寫 CheckConstraint」的症狀正好是資料庫什麼都收，
    只有繞過 ORM 才看得見。
    """
    user = await create_user(db_session)

    with pytest.raises(IntegrityError):
        await db_session.execute(
            text(
                "INSERT INTO expenses (user_id, category, amount, spent_at)"
                " VALUES (:user_id, 'crypto', 100, :spent_at)"
            ),
            {"user_id": user.id, "spent_at": datetime(2026, 12, 15, 12, 0, tzinfo=UTC)},
        )

    await db_session.rollback()


async def test_deleting_a_meal_keeps_the_expense_and_nulls_meal_id(db_session):
    """規格 §2.3 的核心主張：刪掉餐點，錢還在。

    **先斷言刪之前 meal_id 真的有值。** 少了這一步，就算 meal 跟 expense
    根本沒有連起來，這條測試也會綠——它會「證明」一個從來沒發生過的
    CASCADE 沒有發生。

    ON DELETE SET NULL 是資料庫層的行為，ORM 端的 identity map 不會自動
    知道——`expense` 這個 Python 物件在 commit 之後（`db_session` 的
    `expire_on_commit=False`）仍然停留在建立當下的舊值，之後即使用
    `select()` 重新查詢，identity map 命中的還是同一個物件、同一份舊值。
    必須 `refresh()` 之後才看得到資料庫的真實狀態——跟
    `tests/test_supplement_plans.py` 的
    `test_delete_plan_orphans_its_intakes_instead_of_deleting_them` 同一個坑。
    """
    user = await create_user(db_session)
    meal = await create_meal(db_session, user=user)
    expense = await create_expense(db_session, user=user, meal=meal, amount=250)

    assert expense.meal_id == meal.id  # 前提：兩者真的連著

    await db_session.delete(meal)
    await db_session.commit()

    await db_session.refresh(expense)
    remaining = await db_session.scalar(select(Expense).where(Expense.id == expense.id))
    assert remaining is not None
    assert remaining.meal_id is None
    assert remaining.amount == Decimal("250.00")


async def test_deleting_a_user_deletes_their_expenses(db_session):
    """user_id 是 CASCADE（跟 meal_id 相反）：使用者沒了，他的帳也沒有意義。"""
    user = await create_user(db_session)
    expense = await create_expense(db_session, user=user)
    expense_id = expense.id

    await db_session.delete(user)
    await db_session.commit()

    remaining = await db_session.scalar(select(Expense).where(Expense.id == expense_id))
    assert remaining is None
