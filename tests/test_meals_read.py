from datetime import UTC, date, datetime, timedelta
from decimal import Decimal

from app.days import day_bounds
from app.models.meal import MealType
from app.models.user import UserRole
from app.security.tokens import create_token
from tests.factories import (
    create_food,
    create_meal,
    create_pending_revision,
    create_portion,
    create_user,
)


def auth(user):
    return {"Authorization": f"Bearer {create_token(user.id, 'access')}"}


def _create_payload(**overrides):
    payload = {
        "eaten_at": "2026-09-04T12:30:00+08:00",
        "meal_type": "lunch",
        "note": "測試用的一餐",
        "items": [],
    }
    payload.update(overrides)
    return payload


async def test_read_own_meal_returns_items_food_name_and_totals(client, db_session):
    user = await create_user(db_session)
    food = await create_food(
        db_session,
        created_by=user,
        owner=user,
        name="測試雞胸肉",
        kcal=200,
        protein_g=10,
        fat_g=5,
        carb_g=20,
    )

    create_response = await client.post(
        "/api/meals",
        headers=auth(user),
        json=_create_payload(items=[{"food_id": food.id, "quantity": "100"}]),
    )
    assert create_response.status_code == 201
    meal_id = create_response.json()["id"]

    response = await client.get(f"/api/meals/{meal_id}", headers=auth(user))

    assert response.status_code == 200
    body = response.json()
    assert body["id"] == meal_id
    assert body["meal_type"] == "lunch"
    assert body["note"] == "測試用的一餐"
    assert len(body["items"]) == 1
    item = body["items"][0]
    assert item["food_id"] == food.id
    assert item["food_name"] == "測試雞胸肉"
    assert item["quantity_g"] == "100.00"
    assert item["kcal"] == "200.00"
    assert body["kcal"] == "200.00"
    assert body["protein_g"] == "10.00"
    assert body["fat_g"] == "5.00"
    assert body["carb_g"] == "20.00"


async def test_reading_someone_elses_meal_is_not_found(client, db_session):
    alice = await create_user(db_session)
    bob = await create_user(db_session)
    create_response = await client.post(
        "/api/meals", headers=auth(alice), json=_create_payload()
    )
    meal_id = create_response.json()["id"]

    response = await client.get(f"/api/meals/{meal_id}", headers=auth(bob))

    assert response.status_code == 404


async def test_reading_a_nonexistent_meal_is_not_found(client, db_session):
    user = await create_user(db_session)

    response = await client.get("/api/meals/999999", headers=auth(user))

    assert response.status_code == 404


async def test_isolation_failure_and_missing_meal_return_identical_bodies(client, db_session):
    """跟計畫 2 的 test_every_isolation_failure_looks_identical 同一種守則：
    「不是你的」跟「不存在」對呼叫端必須無法區分。
    """
    alice = await create_user(db_session)
    bob = await create_user(db_session)
    create_response = await client.post(
        "/api/meals", headers=auth(alice), json=_create_payload()
    )
    meal_id = create_response.json()["id"]

    not_yours = await client.get(f"/api/meals/{meal_id}", headers=auth(bob))
    missing = await client.get("/api/meals/999999", headers=auth(bob))

    assert not_yours.status_code == missing.status_code == 404
    assert not_yours.json() == missing.json()


async def test_reading_a_meal_with_no_items_returns_zero_totals(client, db_session):
    user = await create_user(db_session)
    create_response = await client.post(
        "/api/meals", headers=auth(user), json=_create_payload(items=[])
    )
    meal_id = create_response.json()["id"]

    response = await client.get(f"/api/meals/{meal_id}", headers=auth(user))

    assert response.status_code == 200
    body = response.json()
    assert body["items"] == []
    assert body["kcal"] == "0.00"
    assert body["protein_g"] == "0.00"
    assert body["fat_g"] == "0.00"
    assert body["carb_g"] == "0.00"


async def test_read_meal_requires_authentication(client, db_session):
    user = await create_user(db_session)
    create_response = await client.post(
        "/api/meals", headers=auth(user), json=_create_payload()
    )
    meal_id = create_response.json()["id"]

    response = await client.get(f"/api/meals/{meal_id}")

    assert response.status_code == 401


async def test_get_meal_uses_frozen_quantity_g_not_live_portion_grams(client, db_session):
    """讀取端的凍結測試 —— Task 7 實測發現明確留下的缺口，本 task 最重要的斷言。

    Task 7 只證明了「寫入的 quantity_g 欄位不會動」，但當時沒有 GET 端點，
    測不到真正危險的形狀：GET handler 去 join 即時的份量資料重算，而不是信任
    寫入時就凍結好的 quantity_g。這裡把兩件事串起來：用 200g 的份量記一餐，
    把份量改成 250g，再用 GET /api/meals/{id} 讀回來 —— quantity_g 與 kcal
    都必須還是舊值（200.00 / 400.00），不能變成用 250g 重算出來的數字。
    """
    user = await create_user(db_session)
    food = await create_food(db_session, created_by=user, owner=user, kcal=200)
    portion = await create_portion(db_session, food=food, grams=200)

    create_response = await client.post(
        "/api/meals",
        headers=auth(user),
        json=_create_payload(
            items=[{"food_id": food.id, "quantity": "1", "portion_id": portion.id}]
        ),
    )
    assert create_response.status_code == 201
    meal_id = create_response.json()["id"]
    original_item = create_response.json()["items"][0]
    assert original_item["quantity_g"] == "200.00"
    assert original_item["kcal"] == "400.00"

    portion.grams = Decimal("250")
    await db_session.commit()

    response = await client.get(f"/api/meals/{meal_id}", headers=auth(user))

    assert response.status_code == 200
    item = response.json()["items"][0]
    assert item["quantity_g"] == "200.00"
    assert item["kcal"] == "400.00"


async def test_get_meal_uses_pinned_revision_not_foods_current_revision(client, db_session):
    """版本化的重點：GET 用項目當時釘住的 food_revision_id，不是食物現在的版本。

    記一餐之後，管理員審核通過一筆全新的營養素版本（kcal 從 200 改成 999），
    food.current_revision_id 因此往前移動 —— 但這一餐的數字必須完全不動，
    因為 meal_items.food_revision_id 釘住的是審核前那一版。
    """
    admin = await create_user(db_session, role=UserRole.ADMIN)
    user = await create_user(db_session)
    # 全域食物（owner=None）：admin 審核流程只對全域食物有意義，
    # 私人食物的編輯是直接生效的（見 app/api/routes/foods.py propose_revision）。
    food = await create_food(
        db_session, created_by=user, kcal=200, protein_g=10, fat_g=5, carb_g=20
    )

    create_response = await client.post(
        "/api/meals",
        headers=auth(user),
        json=_create_payload(items=[{"food_id": food.id, "quantity": "100"}]),
    )
    assert create_response.status_code == 201
    meal_id = create_response.json()["id"]
    assert create_response.json()["items"][0]["kcal"] == "200.00"

    pending = await create_pending_revision(db_session, food=food, created_by=admin, kcal=999)
    approve_response = await client.post(
        f"/api/admin/food-revisions/{pending.id}/approve", headers=auth(admin)
    )
    assert approve_response.status_code == 200

    response = await client.get(f"/api/meals/{meal_id}", headers=auth(user))

    assert response.status_code == 200
    body = response.json()
    assert body["items"][0]["kcal"] == "200.00"
    assert body["kcal"] == "200.00"


# ---------------------------------------------------------------------------
# Task 9: GET /api/meals?date= —— 時區在這裡發揮作用
# ---------------------------------------------------------------------------
#
# 下面三個測試（07:00 早餐、23:00 宵夜、不同時區使用者）是「時區存在 users
# 表」這個計畫決定唯一的實證：如果拿掉它們，一個把 day_bounds() 換成
# 「UTC 當天 00:00-24:00」的實作會全部通過。


async def test_get_by_date_returns_that_days_meals_ordered_by_eaten_at(client, db_session):
    user = await create_user(db_session)  # 預設時區 Asia/Taipei
    # 2026-09-04（台北）的 UTC 範圍是 [2026-09-03T16:00, 2026-09-04T16:00)
    later = await create_meal(
        db_session, user=user, eaten_at=datetime(2026, 9, 4, 10, 0, tzinfo=UTC)
    )
    earlier = await create_meal(
        db_session, user=user, eaten_at=datetime(2026, 9, 3, 20, 0, tzinfo=UTC)
    )
    # 落在這一天範圍外的一餐，確認不會被誤收進來
    await create_meal(db_session, user=user, eaten_at=datetime(2026, 9, 3, 10, 0, tzinfo=UTC))

    response = await client.get("/api/meals", headers=auth(user), params={"date": "2026-09-04"})

    assert response.status_code == 200
    ids = [meal["id"] for meal in response.json()]
    assert ids == [earlier.id, later.id]


async def test_taipei_breakfast_at_07_00_appears_on_its_own_day_not_the_day_before(
    client, db_session
):
    """台北時間早上 7 點的早餐，UTC 時刻是前一天 23:00 —— 這是整個時區設計
    存在的理由：拿掉這個測試，寫死 UTC 的實作也會通過其他所有測試。
    """
    user = await create_user(db_session)  # 預設時區 Asia/Taipei
    # 2026-09-04 07:00 台北 == 2026-09-03 23:00 UTC
    breakfast = await create_meal(
        db_session,
        user=user,
        eaten_at=datetime(2026, 9, 3, 23, 0, tzinfo=UTC),
        meal_type=MealType.BREAKFAST,
    )

    that_day = await client.get("/api/meals", headers=auth(user), params={"date": "2026-09-04"})
    day_before = await client.get("/api/meals", headers=auth(user), params={"date": "2026-09-03"})

    assert [meal["id"] for meal in that_day.json()] == [breakfast.id]
    assert day_before.json() == []


async def test_late_night_snack_appears_that_day_not_the_next(client, db_session):
    """晚間吃的宵夜要留在當天，不能被算到隔天。

    刻意用 America/New_York（UTC-4，夏令時）而不是 Asia/Taipei 來寫這個測試 ——
    這是實測發現：Taipei 是 UTC+8，「當地晚一點」換算成 UTC 只會往回退到
    同一個 UTC 日期（23:00 - 8h = 15:00，還是同一天），所以拿 Taipei 23:00 當
    測資的話，就算把實作寫死成 UTC，這筆宵夜換算後**照樣**落在同一個 UTC 日期、
    測試照樣通過 —— 抓不到「忘記讀使用者時區」這個突變。
    只有時區在 UTC**之後**（America/New_York 這種負偏移）的深夜時刻，
    加上偏移換算成 UTC 才會**進位到隔天**，才是「宵夜被誤判成隔天」這個
    風險真正會發生的方向，也才是這個測試真正該守住的案例。
    """
    user = await create_user(db_session)
    patch_response = await client.patch(
        "/api/me", headers=auth(user), json={"timezone": "America/New_York"}
    )
    assert patch_response.status_code == 200
    # 2026-09-04 23:30 紐約（夏令時 UTC-4） == 2026-09-05 03:30 UTC（隔天！）
    snack = await create_meal(
        db_session,
        user=user,
        eaten_at=datetime(2026, 9, 5, 3, 30, tzinfo=UTC),
        meal_type=MealType.SNACK,
    )

    that_day = await client.get("/api/meals", headers=auth(user), params={"date": "2026-09-04"})
    next_day = await client.get("/api/meals", headers=auth(user), params={"date": "2026-09-05"})

    assert [meal["id"] for meal in that_day.json()] == [snack.id]
    assert next_day.json() == []


async def test_other_users_meals_do_not_appear(client, db_session):
    alice = await create_user(db_session)
    bob = await create_user(db_session)
    await create_meal(db_session, user=alice, eaten_at=datetime(2026, 9, 4, 4, 0, tzinfo=UTC))
    bobs_meal = await create_meal(
        db_session, user=bob, eaten_at=datetime(2026, 9, 4, 4, 0, tzinfo=UTC)
    )

    response = await client.get("/api/meals", headers=auth(bob), params={"date": "2026-09-04"})

    assert [meal["id"] for meal in response.json()] == [bobs_meal.id]


async def test_same_utc_instant_lands_on_different_dates_for_different_timezones(
    client, db_session
):
    """同一個 UTC 時刻，落在台北使用者跟紐約使用者手上是不同的日期 ——
    這是「時區存在 users 表」而不是「伺服器寫死一個時區」的直接證明。
    """
    taipei_user = await create_user(db_session)  # 預設時區 Asia/Taipei
    ny_user = await create_user(db_session)
    patch_response = await client.patch(
        "/api/me", headers=auth(ny_user), json={"timezone": "America/New_York"}
    )
    assert patch_response.status_code == 200

    # 2026-09-04T02:00:00Z：
    #   台北（UTC+8）：2026-09-04 10:00 -> 日期是 2026-09-04
    #   紐約（夏令時 UTC-4）：2026-09-03 22:00 -> 日期是 2026-09-03
    instant = datetime(2026, 9, 4, 2, 0, tzinfo=UTC)
    taipei_meal = await create_meal(db_session, user=taipei_user, eaten_at=instant)
    ny_meal = await create_meal(db_session, user=ny_user, eaten_at=instant)

    taipei_response = await client.get(
        "/api/meals", headers=auth(taipei_user), params={"date": "2026-09-04"}
    )
    ny_wrong_date = await client.get(
        "/api/meals", headers=auth(ny_user), params={"date": "2026-09-04"}
    )
    ny_correct_date = await client.get(
        "/api/meals", headers=auth(ny_user), params={"date": "2026-09-03"}
    )

    assert [meal["id"] for meal in taipei_response.json()] == [taipei_meal.id]
    assert ny_wrong_date.json() == []
    assert [meal["id"] for meal in ny_correct_date.json()] == [ny_meal.id]


async def test_no_date_param_defaults_to_today_in_users_timezone(client, db_session, monkeypatch):
    """省略 date 時預設「使用者時區的今天」。

    用固定日期取代真正的系統時鐘，而不是依賴 datetime.now() 的真實回傳值 ——
    monkeypatch 的對象是 app/days.py 的 today_in_timezone()（一個為了這個
    目的特別留的接縫），不是 datetime.datetime.now（那是不可變的 C 型別，
    沒辦法直接替換）。這樣測試在任何時刻執行結果都一樣，不會有「剛好卡在
    午夜附近跑測試」這種機率極低但確實存在的 flaky 來源。
    """
    user = await create_user(db_session)  # 預設時區 Asia/Taipei
    fixed_today = date(2026, 5, 10)
    monkeypatch.setattr("app.api.routes.meals.today_in_timezone", lambda _tz: fixed_today)

    start, _end = day_bounds(fixed_today, "Asia/Taipei")
    todays_meal = await create_meal(db_session, user=user, eaten_at=start + timedelta(hours=1))
    await create_meal(db_session, user=user, eaten_at=start - timedelta(hours=1))

    response = await client.get("/api/meals", headers=auth(user))

    assert response.status_code == 200
    assert [meal["id"] for meal in response.json()] == [todays_meal.id]


async def test_invalid_date_format_is_rejected(client, db_session):
    user = await create_user(db_session)

    response = await client.get("/api/meals", headers=auth(user), params={"date": "not-a-date"})

    assert response.status_code == 422


async def test_a_meal_at_exactly_midnight_belongs_to_one_day_only(client, db_session):
    """日界線是半開區間 [start, end)，所以恰好落在邊界的一餐只能屬於一天。

    `<=` 而不是 `<` 的話，午夜零點那一餐會同時出現在兩天的結果裡。
    這在計畫 3 只是「清單多一筆」，但到了計畫 4 的每日統計，
    那一餐的熱量會被計入兩次 —— 而且兩天的數字各自看起來都很合理，
    沒有任何東西會報錯。
    """
    user = await create_user(db_session)  # server_default 就是 Asia/Taipei
    day = date(2026, 9, 4)
    start, end = day_bounds(day, "Asia/Taipei")

    # end 同時是「這一天的結束」與「隔天的開始」—— 它必須只屬於隔天
    await create_meal(db_session, user=user, eaten_at=end)
    await db_session.commit()

    today = await client.get("/api/meals", headers=auth(user), params={"date": day.isoformat()})
    tomorrow = await client.get(
        "/api/meals",
        headers=auth(user),
        params={"date": (day + timedelta(days=1)).isoformat()},
    )

    assert today.status_code == 200
    assert tomorrow.status_code == 200
    assert today.json() == [], "邊界那一刻屬於隔天，不能出現在當天"
    assert len(tomorrow.json()) == 1

    # 對照：start 那一刻確實屬於這一天
    await create_meal(db_session, user=user, eaten_at=start)
    await db_session.commit()
    again = await client.get("/api/meals", headers=auth(user), params={"date": day.isoformat()})
    assert len(again.json()) == 1
