"""條碼：建立、修改、查詢（掃條碼規格 §4、§5、§9），以及查不到時問 Open Food Facts、
限速（§6、D11）。

OFF 一律是假的：要結果就 `app.dependency_overrides[get_product_lookup]`；沒覆寫的測試要是真的
走到 OFF，conftest 的守衛會讓它 500（規格 D14）。
"""

from decimal import Decimal

import pytest
from sqlalchemy import select

from app import off
from app.api.routes.foods import get_product_lookup
from app.config import settings
from app.main import app
from app.models.food import BaseUnit, Food, FoodRevision
from app.models.user import UserRole
from app.security.tokens import create_access_token
from tests.factories import create_food, create_meal, create_user

CODE = "4710088432094"
NUTRITION = {"kcal": "100", "protein_g": "1", "fat_g": "1", "carb_g": "1"}


def auth(user):
    return {"Authorization": f"Bearer {create_access_token(user.id)}"}


class FakeLookup:
    """假的 OFF：記下被問了哪些條碼，回固定的結果。"""

    def __init__(self, result=None):
        self.result = result
        self.codes: list[str] = []

    async def lookup(self, code):
        self.codes.append(code)
        return self.result


def _coke():
    return off.ProductPrefill(
        name="可口可樂",
        brand="Coca-Cola",
        base_unit=BaseUnit.ML,
        per100=off.Per100(Decimal("42.00"), Decimal("0.00"), Decimal("0.00"), Decimal("10.60")),
        serving=off.Serving(Decimal("330.00"), BaseUnit.ML),
    )


async def _create(client, headers, *, name="洋芋片", barcode=None, is_global=False):
    body = {"name": name, "nutrition": NUTRITION}
    if barcode is not None:
        body["barcode"] = barcode
    if is_global:
        body["is_global"] = True
    return await client.post("/api/foods", headers=headers, json=body)


# ---- 建立 ----


async def test_create_stores_the_standard_form(client, db_session):
    user = await create_user(db_session)
    response = await _create(client, auth(user), barcode="036000-291452")

    assert response.status_code == 201
    assert response.json()["barcode"] == "0036000291452"
    stored = await db_session.scalar(select(Food.barcode).where(Food.id == response.json()["id"]))
    assert stored == "0036000291452"


async def test_create_without_a_barcode_returns_null(client, db_session):
    user = await create_user(db_session)
    response = await _create(client, auth(user))
    assert response.status_code == 201
    assert response.json()["barcode"] is None


async def test_create_rejects_a_bad_check_digit(client, db_session):
    user = await create_user(db_session)
    response = await _create(client, auth(user), barcode="4710088432096")

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "VALIDATION_ERROR"
    assert "檢查碼" in response.text


async def test_my_second_food_with_the_same_barcode_is_409(client, db_session):
    user = await create_user(db_session)
    headers = auth(user)
    first = await _create(client, headers, name="洋芋片", barcode=CODE)

    second = await _create(client, headers, name="另一包", barcode=CODE)

    assert second.status_code == 409
    error = second.json()["error"]
    assert error["code"] == "BARCODE_EXISTS"
    assert error["message"] == "你已經有一個用這個條碼的食物了"
    assert error["details"]["food_id"] == first.json()["id"]
    # rollback 有生效：同一個 session 之後還能用
    after = await client.get("/api/foods", headers=headers, params={"q": "洋芋"})
    assert after.status_code == 200


async def test_a_second_public_food_with_the_same_barcode_is_409(client, db_session):
    admin = await create_user(db_session, role=UserRole.ADMIN)
    headers = auth(admin)
    first = await _create(client, headers, name="公開洋芋片", barcode=CODE, is_global=True)

    second = await _create(client, headers, name="公開另一包", barcode=CODE, is_global=True)

    assert second.status_code == 409
    assert second.json()["error"]["message"] == "已經有公開食物用這個條碼了"
    assert second.json()["error"]["details"]["food_id"] == first.json()["id"]


async def test_the_409_never_points_at_someone_elses_food(client, db_session):
    """重查的範圍同唯一索引：別人（先建的）私人食物、公開食物都用同一個條碼時，
    409 附的一定是撞到的那一筆——我自己的（附別人的 id 會洩漏它存在）。"""
    admin = await create_user(db_session, role=UserRole.ADMIN)
    other, user = await create_user(db_session), await create_user(db_session)
    await create_food(db_session, created_by=other, owner=other, barcode=CODE)
    await create_food(db_session, created_by=admin, barcode=CODE)
    headers = auth(user)
    mine = await _create(client, headers, name="我的洋芋片", barcode=CODE)

    second = await _create(client, headers, name="我的另一包", barcode=CODE)

    assert second.status_code == 409
    assert second.json()["error"]["details"]["food_id"] == mine.json()["id"]


async def test_same_name_still_wins_over_same_barcode(client, db_session):
    """同名又同條碼：名稱的前置查詢先擋（既有的 FOOD_EXISTS）。"""
    user = await create_user(db_session)
    headers = auth(user)
    await _create(client, headers, name="洋芋片", barcode=CODE)
    again = await _create(client, headers, name="洋芋片", barcode=CODE)
    assert again.json()["error"]["code"] == "FOOD_EXISTS"


async def test_private_may_share_with_public_and_with_others(client, db_session):
    admin = await create_user(db_session, role=UserRole.ADMIN)
    first, second = await create_user(db_session), await create_user(db_session)
    assert (await _create(client, auth(admin), barcode=CODE, is_global=True)).status_code == 201
    assert (await _create(client, auth(first), barcode=CODE)).status_code == 201
    assert (await _create(client, auth(second), barcode=CODE)).status_code == 201


# ---- 每一個回 FoodResponse 的端點都有 barcode ----


async def test_read_search_and_frequent_include_the_barcode(client, db_session):
    user = await create_user(db_session)
    food = await create_food(db_session, created_by=user, owner=user, name="洋芋片", barcode=CODE)
    revision = await db_session.get(FoodRevision, food.current_revision_id)
    await create_meal(db_session, user=user, items=[(revision, 100)])
    headers, food_id = auth(user), food.id

    read = await client.get(f"/api/foods/{food_id}", headers=headers)
    search = await client.get("/api/foods", headers=headers, params={"q": "洋芋"})
    frequent = await client.get("/api/foods/frequent", headers=headers)

    assert read.json()["barcode"] == CODE
    assert search.json()[0]["barcode"] == CODE
    assert frequent.json()[0]["barcode"] == CODE


# ---- PATCH ----


async def test_the_owner_sets_changes_and_removes_a_barcode(client, db_session):
    user = await create_user(db_session)
    food = await create_food(db_session, created_by=user, owner=user)
    headers, food_id = auth(user), food.id

    set_ = await client.patch(
        f"/api/foods/{food_id}", headers=headers, json={"barcode": "96385074"}
    )
    assert set_.status_code == 200
    assert set_.json()["barcode"] == "96385074"
    assert set_.json()["nutrition"] is not None  # 回的是完整的 FoodResponse

    removed = await client.patch(f"/api/foods/{food_id}", headers=headers, json={"barcode": None})
    assert removed.json()["barcode"] is None
    assert (await client.get(f"/api/foods/{food_id}", headers=headers)).json()["barcode"] is None


async def test_patch_requires_the_barcode_key(client, db_session):
    """`{}` 不是「不動」：這個端點只做一件事，少了 key 是 422（null 才是移除）。"""
    user = await create_user(db_session)
    food = await create_food(db_session, created_by=user, owner=user)
    response = await client.patch(f"/api/foods/{food.id}", headers=auth(user), json={})
    assert response.status_code == 422


async def test_only_an_admin_changes_a_public_foods_barcode(client, db_session):
    admin = await create_user(db_session, role=UserRole.ADMIN)
    user = await create_user(db_session)
    public = await create_food(db_session, created_by=admin, name="公開食物")
    public_id = public.id

    denied = await client.patch(
        f"/api/foods/{public_id}", headers=auth(user), json={"barcode": CODE}
    )
    allowed = await client.patch(
        f"/api/foods/{public_id}", headers=auth(admin), json={"barcode": CODE}
    )

    assert denied.status_code == 403
    assert denied.json()["error"]["code"] == "FORBIDDEN"
    assert allowed.status_code == 200
    assert allowed.json()["barcode"] == CODE


async def test_someone_elses_private_food_is_404(client, db_session):
    owner, other = await create_user(db_session), await create_user(db_session)
    food = await create_food(db_session, created_by=owner, owner=owner)
    food_id = food.id
    # 先證明路徑是對的：擁有者改得到
    mine = await client.patch(f"/api/foods/{food_id}", headers=auth(owner), json={"barcode": CODE})
    assert mine.status_code == 200

    response = await client.patch(
        f"/api/foods/{food_id}", headers=auth(other), json={"barcode": None}
    )
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "FOOD_NOT_FOUND"


async def test_patch_to_a_barcode_i_already_use_is_409(client, db_session):
    user = await create_user(db_session)
    taken = await create_food(db_session, created_by=user, owner=user, barcode=CODE)
    food = await create_food(db_session, created_by=user, owner=user)
    headers, taken_id, food_id = auth(user), taken.id, food.id

    response = await client.patch(f"/api/foods/{food_id}", headers=headers, json={"barcode": CODE})

    assert response.status_code == 409
    assert response.json()["error"]["code"] == "BARCODE_EXISTS"
    assert response.json()["error"]["details"]["food_id"] == taken_id
    assert (await client.get(f"/api/foods/{food_id}", headers=headers)).json()["barcode"] is None


async def test_patching_the_same_barcode_again_is_fine(client, db_session):
    user = await create_user(db_session)
    food = await create_food(db_session, created_by=user, owner=user, barcode=CODE)
    response = await client.patch(
        f"/api/foods/{food.id}", headers=auth(user), json={"barcode": "4 710088 43209 4"}
    )
    assert response.status_code == 200
    assert response.json()["barcode"] == CODE


# ---- 查詢 ----


async def test_lookup_finds_my_food_before_the_public_one(client, db_session):
    admin = await create_user(db_session, role=UserRole.ADMIN)
    user = await create_user(db_session)
    await create_food(db_session, created_by=admin, name="公開那一筆", barcode=CODE)
    mine = await create_food(db_session, created_by=user, owner=user, name="我的", barcode=CODE)
    mine_id = mine.id

    response = await client.get(f"/api/foods/by-barcode/{CODE}", headers=auth(user))

    assert response.status_code == 200
    body = response.json()
    assert body["code"] == CODE
    assert body["food"]["id"] == mine_id
    assert body["prefill"] is None


async def test_lookup_finds_a_public_food_and_normalizes_the_path(client, db_session):
    admin = await create_user(db_session, role=UserRole.ADMIN)
    user = await create_user(db_session)
    public = await create_food(db_session, created_by=admin, barcode="0036000291452")
    public_id = public.id

    response = await client.get("/api/foods/by-barcode/036000291452", headers=auth(user))

    assert response.json()["code"] == "0036000291452"
    assert response.json()["food"]["id"] == public_id


async def test_lookup_cannot_see_someone_elses_private_food(client, db_session):
    owner, other = await create_user(db_session), await create_user(db_session)
    await create_food(db_session, created_by=owner, owner=owner, barcode=CODE)
    # 先證明同一個條碼查得到（擁有者自己）
    seen = await client.get(f"/api/foods/by-barcode/{CODE}", headers=auth(owner))
    assert seen.json()["food"] is not None
    # 沒命中會問 OFF：給一個說「沒有」的假的（不然會撞上 conftest 的守衛）。
    fake = FakeLookup()
    app.dependency_overrides[get_product_lookup] = lambda: fake

    response = await client.get(f"/api/foods/by-barcode/{CODE}", headers=auth(other))

    assert response.status_code == 200
    assert response.json() == {"code": CODE, "food": None, "prefill": None}


async def test_lookup_returns_a_food_without_a_current_revision(client, db_session):
    """沒有生效版本的食物照樣回（`nutrition: null`）：畫面說明它不能選（規格 D19）。"""
    admin = await create_user(db_session, role=UserRole.ADMIN)
    food = await create_food(db_session, created_by=admin, barcode=CODE)
    food.current_revision_id = None
    await db_session.commit()

    response = await client.get(f"/api/foods/by-barcode/{CODE}", headers=auth(admin))
    assert response.json()["food"]["nutrition"] is None


async def test_lookup_rejects_a_malformed_code(client, db_session):
    user = await create_user(db_session)
    response = await client.get("/api/foods/by-barcode/12345", headers=auth(user))
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "VALIDATION_ERROR"


async def test_lookup_needs_login(client):
    assert (await client.get(f"/api/foods/by-barcode/{CODE}")).status_code == 401


# ---- 查不到時問 Open Food Facts（規格 §6）、限速（D11） ----


async def test_a_miss_returns_the_prefill(client, db_session):
    user = await create_user(db_session)
    fake = FakeLookup(_coke())
    app.dependency_overrides[get_product_lookup] = lambda: fake

    response = await client.get("/api/foods/by-barcode/036000291452", headers=auth(user))

    assert response.status_code == 200
    body = response.json()
    assert body["code"] == "0036000291452"
    assert body["food"] is None
    assert body["prefill"] == {
        "name": "可口可樂",
        "brand": "Coca-Cola",
        "base_unit": "ml",
        "per100": {"kcal": "42.00", "protein_g": "0.00", "fat_g": "0.00", "carb_g": "10.60"},
        "serving": {"amount": "330.00", "unit": "ml"},
        "source": "openfoodfacts",
    }
    # 送給 OFF 的是標準形式
    assert fake.codes == ["0036000291452"]


async def test_a_miss_without_off_data_has_no_prefill(client, db_session):
    user = await create_user(db_session)
    fake = FakeLookup(None)
    app.dependency_overrides[get_product_lookup] = lambda: fake

    response = await client.get(f"/api/foods/by-barcode/{CODE}", headers=auth(user))

    assert response.json() == {"code": CODE, "food": None, "prefill": None}
    assert fake.codes == [CODE]


@pytest.mark.parametrize(
    "absurd",
    [
        {"proteins_100g": 1e40},
        {"proteins_100g": "1e30"},
        {"proteins_100g": 10**30},
        {"energy-kcal_100g": None, "energy-kj_100g": "1e40"},
    ],
)
async def test_absurd_off_numbers_are_200_without_a_prefill(client, db_session, absurd):
    """審查 I1：真的 `OpenFoodFacts`（只有 fetcher 是假的）收到 quantize 放不下的數字——以前是 500，
    而且錯誤不快取、每掃一次就重打一次 OFF。現在是 200、沒有預填。"""
    user = await create_user(db_session)
    nutriments = {
        "energy-kcal_100g": 42,
        "proteins_100g": 0,
        "fat_100g": 0,
        "carbohydrates_100g": 10.6,
        **absurd,
    }
    payload = {
        "status": 1,
        "product": {
            "product_name": "x",
            "nutriments": {k: v for k, v in nutriments.items() if v is not None},
        },
    }

    async def fetch(url):
        return off.FetchResult(200, payload)

    lookup = off.OpenFoodFacts(fetch=fetch)
    app.dependency_overrides[get_product_lookup] = lambda: lookup

    response = await client.get(f"/api/foods/by-barcode/{CODE}", headers=auth(user))

    assert response.status_code == 200
    assert response.json() == {"code": CODE, "food": None, "prefill": None}


async def test_a_hit_never_asks_off(client, db_session):
    user = await create_user(db_session)
    await create_food(db_session, created_by=user, owner=user, barcode=CODE)
    fake = FakeLookup(_coke())
    app.dependency_overrides[get_product_lookup] = lambda: fake

    response = await client.get(f"/api/foods/by-barcode/{CODE}", headers=auth(user))

    assert response.json()["food"] is not None
    assert response.json()["prefill"] is None
    assert fake.codes == []


async def test_off_disabled_never_asks(client, db_session, monkeypatch):
    """**不覆寫**依賴：設定關掉時用的是 DisabledLookup。要是打出去，conftest 的守衛會讓它 500。"""
    monkeypatch.setattr(settings, "off_enabled", False)
    user = await create_user(db_session)

    response = await client.get(f"/api/foods/by-barcode/{CODE}", headers=auth(user))

    assert response.status_code == 200
    assert response.json() == {"code": CODE, "food": None, "prefill": None}


async def test_the_31st_lookup_in_a_minute_is_429(client, db_session):
    """31 次都查**自己的那一筆（命中）**：限速要在查資料庫之前、命中也算——全部沒命中的話，
    「限速移到沒命中那一支」的突變會活下來。"""
    user, other = await create_user(db_session), await create_user(db_session)
    await create_food(db_session, created_by=user, owner=user, barcode=CODE)
    await create_food(db_session, created_by=other, owner=other, barcode=CODE)
    headers = auth(user)

    for _ in range(30):
        ok = await client.get(f"/api/foods/by-barcode/{CODE}", headers=headers)
        assert ok.status_code == 200
        assert ok.json()["food"] is not None
    blocked = await client.get(f"/api/foods/by-barcode/{CODE}", headers=headers)

    assert blocked.status_code == 429
    assert blocked.json()["error"]["code"] == "TOO_MANY_BARCODE_LOOKUPS"
    assert "retry-after" in blocked.headers
    # 鍵是使用者：別人照樣查得到
    others = await client.get(f"/api/foods/by-barcode/{CODE}", headers=auth(other))
    assert others.status_code == 200
