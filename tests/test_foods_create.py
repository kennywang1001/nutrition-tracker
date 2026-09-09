from sqlalchemy import select

from app.models.food import Food, FoodRevision, RevisionStatus
from app.security.tokens import create_token
from tests.factories import create_food, create_user


def auth(user):
    return {"Authorization": f"Bearer {create_token(user.id, 'access')}"}


async def test_create_food_returns_the_food_with_its_nutrition(client, db_session):
    user = await create_user(db_session)

    response = await client.post(
        "/api/foods",
        headers=auth(user),
        json={
            "name": "滷肉飯",
            "brand": None,
            "nutrition": {
                "base_unit": "g",
                "kcal": "180.5",
                "protein_g": "6.2",
                "fat_g": "7.1",
                "carb_g": "22.4",
            },
        },
    )

    assert response.status_code == 201
    body = response.json()
    assert body["name"] == "滷肉飯"
    assert body["is_global"] is False
    assert body["nutrition"]["kcal"] == "180.50"
    assert body["nutrition"]["base_unit"] == "g"


async def test_create_food_persists_food_and_first_revision_and_links_them(client, db_session):
    user = await create_user(db_session)

    response = await client.post(
        "/api/foods",
        headers=auth(user),
        json={
            "name": "滷肉飯",
            "nutrition": {"kcal": "180", "protein_g": "6", "fat_g": "7", "carb_g": "22"},
        },
    )

    food = await db_session.scalar(select(Food).where(Food.id == response.json()["id"]))
    assert food is not None
    assert food.owner_id == user.id
    assert food.current_revision_id is not None

    revision = await db_session.get(FoodRevision, food.current_revision_id)
    assert revision is not None
    assert revision.food_id == food.id
    assert revision.status is RevisionStatus.APPROVED


async def test_create_food_requires_authentication(client):
    response = await client.post(
        "/api/foods",
        json={
            "name": "滷肉飯",
            "nutrition": {"kcal": "1", "protein_g": "1", "fat_g": "1", "carb_g": "1"},
        },
    )

    assert response.status_code == 401


async def test_create_food_rejects_negative_nutrition(client, db_session):
    user = await create_user(db_session)

    response = await client.post(
        "/api/foods",
        headers=auth(user),
        json={
            "name": "滷肉飯",
            "nutrition": {"kcal": "-1", "protein_g": "1", "fat_g": "1", "carb_g": "1"},
        },
    )

    assert response.status_code == 422


async def test_create_food_rejects_a_duplicate_name_for_the_same_owner(client, db_session):
    """Task 11（計畫 4a）跨端點的 rollback 稽核：先加上「409 之後 session
    還能用」這個一般性斷言，比照 Task 5 之後那些接了 rollback 的測試。

    **這個斷言驗證不到 `foods.py` 84-91 的 `except IntegrityError` /
    `await db.rollback()`。** `create_food` 在真的 commit 之前，先用一次
    SELECT 預先擋掉「已經存在同名列」的重複（見 foods.py 42-56），
    一般的重複建立走的就是這一層，回應就在這裡（line 56）產生，根本不會
    跑到後面的 try/except。實測確認：把 line 88 的 `await db.rollback()`
    拿掉，這個測試（含這裡新加的 listing 斷言）照樣全線通過。

    更進一步：用 monkeypatch 讓第一層的 SELECT 假裝「沒有重複」、逼流程真的
    往下走，結果連 `db.add(food)` 後面那個**沒有包 try/except** 的
    `await db.flush()`（line 65）就先撞上 `uq_foods_owner_id_name_brand`，
    以未被攔截的 `IntegrityError` 直接炸穿測試 —— 根本走不到 line 84 的
    try 區塊。這代表 84-91 這段 `except IntegrityError` 對「兩個相同名稱
    同時通過上面檢查」（line 87 的註解講的正是這個情境）**很可能是打不到
    的死碼**：真正的名稱唯一約束衝突在更早的地方就以未攔截的例外離開了。
    這是稽核過程中意外發現的既有缺陷，不在這個 task 的修改範圍內
    （「只能改測試、不能動 app/」），另外在報告裡回報。這裡不把那個
    monkeypatch 實驗寫成常駐測試 —— 它本身會讓套件在稽核基準狀態下就是紅的，
    不適合留在測試套件裡。
    """
    user = await create_user(db_session)
    await create_food(db_session, created_by=user, owner=user, name="滷肉飯")
    headers = auth(user)

    response = await client.post(
        "/api/foods",
        headers=headers,
        json={
            "name": "滷肉飯",
            "nutrition": {"kcal": "1", "protein_g": "1", "fat_g": "1", "carb_g": "1"},
        },
    )

    assert response.status_code == 409
    assert response.json()["error"]["code"] == "FOOD_EXISTS"

    # rollback 是否必要，要靠「同一個 session 之後還能用」來驗證：漏掉的話
    # 這裡會拋 PendingRollbackError，而不是單純讓上面的斷言變紅。
    listing = await client.get("/api/foods", params={"q": "滷肉飯"}, headers=headers)
    assert listing.status_code == 200
    assert len(listing.json()) == 1


async def test_two_users_can_each_have_a_food_with_the_same_name(client, db_session):
    alice = await create_user(db_session)
    bob = await create_user(db_session)
    await create_food(db_session, created_by=alice, owner=alice, name="滷肉飯")

    response = await client.post(
        "/api/foods",
        headers=auth(bob),
        json={
            "name": "滷肉飯",
            "nutrition": {"kcal": "1", "protein_g": "1", "fat_g": "1", "carb_g": "1"},
        },
    )

    assert response.status_code == 201
