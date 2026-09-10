import io
from datetime import UTC, date, datetime
from decimal import Decimal
from pathlib import Path

import pytest
from PIL import Image
from sqlalchemy import func, select

from app.config import settings
from app.models.food import FoodRevision
from app.models.meal import Meal, MealItem
from app.models.supplement import SupplementIntake, SupplementPlan
from app.security.tokens import create_token
from tests.factories import (
    create_food,
    create_intake,
    create_meal,
    create_plan,
    create_portion,
    create_supplement,
    create_target,
    create_user,
)


def auth(user):
    return {"Authorization": f"Bearer {create_token(user.id, 'access')}"}


NUTRITION = {"kcal": "1", "protein_g": "1", "fat_g": "1", "carb_g": "1"}


def _jpeg_bytes(width: int = 400, height: int = 300) -> bytes:
    image = Image.new("RGB", (width, height), color=(200, 100, 50))
    buffer = io.BytesIO()
    image.save(buffer, format="JPEG")
    return buffer.getvalue()


@pytest.fixture
async def alices_food(db_session):
    alice = await create_user(db_session)
    bob = await create_user(db_session)
    food = await create_food(db_session, created_by=alice, owner=alice, name="愛麗絲的便當")
    return alice, bob, food


async def test_bob_cannot_read_alices_food(client, alices_food):
    _, bob, food = alices_food
    response = await client.get(f"/api/foods/{food.id}", headers=auth(bob))
    assert response.status_code == 404


async def test_bob_cannot_list_alices_revisions(client, alices_food):
    _, bob, food = alices_food
    response = await client.get(f"/api/foods/{food.id}/revisions", headers=auth(bob))
    assert response.status_code == 404


async def test_bob_cannot_edit_alices_food(client, alices_food):
    _, bob, food = alices_food
    response = await client.post(
        f"/api/foods/{food.id}/revisions", headers=auth(bob), json={"nutrition": NUTRITION}
    )
    assert response.status_code == 404


async def test_bob_cannot_list_alices_portions(client, alices_food):
    _, bob, food = alices_food
    response = await client.get(f"/api/foods/{food.id}/portions", headers=auth(bob))
    assert response.status_code == 404


async def test_bob_cannot_add_a_portion_to_alices_food(client, alices_food):
    _, bob, food = alices_food
    response = await client.post(
        f"/api/foods/{food.id}/portions", headers=auth(bob), json={"label": "1 碗", "grams": "200"}
    )
    assert response.status_code == 404


async def test_bob_cannot_find_alices_food_by_search(client, alices_food):
    _, bob, food = alices_food
    response = await client.get("/api/foods", params={"q": "愛麗絲"}, headers=auth(bob))
    assert response.json() == []


async def test_bob_cannot_see_alices_portion_on_a_global_food(client, db_session):
    admin = await create_user(db_session)
    alice = await create_user(db_session)
    bob = await create_user(db_session)
    food = await create_food(db_session, created_by=admin)
    await create_portion(db_session, food=food, label="愛麗絲的碗", owner=alice)

    response = await client.get(f"/api/foods/{food.id}/portions", headers=auth(bob))

    assert response.json() == []


async def test_every_isolation_failure_looks_identical(client, alices_food):
    """所有「不是你的」都必須跟「不存在」長得一模一樣。"""
    _, bob, food = alices_food

    not_yours = await client.get(f"/api/foods/{food.id}", headers=auth(bob))
    missing = await client.get("/api/foods/999999", headers=auth(bob))

    assert not_yours.status_code == missing.status_code
    assert not_yours.json() == missing.json()


# ---------------------------------------------------------------------------
# Task 18：計畫 3 新增的 12 個端點，全部要進這份集中清單。
#
# 食物刻意用**全域**的（owner=None）：Bob 看得到這個食物本身，這樣如果
# `Meal.user_id` 這個過濾被拿掉，Bob 真的能利用它把項目加進 Alice 的餐 ——
# 食物可見性擋不住他，才驗證得到 `Meal.user_id` 這個過濾器本身。用 Alice
# 的私人食物的話，`Food.owner_id` 那層防禦性過濾會先擋住 Bob，兩個過濾器
# 同時能擋住同一筆突變，測試就失去了鑑別力（Task 17 實測發現：拿掉
# `Meal.user_id` 過濾、用私人食物寫的版本，零個測試會失敗）。
# ---------------------------------------------------------------------------


@pytest.fixture
async def alices_meal(db_session):
    admin = await create_user(db_session)
    alice = await create_user(db_session)
    bob = await create_user(db_session)
    food = await create_food(db_session, created_by=admin, name="全域食物：只有愛麗絲吃過")
    revision = await db_session.get(FoodRevision, food.current_revision_id)
    assert revision is not None
    meal = await create_meal(db_session, user=alice, items=[(revision, 100)])
    item = await db_session.scalar(select(MealItem).where(MealItem.meal_id == meal.id))
    assert item is not None
    return alice, bob, meal, item, food




async def test_bob_cannot_read_alices_meal(client, alices_meal):
    _, bob, meal, _, _ = alices_meal
    response = await client.get(f"/api/meals/{meal.id}", headers=auth(bob))
    assert response.status_code == 404


async def test_bob_cannot_update_alices_meal(client, alices_meal, db_session):
    _, bob, meal, _, _ = alices_meal
    response = await client.patch(
        f"/api/meals/{meal.id}", headers=auth(bob), json={"note": "被入侵了"}
    )
    assert response.status_code == 404

    await db_session.refresh(meal)
    assert meal.note != "被入侵了"


async def test_bob_cannot_delete_alices_meal(client, alices_meal, db_session):
    _, bob, meal, _, _ = alices_meal
    meal_id = meal.id

    response = await client.delete(f"/api/meals/{meal_id}", headers=auth(bob))
    assert response.status_code == 404

    still_there = await db_session.get(Meal, meal_id)
    assert still_there is not None


async def test_bob_cannot_add_item_to_alices_meal(client, alices_meal, db_session):
    _, bob, meal, _, food = alices_meal

    response = await client.post(
        f"/api/meals/{meal.id}/items",
        headers=auth(bob),
        json={"food_id": food.id, "quantity": "100"},
    )
    assert response.status_code == 404

    item_count = await db_session.scalar(
        select(func.count()).select_from(MealItem).where(MealItem.meal_id == meal.id)
    )
    assert item_count == 1  # 還是只有 fixture 建立時的那一筆


async def test_bob_cannot_delete_item_from_alices_meal_via_his_own_meal_id(
    client, alices_meal, db_session
):
    """M2 專用：`_load_owned_meal` 已經擋得住「用 Alice 的 meal_id」，
    但 `delete_meal_item` 還有第二層檢查 —— item_id 是否真的屬於**這個**
    meal_id。這裡用 Bob 自己的 meal_id（第一層過得去）配 Alice 的 item_id，
    才能單獨驗證第二層，不被第一層擋住而看不出差異。
    """
    _, bob, _, alices_item, _ = alices_meal
    bobs_meal = await create_meal(db_session, user=bob)
    item_id = alices_item.id

    response = await client.delete(
        f"/api/meals/{bobs_meal.id}/items/{item_id}", headers=auth(bob)
    )
    assert response.status_code == 404

    still_there = await db_session.get(MealItem, item_id)
    assert still_there is not None


async def test_bob_cannot_upload_photo_to_alices_meal(client, alices_meal, db_session):
    _, bob, meal, _, _ = alices_meal

    response = await client.post(
        f"/api/meals/{meal.id}/photo",
        headers=auth(bob),
        files={"file": ("food.jpg", _jpeg_bytes(), "image/jpeg")},
    )
    assert response.status_code == 404

    await db_session.refresh(meal)
    assert meal.photo_path is None


async def test_bob_cannot_read_alices_meal_photo(client, alices_meal):
    alice, bob, meal, _, _ = alices_meal
    upload = await client.post(
        f"/api/meals/{meal.id}/photo",
        headers=auth(alice),
        files={"file": ("food.jpg", _jpeg_bytes(), "image/jpeg")},
    )
    assert upload.status_code == 200

    response = await client.get(f"/api/meals/{meal.id}/photo", headers=auth(bob))
    assert response.status_code == 404


async def test_bob_cannot_delete_alices_meal_photo(client, alices_meal, db_session):
    alice, bob, meal, _, _ = alices_meal
    upload = await client.post(
        f"/api/meals/{meal.id}/photo",
        headers=auth(alice),
        files={"file": ("food.jpg", _jpeg_bytes(), "image/jpeg")},
    )
    photo_path = upload.json()["photo_path"]
    photo_file = Path(settings.photo_dir) / photo_path

    response = await client.delete(f"/api/meals/{meal.id}/photo", headers=auth(bob))
    assert response.status_code == 404
    assert photo_file.is_file()

    await db_session.refresh(meal)
    assert meal.photo_path == photo_path


async def test_alices_meals_are_absent_from_bobs_list(client, db_session):
    alice = await create_user(db_session)
    bob = await create_user(db_session)
    same_instant = datetime(2026, 9, 4, 4, 0, tzinfo=UTC)
    await create_meal(db_session, user=alice, eaten_at=same_instant)
    bobs_meal = await create_meal(db_session, user=bob, eaten_at=same_instant)

    response = await client.get(
        "/api/meals", headers=auth(bob), params={"date": "2026-09-04"}
    )

    assert response.status_code == 200
    assert [meal["id"] for meal in response.json()] == [bobs_meal.id]


async def test_frequent_excludes_a_global_food_alice_ate_and_bob_never_did(client, db_session):
    """跟 fixture 頂端的說明同一個道理：食物要是全域的，Bob 才看得到它、
    但沒吃過它 —— 才能真正驗證 `Meal.user_id` 過濾，而不是被
    `Food.owner_id` 那層防禦性過濾遮住。
    """
    admin = await create_user(db_session)
    alice = await create_user(db_session)
    bob = await create_user(db_session)
    food = await create_food(db_session, created_by=admin, name="全域食物只有愛麗絲吃過")
    revision = await db_session.get(FoodRevision, food.current_revision_id)
    assert revision is not None
    await create_meal(db_session, user=alice, items=[(revision, 100)])

    response = await client.get("/api/foods/frequent", headers=auth(bob))

    assert response.status_code == 200
    assert food.name not in [item["name"] for item in response.json()]


async def test_patching_me_as_bob_does_not_change_alices_row(client, db_session):
    """Task 3 實測發現的缺口：`PATCH /api/me` 沒有路徑參數，使用者 id 只來自
    token，直覺上不可能寫錯。但把 handler 改成寫 `user.id - 1` 那一列，
    全部既有測試照樣通過，Bob 的請求靜默地覆寫了 Alice 的資料、回 200。
    沒有路徑參數消除的是**惡意輸入**這條路，不是**程式寫錯**那條 ——
    這裡守的是後者：直接重查 Alice 的列，而不是只看 Bob 收到的回應。
    """
    alice = await create_user(db_session, display_name="愛麗絲")
    bob = await create_user(db_session, display_name="鮑伯")
    alice_id = alice.id
    alice_display_name = alice.display_name
    alice_timezone = alice.timezone

    response = await client.patch(
        "/api/me", headers=auth(bob), json={"display_name": "鮑伯改的名字"}
    )
    assert response.status_code == 200
    assert response.json()["display_name"] == "鮑伯改的名字"

    await db_session.refresh(alice)
    assert alice.id == alice_id
    assert alice.display_name == alice_display_name
    assert alice.timezone == alice_timezone


# ---------------------------------------------------------------------------
# Task 11（計畫 4a）：補劑的九個端點，全部要進這份集中清單。
#
# 補劑刻意用**全域**的（owner=None）：Bob 看得到這個補劑本身，這樣如果
# `SupplementPlan.user_id` / `SupplementIntake.user_id` 這些過濾被拿掉，
# Bob 真的能看到、甚至操作 Alice 的計畫或打卡 —— 補劑可見性擋不住他，
# 才驗證得到 user_id 過濾器本身。用 Alice 的私人補劑的話，補劑可見性那層
# 防禦性過濾會先擋住 Bob，兩個過濾器同時能擋住同一筆突變，測試就失去了
# 鑑別力（計畫 3 Task 17、本計畫 Task 10 都踩過這個陷阱）。
#
# 補劑可見性本身（M1）反過來要用**私人**補劑測 —— 那正是可見性過濾要擋的
# 情境，用全域的話 Bob 本來就看得到，測不出可見性過濾被拿掉。
# ---------------------------------------------------------------------------


@pytest.fixture
async def alices_private_supplement(db_session):
    alice = await create_user(db_session)
    bob = await create_user(db_session)
    supplement = await create_supplement(
        db_session, created_by=alice, owner=alice, name="愛麗絲的私人魚油"
    )
    return alice, bob, supplement


@pytest.fixture
async def alices_global_supplement_plan_and_intake(db_session):
    """M2～M6 共用：全域補劑 + Alice 的一筆計畫 + 一筆打卡。"""
    admin = await create_user(db_session)
    alice = await create_user(db_session)
    bob = await create_user(db_session)
    supplement = await create_supplement(
        db_session, created_by=admin, name="全域補劑：只有愛麗絲用過"
    )
    plan = await create_plan(db_session, user=alice, supplement=supplement)
    intake = await create_intake(db_session, user=alice, supplement=supplement, plan=plan)
    return admin, alice, bob, supplement, plan, intake


async def test_bob_cannot_find_alices_private_supplement_by_search(
    client, alices_private_supplement
):
    """GET /api/supplements —— M1（`supplement_visibility` 的 owner_id 條件）。"""
    _, bob, supplement = alices_private_supplement

    response = await client.get(
        "/api/supplements", params={"q": "愛麗絲"}, headers=auth(bob)
    )

    assert response.status_code == 200
    assert supplement.name not in [item["name"] for item in response.json()]


async def test_alice_cannot_see_a_private_supplement_bob_just_created(client, db_session):
    """POST /api/supplements —— 建立本身沒有跨使用者的擁有權可測（owner
    永遠是 token 裡的自己），這裡驗證的是建立之後的另一半：Bob 建立的私人
    補劑不會出現在 Alice 的預設搜尋裡，跟上一個測試共用同一段 M1 防線，
    只是從「寫入端」而非「查詢端」進場。
    """
    alice = await create_user(db_session)
    bob = await create_user(db_session)

    create_response = await client.post(
        "/api/supplements",
        headers=auth(bob),
        json={
            "name": "鮑伯的私人魚油",
            "serving_unit": "capsule",
            "serving_size": "1",
            "kcal": "1",
            "protein_g": "1",
            "fat_g": "1",
            "carb_g": "1",
        },
    )
    assert create_response.status_code == 201

    response = await client.get(
        "/api/supplements", params={"q": "鮑伯"}, headers=auth(alice)
    )

    assert response.status_code == 200
    assert response.json() == []


async def test_bob_cannot_list_alices_plans(client, alices_global_supplement_plan_and_intake):
    """GET /api/supplement-plans —— M2（`list_plans` 的 user_id 過濾）。"""
    _, _, bob, _, _, _ = alices_global_supplement_plan_and_intake

    response = await client.get("/api/supplement-plans", headers=auth(bob))

    assert response.status_code == 200
    assert response.json() == []


async def test_bob_cannot_create_a_plan_referencing_alices_private_supplement(
    client, alices_private_supplement
):
    """POST /api/supplement-plans —— 引用看不到的補劑一律 404（M1 的第二個
    呼叫端，跟建立打卡共用同一套 `assert_supplement_visible`）。
    """
    _, bob, supplement = alices_private_supplement

    response = await client.post(
        "/api/supplement-plans",
        headers=auth(bob),
        json={
            "supplement_id": supplement.id,
            "dose": "1",
            "time_of_day": "morning",
            "effective_from": "2026-01-01",
        },
    )

    assert response.status_code == 404


async def test_bob_cannot_update_alices_plan(
    client, alices_global_supplement_plan_and_intake, db_session
):
    """PATCH /api/supplement-plans/{id} —— M3（`_load_owned_plan` 的擁有權
    條件）。跟 DELETE 共用同一個函式，見下一個測試。
    """
    _, _, bob, _, plan, _ = alices_global_supplement_plan_and_intake
    plan_id = plan.id

    response = await client.patch(
        f"/api/supplement-plans/{plan_id}",
        headers=auth(bob),
        json={"dose": "99"},
    )

    assert response.status_code == 404

    unchanged = await db_session.get(SupplementPlan, plan_id)
    assert unchanged is not None
    assert unchanged.dose == plan.dose
    assert unchanged.effective_to is None


async def test_bob_cannot_delete_alices_plan(
    client, alices_global_supplement_plan_and_intake, db_session
):
    """DELETE /api/supplement-plans/{id} —— 跟 PATCH 共用同一個
    `_load_owned_plan`，同一個擁有權條件，也就是同一個突變點（M3）。
    """
    _, _, bob, _, plan, _ = alices_global_supplement_plan_and_intake
    plan_id = plan.id

    response = await client.delete(f"/api/supplement-plans/{plan_id}", headers=auth(bob))

    assert response.status_code == 404
    still_there = await db_session.get(SupplementPlan, plan_id)
    assert still_there is not None


async def test_bob_cannot_create_an_intake_against_alices_plan(
    client, alices_global_supplement_plan_and_intake
):
    """POST /api/supplement-intakes —— 引用別人的計畫一律 404
    （重用 `_load_owned_plan`，同一個突變點 M3；補劑用全域的，才不會被
    M1 先擋住，單獨驗證到這裡）。
    """
    _, _, bob, supplement, plan, _ = alices_global_supplement_plan_and_intake

    response = await client.post(
        "/api/supplement-intakes",
        headers=auth(bob),
        json={
            "supplement_id": supplement.id,
            "plan_id": plan.id,
            "dose": "1",
            "taken_at": "2026-01-01T08:00:00Z",
        },
    )

    assert response.status_code == 404


async def test_bob_cannot_delete_alices_intake(
    client, alices_global_supplement_plan_and_intake, db_session
):
    """DELETE /api/supplement-intakes/{id} —— M4（`_load_owned_intake` 的
    擁有權條件）。
    """
    _, _, bob, _, _, intake = alices_global_supplement_plan_and_intake
    intake_id = intake.id

    response = await client.delete(f"/api/supplement-intakes/{intake_id}", headers=auth(bob))

    assert response.status_code == 404
    still_there = await db_session.get(SupplementIntake, intake_id)
    assert still_there is not None


async def test_bob_cannot_see_alices_plan_in_his_own_today_list(
    client, alices_global_supplement_plan_and_intake, monkeypatch
):
    """GET /api/supplements/today —— M5（計畫的 user_id 過濾）。

    **這裡一定要把「今天」釘死**，跟 fixture 裡計畫的固定值對上
    （`_DEFAULT_EFFECTIVE_FROM` 是 2026-01-01，`effective_to` 是 None，
    永遠有效）——用真實系統時間的話，計畫本身仍然「今天生效」，
    不需要釘死也會通過，但釘死能讓斷言的理由跟資料的意圖一致，
    不依賴「測試執行的那一天剛好還沒到 2026-01-01 之後很久」這種偶然。
    """
    _, _, bob, _, _, _ = alices_global_supplement_plan_and_intake
    monkeypatch.setattr(
        "app.api.routes.supplements.today_in_timezone", lambda _tz: date(2026, 1, 1)
    )

    response = await client.get("/api/supplements/today", headers=auth(bob))

    assert response.status_code == 200
    # Alice 的計畫不能出現在 Bob 的清單裡。M6（打卡的 user_id 過濾）由下一個
    # 測試單獨驗證，用即興記錄，不掛在任何計畫底下，才不會被 M5 掩護。
    assert response.json() == []


async def test_bob_cannot_see_alices_ad_hoc_intake_in_his_own_today_list(
    client, db_session, monkeypatch
):
    """GET /api/supplements/today —— M6（打卡的 user_id 過濾）。

    刻意用**即興記錄**（`plan_id` 是 None）而不是掛在計畫底下的打卡：
    掛在計畫底下的打卡只有在對應的計畫也出現在清單裡才會被組進最終回應
    （`intakes_by_plan` 是照 `plans` 這個清單去配對的），所以若用計畫內的
    打卡，M5（計畫的 user_id 過濾）還在的話會**掩護** M6 —— 即使打卡的
    user_id 過濾被拿掉，少了對應的計畫，這筆打卡也組不進最終回應，測試
    測不出 M6 被拿掉（這是實測時發現的坑，第一版就是這樣寫、不會失敗）。
    即興記錄不需要配對，只要進了 `intakes` 查詢結果就一定會出現在回應裡，
    才是單獨驗證 M6 的正確資料形狀。
    """
    admin = await create_user(db_session)
    alice = await create_user(db_session)
    bob = await create_user(db_session)
    supplement = await create_supplement(
        db_session, created_by=admin, name="全域補劑：只有愛麗絲即興吃過"
    )
    fixed_today = date(2026, 1, 1)
    monkeypatch.setattr(
        "app.api.routes.supplements.today_in_timezone", lambda _tz: fixed_today
    )
    await create_intake(
        db_session,
        user=alice,
        supplement=supplement,
        taken_at=datetime(2026, 1, 1, 8, 0, tzinfo=UTC),
    )

    response = await client.get("/api/supplements/today", headers=auth(bob))

    assert response.status_code == 200
    assert response.json() == []


async def test_todays_list_does_not_leak_a_long_past_ad_hoc_intake(
    client, db_session, monkeypatch
):
    """GET /api/supplements/today —— M7（日期範圍條件改成不限日期）。

    這一筆打卡是一年前記錄的、跟「今天」完全無關；如果 taken_at 的半開
    區間過濾被拿掉（變成不限日期），這筆舊記錄會用 user_id 通過，冒出在
    今天的清單裡。同一個使用者、不需要 Alice/Bob 兩人 —— 這個突變跟
    「別人的資料」無關，是「這個使用者太久以前的資料」，用一個使用者
    就測得出來。
    """
    user = await create_user(db_session)
    supplement = await create_supplement(db_session, created_by=user, owner=user)
    await create_intake(
        db_session,
        user=user,
        supplement=supplement,
        taken_at=datetime(2025, 1, 1, 8, 0, tzinfo=UTC),
    )
    monkeypatch.setattr(
        "app.api.routes.supplements.today_in_timezone", lambda _tz: date(2026, 6, 1)
    )

    response = await client.get("/api/supplements/today", headers=auth(user))

    assert response.status_code == 200
    assert response.json() == []


# ---------------------------------------------------------------------------
# 目標與統計（計畫 4b Task 10）
#
# 這一段的測試資料一律用**全域**食物與補劑（owner=None）。用私人的話，
# 可見性過濾會先擋住 Bob，於是就算 user_id 過濾整個被拿掉也不會有測試變紅
# —— 計畫 3 Task 17 與計畫 4a Task 11 都真的踩過這個「兩個過濾器互相掩護」
# 的陷阱。要測 A 過濾器，測試資料就必須讓 B 過濾器無效。
# ---------------------------------------------------------------------------

_DAY = date(2026, 9, 8)
# 台北當地 2026-09-08 00:30 -> UTC 前一天 16:30。挑清晨是因為 UTC 以東的
# 時區只有當地 00:00~08:00 對「用 UTC 還是用當地時區」有鑑別力。
_NOON_UTC = datetime(2026, 9, 8, 4, 0, tzinfo=UTC)


@pytest.fixture
async def alice_and_bob(db_session):
    alice = await create_user(db_session)
    bob = await create_user(db_session)
    return alice, bob


async def test_bob_cannot_list_alices_targets(client, alice_and_bob, db_session):
    alice, bob = alice_and_bob
    await create_target(db_session, user=alice, kcal=2000, effective_from=date(2026, 1, 1))
    await db_session.commit()

    response = await client.get("/api/targets", headers=auth(bob))

    assert response.status_code == 200
    assert response.json() == []


async def test_bob_cannot_see_alices_target_by_date(client, alice_and_bob, db_session):
    alice, bob = alice_and_bob
    await create_target(db_session, user=alice, kcal=2000, effective_from=date(2026, 1, 1))
    await db_session.commit()

    response = await client.get(
        "/api/targets", headers=auth(bob), params={"date": _DAY.isoformat()}
    )

    assert response.status_code == 200
    assert response.json() is None, "Bob 沒設目標，不能看到愛麗絲的"


async def test_bob_cannot_update_alices_target(client, alice_and_bob, db_session):
    alice, bob = alice_and_bob
    target = await create_target(
        db_session, user=alice, kcal=2000, effective_from=date(2026, 1, 1)
    )
    await db_session.commit()
    target_id = target.id

    response = await client.patch(
        f"/api/targets/{target_id}",
        headers=auth(bob),
        json={"kcal": "9999", "effective_from": _DAY.isoformat()},
    )

    assert response.status_code == 404
    # 「回 404」與「沒有真的改到」是兩件事 —— 要重查確認
    await db_session.refresh(target)
    assert target.kcal == Decimal("2000.00")


async def test_alices_meal_does_not_appear_in_bobs_daily_stats(client, alice_and_bob, db_session):
    """`/stats/daily` 的食物查詢 user_id 過濾。用**全域**食物佈置。"""
    alice, bob = alice_and_bob
    food = await create_food(db_session, created_by=alice, kcal=500)
    revision = await db_session.get(FoodRevision, food.current_revision_id)
    await create_meal(
        db_session, user=alice, eaten_at=_NOON_UTC, items=[(revision, Decimal("100"))]
    )
    await db_session.commit()

    response = await client.get(
        "/api/stats/daily", headers=auth(bob), params={"date": _DAY.isoformat()}
    )

    assert response.status_code == 200
    assert response.json()["actual"]["kcal"] == "0.00"
    assert response.json()["breakdown"]["food"]["kcal"] == "0.00"


async def test_alices_intake_does_not_appear_in_bobs_daily_stats(
    client, alice_and_bob, db_session
):
    """`/stats/daily` 的補劑查詢 user_id 過濾。用**全域**補劑佈置。"""
    alice, bob = alice_and_bob
    supplement = await create_supplement(db_session, created_by=alice, kcal=80)
    await create_intake(
        db_session, user=alice, supplement=supplement, taken_at=_NOON_UTC, kcal=80
    )
    await db_session.commit()

    response = await client.get(
        "/api/stats/daily", headers=auth(bob), params={"date": _DAY.isoformat()}
    )

    assert response.status_code == 200
    assert response.json()["breakdown"]["supplement"]["kcal"] == "0.00"


async def test_alices_data_does_not_appear_in_bobs_range_stats(client, alice_and_bob, db_session):
    """`/stats/range` 是另一條分桶路徑（bucket_daily_macros），要各自釘住。"""
    alice, bob = alice_and_bob
    food = await create_food(db_session, created_by=alice, kcal=500)
    revision = await db_session.get(FoodRevision, food.current_revision_id)
    await create_meal(
        db_session, user=alice, eaten_at=_NOON_UTC, items=[(revision, Decimal("100"))]
    )
    await db_session.commit()

    response = await client.get(
        "/api/stats/range",
        headers=auth(bob),
        params={"from": _DAY.isoformat(), "to": _DAY.isoformat()},
    )

    assert response.status_code == 200
    assert response.json()["trend"][0]["actual"]["kcal"] == "0.00"


async def test_alices_plans_do_not_affect_bobs_adherence(client, alice_and_bob, db_session):
    """依從率的分母來自計畫查詢 —— 別人的計畫不能變成你的應吃次數。

    用**全域**補劑：Bob 看得到這個補劑，所以可見性過濾擋不住他，
    唯一能擋的就是計畫查詢的 user_id 過濾。
    """
    alice, bob = alice_and_bob
    supplement = await create_supplement(db_session, created_by=alice)
    await create_plan(
        db_session, user=alice, supplement=supplement, effective_from=date(2026, 1, 1)
    )
    await db_session.commit()

    response = await client.get(
        "/api/stats/range",
        headers=auth(bob),
        params={"from": _DAY.isoformat(), "to": _DAY.isoformat()},
    )

    assert response.status_code == 200
    assert response.json()["adherence"] is None, "Bob 沒有計畫，分母應該是 0"


async def test_target_and_stats_endpoints_require_authentication(client):
    for method, path, params in (
        ("get", "/api/targets", None),
        ("get", "/api/stats/daily", None),
        ("get", "/api/stats/range", {"from": "2026-09-08", "to": "2026-09-08"}),
    ):
        response = await getattr(client, method)(path, params=params)
        assert response.status_code == 401, f"{method.upper()} {path}"
