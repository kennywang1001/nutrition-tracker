from datetime import UTC, datetime

from app.models.expense import ExpenseCategory
from app.security.tokens import create_access_token
from tests.factories import create_expense, create_user


def auth(user):
    return {"Authorization": f"Bearer {create_access_token(user.id)}"}


async def test_summary_groups_by_category(client, db_session):
    user = await create_user(db_session)
    await create_expense(db_session, user=user, amount=100, category=ExpenseCategory.FOOD)
    await create_expense(db_session, user=user, amount=250, category=ExpenseCategory.FOOD)
    await create_expense(
        db_session, user=user, amount=50, category=ExpenseCategory.TRANSPORT
    )

    response = await client.get("/api/expenses/summary?month=2026-12", headers=auth(user))

    assert response.status_code == 200
    body = response.json()
    assert body["month"] == "2026-12"
    assert body["total"] == "400.00"
    assert body["by_category"] == [
        {"category": "food", "total": "350.00", "count": 2},
        {"category": "transport", "total": "50.00", "count": 1},
    ]


async def test_summary_omits_categories_with_no_data(client, db_session):
    """零元的分類不回——前端有完整的分類清單可以自己對(規格 §5.2)。"""
    user = await create_user(db_session)
    await create_expense(db_session, user=user, amount=100, category=ExpenseCategory.FOOD)

    response = await client.get("/api/expenses/summary?month=2026-12", headers=auth(user))

    categories = [row["category"] for row in response.json()["by_category"]]
    assert categories == ["food"]


async def test_summary_of_an_empty_month_is_zero_not_an_error(client, db_session):
    user = await create_user(db_session)

    response = await client.get("/api/expenses/summary?month=2026-03", headers=auth(user))

    assert response.status_code == 200
    body = response.json()
    assert body["total"] == "0.00"
    assert body["by_category"] == []


async def test_summary_excludes_other_months(client, db_session):
    """11 月的花費不能算進 12 月。"""
    user = await create_user(db_session)
    await create_expense(db_session, user=user, amount=100)  # 2026-12-15
    await create_expense(
        db_session, user=user, amount=999, spent_at=datetime(2026, 11, 15, 12, 0, tzinfo=UTC)
    )

    response = await client.get("/api/expenses/summary?month=2026-12", headers=auth(user))

    assert response.json()["total"] == "100.00"


async def test_summary_respects_user_timezone_at_the_month_boundary(client, db_session):
    """台北 12 月 1 日 01:00 = UTC 11 月 30 日 17:00。

    這一筆對台北使用者來說是 **12 月**的花費。如果 summary 用 UTC 算月界線,
    它會被算進 11 月,而 12 月的總額會少這一筆。

    **這是整個模組最容易錯、也最難發現的地方**——錯的時候每個月只有
    邊界那幾小時的資料會跑錯月,平常完全看不出來。
    """
    user = await create_user(db_session)  # timezone 預設 Asia/Taipei
    await create_expense(
        db_session,
        user=user,
        amount=777,
        spent_at=datetime(2026, 11, 30, 17, 0, tzinfo=UTC),
    )

    response = await client.get("/api/expenses/summary?month=2026-12", headers=auth(user))

    assert response.json()["total"] == "777.00"


async def test_summary_only_counts_my_own(client, db_session):
    alice = await create_user(db_session)
    bob = await create_user(db_session)
    await create_expense(db_session, user=alice, amount=100)
    await create_expense(db_session, user=bob, amount=999)

    response = await client.get("/api/expenses/summary?month=2026-12", headers=auth(alice))

    assert response.json()["total"] == "100.00"


async def test_summary_defaults_to_this_month(client, db_session, monkeypatch):
    from app.api.routes import expenses as expenses_route

    monkeypatch.setattr(expenses_route, "this_month_in_timezone", lambda tz_name: (2026, 12))

    user = await create_user(db_session)
    await create_expense(db_session, user=user, amount=100)  # 2026-12-15

    response = await client.get("/api/expenses/summary", headers=auth(user))

    assert response.status_code == 200
    assert response.json()["month"] == "2026-12"
    assert response.json()["total"] == "100.00"


async def test_list_and_summary_agree_on_explicit_months_at_the_local_boundary(
    client, db_session
):
    """報表可以看其他月份之後（報表月份與匯出規格 §2），明確帶 `month` 的清單與報表
    都要用使用者時區切月，而且切在同一個地方。

    台北 11/30 23:59:59 ＝ UTC 11/30 15:59:59（11 月的最後一秒）；
    台北 12/01 00:00:00 ＝ UTC 11/30 16:00:00（12 月的第一刻）。
    兩筆在 UTC 都是 11 月 30 日：用 UTC 切月，兩筆都會算進 11 月。
    """
    user = await create_user(db_session)  # timezone 預設 Asia/Taipei
    await create_expense(
        db_session,
        user=user,
        amount=111,
        spent_at=datetime(2026, 11, 30, 15, 59, 59, tzinfo=UTC),
        note="十一月的最後一筆",
    )
    await create_expense(
        db_session,
        user=user,
        amount=222,
        spent_at=datetime(2026, 11, 30, 16, 0, tzinfo=UTC),
        note="十二月的第一筆",
    )

    seen = {}
    for month in ("2026-11", "2026-12"):
        listing = await client.get(f"/api/expenses?month={month}", headers=auth(user))
        summary = await client.get(f"/api/expenses/summary?month={month}", headers=auth(user))
        seen[month] = (
            [item["note"] for item in listing.json()],
            summary.json()["total"],
            summary.json()["month"],
        )

    assert seen == {
        "2026-11": (["十一月的最後一筆"], "111.00", "2026-11"),
        "2026-12": (["十二月的第一筆"], "222.00", "2026-12"),
    }


async def test_a_future_month_is_empty_not_an_error(client, db_session):
    """前端在知道「這個月是哪個月」之前，可能先照網址上的月份問一次（手打的未來月份）。
    那一次要是 200 的空報表，不是 422——畫面才不會先閃一個錯誤再退回這個月。"""
    user = await create_user(db_session)
    await create_expense(db_session, user=user, amount=100)  # 2026-12-15

    listing = await client.get("/api/expenses?month=2099-12", headers=auth(user))
    summary = await client.get("/api/expenses/summary?month=2099-12", headers=auth(user))

    assert (listing.status_code, listing.json()) == (200, [])
    assert summary.json() == {"month": "2099-12", "total": "0.00", "by_category": []}
