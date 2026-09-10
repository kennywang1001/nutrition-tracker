"""Task 7：`GET /api/stats/daily?date=`。

回應形狀（決定 2）：`actual`／`breakdown.food`／`breakdown.supplement` 一律是
數字（沒有資料就是 0，不是 null）；`target`／`ratio` 沒設目標時整組是
null，設了目標則逐欄位處理（陷阱 3：某個營養素沒設 -> 那一欄 null；
某個營養素目標是 0 -> 那一欄 ratio 也是 null，不能除以 0）。
"""

from datetime import UTC, date, datetime
from decimal import Decimal

from sqlalchemy import event

from app.models.food import FoodRevision
from app.models.user import UserRole
from app.security.tokens import create_token
from tests.factories import (
    create_food,
    create_intake,
    create_meal,
    create_pending_revision,
    create_supplement,
    create_target,
    create_user,
)


def auth(user):
    return {"Authorization": f"Bearer {create_token(user.id, 'access')}"}


async def _revision(db_session, food):
    return await db_session.get(FoodRevision, food.current_revision_id)


# ---------------------------------------------------------------------------
# actual / breakdown：食物、補劑、兩者都有
# ---------------------------------------------------------------------------


async def test_daily_stats_with_only_food(client, db_session):
    user = await create_user(db_session)
    food = await create_food(
        db_session, created_by=user, kcal=200, protein_g=20, fat_g=10, carb_g=30
    )
    revision = await _revision(db_session, food)
    await create_meal(
        db_session,
        user=user,
        eaten_at=datetime(2026, 1, 1, 4, 0, tzinfo=UTC),
        items=[(revision, Decimal("100"))],
    )

    response = await client.get(
        "/api/stats/daily", headers=auth(user), params={"date": "2026-01-01"}
    )

    assert response.status_code == 200
    body = response.json()
    assert body["date"] == "2026-01-01"
    assert body["actual"] == {
        "kcal": "200.00",
        "protein_g": "20.00",
        "fat_g": "10.00",
        "carb_g": "30.00",
    }
    assert body["breakdown"]["food"] == body["actual"]
    assert body["breakdown"]["supplement"] == {
        "kcal": "0.00",
        "protein_g": "0.00",
        "fat_g": "0.00",
        "carb_g": "0.00",
    }


async def test_daily_stats_with_only_supplement(client, db_session):
    user = await create_user(db_session)
    supplement = await create_supplement(db_session, created_by=user, owner=user)
    await create_intake(
        db_session,
        user=user,
        supplement=supplement,
        taken_at=datetime(2026, 1, 1, 1, 0, tzinfo=UTC),
        kcal=150,
        protein_g=32,
        fat_g=2,
        carb_g=2,
    )

    response = await client.get(
        "/api/stats/daily", headers=auth(user), params={"date": "2026-01-01"}
    )

    assert response.status_code == 200
    body = response.json()
    assert body["breakdown"]["supplement"] == {
        "kcal": "150.00",
        "protein_g": "32.00",
        "fat_g": "2.00",
        "carb_g": "2.00",
    }
    assert body["breakdown"]["food"] == {
        "kcal": "0.00",
        "protein_g": "0.00",
        "fat_g": "0.00",
        "carb_g": "0.00",
    }
    assert body["actual"] == body["breakdown"]["supplement"]


async def test_daily_stats_actual_is_food_plus_supplement_and_breakdown_matches(
    client, db_session
):
    user = await create_user(db_session)
    food = await create_food(
        db_session, created_by=user, kcal=200, protein_g=20, fat_g=10, carb_g=30
    )
    revision = await _revision(db_session, food)
    await create_meal(
        db_session,
        user=user,
        eaten_at=datetime(2026, 1, 1, 4, 0, tzinfo=UTC),
        items=[(revision, Decimal("100"))],
    )
    supplement = await create_supplement(db_session, created_by=user, owner=user)
    await create_intake(
        db_session,
        user=user,
        supplement=supplement,
        taken_at=datetime(2026, 1, 1, 1, 0, tzinfo=UTC),
        kcal=150,
        protein_g=32,
        fat_g=2,
        carb_g=2,
    )

    response = await client.get(
        "/api/stats/daily", headers=auth(user), params={"date": "2026-01-01"}
    )

    assert response.status_code == 200
    body = response.json()
    assert body["actual"] == {
        "kcal": "350.00",
        "protein_g": "52.00",
        "fat_g": "12.00",
        "carb_g": "32.00",
    }
    for field in ("kcal", "protein_g", "fat_g", "carb_g"):
        food_value = Decimal(body["breakdown"]["food"][field])
        supplement_value = Decimal(body["breakdown"]["supplement"][field])
        assert food_value + supplement_value == Decimal(body["actual"][field])


# ---------------------------------------------------------------------------
# 決定 2 + 陷阱 3：target / ratio 的 null 矩陣
# ---------------------------------------------------------------------------


async def test_daily_stats_no_target_set_returns_null_target_and_ratio(client, db_session):
    """決定 2：沒設目標時 target 與 ratio 整組都是 null，不是省略欄位、
    也不是全 0 的物件。"""
    user = await create_user(db_session)

    response = await client.get(
        "/api/stats/daily", headers=auth(user), params={"date": "2026-01-01"}
    )

    assert response.status_code == 200
    body = response.json()
    assert body["target"] is None
    assert body["ratio"] is None
    # 沒有目標不代表沒有「實際攝取」這個概念 —— actual 永遠是數字。
    assert body["actual"] == {
        "kcal": "0.00",
        "protein_g": "0.00",
        "fat_g": "0.00",
        "carb_g": "0.00",
    }


async def test_daily_stats_kcal_only_target_leaves_other_ratios_null(client, db_session):
    """陷阱 3：只設熱量目標時，target/ratio 是一個物件（不是 null），
    但物件裡只有 kcal 有值，其餘三個欄位各自是 null。"""
    user = await create_user(db_session)
    await create_target(
        db_session, user=user, kcal=2000, effective_from=date(2026, 1, 1)
    )
    food = await create_food(db_session, created_by=user, kcal=1850, protein_g=0, fat_g=0, carb_g=0)
    revision = await _revision(db_session, food)
    await create_meal(
        db_session,
        user=user,
        eaten_at=datetime(2026, 1, 1, 4, 0, tzinfo=UTC),
        items=[(revision, Decimal("100"))],
    )

    response = await client.get(
        "/api/stats/daily", headers=auth(user), params={"date": "2026-01-01"}
    )

    assert response.status_code == 200
    body = response.json()
    assert body["target"] == {
        "kcal": "2000.00",
        "protein_g": None,
        "fat_g": None,
        "carb_g": None,
    }
    assert body["ratio"]["kcal"] == "0.93"  # 1850 / 2000 = 0.925 -> ROUND_HALF_UP -> 0.93
    assert body["ratio"]["protein_g"] is None
    assert body["ratio"]["fat_g"] is None
    assert body["ratio"]["carb_g"] is None


async def test_daily_stats_target_of_zero_returns_null_ratio_not_500(client, db_session):
    """陷阱 3 收尾：目標可以合法是 0（CHECK 放行），但 0 沒辦法定義「比例」——
    除以 0 不能讓客戶端收到 500。選擇：該欄 ratio 回 null，並在這裡釘住。
    """
    user = await create_user(db_session)
    await create_target(
        db_session, user=user, kcal=0, protein_g=100, effective_from=date(2026, 1, 1)
    )

    response = await client.get(
        "/api/stats/daily", headers=auth(user), params={"date": "2026-01-01"}
    )

    assert response.status_code == 200
    body = response.json()
    assert body["target"]["kcal"] == "0.00"
    assert body["ratio"]["kcal"] is None
    # 其他有正常設定（非 0）的欄位不受影響，證明不是整組都被砍成 null。
    assert body["target"]["protein_g"] == "100.00"
    assert body["ratio"]["protein_g"] == "0.00"


# ---------------------------------------------------------------------------
# 陷阱 4 的另一半：食物必須用「釘住」的 revision，不是食物現在的版本
# ---------------------------------------------------------------------------


async def test_daily_stats_uses_pinned_food_revision_not_foods_current_revision(
    client, db_session
):
    """跟 GET /api/meals/{id}（計畫 3）同一個坑，但這裡是完全不同的查詢
    （app/stats.py 的 bucket_daily_macros，不是 meals.py 的 _item_join_query），
    所以需要自己的測試：記一餐之後，食物被審核通過一筆全新的版本
    （kcal 200 -> 999），這一餐的統計數字必須維持記錄當時的版本，不能跟著變。
    """
    admin = await create_user(db_session, role=UserRole.ADMIN)
    user = await create_user(db_session)
    food = await create_food(
        db_session, created_by=user, kcal=200, protein_g=10, fat_g=5, carb_g=20
    )
    revision = await _revision(db_session, food)
    await create_meal(
        db_session,
        user=user,
        eaten_at=datetime(2026, 1, 1, 4, 0, tzinfo=UTC),
        items=[(revision, Decimal("100"))],
    )

    pending = await create_pending_revision(db_session, food=food, created_by=admin, kcal=999)
    approve_response = await client.post(
        f"/api/admin/food-revisions/{pending.id}/approve", headers=auth(admin)
    )
    assert approve_response.status_code == 200

    response = await client.get(
        "/api/stats/daily", headers=auth(user), params={"date": "2026-01-01"}
    )

    assert response.status_code == 200
    assert response.json()["breakdown"]["food"]["kcal"] == "200.00"


# ---------------------------------------------------------------------------
# date 預設值、跨使用者隔離、認證
# ---------------------------------------------------------------------------


async def test_daily_stats_defaults_to_today_in_users_timezone(client, db_session, monkeypatch):
    user = await create_user(db_session)  # 預設時區 Asia/Taipei
    fixed_today = date(2026, 5, 10)
    monkeypatch.setattr("app.api.routes.stats.today_in_timezone", lambda _tz: fixed_today)
    food = await create_food(db_session, created_by=user, kcal=200, protein_g=0, fat_g=0, carb_g=0)
    revision = await _revision(db_session, food)
    # 台北 2026-05-10 04:00 == UTC 2026-05-09 20:00，落在 fixed_today 的範圍內。
    await create_meal(
        db_session,
        user=user,
        eaten_at=datetime(2026, 5, 9, 20, 0, tzinfo=UTC),
        items=[(revision, Decimal("100"))],
    )

    response = await client.get("/api/stats/daily", headers=auth(user))

    assert response.status_code == 200
    body = response.json()
    assert body["date"] == "2026-05-10"
    assert body["actual"]["kcal"] == "200.00"


async def test_daily_stats_excludes_other_users_data(client, db_session):
    """用全域食物/補劑（owner=None）：可見性不會先擋住 bob 的資料，
    這裡測的才是真正的 user_id 過濾（計畫 3 Task 17 的教訓）。
    """
    alice = await create_user(db_session)
    bob = await create_user(db_session)
    food = await create_food(db_session, created_by=alice, kcal=200, protein_g=0, fat_g=0, carb_g=0)
    revision = await _revision(db_session, food)
    await create_meal(
        db_session,
        user=bob,
        eaten_at=datetime(2026, 1, 1, 4, 0, tzinfo=UTC),
        items=[(revision, Decimal("100"))],
    )
    await create_target(db_session, user=bob, kcal=1800, effective_from=date(2026, 1, 1))

    response = await client.get(
        "/api/stats/daily", headers=auth(alice), params={"date": "2026-01-01"}
    )

    assert response.status_code == 200
    body = response.json()
    assert body["actual"]["kcal"] == "0.00"
    assert body["target"] is None


async def test_daily_stats_requires_authentication(client):
    response = await client.get("/api/stats/daily")

    assert response.status_code == 401


# ---------------------------------------------------------------------------
# 查詢次數：不能隨項目/打卡數量增加（陷阱 2 的 N+1 提醒也適用在這個端點）
# ---------------------------------------------------------------------------


async def test_daily_stats_query_count_does_not_scale_with_item_count(client, db_session):
    """10 個餐點項目 + 5 筆補劑打卡：查詢數必須是固定的常數，不能跟著項目數
    成長 —— 用 SQLAlchemy 的 before_cursor_execute 事件直接數這次 request
    真的送了幾次 SQL 到資料庫，不是用碼審讀程式碼用猜的。
    """
    user = await create_user(db_session)
    await create_target(db_session, user=user, kcal=2000, effective_from=date(2026, 1, 1))
    food = await create_food(db_session, created_by=user, kcal=10, protein_g=1, fat_g=1, carb_g=1)
    revision = await _revision(db_session, food)
    items = [(revision, Decimal("100")) for _ in range(10)]
    await create_meal(
        db_session, user=user, eaten_at=datetime(2026, 1, 1, 4, 0, tzinfo=UTC), items=items
    )
    supplement = await create_supplement(db_session, created_by=user, owner=user)
    for hour in range(5):
        await create_intake(
            db_session,
            user=user,
            supplement=supplement,
            taken_at=datetime(2026, 1, 1, hour, 0, tzinfo=UTC),
            kcal=10,
        )

    sync_engine = db_session.bind.sync_engine
    statement_count = 0

    def _count_statement(*_args, **_kwargs):
        nonlocal statement_count
        statement_count += 1

    event.listen(sync_engine, "before_cursor_execute", _count_statement)
    try:
        response = await client.get(
            "/api/stats/daily", headers=auth(user), params={"date": "2026-01-01"}
        )
    finally:
        event.remove(sync_engine, "before_cursor_execute", _count_statement)

    assert response.status_code == 200
    assert response.json()["breakdown"]["food"]["kcal"] == "100.00"
    # 目前的實作：食物一次查詢、補劑一次查詢、目標一次查詢 = 3 次，
    # 跟 10 個項目、5 筆打卡完全無關。這裡斷言一個固定的小數字，
    # 之後如果多了一次查詢（=出現 N+1），這個數字會被撐大，測試會抓到。
    assert statement_count == 3
