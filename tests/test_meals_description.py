"""`meals.description`（AI 多樣估算規格 §3.2、§4）：這一餐吃了什麼的一句話，好友看得到。

跟 `note`（備註，只有自己看得到）是兩個欄位。寫入一律經過 `single_line`；
清完是空的存 NULL。
"""

import pytest
from sqlalchemy import select

from app.models.food import FoodRevision
from app.models.meal import Meal
from app.security.tokens import create_access_token
from tests.factories import create_food, create_meal, create_user


def auth(user):
    return {"Authorization": f"Bearer {create_access_token(user.id)}"}


def _payload(**overrides):
    payload = {"eaten_at": "2026-09-04T12:30:00+08:00", "meal_type": "lunch", "items": []}
    payload.update(overrides)
    return payload


async def _stored(db_session, meal_id: int) -> tuple[str | None, str | None]:
    """資料庫裡真的存了什麼：`(description, note)`。

    先 `rollback()`：`client` 跟測試共用 session，端點忘了 commit 的改動在同一個
    session 裡照樣讀得到（第 11 種）。選欄位而不是拿 ORM 物件：identity map 裡的
    舊物件會蓋住資料庫的值（第 30 種）。
    """
    await db_session.rollback()
    row = (
        await db_session.execute(
            select(Meal.description, Meal.note).where(Meal.id == meal_id)
        )
    ).one()
    return row.description, row.note


async def test_creating_a_meal_with_a_description_stores_and_returns_it(client, db_session):
    user = await create_user(db_session)

    response = await client.post(
        "/api/meals",
        headers=auth(user),
        json=_payload(description="一碗白飯、滷雞腿一隻", note="跟同事吃"),
    )

    assert response.status_code == 201
    body = response.json()
    # 兩個欄位各存各的——互換或寫到同一欄，這兩行會有一行紅。
    assert body["description"] == "一碗白飯、滷雞腿一隻"
    assert body["note"] == "跟同事吃"
    assert await _stored(db_session, body["id"]) == ("一碗白飯、滷雞腿一隻", "跟同事吃")


async def test_a_meal_without_a_description_has_null(client, db_session):
    user = await create_user(db_session)

    response = await client.post("/api/meals", headers=auth(user), json=_payload())

    assert response.status_code == 201
    assert response.json()["description"] is None
    assert await _stored(db_session, response.json()["id"]) == (None, None)


async def test_every_read_of_my_meal_carries_the_description(client, db_session):
    """兩個組 `MealResponse` 的地方之外的每一條路：讀一餐、清單、加一項之後的回應
    （都經過 `_build_meal_response`）。"""
    user = await create_user(db_session)
    food = await create_food(db_session, created_by=user, owner=user, name="白飯")
    meal = await create_meal(db_session, user=user, description="便當", note="備註不是描述")

    one = await client.get(f"/api/meals/{meal.id}", headers=auth(user))
    # 工廠預設的 eaten_at 是 2026-01-01 12:00 UTC＝台北 1/1 20:00。
    listed = await client.get(
        "/api/meals", headers=auth(user), params={"date": "2026-01-01"}
    )
    added = await client.post(
        f"/api/meals/{meal.id}/items",
        headers=auth(user),
        json={"food_id": food.id, "quantity": "100"},
    )

    assert one.json()["description"] == "便當"
    assert [m["description"] for m in listed.json() if m["id"] == meal.id] == ["便當"]
    assert added.status_code == 201
    assert added.json()["description"] == "便當"


async def test_the_description_is_cleaned_to_a_single_line(client, db_session):
    user = await create_user(db_session)

    response = await client.post(
        "/api/meals",
        headers=auth(user),
        json=_payload(description="  一碗\n白飯\x00\u202e、湯  "),
    )

    assert response.status_code == 201
    assert response.json()["description"] == "一碗 白飯 、湯"
    assert (await _stored(db_session, response.json()["id"]))[0] == "一碗 白飯 、湯"


@pytest.mark.parametrize("blank", ["", "   ", "\n\t"])
async def test_a_blank_description_is_stored_as_null(client, db_session, blank):
    user = await create_user(db_session)

    response = await client.post(
        "/api/meals", headers=auth(user), json=_payload(description=blank)
    )

    assert response.status_code == 201
    assert response.json()["description"] is None
    assert (await _stored(db_session, response.json()["id"]))[0] is None


async def test_a_description_of_500_characters_is_accepted_and_501_is_rejected(
    client, db_session
):
    user = await create_user(db_session)
    # 先記下來：下面 rollback() 之後 ORM 物件過期，再碰 `user.id` 是一次同步的
    # lazy load（MissingGreenlet），不是我們要測的東西。
    user_id = user.id

    ok = await client.post(
        "/api/meals", headers=auth(user), json=_payload(description="飯" * 500)
    )
    too_long = await client.post(
        "/api/meals", headers=auth(user), json=_payload(description="飯" * 501)
    )

    assert ok.status_code == 201
    assert len(ok.json()["description"]) == 500
    assert too_long.status_code == 422
    assert too_long.json()["error"]["code"] == "VALIDATION_ERROR"
    # 被拒絕的那一次沒有留下一餐。
    await db_session.rollback()
    meals = (await db_session.scalars(select(Meal.id).where(Meal.user_id == user_id))).all()
    assert meals == [ok.json()["id"]]


async def test_patching_the_description_changes_only_the_description(client, db_session):
    user = await create_user(db_session)
    meal = await create_meal(db_session, user=user, description="原本的描述", note="原本的備註")

    response = await client.patch(
        f"/api/meals/{meal.id}", headers=auth(user), json={"description": "改過的描述"}
    )

    assert response.status_code == 200
    assert response.json()["description"] == "改過的描述"
    assert response.json()["note"] == "原本的備註"
    assert await _stored(db_session, meal.id) == ("改過的描述", "原本的備註")


async def test_patching_something_else_leaves_the_description_alone(client, db_session):
    user = await create_user(db_session)
    meal = await create_meal(db_session, user=user, description="原本的描述", note="原本的備註")

    response = await client.patch(
        f"/api/meals/{meal.id}", headers=auth(user), json={"note": "改過的備註"}
    )

    assert response.status_code == 200
    assert response.json()["description"] == "原本的描述"
    assert await _stored(db_session, meal.id) == ("原本的描述", "改過的備註")


@pytest.mark.parametrize("cleared", [None, "", "  \n "])
async def test_patching_null_or_blank_clears_the_description(client, db_session, cleared):
    user = await create_user(db_session)
    meal = await create_meal(db_session, user=user, description="原本的描述", note="原本的備註")

    response = await client.patch(
        f"/api/meals/{meal.id}", headers=auth(user), json={"description": cleared}
    )

    assert response.status_code == 200
    assert response.json()["description"] is None
    # 備註還在：清掉的是描述，不是「所有文字欄位」。
    assert await _stored(db_session, meal.id) == (None, "原本的備註")


async def test_patching_a_description_of_501_characters_is_rejected(client, db_session):
    """PATCH 的長度上限是另一個 schema（`MealUpdateRequest`）上的另一個 `max_length`——
    建立那一條守不到它。"""
    user = await create_user(db_session)
    meal = await create_meal(db_session, user=user, description="原本的描述")
    # 先記下來：`_stored` 會 rollback()，之後 ORM 物件過期，不能再碰 `meal.id`／`user.id`。
    meal_id, headers = meal.id, auth(user)

    too_long = await client.patch(
        f"/api/meals/{meal_id}", headers=headers, json={"description": "飯" * 501}
    )

    assert too_long.status_code == 422
    assert too_long.json()["error"]["code"] == "VALIDATION_ERROR"
    assert (await _stored(db_session, meal_id))[0] == "原本的描述"

    ok = await client.patch(
        f"/api/meals/{meal_id}", headers=headers, json={"description": "飯" * 500}
    )

    assert ok.status_code == 200
    assert (await _stored(db_session, meal_id))[0] == "飯" * 500


async def test_someone_elses_meal_description_cannot_be_changed(client, db_session):
    owner = await create_user(db_session)
    stranger = await create_user(db_session)
    meal = await create_meal(db_session, user=owner, description="原本的描述")

    response = await client.patch(
        f"/api/meals/{meal.id}", headers=auth(stranger), json={"description": "亂改"}
    )

    assert response.status_code == 404
    assert (await _stored(db_session, meal.id))[0] == "原本的描述"


async def test_the_description_does_not_change_the_nutrition(client, db_session):
    """描述只是一句話：帶不帶它，這一餐的營養素一樣。"""
    user = await create_user(db_session)
    food = await create_food(db_session, created_by=user, owner=user, name="白飯", kcal=130)
    revision = await db_session.get(FoodRevision, food.current_revision_id)
    assert revision is not None
    plain = await create_meal(db_session, user=user, items=[(revision, 200)])
    described = await create_meal(
        db_session, user=user, items=[(revision, 200)], description="一碗白飯"
    )

    first = (await client.get(f"/api/meals/{plain.id}", headers=auth(user))).json()
    second = (await client.get(f"/api/meals/{described.id}", headers=auth(user))).json()

    assert first["kcal"] == second["kcal"] == "260.00"
