import io
from datetime import UTC, datetime
from pathlib import Path

import pytest
from PIL import Image
from sqlalchemy import func, select

from app.config import settings
from app.models.food import FoodRevision
from app.models.meal import Meal, MealItem
from app.security.tokens import create_token
from tests.factories import create_food, create_meal, create_portion, create_user


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


@pytest.fixture(autouse=True)
def _photo_dir_in_tmp_path(tmp_path, monkeypatch):
    # 這個檔案裡的照片測試絕對不能寫進真的 data/photos。
    monkeypatch.setattr(settings, "photo_dir", str(tmp_path))


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
