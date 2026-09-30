from datetime import UTC, datetime

from sqlalchemy import func, select

from app.models.expense import Expense, ExpenseCategory
from app.security.tokens import create_access_token
from tests.factories import create_expense, create_meal, create_user


def auth(user):
    return {"Authorization": f"Bearer {create_access_token(user.id)}"}


async def test_create_expense_returns_the_expense(client, db_session):
    user = await create_user(db_session)

    response = await client.post(
        "/api/expenses",
        headers=auth(user),
        json={
            "amount": "250.50",
            "category": "transport",
            "spent_at": "2026-12-15T12:00:00+08:00",
            "note": "高鐵",
        },
    )

    assert response.status_code == 201
    body = response.json()
    assert body["amount"] == "250.50"
    assert body["category"] == "transport"
    assert body["note"] == "高鐵"
    assert body["meal_id"] is None


async def test_create_expense_requires_authentication(client):
    response = await client.post(
        "/api/expenses",
        json={"amount": "1", "category": "other", "spent_at": "2026-12-15T12:00:00+08:00"},
    )

    assert response.status_code == 401


async def test_create_expense_rejects_zero_amount(client, db_session):
    """Pydantic 的 gt=0 是第一道防線，資料庫的 CHECK 是第二道
    （tests/test_expenses_model.py）。兩道都要有。"""
    user = await create_user(db_session)

    response = await client.post(
        "/api/expenses",
        headers=auth(user),
        json={"amount": "0", "category": "other", "spent_at": "2026-12-15T12:00:00+08:00"},
    )

    assert response.status_code == 422
    assert await db_session.scalar(select(func.count()).select_from(Expense)) == 0


async def test_create_expense_rejects_unknown_category(client, db_session):
    user = await create_user(db_session)

    response = await client.post(
        "/api/expenses",
        headers=auth(user),
        json={"amount": "1", "category": "crypto", "spent_at": "2026-12-15T12:00:00+08:00"},
    )

    assert response.status_code == 422


async def test_list_expenses_defaults_to_this_month(client, db_session, monkeypatch):
    """省略 month 時是「使用者時區的這個月」（規格 §5.3）。

    monkeypatch 的目標是 **routes 模組裡的名字**，不是 app.days 裡的——
    路由是 `from app.days import this_month_in_timezone` 匯入的，
    換掉 app.days 那一份不會影響已經綁好的參照。
    """
    from app.api.routes import expenses as expenses_route

    monkeypatch.setattr(expenses_route, "this_month_in_timezone", lambda tz_name: (2026, 12))

    user = await create_user(db_session)
    await create_expense(db_session, user=user, amount=100)  # 預設 2026-12-15
    await create_expense(
        db_session, user=user, amount=999, spent_at=datetime(2026, 11, 15, 12, 0, tzinfo=UTC)
    )

    response = await client.get("/api/expenses", headers=auth(user))

    assert response.status_code == 200
    amounts = [item["amount"] for item in response.json()]
    assert amounts == ["100.00"]


async def test_list_expenses_accepts_explicit_month(client, db_session):
    user = await create_user(db_session)
    await create_expense(db_session, user=user, amount=100)  # 2026-12-15

    response = await client.get("/api/expenses?month=2026-12", headers=auth(user))

    assert response.status_code == 200
    assert [item["amount"] for item in response.json()] == ["100.00"]


async def test_list_expenses_rejects_year_zero(client, db_session):
    """month=0000-01 必須是 422，不是 500。

    `date(0, 1, 1)` 直接拋 ValueError，那會變成一個已認證使用者就能
    觸發的 500。年份的 pattern 限定 19xx/20xx 就擋在 FastAPI 層。
    """
    user = await create_user(db_session)

    response = await client.get("/api/expenses?month=0000-01", headers=auth(user))

    assert response.status_code == 422


async def test_list_expenses_rejects_month_thirteen(client, db_session):
    user = await create_user(db_session)

    response = await client.get("/api/expenses?month=2026-13", headers=auth(user))

    assert response.status_code == 422


async def test_list_expenses_only_returns_my_own(client, db_session):
    alice = await create_user(db_session)
    bob = await create_user(db_session)
    await create_expense(db_session, user=alice, amount=100)
    await create_expense(db_session, user=bob, amount=200)

    response = await client.get("/api/expenses?month=2026-12", headers=auth(alice))

    assert response.status_code == 200
    assert [item["amount"] for item in response.json()] == ["100.00"]


async def test_patch_expense_updates_amount(client, db_session):
    user = await create_user(db_session)
    expense = await create_expense(db_session, user=user, amount=100)

    response = await client.patch(
        f"/api/expenses/{expense.id}", headers=auth(user), json={"amount": "150.25"}
    )

    assert response.status_code == 200
    assert response.json()["amount"] == "150.25"


async def test_patch_expense_leaves_untouched_fields_alone(client, db_session):
    """只帶 amount 時，category 不能被打成預設值。

    這是哨兵寫法真正要守的東西：`model_dump(exclude_unset=True)` 如果
    寫成 `model_dump()`，沒帶的欄位會以 None 出現在 dict 裡，
    然後被 setattr 寫進 NOT NULL 欄位。
    """
    user = await create_user(db_session)
    expense = await create_expense(
        db_session, user=user, amount=100, category=ExpenseCategory.TRANSPORT
    )

    response = await client.patch(
        f"/api/expenses/{expense.id}", headers=auth(user), json={"amount": "150"}
    )

    assert response.status_code == 200
    assert response.json()["category"] == "transport"


async def test_patch_expense_can_clear_the_note(client, db_session):
    """note 是 nullable，`{"note": null}` 是合法輸入、必須放行到底。"""
    user = await create_user(db_session)
    expense = await create_expense(db_session, user=user, note="原本的備註")

    response = await client.patch(
        f"/api/expenses/{expense.id}", headers=auth(user), json={"note": None}
    )

    assert response.status_code == 200
    assert response.json()["note"] is None


async def test_patch_expense_rejects_explicit_null_on_not_null_field(client, db_session):
    """`{"amount": null}` 必須是 422，不是 500。

    amount 是 NOT NULL。顯式 null 如果流到 setattr，會撞上
    asyncpg.NotNullViolationError 變成已認證使用者就能觸發的 500
    （UpdateMeRequest 踩過的同一個坑）。
    """
    user = await create_user(db_session)
    expense = await create_expense(db_session, user=user)

    response = await client.patch(
        f"/api/expenses/{expense.id}", headers=auth(user), json={"amount": None}
    )

    assert response.status_code == 422


async def test_patch_someone_elses_expense_is_404(client, db_session):
    """404 不是 403——403 等於告訴對方「這個 ID 存在，只是你不能看」。

    **`code` 也要斷言，不能只看狀態碼。** Task 4 實測發現：這條測試在
    端點還不存在時就是綠的——路徑不匹配任何路由時 Starlette 也回 404。
    只斷言 `404` 的話，它分不出「擁有權檢查擋下了你」與「這個路由根本
    沒被註冊」，於是有人整個刪掉端點它照樣綠。

    兩者的 `code` 不同：我們的 `NotFoundError` 是 `"NOT_FOUND"`，
    而路由不存在走的是 `handle_http_exception`，`code` 是 `"HTTP_ERROR"`
    （`app/errors.py`）。斷言前者才真的守得住。
    """
    alice = await create_user(db_session)
    bob = await create_user(db_session)
    expense = await create_expense(db_session, user=alice, amount=100)

    response = await client.patch(
        f"/api/expenses/{expense.id}", headers=auth(bob), json={"amount": "1"}
    )

    assert response.status_code == 404
    assert response.json()["error"]["code"] == "NOT_FOUND"


async def test_patch_nonexistent_expense_is_404_with_identical_body(client, db_session):
    """「不存在」與「不是你的」必須回一模一樣的東西，否則差異本身就是洩漏。

    `code` 的斷言理由同上：少了它，端點不存在時這條也是綠的
    （兩邊都會拿到 FastAPI 預設的 404 body，「一模一樣」自動成立）。
    """
    alice = await create_user(db_session)
    bob = await create_user(db_session)
    alices_expense = await create_expense(db_session, user=alice, amount=100)

    not_mine = await client.patch(
        f"/api/expenses/{alices_expense.id}", headers=auth(bob), json={"amount": "1"}
    )
    missing = await client.patch(
        "/api/expenses/999999", headers=auth(bob), json={"amount": "1"}
    )

    assert not_mine.status_code == missing.status_code == 404
    assert not_mine.json() == missing.json()
    assert not_mine.json()["error"]["code"] == "NOT_FOUND"


async def test_delete_expense_removes_it(client, db_session):
    user = await create_user(db_session)
    expense = await create_expense(db_session, user=user)

    response = await client.delete(f"/api/expenses/{expense.id}", headers=auth(user))

    assert response.status_code == 204
    assert await db_session.scalar(select(func.count()).select_from(Expense)) == 0


async def test_delete_someone_elses_expense_is_404_and_keeps_it(client, db_session):
    alice = await create_user(db_session)
    bob = await create_user(db_session)
    expense = await create_expense(db_session, user=alice)

    response = await client.delete(f"/api/expenses/{expense.id}", headers=auth(bob))

    assert response.status_code == 404
    # `code` 的斷言分辨「擁有權擋下了你」與「路由根本不存在」——後者也是 404
    # （Task 4 實測：這條測試在端點還沒實作時就是綠的）。
    assert response.json()["error"]["code"] == "NOT_FOUND"
    # 關鍵斷言：不只是回 404，那筆資料要真的還在
    assert await db_session.scalar(select(func.count()).select_from(Expense)) == 1


async def test_create_expense_rejects_naive_spent_at(client, db_session):
    """沒有時區偏移的 `spent_at` 必須是 422。

    **這是這個模組唯一一個會算錯錢、而且只在 production 出錯的 bug。**
    最終審查實測：naive datetime 會被 asyncpg 用執行程序的本機時區解釋
    （`dt.astimezone()` 對 naive 值假設本機時區）。同一個輸入
    `"2026-11-30T23:30:00"`：

      開發機（Asia/Taipei）→ 存成 2026-11-30T15:30Z → 月報表算 11 月 ✅
      容器（沒設 TZ = UTC）→ 存成 2026-11-30T23:30Z → 算 12 月 ❌

    也就是說：台北使用者在每個月最後一天 16:00 之後記的每一筆，
    在 production 都會跑到下個月，而**開發機上永遠重現不出來**。

    而 `<input type="datetime-local">` 產出的正好就是這個沒有 offset 的
    格式——P5 計畫二的前端表單會用的就是它。
    """
    user = await create_user(db_session)

    response = await client.post(
        "/api/expenses",
        headers=auth(user),
        json={"amount": "1", "category": "other", "spent_at": "2026-11-30T23:30:00"},
    )

    assert response.status_code == 422
    assert await db_session.scalar(select(func.count()).select_from(Expense)) == 0


async def test_patch_expense_rejects_naive_spent_at(client, db_session):
    """PATCH 走同一條規則——理由見上面那條。"""
    user = await create_user(db_session)
    expense = await create_expense(db_session, user=user)

    response = await client.patch(
        f"/api/expenses/{expense.id}",
        headers=auth(user),
        json={"spent_at": "2026-11-30T23:30:00"},
    )

    assert response.status_code == 422


async def test_patch_cannot_move_an_expense_to_another_meal(client, db_session):
    """`meal_id` 不可改（規格 §5.1）——把支出搬到別人的餐點是個攻擊面。

    **執行期本來就安全**：`meal_id` 不是 `ExpenseUpdateRequest` 的欄位，
    Pydantic 預設 `extra="ignore"` 會直接丟掉它。

    但最終審查指出：**沒有任何測試釘住這件事**。只要有人「順手」把
    `meal_id: int | None = None` 加進那個 model，洞就開了，而 595 條測試
    沒有一條會紅。這條就是那根釘子。
    """
    alice = await create_user(db_session)
    bob = await create_user(db_session)
    bobs_meal = await create_meal(db_session, user=bob)
    expense = await create_expense(db_session, user=alice)

    response = await client.patch(
        f"/api/expenses/{expense.id}",
        headers=auth(alice),
        json={"meal_id": bobs_meal.id, "note": "試著搬過去"},
    )

    assert response.status_code == 200
    # 關鍵：不是只看狀態碼——meal_id 必須原封不動
    assert response.json()["meal_id"] is None
    # expire_on_commit=False，不 refresh 會被 identity map 的舊值騙過
    await db_session.refresh(expense)
    assert expense.meal_id is None
