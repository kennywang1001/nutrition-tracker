from decimal import Decimal

from sqlalchemy import func, select

from app.models.food import Food, FoodRevision, RevisionStatus
from app.models.user import UserRole
from app.security.tokens import create_access_token
from tests.factories import create_food, create_user


def auth(user):
    return {"Authorization": f"Bearer {create_access_token(user.id)}"}


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


async def test_a_concurrent_duplicate_name_returns_409_not_500(client, db_session, monkeypatch):
    """併發下兩個請求同時通過前置檢查時，必須是 409 而不是未處理的 500。

    這條路徑無法用「先建一筆再送重複的」測到 —— 前置的 SELECT 會先擋下來，
    根本走不到寫入。所以用 monkeypatch 讓那個 SELECT 謊報一次「沒有重複」，
    這正是併發下真實會發生的狀態。

    修正前實測：IntegrityError 在 `db.flush()` 逃逸成未處理的 500，
    因為那時 try/except 只包住好幾行之後的 commit()。
    """
    user = await create_user(db_session)
    await create_food(db_session, created_by=user, owner=user, name="撞名食物")
    await db_session.commit()
    headers = auth(user)

    real_scalar = db_session.scalar
    calls = {"n": 0}

    async def scalar_that_misses_the_duplicate_once(*args, **kwargs):
        calls["n"] += 1
        if calls["n"] == 1:
            return None
        return await real_scalar(*args, **kwargs)

    monkeypatch.setattr(db_session, "scalar", scalar_that_misses_the_duplicate_once)

    response = await client.post(
        "/api/foods",
        headers=headers,
        json={
            "name": "撞名食物",
            "nutrition": {"kcal": "100", "protein_g": "1", "fat_g": "1", "carb_g": "1"},
        },
    )

    assert response.status_code == 409
    assert response.json()["error"]["code"] == "FOOD_EXISTS"

    # rollback 有生效：同一個 session 之後還能用（計畫 4a Task 5 的教訓）
    monkeypatch.undo()
    after = await client.get("/api/foods", headers=headers, params={"q": "撞名"})
    assert after.status_code == 200
    assert len(after.json()) == 1


async def test_an_admin_can_create_a_global_food(client, db_session):
    """照抄 `create_portion` 已經有的模式（`test_an_admin_can_create_a_global_portion`）。"""
    admin = await create_user(db_session, role=UserRole.ADMIN)

    response = await client.post(
        "/api/foods",
        headers=auth(admin),
        json={
            "name": "全域滷肉飯",
            "nutrition": {"kcal": "180", "protein_g": "6", "fat_g": "7", "carb_g": "22"},
            "is_global": True,
        },
    )

    assert response.status_code == 201
    body = response.json()
    assert body["is_global"] is True

    food = await db_session.scalar(select(Food).where(Food.id == body["id"]))
    assert food is not None
    assert food.owner_id is None


async def test_a_normal_user_cannot_create_a_global_food(client, db_session):
    """照抄 `test_a_normal_user_cannot_create_a_global_portion`：角色不符，403 不是 404。"""
    user = await create_user(db_session)

    response = await client.post(
        "/api/foods",
        headers=auth(user),
        json={
            "name": "全域滷肉飯",
            "nutrition": {"kcal": "180", "protein_g": "6", "fat_g": "7", "carb_g": "22"},
            "is_global": True,
        },
    )

    assert response.status_code == 403
    assert response.json()["error"]["code"] == "FORBIDDEN"


async def test_create_food_without_is_global_defaults_to_a_private_food(client, db_session):
    """不帶 `is_global` 時（既有呼叫端的行為）仍然是私人食物 —— 加欄位不能改變預設行為。"""
    user = await create_user(db_session)

    response = await client.post(
        "/api/foods",
        headers=auth(user),
        json={
            "name": "預設私人食物",
            "nutrition": {"kcal": "1", "protein_g": "1", "fat_g": "1", "carb_g": "1"},
        },
    )

    assert response.status_code == 201
    body = response.json()
    assert body["is_global"] is False

    food = await db_session.scalar(select(Food).where(Food.id == body["id"]))
    assert food is not None
    assert food.owner_id == user.id


NUTRITION = {"kcal": "180", "protein_g": "6", "fat_g": "7", "carb_g": "22"}


async def test_create_food_with_a_default_portion_creates_it(client, db_session):
    """新增食物時一併建立「一份」（食物份量規格 §3.1）。"""
    user = await create_user(db_session)

    response = await client.post(
        "/api/foods",
        headers=auth(user),
        json={
            "name": "滷肉飯",
            "nutrition": NUTRITION,
            "default_portion": {"label": "碗", "grams": "150"},
        },
    )

    assert response.status_code == 201
    portions = await client.get(
        f"/api/foods/{response.json()['id']}/portions", headers=auth(user)
    )
    body = portions.json()
    assert len(body) == 1
    assert body[0]["label"] == "碗"
    assert body[0]["grams"] == "150.00"
    assert body[0]["is_default"] is True
    assert body[0]["is_global"] is False


async def test_create_food_without_a_default_portion_has_no_portions(client, db_session):
    """不帶 default_portion 時行為完全不變——加欄位不能改變預設行為。"""
    user = await create_user(db_session)

    response = await client.post(
        "/api/foods", headers=auth(user), json={"name": "白飯", "nutrition": NUTRITION}
    )

    assert response.status_code == 201
    portions = await client.get(
        f"/api/foods/{response.json()['id']}/portions", headers=auth(user)
    )
    assert portions.json() == []


async def test_default_portion_with_zero_grams_is_rejected_before_anything_is_written(
    client, db_session
):
    """份量格式錯誤 → 422，而且食物沒有被建立。

    **這條守的是「驗證在任何寫入之前」，不是「同一個交易」**：Pydantic 在
    進入 handler 之前就擋下來了，不管實作是一次還是兩次 commit 都會綠。
    「同一個交易」由下一條測試守。
    """
    user = await create_user(db_session)

    response = await client.post(
        "/api/foods",
        headers=auth(user),
        json={
            "name": "零克食物",
            "nutrition": NUTRITION,
            "default_portion": {"label": "碗", "grams": "0"},
        },
    )

    assert response.status_code == 422
    count = await db_session.scalar(
        select(func.count()).select_from(Food).where(Food.name == "零克食物")
    )
    assert count == 0


async def test_food_and_default_portion_are_written_in_one_transaction(
    client, db_session, monkeypatch
):
    """份量寫入失敗時，食物也不能留下來（規格 §2「同一個交易」）。

    讓份量的 grams 在 commit 時被資料庫的 CHECK (grams > 0) 擋下——
    Pydantic 已經放行，所以這是真的走到寫入才失敗。

    **如果實作把份量放在另一次 commit（食物先 commit），這條會紅**：
    食物已經寫進去了，第二次 commit 失敗也撤不回來。
    """
    from app.api.routes import foods as foods_route

    real_portion = foods_route.FoodPortion

    def portion_that_violates_the_check(**kwargs):
        return real_portion(**{**kwargs, "grams": Decimal("-1")})

    monkeypatch.setattr(foods_route, "FoodPortion", portion_that_violates_the_check)
    user = await create_user(db_session)

    response = await client.post(
        "/api/foods",
        headers=auth(user),
        json={
            "name": "交易測試食物",
            "nutrition": NUTRITION,
            "default_portion": {"label": "碗", "grams": "150"},
        },
    )

    assert response.status_code != 201
    monkeypatch.undo()
    count = await db_session.scalar(
        select(func.count()).select_from(Food).where(Food.name == "交易測試食物")
    )
    assert count == 0


async def test_admin_global_food_gets_a_global_default_portion(client, db_session):
    """份量跟著食物走：公開食物的預設份量是公開的，別的使用者也看得到。"""
    admin = await create_user(db_session, role=UserRole.ADMIN)
    other = await create_user(db_session)

    response = await client.post(
        "/api/foods",
        headers=auth(admin),
        json={
            "name": "公開滷肉飯",
            "nutrition": NUTRITION,
            "is_global": True,
            "default_portion": {"label": "碗", "grams": "200"},
        },
    )

    assert response.status_code == 201
    portions = await client.get(
        f"/api/foods/{response.json()['id']}/portions", headers=auth(other)
    )
    body = portions.json()
    assert [item["label"] for item in body] == ["碗"]
    assert body[0]["is_global"] is True
