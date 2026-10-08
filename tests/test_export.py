"""`GET /api/export/{meals,expenses,supplements}.csv`（報表月份與匯出規格 §3）。

讀回來一律用 `csv.reader`（跟試算表同一種讀法），不是自己切逗號——備註裡有逗號、
引號、換行。`httpx.ASGITransport` 會把整個回應收完才交回來，所以「是不是一塊一塊吐」
在端點層看不到，那幾條直接測 `app/export.py` 的 generator。
"""

import csv
import io
from collections.abc import AsyncIterator, Iterator
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import event

from app.db import get_db
from app.export import (
    EXPENSE_CATEGORY_LABELS,
    MEAL_TYPE_LABELS,
    expense_csv,
    meal_csv,
    supplement_csv,
)
from app.main import app
from app.models.expense import ExpenseCategory
from app.models.food import BaseUnit, FoodRevision
from app.models.meal import MealType
from app.ratelimit import EXPORT_LIMIT
from app.security.tokens import create_access_token
from tests.factories import (
    create_expense,
    create_food,
    create_intake,
    create_meal,
    create_supplement,
    create_user,
)

MEALS = "/api/export/meals.csv"
EXPENSES = "/api/export/expenses.csv"
SUPPLEMENTS = "/api/export/supplements.csv"

# 標題列寫死在測試裡，不 import `app.export` 的常數——拿它自己比自己永遠是綠的（第 10 種）。
MEAL_HEADER = [
    "餐點編號", "日期", "時間", "餐別", "食物", "品牌", "份量", "單位",
    "熱量(kcal)", "蛋白質(g)", "脂肪(g)", "碳水(g)", "備註", "只有我看得到",
]  # fmt: skip
EXPENSE_HEADER = ["日期", "時間", "分類", "金額", "備註", "是否餐費"]
SUPPLEMENT_HEADER = [
    "日期", "時間", "補劑", "品牌", "份數", "熱量(kcal)", "蛋白質(g)", "脂肪(g)", "碳水(g)",
]  # fmt: skip

BOM = b"\xef\xbb\xbf"


def auth(user_id: int) -> dict[str, str]:
    return {"Authorization": f"Bearer {create_access_token(user_id)}"}


def _table(content: bytes) -> list[list[str]]:
    """整個檔案讀成列。先確認開頭真的有 BOM，再拿掉它。"""
    assert content.startswith(BOM)
    return list(csv.reader(io.StringIO(content[len(BOM) :].decode("utf-8"), newline="")))


async def _revision(db_session, food) -> FoodRevision:
    revision = await db_session.get(FoodRevision, food.current_revision_id)
    assert revision is not None
    return revision


# ── 回應的形狀 ────────────────────────────────────────────────────────────────


@pytest.fixture
def seen_timezones(monkeypatch) -> list[str]:
    """檔名的日期是「使用者的今天」：固定日期，並記下收到的時區（第 2、22 種）。"""
    seen: list[str] = []

    def fake_today(tz_name: str) -> date:
        seen.append(tz_name)
        return date(2019, 7, 4)

    monkeypatch.setattr("app.api.routes.export.today_in_timezone", fake_today)
    return seen


@pytest.mark.parametrize(
    ("path", "filename", "header"),
    [
        (MEALS, "meals-2019-07-04.csv", MEAL_HEADER),
        (EXPENSES, "expenses-2019-07-04.csv", EXPENSE_HEADER),
        (SUPPLEMENTS, "supplements-2019-07-04.csv", SUPPLEMENT_HEADER),
    ],
)
async def test_an_export_is_a_utf8_csv_attachment_named_after_the_users_today(
    client, db_session, seen_timezones, path, filename, header
):
    user = await create_user(db_session)
    user.timezone = "America/New_York"
    await db_session.commit()

    response = await client.get(path, headers=auth(user.id))

    assert response.status_code == 200
    assert response.headers["content-type"] == "text/csv; charset=utf-8"
    assert response.headers["content-disposition"] == f'attachment; filename="{filename}"'
    assert response.headers["cache-control"] == "no-store"
    assert seen_timezones == ["America/New_York"]
    # 沒有任何資料：只有 BOM 與標題列。
    assert response.content == BOM + (",".join(header) + "\r\n").encode()


@pytest.mark.parametrize("path", [MEALS, EXPENSES, SUPPLEMENTS])
async def test_exports_require_authentication(client, path):
    response = await client.get(path)

    assert response.status_code == 401
    assert response.json()["error"]["code"] == "NOT_AUTHENTICATED"


def test_openapi_says_the_exports_return_csv():
    for path in (MEALS, EXPENSES, SUPPLEMENTS):
        ok = app.openapi()["paths"][path]["get"]["responses"]["200"]
        assert list(ok["content"]) == ["text/csv"]


# ── 內容 ──────────────────────────────────────────────────────────────────────


async def test_expenses_come_oldest_first_with_tricky_notes_intact(client, db_session):
    user = await create_user(db_session)
    meal = await create_meal(db_session, user=user)
    notes = [
        "便當, 加蛋",
        '他說 "好吃"',
        "第一行\n第二行",
        '=HYPERLINK("http://evil.example","x")',
        "+886912345678",
        "-5",
        "@SUM(A1)",
        "滷肉飯🍚",
        None,
    ]
    first = datetime(2026, 3, 10, 4, 0, tzinfo=UTC)  # 台北 12:00
    # 最新的先建：id 的順序跟時間相反，只按 id 排的實作會紅。
    for index in reversed(range(len(notes))):
        await create_expense(
            db_session,
            user=user,
            # 180.5：資料庫存的是 180.50（numeric(10,2)），匯出的要是資料庫裡的樣子。
            amount=Decimal("180.5") if index == 0 else 100 + index,
            category=ExpenseCategory.FOOD if index == 0 else ExpenseCategory.TRANSPORT,
            spent_at=first + timedelta(minutes=index),
            note=notes[index],
            meal=meal if index == 0 else None,
        )

    response = await client.get(EXPENSES, headers=auth(user.id))

    header, *rows = _table(response.content)
    assert header == EXPENSE_HEADER
    assert rows[0] == ["2026-03-10", "12:00", "飲食", "180.50", "便當, 加蛋", "是"]
    assert rows[1] == ["2026-03-10", "12:01", "交通", "101.00", '他說 "好吃"', "否"]
    assert [row[1] for row in rows] == [f"12:0{minute}" for minute in range(9)]
    assert [row[4] for row in rows] == [
        "便當, 加蛋",
        '他說 "好吃"',
        "第一行\n第二行",
        '\'=HYPERLINK("http://evil.example","x")',
        "'+886912345678",
        "'-5",
        "'@SUM(A1)",
        "滷肉飯🍚",
        "",
    ]
    # 金額是數字欄：沒有任何一格被加上單引號。
    assert [row[3] for row in rows[1:]] == [f"{100 + index}.00" for index in range(1, 9)]


async def test_a_meal_is_one_row_per_item_and_an_empty_meal_still_gets_a_row(
    client, db_session
):
    user = await create_user(db_session)
    rice = await create_food(
        db_session, created_by=user, owner=user, name="白飯",
        kcal=130, protein_g=Decimal("2.7"), fat_g=Decimal("0.3"), carb_g=28,
    )  # fmt: skip
    tea = await create_food(
        db_session, created_by=user, owner=user, name="無糖綠茶", brand="=茶裏王",
        kcal=0, protein_g=0, fat_g=0, carb_g=0, base_unit=BaseUnit.ML,
    )  # fmt: skip
    lunch = await create_meal(
        db_session,
        user=user,
        eaten_at=datetime(2026, 3, 10, 4, 30, tzinfo=UTC),
        meal_type=MealType.LUNCH,
        items=[(await _revision(db_session, rice), 150), (await _revision(db_session, tea), 500)],
        note="自己煮",
    )
    lunch.is_private = True
    await db_session.commit()
    empty = await create_meal(
        db_session,
        user=user,
        eaten_at=datetime(2026, 3, 10, 11, 0, tzinfo=UTC),
        meal_type=MealType.DINNER,
    )

    response = await client.get(MEALS, headers=auth(user.id))

    header, *rows = _table(response.content)
    assert header == MEAL_HEADER
    assert rows == [
        [str(lunch.id), "2026-03-10", "12:30", "午餐", "白飯", "", "150.00", "g",
         "195.00", "4.05", "0.45", "42.00", "自己煮", "是"],
        [str(lunch.id), "2026-03-10", "12:30", "午餐", "無糖綠茶", "'=茶裏王", "500.00", "ml",
         "0.00", "0.00", "0.00", "0.00", "自己煮", "是"],
        [str(empty.id), "2026-03-10", "19:00", "晚餐", "", "", "", "", "", "", "", "", "", "否"],
    ]  # fmt: skip
    # 跟 app 裡看到的同一組數字（同一份 join、同一套四捨五入）。
    api = (await client.get(f"/api/meals/{lunch.id}", headers=auth(user.id))).json()
    assert [
        [item["quantity_g"], item["kcal"], item["protein_g"], item["fat_g"], item["carb_g"]]
        for item in api["items"]
    ] == [[row[6], *row[8:12]] for row in rows[:2]]


async def test_supplement_intakes_carry_the_snapshot_taken_at_the_time(client, db_session):
    user = await create_user(db_session)
    whey = await create_supplement(
        db_session, created_by=user, owner=user, name="乳清蛋白", brand="+MyProtein"
    )
    await create_intake(
        db_session,
        user=user,
        supplement=whey,
        dose=2,
        taken_at=datetime(2026, 3, 10, 0, 5, tzinfo=UTC),
        kcal=240,
        protein_g=48,
        fat_g=3,
        carb_g=Decimal("4.5"),
    )

    response = await client.get(SUPPLEMENTS, headers=auth(user.id))

    header, *rows = _table(response.content)
    assert header == SUPPLEMENT_HEADER
    assert rows == [
        ["2026-03-10", "08:05", "乳清蛋白", "'+MyProtein", "2.00",
         "240.00", "48.00", "3.00", "4.50"],
    ]  # fmt: skip


async def test_dates_and_times_follow_the_account_timezone(client, db_session):
    """同一個時刻，兩個時區的人各自看到自己的當地時間。

    UTC 3/2 03:30 ＝ 紐約 3/1 22:30（宵夜算在 3/1）＝ 台北 3/2 11:30。寫死 UTC、寫死台北、
    或用伺服器的時區，紐約那一列的日期都會是 3/2（第 2 種：兩個時區才有鑑別力）。
    """
    instant = datetime(2026, 3, 2, 3, 30, tzinfo=UTC)
    taipei = await create_user(db_session)
    new_york = await create_user(db_session)
    new_york.timezone = "America/New_York"
    await db_session.commit()
    for user in (taipei, new_york):
        await create_meal(db_session, user=user, eaten_at=instant)
        await create_expense(db_session, user=user, spent_at=instant)
        pill = await create_supplement(db_session, created_by=user, owner=user)
        await create_intake(db_session, user=user, supplement=pill, taken_at=instant)

    seen: dict[str, list[tuple[str, str]]] = {}
    for name, user in (("taipei", taipei), ("new_york", new_york)):
        seen[name] = []
        for path, date_column in ((MEALS, 1), (EXPENSES, 0), (SUPPLEMENTS, 0)):
            _, row = _table((await client.get(path, headers=auth(user.id))).content)
            seen[name].append((row[date_column], row[date_column + 1]))

    assert seen == {
        "taipei": [("2026-03-02", "11:30")] * 3,
        "new_york": [("2026-03-01", "22:30")] * 3,
    }


async def test_a_meal_just_after_local_midnight_lands_on_the_new_day(client, db_session):
    # 台北 3/2 00:30 ＝ UTC 3/1 16:30：用 UTC 算日期會寫成 3/1。
    user = await create_user(db_session)  # Asia/Taipei
    await create_meal(db_session, user=user, eaten_at=datetime(2026, 3, 1, 16, 30, tzinfo=UTC))

    _, row = _table((await client.get(MEALS, headers=auth(user.id))).content)

    assert (row[1], row[2]) == ("2026-03-02", "00:30")


def test_every_enum_member_has_a_chinese_label():
    assert set(MEAL_TYPE_LABELS) == set(MealType)
    assert set(EXPENSE_CATEGORY_LABELS) == set(ExpenseCategory)
    assert all(MEAL_TYPE_LABELS.values()) and all(EXPENSE_CATEGORY_LABELS.values())


# ── 只有自己的 ────────────────────────────────────────────────────────────────


async def test_each_export_only_contains_the_callers_own_rows(client, db_session):
    people = {}
    for name in ("alice", "bob"):
        user = await create_user(db_session)
        food = await create_food(db_session, created_by=user, owner=user, name=f"{name}的便當")
        await create_meal(
            db_session,
            user=user,
            items=[(await _revision(db_session, food), 100)],
            note=f"{name}的備註",
            photo_path=f"{user.id}/{name}-photo.jpg",
        )
        await create_expense(db_session, user=user, note=f"{name}的花費")
        pill = await create_supplement(
            db_session, created_by=user, owner=user, name=f"{name}的補劑"
        )
        await create_intake(db_session, user=user, supplement=pill)
        people[name] = user

    for path, marker in ((MEALS, "的便當"), (EXPENSES, "的花費"), (SUPPLEMENTS, "的補劑")):
        text = (await client.get(path, headers=auth(people["alice"].id))).content.decode()
        assert f"alice{marker}" in text
        assert "bob" not in text
        # 每一支都剛好一列資料：自己的那一列。
        assert len(_table(text.encode())) == 2
    meals = (await client.get(MEALS, headers=auth(people["alice"].id))).content.decode()
    assert "alice的備註" in meals
    assert "photo" not in meals  # 照片路徑不匯出


# ── 一塊一塊地讀、一塊一塊地吐 ─────────────────────────────────────────────────


@pytest.fixture
def selects(db_connection) -> Iterator[list[str]]:
    """這條連線上執行過的 SELECT（不含 SAVEPOINT 之類）。"""
    seen: list[str] = []

    def record(conn, cursor, statement, parameters, context, executemany):
        if statement.lstrip().upper().startswith("SELECT"):
            seen.append(statement)

    event.listen(db_connection.sync_connection, "before_cursor_execute", record)
    yield seen
    event.remove(db_connection.sync_connection, "before_cursor_execute", record)


async def test_expenses_are_read_and_emitted_one_bounded_chunk_at_a_time(
    db_session, monkeypatch, selects
):
    monkeypatch.setattr("app.export.EXPORT_CHUNK_ROWS", 2)
    user = await create_user(db_session)
    start = datetime(2026, 3, 10, 4, 0, tzinfo=UTC)
    for index in range(5):
        await create_expense(
            db_session, user=user, spent_at=start + timedelta(minutes=index), note=f"n{index}"
        )
    user_id = user.id
    selects.clear()

    stream = expense_csv(db_session, user_id=user_id, tz_name="Asia/Taipei")
    progress: list[tuple[int, int]] = []  # （這一塊有幾列, 到目前為止查了幾次）
    chunks: list[bytes] = []
    async for chunk in stream:
        chunks.append(chunk)
        progress.append((chunk.count(b"\r\n"), len(selects)))

    # 標題不用查；之後每一塊最多 2 列，而且是「查一次、吐一塊」——不是先全部讀進來再切。
    assert progress == [(1, 0), (2, 1), (2, 2), (1, 3)]
    assert all("LIMIT" in statement for statement in selects)
    assert [row[4] for row in _table(b"".join(chunks))[1:]] == ["n0", "n1", "n2", "n3", "n4"]


async def test_rows_sharing_one_instant_are_neither_skipped_nor_repeated(
    db_session, monkeypatch
):
    # 塊的邊界剛好切在同一個時刻的幾列中間：只用時間當游標會漏掉（或重複）同時刻的列。
    monkeypatch.setattr("app.export.EXPORT_CHUNK_ROWS", 2)
    monkeypatch.setattr("app.export.EXPORT_CHUNK_MEALS", 2)
    user = await create_user(db_session)
    instant = datetime(2026, 3, 10, 4, 0, tzinfo=UTC)
    pill = await create_supplement(db_session, created_by=user, owner=user)
    meal_ids = []
    for index in range(5):
        await create_expense(db_session, user=user, spent_at=instant, note=f"n{index}")
        await create_intake(
            db_session, user=user, supplement=pill, taken_at=instant, dose=index + 1
        )
        meal_ids.append((await create_meal(db_session, user=user, eaten_at=instant)).id)
    user_id = user.id

    async def rows(stream: AsyncIterator[bytes]) -> list[list[str]]:
        return _table(b"".join([chunk async for chunk in stream]))[1:]

    kwargs = {"user_id": user_id, "tz_name": "Asia/Taipei"}
    assert [row[4] for row in await rows(expense_csv(db_session, **kwargs))] == [
        "n0", "n1", "n2", "n3", "n4",
    ]  # fmt: skip
    assert [row[4] for row in await rows(supplement_csv(db_session, **kwargs))] == [
        "1.00", "2.00", "3.00", "4.00", "5.00",
    ]  # fmt: skip
    assert [row[0] for row in await rows(meal_csv(db_session, **kwargs))] == [
        str(meal_id) for meal_id in meal_ids
    ]


async def test_meals_are_read_a_few_meals_at_a_time(db_session, monkeypatch, selects):
    monkeypatch.setattr("app.export.EXPORT_CHUNK_MEALS", 2)
    user = await create_user(db_session)
    food = await create_food(db_session, created_by=user, owner=user)
    revision = await _revision(db_session, food)
    start = datetime(2026, 3, 10, 4, 0, tzinfo=UTC)
    for index in range(3):
        await create_meal(
            db_session,
            user=user,
            eaten_at=start + timedelta(hours=index),
            items=[(revision, 100), (revision, 50)],
        )
    user_id = user.id
    selects.clear()

    sizes = []
    async for chunk in meal_csv(db_session, user_id=user_id, tz_name="Asia/Taipei"):
        sizes.append((chunk.count(b"\r\n"), len(selects)))

    # 一塊 2 餐（各 2 個項目 → 4 列），每一塊兩次查詢：餐、它們的項目。
    assert sizes == [(1, 0), (4, 2), (2, 4)]


async def test_the_database_session_stays_open_until_the_last_chunk(db_session, monkeypatch):
    """`get_db` 的收尾要在串流**結束之後**。

    FastAPI 0.118 之前、或把依賴改成 `scope="function"`，session 會在第一塊送出之前就被關掉
    ——而共用 session 的 `client` 夾具根本不關 session，看不到這件事（第 14 種）。
    """
    user = await create_user(db_session)
    await create_expense(db_session, user=user)
    user_id = user.id
    events: list[str] = []

    async def get_db_spy():
        try:
            yield db_session
        finally:
            events.append("session-closed")

    async def spying(db, **kwargs):
        async for chunk in expense_csv(db, **kwargs):
            events.append("chunk")
            yield chunk

    monkeypatch.setattr("app.api.routes.export.expense_csv", spying)
    app.dependency_overrides[get_db] = get_db_spy
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as raw:
            response = await raw.get(EXPENSES, headers=auth(user_id))
    finally:
        app.dependency_overrides.clear()

    assert response.status_code == 200
    assert events == ["chunk", "chunk", "session-closed"]  # 標題、一塊資料，然後才收尾


# ── 限速 ──────────────────────────────────────────────────────────────────────


async def test_the_three_exports_share_one_budget_per_user(client, db_session):
    alice = await create_user(db_session)
    bob = await create_user(db_session)
    paths = [MEALS, EXPENSES, SUPPLEMENTS]

    allowed = [
        await client.get(paths[index % 3], headers=auth(alice.id))
        for index in range(EXPORT_LIMIT)
    ]
    # 第 7 次打的是 meals——alice 只打過它兩次。每個端點各算各的話，這一次會過。
    blocked = await client.get(MEALS, headers=auth(alice.id))
    someone_else = await client.get(MEALS, headers=auth(bob.id))

    assert EXPORT_LIMIT == 6
    assert [response.status_code for response in allowed] == [200] * 6
    assert blocked.status_code == 429
    assert blocked.json()["error"]["code"] == "TOO_MANY_EXPORTS"
    assert 1 <= int(blocked.headers["Retry-After"]) <= 60
    assert someone_else.status_code == 200  # 別人的額度不受影響
