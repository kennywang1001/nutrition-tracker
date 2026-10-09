"""`GET /api/export/{meals,expenses,supplements}.csv`（報表月份與匯出規格 §3）。

讀回來一律用 `csv.reader`（跟試算表同一種讀法），不是自己切逗號——備註裡有逗號、
引號、換行。`httpx.ASGITransport` 會把整個回應收完才交回來，所以「是不是一塊一塊吐」
在端點層看不到，那幾條直接測 `app/export.py` 的 generator。
"""

import asyncio
import csv
import io
from collections.abc import AsyncIterator, Awaitable, Callable, Iterator
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from typing import Any

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import delete, event, text
from sqlalchemy.exc import TimeoutError as PoolTimeoutError
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from sqlalchemy.util import await_only

from app.api.routes import export as export_routes
from app.db import get_db
from app.errors import TooManyRequestsError
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
from app.models.user import User
from app.ratelimit import EXPORT_LIMIT, EXPORT_MAX_HOLD_SECONDS, InFlightLimiter
from app.security.tokens import create_access_token
from tests.conftest import TEST_DATABASE_URL
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
    "熱量(kcal)", "蛋白質(g)", "脂肪(g)", "碳水(g)", "描述", "備註", "只有我看得到",
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
        # 刻意用公式字元開頭：守「描述經過 guard_text」（跟品牌的 `=茶裏王` 同一招）。
        description="=便當",
    )
    lunch.is_private = True
    await db_session.commit()
    empty = await create_meal(
        db_session,
        user=user,
        eaten_at=datetime(2026, 3, 10, 11, 0, tzinfo=UTC),
        meal_type=MealType.DINNER,
        description="還沒填項目",
    )

    response = await client.get(MEALS, headers=auth(user.id))

    header, *rows = _table(response.content)
    assert header == MEAL_HEADER
    assert rows == [
        [str(lunch.id), "2026-03-10", "12:30", "午餐", "白飯", "", "150.00", "g",
         "195.00", "4.05", "0.45", "42.00", "'=便當", "自己煮", "是"],
        [str(lunch.id), "2026-03-10", "12:30", "午餐", "無糖綠茶", "'=茶裏王", "500.00", "ml",
         "0.00", "0.00", "0.00", "0.00", "'=便當", "自己煮", "是"],
        [str(empty.id), "2026-03-10", "19:00", "晚餐", "", "", "", "", "", "", "", "",
         "還沒填項目", "", "否"],
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


async def _some_of_each(db: AsyncSession, user: User, *, count: int = 1) -> None:
    """三種資料各 `count` 筆，時間一筆一筆往後（餐點沒有項目：一餐一列）。"""
    start = datetime(2026, 3, 10, 4, 0, tzinfo=UTC)
    pill = await create_supplement(db, created_by=user, owner=user)
    for index in range(count):
        moment = start + timedelta(minutes=index)
        await create_meal(db, user=user, eaten_at=moment)
        await create_expense(db, user=user, spent_at=moment)
        await create_intake(db, user=user, supplement=pill, taken_at=moment)


# 三條匯出的路：網址，與 route 模組裡那支 generator 的名字（測試要把它包一層）。
EXPORT_PATHS = [
    pytest.param(MEALS, "meal_csv", id="meals"),
    pytest.param(EXPENSES, "expense_csv", id="expenses"),
    pytest.param(SUPPLEMENTS, "supplement_csv", id="supplements"),
]


@pytest.mark.parametrize(("path", "generator"), EXPORT_PATHS)
async def test_the_database_session_stays_open_until_the_last_chunk(
    db_session, monkeypatch, path, generator
):
    """`get_db` 的收尾要在串流**結束之後**——三個端點各自宣告自己的 `Depends(get_db)`，
    所以三個都要守（只測花費的話，把餐點那一支改成 `scope="function"` 沒有人會發現）。

    FastAPI 0.118 之前、或把依賴改成 `scope="function"`，session 會在第一塊送出之前就被關掉
    ——而共用 session 的 `client` 夾具根本不關 session，看不到這件事（第 14 種）。
    """
    user = await create_user(db_session)
    await _some_of_each(db_session, user)
    user_id = user.id
    events: list[str] = []

    async def get_db_spy():
        try:
            yield db_session
        finally:
            events.append("session-closed")

    original = getattr(export_routes, generator)

    async def spying(db, **kwargs):
        async for chunk in original(db, **kwargs):
            events.append("chunk")
            yield chunk

    monkeypatch.setattr(export_routes, generator, spying)
    app.dependency_overrides[get_db] = get_db_spy
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as raw:
            response = await raw.get(path, headers=auth(user_id))
    finally:
        app.dependency_overrides.clear()

    assert response.status_code == 200
    assert len(_table(response.content)) == 2  # 標題＋一列：真的讀到資料了
    assert events == ["chunk", "chunk", "session-closed"]  # 標題、一塊資料，然後才收尾


# ── 送的時候不握著資料庫連線 ──────────────────────────────────────────────────
#
# 讀得很慢、或根本不讀的用戶端，會讓伺服器卡在 ASGI 的 `send` 上（uvicorn 的寫入緩衝滿了
# 就等）。那時候如果交易還開著，那條連線就一直「idle in transaction」地被佔著——限速只管
# 「開始幾次」，幾個卡住的下載就能把連線池（5＋10）佔滿。所以這裡看的是 **`send` 的那一刻**。


async def _just_send(message: dict[str, Any]) -> None:
    return None


def _on_the_wire(
    on_send: Callable[[dict[str, Any]], Awaitable[None]] = _just_send,
    *,
    hang_up: asyncio.Event | None = None,
) -> Any:
    """包在 `app` 外面的一層 ASGI，站在 uvicorn 的位置上。

    - 每一個要送出去的訊息（標頭、每一塊、結尾）先交給 `on_send`。
    - 給了 `hang_up`：它被 set 的時候，app 收到 `http.disconnect`——用戶端斷線在 ASGI 裡
      就是這個訊息，Starlette 收到之後取消還在串流的那個 task（用的是 anyio 的 cancel scope，
      跟直接 `task.cancel()` 不一樣：在那個 scope 裡每一次 await 都會再被取消一次）。
      斷線之後 app 沒送結尾就回來了；真的 uvicorn 這時候只是把連線關掉，httpx 的
      `ASGITransport` 卻堅持回應要有結尾，所以這裡替它補一個——測試拿到的是斷在半路的內容。
    """

    async def asgi(scope: Any, receive: Any, send: Any) -> None:
        asked = False
        ended = False

        async def spy_send(message: dict[str, Any]) -> None:
            nonlocal ended
            await on_send(message)
            await send(message)
            ended = _kind(message) == "end"

        async def spy_receive() -> dict[str, Any]:
            nonlocal asked
            if hang_up is None or not asked:
                asked = True  # GET 沒有 body：第一個訊息就是整個請求
                return await receive()
            await hang_up.wait()
            return {"type": "http.disconnect"}

        await app(scope, spy_receive, spy_send)
        if hang_up is not None and hang_up.is_set() and not ended:
            await send({"type": "http.response.body", "body": b"", "more_body": False})

    return asgi


def _kind(message: dict[str, Any]) -> str:
    """標頭／一塊內容／結尾。Starlette 的結尾是一個空的、`more_body=False` 的 body。"""
    if message["type"] == "http.response.start":
        return "start"
    return "chunk" if message.get("more_body") else "end"


@pytest.mark.parametrize(("path", "generator"), EXPORT_PATHS)
async def test_no_transaction_is_open_whenever_the_response_is_being_sent(
    client, db_session, monkeypatch, path, generator
):
    """共用交易的夾具看不到連線池，看的是它的前提：`send` 的時候 session 沒有開著的交易
    （正式環境裡，交易結束＝連線還給池子；真的連線池在下一條測試）。"""
    monkeypatch.setattr("app.export.EXPORT_CHUNK_ROWS", 2)
    monkeypatch.setattr("app.export.EXPORT_CHUNK_MEALS", 2)
    user = await create_user(db_session)
    await _some_of_each(db_session, user, count=3)
    user_id = user.id
    seen: list[tuple[str, bool]] = []

    async def on_send(message: dict[str, Any]) -> None:
        seen.append((_kind(message), db_session.in_transaction()))

    transport = ASGITransport(app=_on_the_wire(on_send))
    async with AsyncClient(transport=transport, base_url="http://test") as watched:
        response = await watched.get(path, headers=auth(user_id))

    assert response.status_code == 200
    assert len(_table(response.content)) == 1 + 3
    # 標頭（認證那一次查詢開的交易）、標題列、兩塊資料、結尾（最後那一次「查不到東西」的查詢）。
    assert seen == [
        ("start", False),
        ("chunk", False),
        ("chunk", False),
        ("chunk", False),
        ("end", False),
    ]


@pytest_asyncio.fixture
async def one_connection_pool(migrated_database: None, monkeypatch) -> AsyncIterator[AsyncEngine]:
    """**真的連線池、而且只有一條連線**，接在正式的 `get_db` 後面（換掉的是 `SessionLocal`）。

    `db_session` 夾具從頭到尾握著同一條連線，「還給池子」在那裡不存在。其餘跟 `app/db.py`
    一樣（`pool_pre_ping`：每次借連線先 ping 一下）。
    """
    engine = create_async_engine(
        TEST_DATABASE_URL, pool_pre_ping=True, pool_size=1, max_overflow=0, pool_timeout=0.5
    )
    monkeypatch.setattr("app.db.SessionLocal", async_sessionmaker(engine, expire_on_commit=False))
    try:
        yield engine
    finally:
        await engine.dispose()


@pytest_asyncio.fixture
async def committed_user(migrated_database: None) -> AsyncIterator[int]:
    """**真的 commit 進資料庫**的使用者（三種資料各三筆）——別的連線才看得到。測試結束時
    刪掉，其他的跟著 `ON DELETE CASCADE` 走。

    用自己的 engine，不用被測的那個池子：那個池子漏了連線（這幾條測試紅的樣子）的時候，
    這裡照樣清得掉，不會留一個使用者給後面的測試。
    """
    engine = create_async_engine(TEST_DATABASE_URL)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    async with sessions() as setup:
        user = await create_user(setup)
        user_id = user.id
        await _some_of_each(setup, user, count=3)
    try:
        yield user_id
    finally:
        async with sessions() as cleanup:
            await cleanup.execute(delete(User).where(User.id == user_id))
            await cleanup.commit()
        await engine.dispose()


@pytest.mark.parametrize(("path", "generator"), EXPORT_PATHS)
async def test_the_connection_is_back_in_the_pool_whenever_the_response_is_being_sent(
    one_connection_pool, committed_user, monkeypatch, path, generator
):
    monkeypatch.setattr("app.export.EXPORT_CHUNK_ROWS", 2)
    monkeypatch.setattr("app.export.EXPORT_CHUNK_MEALS", 2)
    engine = one_connection_pool
    seen: list[tuple[str, int, bool]] = []  # （哪一種訊息, 借出去幾條, 這時候別人借不借得到）

    async def on_send(message: dict[str, Any]) -> None:
        checked_out = engine.pool.checkedout()
        try:
            # 池子只有一條：串流還握著它的話，這裡等到 pool_timeout 就放棄。
            async with engine.connect() as other:
                await other.execute(text("SELECT 1"))
            borrowed = True
        except PoolTimeoutError:
            borrowed = False
        seen.append((_kind(message), checked_out, borrowed))

    transport = ASGITransport(app=_on_the_wire(on_send))
    async with AsyncClient(transport=transport, base_url="http://test") as watched:
        response = await watched.get(path, headers=auth(committed_user))

    assert response.status_code == 200
    # 每一塊都是重新借一條連線查的，而且三列都在：還了之後下一塊照樣讀得到。
    assert len(_table(response.content)) == 1 + 3
    assert seen == [
        ("start", 0, True),
        ("chunk", 0, True),
        ("chunk", 0, True),
        ("chunk", 0, True),
        ("end", 0, True),
    ]
    assert engine.pool.checkedout() == 0


async def _backend_pid(engine: AsyncEngine) -> int:
    async with engine.connect() as connection:
        return (await connection.execute(text("SELECT pg_backend_pid()"))).scalar_one()


@pytest.mark.parametrize(
    "step",
    [
        pytest.param("_do_ping_w_event", id="checkout"),
        pytest.param("do_execute", id="query"),
        pytest.param("do_commit", id="commit"),
    ],
)
async def test_a_disconnect_in_the_middle_of_a_database_step_does_not_cost_the_connection(
    one_connection_pool, committed_user, monkeypatch, caplog, step
):
    """每一塊都重新借一次連線，所以斷線有機會落在「借」（pre-ping）、查詢、結束交易的任何
    一步中間。被取消打斷的資料庫操作，SQLAlchemy 只能把那條連線作廢——而在被取消的 scope 裡
    連關都關不掉（log 一個 `Exception terminating connection` 的 traceback）；落在「借」的
    中間時更糟：連線一直記在「借出去了」，要等垃圾回收才回到池子。

    所以那一步要做完：做完才輪到取消，還回去的是好好的同一條連線。**而且取消真的要輪到**
    ——斷線之後 uvicorn 的 `send` 馬上就回來（不等任何東西），取消沒有地方可以送達的話，
    串流會把剩下的整段歷史讀完、對著一條已經關掉的連線送完。

    作法：把 dialect 的那一個方法換成「先停住、再做原本的事」→ 停住的時候斷線 → 放行。
    換的是 dialect 的方法而不是事件 hook：hook 在 SQLAlchemy 處理 DBAPI 例外的那一層外面，
    在那裡被取消不會讓連線作廢，測不到東西。
    """
    engine = one_connection_pool
    backend_before = await _backend_pid(engine)
    armed = False
    reached = asyncio.Event()
    resume = asyncio.Event()
    hang_up = asyncio.Event()
    dialect = engine.sync_engine.dialect
    original = getattr(dialect, step)

    def held_step(*args: Any, **kwargs: Any) -> Any:
        # 同步的方法，但跑在 SQLAlchemy 的 greenlet 裡：`await_only` 可以在這裡等。
        nonlocal armed
        if armed:
            armed = False
            reached.set()
            await_only(resume.wait())
        return original(*args, **kwargs)

    sent: list[str] = []

    async def on_send(message: dict[str, Any]) -> None:
        # 標題列送出去之後才開始攔：攔的是「下一塊」的那一步，不是認證的那一次查詢。
        # 這裡沒有任何 await——跟斷線之後的 uvicorn 一樣，取消不會在「送」的時候送達。
        nonlocal armed
        sent.append(_kind(message))
        if _kind(message) == "chunk":
            armed = True

    monkeypatch.setattr(dialect, step, held_step)
    try:
        transport = ASGITransport(app=_on_the_wire(on_send, hang_up=hang_up))
        async with AsyncClient(transport=transport, base_url="http://test") as wire:
            download = asyncio.create_task(wire.get(EXPENSES, headers=auth(committed_user)))
            await asyncio.wait_for(reached.wait(), 5)
            hang_up.set()
            # 讓取消有機會送達：沒有擋住的話，它這時候就會打斷停住的那一步。
            for _ in range(10):
                await asyncio.sleep(0)
            resume.set()
            response = await asyncio.wait_for(download, 5)
    finally:
        resume.set()
    checked_out = engine.pool.checkedout()  # 不靠垃圾回收：請求一結束就要是 0

    assert response.status_code == 200  # 標頭早就送出去了；內容斷在半路
    # 標頭、標題列，然後就停了：斷線的時候正在做的那一塊沒有送出去，也沒有再讀下一塊。
    assert sent == ["start", "chunk"]
    assert checked_out == 0
    # 池子裡還是同一條連線：沒有被作廢、重連。
    assert await _backend_pid(engine) == backend_before
    assert [record.getMessage() for record in caplog.records if record.levelname == "ERROR"] == []


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


# ── 一個人同時只能有一個匯出在跑 ──────────────────────────────────────────────


class _FakeClock:
    """單調時鐘的替身（同 `tests/test_session_rate_limit.py`）：時間只在測試說要走的時候走。"""

    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


def _in_flight(clock: _FakeClock, *, max_hold_seconds: float = 600.0) -> InFlightLimiter:
    return InFlightLimiter(
        code="BUSY", message="忙", max_hold_seconds=max_hold_seconds, clock=clock
    )


def test_the_in_flight_limiter_allows_one_per_key_until_it_is_released():
    limiter = _in_flight(_FakeClock())

    alice = limiter.acquire("alice")
    limiter.acquire("bob")  # 別人不受影響
    with pytest.raises(TooManyRequestsError) as refused:
        limiter.acquire("alice")
    limiter.release("alice", alice)
    again = limiter.acquire("alice")  # 放掉之後又可以了
    limiter.release("nobody", object())  # 沒有佔著的鍵：不是錯誤

    assert (refused.value.status_code, refused.value.code) == (429, "BUSY")
    # 不知道前一個什麼時候結束：不給一個編出來的秒數。
    assert refused.value.retry_after_seconds is None
    assert refused.value.headers is None
    assert again is not alice  # 每一次佔到的是一張新的憑證
    limiter.reset()
    limiter.acquire("alice")
    limiter.acquire("bob")


def test_the_in_flight_limiter_keeps_the_slot_until_the_time_limit():
    # 還沒到上限：不管等了多久，佔著就是佔著（正常的下載不能被第二次按下去搶走）。
    clock = _FakeClock()
    limiter = _in_flight(clock, max_hold_seconds=600.0)
    limiter.acquire("alice")

    clock.now += 599.9
    with pytest.raises(TooManyRequestsError) as refused:
        limiter.acquire("alice")

    assert refused.value.code == "BUSY"
    assert refused.value.retry_after_seconds is None


def test_the_in_flight_limiter_hands_the_slot_over_after_the_time_limit():
    # 佔著不放的（不讀、也不斷線的用戶端）不能讓這個人永遠匯出不了：到了上限，下一個接手。
    clock = _FakeClock()
    limiter = _in_flight(clock, max_hold_seconds=600.0)
    stale = limiter.acquire("alice")

    clock.now += 600.0
    fresh = limiter.acquire("alice")

    assert fresh is not stale
    # 接手的那一個是「剛剛」佔的：它自己也有完整的一段時間，不是馬上又可以被接手。
    clock.now += 599.9
    with pytest.raises(TooManyRequestsError):
        limiter.acquire("alice")
    clock.now += 0.1
    limiter.acquire("alice")


def test_a_stale_holder_releasing_late_does_not_free_the_new_holder():
    # 被接手的那一個後來才結束（連線終於斷了）：它放的是**自己的**位子，而那個位子已經
    # 不是它的了。只認鍵的話，這裡會把正在跑的那一個放掉——第三個就進得來。
    clock = _FakeClock()
    limiter = _in_flight(clock, max_hold_seconds=600.0)
    stale = limiter.acquire("alice")
    clock.now += 600.0
    fresh = limiter.acquire("alice")

    limiter.release("alice", stale)
    with pytest.raises(TooManyRequestsError):
        limiter.acquire("alice")
    limiter.release("alice", stale)  # 放兩次也一樣
    with pytest.raises(TooManyRequestsError):
        limiter.acquire("alice")

    limiter.release("alice", fresh)  # 現在佔著的那一個自己放：正常放掉
    limiter.acquire("alice")


def test_a_release_with_another_keys_token_does_nothing():
    clock = _FakeClock()
    limiter = _in_flight(clock)
    limiter.acquire("alice")
    bob = limiter.acquire("bob")

    limiter.release("alice", bob)

    with pytest.raises(TooManyRequestsError):
        limiter.acquire("alice")


def test_the_export_slot_is_held_for_ten_minutes_at_most():
    # 數字寫死：改這個常數要經過這裡（理由在 `app/ratelimit.py`）。
    assert EXPORT_MAX_HOLD_SECONDS == 600.0


class _HeldExport:
    """換掉 route 模組裡的 generator：吐了標題就停住，等測試放行（或叫它失敗）。"""

    def __init__(self) -> None:
        self.header_sent = asyncio.Event()
        self.proceed = asyncio.Event()
        self.fail_with: Exception | None = None
        self.started = 0

    async def csv(self, db: AsyncSession, *, user_id: int, tz_name: str) -> AsyncIterator[bytes]:
        self.started += 1
        yield BOM + b"header\r\n"
        self.header_sent.set()
        await self.proceed.wait()
        if self.fail_with is not None:
            raise self.fail_with
        yield b"row\r\n"


@pytest.fixture
def held(monkeypatch) -> _HeldExport:
    """花費那一支換成會停住的版本；餐點與補劑是真的。"""
    held = _HeldExport()
    monkeypatch.setattr(export_routes, "expense_csv", held.csv)
    return held


async def test_a_second_export_is_refused_while_one_is_still_streaming(client, db_session, held):
    alice = (await create_user(db_session)).id
    bob = (await create_user(db_session)).id

    first = asyncio.create_task(client.get(EXPENSES, headers=auth(alice)))
    try:
        await asyncio.wait_for(held.header_sent.wait(), 5)
        # 另外兩個端點也一樣：算的是人，不是端點。
        second = await client.get(MEALS, headers=auth(alice))
        # 被擋下來的那一次不能把正在跑的那個的位子放掉。
        third = await client.get(SUPPLEMENTS, headers=auth(alice))
        someone_else = await client.get(MEALS, headers=auth(bob))
    finally:
        held.proceed.set()
        finished = await first
    afterwards = await client.get(MEALS, headers=auth(alice))

    for refused in (second, third):
        assert refused.status_code == 429
        assert refused.json()["error"] == {
            "code": "EXPORT_IN_PROGRESS",
            "message": "已經有一個匯出在進行，等它下載完再試",
            "details": {},
        }
        # 跟「太頻繁」不同：沒有一個說得準的秒數。
        assert "Retry-After" not in refused.headers
    assert someone_else.status_code == 200
    assert finished.status_code == 200
    assert finished.content == BOM + b"header\r\nrow\r\n"
    assert afterwards.status_code == 200  # 傳完就放掉了


async def test_refused_attempts_still_count_towards_the_rate_limit(client, db_session, held):
    # 順序是「先算次數、再看有沒有在跑」：對著進行中的匯出狂打的迴圈一樣會被限速擋下來。
    alice = (await create_user(db_session)).id

    first = asyncio.create_task(client.get(EXPENSES, headers=auth(alice)))
    try:
        await asyncio.wait_for(held.header_sent.wait(), 5)
        codes = [
            (await client.get(MEALS, headers=auth(alice))).json()["error"]["code"]
            for _ in range(EXPORT_LIMIT)
        ]
    finally:
        held.proceed.set()
        await first

    assert codes == ["EXPORT_IN_PROGRESS"] * (EXPORT_LIMIT - 1) + ["TOO_MANY_EXPORTS"]


async def test_the_slot_is_released_when_the_stream_fails_midway(client, db_session, held):
    alice = (await create_user(db_session)).id
    held.fail_with = RuntimeError("資料庫斷線之類的")
    held.proceed.set()

    with pytest.raises(RuntimeError, match="資料庫斷線之類的"):
        await client.get(EXPENSES, headers=auth(alice))
    afterwards = await client.get(MEALS, headers=auth(alice))

    assert held.started == 1
    assert afterwards.status_code == 200


async def _never_sent(stalled: asyncio.Event) -> Callable[[dict[str, Any]], Awaitable[None]]:
    """讀的人不讀了：第一塊內容永遠送不出去（uvicorn 的寫入緩衝滿了就是這樣卡在 `send`）。"""

    async def on_send(message: dict[str, Any]) -> None:
        if message["type"] == "http.response.body" and message.get("body"):
            stalled.set()
            await asyncio.Event().wait()

    return on_send


async def test_the_slot_is_released_when_a_stalled_download_hangs_up(client, db_session, held):
    """讀的人不讀了（伺服器卡在 `send`），然後斷線。Starlette 取消的是卡在 `send` 的那個
    task；generator 停在 `yield` 上，沒有人叫它收尾——位子不能靠 generator 自己放。"""
    alice = (await create_user(db_session)).id
    stalled = asyncio.Event()
    hang_up = asyncio.Event()

    transport = ASGITransport(app=_on_the_wire(await _never_sent(stalled), hang_up=hang_up))
    async with AsyncClient(transport=transport, base_url="http://test") as stuck:
        download = asyncio.create_task(stuck.get(EXPENSES, headers=auth(alice)))
        await asyncio.wait_for(stalled.wait(), 5)
        refused = await client.get(MEALS, headers=auth(alice))  # 卡著的時候位子還佔著
        hang_up.set()
        cut_short = await asyncio.wait_for(download, 5)
    afterwards = await client.get(MEALS, headers=auth(alice))

    assert refused.status_code == 429
    assert cut_short.content == b""  # 一塊都沒送出去
    assert held.started == 1
    assert not held.header_sent.is_set()  # generator 還停在第一個 yield
    assert afterwards.status_code == 200


async def test_a_stalled_download_loses_the_slot_after_the_time_limit(
    client, db_session, held, monkeypatch
):
    """讀的人不讀、**也不斷線**：位子不能跟著那條連線一起永遠佔著。到了上限下一個接手；
    卡住的那一個後來才結束時，放掉的不能是接手的那一個的位子。"""
    # 只換**正式那一個 instance** 的時鐘，不另外建一個：上限要是它真的被設定的那個值
    # （自己建一個的話，正式的 instance 寫死成別的數字這裡也是綠的——突變實測過）。
    clock = _FakeClock()
    monkeypatch.setattr(export_routes.export_in_flight, "_clock", clock)
    alice = (await create_user(db_session)).id
    stalled = asyncio.Event()
    hang_up = asyncio.Event()

    transport = ASGITransport(app=_on_the_wire(await _never_sent(stalled), hang_up=hang_up))
    async with AsyncClient(transport=transport, base_url="http://test") as stuck:
        download = asyncio.create_task(stuck.get(EXPENSES, headers=auth(alice)))
        await asyncio.wait_for(stalled.wait(), 5)
        clock.now += EXPORT_MAX_HOLD_SECONDS - 1
        too_early = await client.get(MEALS, headers=auth(alice))
        clock.now += 1
        # 接手的這一個也停在串流中間（花費那一支：吐了標題就等放行）。
        takeover = asyncio.create_task(client.get(EXPENSES, headers=auth(alice)))
        try:
            await asyncio.wait_for(held.header_sent.wait(), 5)
            # 卡住的那一個現在才斷線、收尾。
            hang_up.set()
            cut_short = await asyncio.wait_for(download, 5)
            while_the_new_one_runs = await client.get(MEALS, headers=auth(alice))
        finally:
            held.proceed.set()
            finished = await asyncio.wait_for(takeover, 5)
    afterwards = await client.get(MEALS, headers=auth(alice))

    assert too_early.status_code == 429
    assert too_early.json()["error"]["code"] == "EXPORT_IN_PROGRESS"
    assert cut_short.content == b""
    assert finished.status_code == 200
    assert finished.content == BOM + b"header\r\nrow\r\n"
    assert held.started == 2
    # 舊的那一個收尾時沒有把新的那一個的位子放掉。
    assert while_the_new_one_runs.status_code == 429
    assert while_the_new_one_runs.json()["error"]["code"] == "EXPORT_IN_PROGRESS"
    assert afterwards.status_code == 200  # 新的那一個自己做完，位子才空出來


async def test_the_slot_is_released_when_the_request_task_is_cancelled(client, db_session, held):
    """同一種卡住，但結束的方式是整個請求的 task 被取消——uvicorn 設了
    `--timeout-graceful-shutdown`、關機等到時間到的時候就是這樣（這個部署沒有設）。"""
    alice = (await create_user(db_session)).id
    stalled = asyncio.Event()

    transport = ASGITransport(app=_on_the_wire(await _never_sent(stalled)))
    async with AsyncClient(transport=transport, base_url="http://test") as stuck:
        download = asyncio.create_task(stuck.get(EXPENSES, headers=auth(alice)))
        await asyncio.wait_for(stalled.wait(), 5)
        download.cancel()
        with pytest.raises(asyncio.CancelledError):
            await download
    afterwards = await client.get(MEALS, headers=auth(alice))

    assert held.started == 1
    assert not held.header_sent.is_set()
    assert afterwards.status_code == 200


async def test_the_slot_is_released_when_the_response_never_starts(client, db_session, held):
    """handler 已經回了 `StreamingResponse`，但連標頭都送不出去（用戶端早就走了）：
    generator 建了、**從來沒有被迭代**——寫在 generator 裡的 `finally` 永遠不會跑。"""
    alice = (await create_user(db_session)).id

    async def on_send(message: dict[str, Any]) -> None:
        raise OSError("用戶端已經斷線")

    transport = ASGITransport(app=_on_the_wire(on_send))
    async with AsyncClient(transport=transport, base_url="http://test") as gone:
        with pytest.raises(OSError, match="用戶端已經斷線"):
            await gone.get(EXPENSES, headers=auth(alice))
    afterwards = await client.get(MEALS, headers=auth(alice))

    assert held.started == 0
    assert afterwards.status_code == 200
