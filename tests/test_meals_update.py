from app.security.tokens import create_token
from tests.factories import create_user


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


# ---------------------------------------------------------------------------
# Task 10: PATCH /api/meals/{id} —— 依計畫決定 2，只改 eaten_at / meal_type /
# note，項目不在這個端點的範圍內。
# ---------------------------------------------------------------------------


async def test_updating_note_succeeds(client, db_session):
    user = await create_user(db_session)
    create_response = await client.post(
        "/api/meals", headers=auth(user), json=_create_payload(note="原本的備註")
    )
    meal_id = create_response.json()["id"]

    response = await client.patch(
        f"/api/meals/{meal_id}", headers=auth(user), json={"note": "改過的備註"}
    )

    assert response.status_code == 200
    assert response.json()["note"] == "改過的備註"


async def test_updating_eaten_at_moves_the_meal_to_a_different_day(client, db_session):
    """改 eaten_at 不只是改一個欄位而已 —— 必須真的讓這一餐換到另一天，
    用 GET /api/meals?date= 實際觀察才算數，不能只看 PATCH 回應裡的欄位值。
    """
    user = await create_user(db_session)  # 預設時區 Asia/Taipei
    create_response = await client.post(
        "/api/meals",
        headers=auth(user),
        json=_create_payload(eaten_at="2026-09-04T12:00:00+08:00"),
    )
    meal_id = create_response.json()["id"]

    old_day = await client.get("/api/meals", headers=auth(user), params={"date": "2026-09-04"})
    assert [meal["id"] for meal in old_day.json()] == [meal_id]

    response = await client.patch(
        f"/api/meals/{meal_id}",
        headers=auth(user),
        json={"eaten_at": "2026-09-10T12:00:00+08:00"},
    )
    assert response.status_code == 200

    old_day_after = await client.get(
        "/api/meals", headers=auth(user), params={"date": "2026-09-04"}
    )
    new_day_after = await client.get(
        "/api/meals", headers=auth(user), params={"date": "2026-09-10"}
    )
    assert old_day_after.json() == []
    assert [meal["id"] for meal in new_day_after.json()] == [meal_id]


async def test_updating_meal_type_succeeds(client, db_session):
    user = await create_user(db_session)
    create_response = await client.post(
        "/api/meals", headers=auth(user), json=_create_payload(meal_type="lunch")
    )
    meal_id = create_response.json()["id"]

    response = await client.patch(
        f"/api/meals/{meal_id}", headers=auth(user), json={"meal_type": "dinner"}
    )

    assert response.status_code == 200
    assert response.json()["meal_type"] == "dinner"


async def test_updating_one_field_leaves_others_unchanged(client, db_session):
    user = await create_user(db_session)
    create_response = await client.post(
        "/api/meals",
        headers=auth(user),
        json=_create_payload(
            eaten_at="2026-09-04T12:30:00+08:00", meal_type="lunch", note="原本的備註"
        ),
    )
    meal_id = create_response.json()["id"]
    original_eaten_at = create_response.json()["eaten_at"]

    response = await client.patch(
        f"/api/meals/{meal_id}", headers=auth(user), json={"note": "只改這個"}
    )

    assert response.status_code == 200
    body = response.json()
    assert body["note"] == "只改這個"
    assert body["meal_type"] == "lunch"
    assert body["eaten_at"] == original_eaten_at


async def test_updating_someone_elses_meal_is_not_found(client, db_session):
    alice = await create_user(db_session)
    bob = await create_user(db_session)
    create_response = await client.post(
        "/api/meals", headers=auth(alice), json=_create_payload(note="愛麗絲的備註")
    )
    meal_id = create_response.json()["id"]

    response = await client.patch(
        f"/api/meals/{meal_id}", headers=auth(bob), json={"note": "被入侵了"}
    )

    assert response.status_code == 404

    reread = await client.get(f"/api/meals/{meal_id}", headers=auth(alice))
    assert reread.json()["note"] == "愛麗絲的備註"


async def test_invalid_meal_type_on_update_is_rejected(client, db_session):
    user = await create_user(db_session)
    create_response = await client.post("/api/meals", headers=auth(user), json=_create_payload())
    meal_id = create_response.json()["id"]

    response = await client.patch(
        f"/api/meals/{meal_id}", headers=auth(user), json={"meal_type": "brunch"}
    )

    assert response.status_code == 422


# ---------------------------------------------------------------------------
# 顯式 null 的邊界：note 可為 null（NOT NULL 以外的欄位），
# eaten_at / meal_type 是 NOT NULL，顯式 null 必須是 422 而不是撞到
# asyncpg 的 NotNullViolationError 變成未處理的 500（見 UpdateMeRequest
# 踩過的同一個坑）。
# ---------------------------------------------------------------------------


async def test_explicit_null_note_is_accepted_and_clears_it(client, db_session):
    user = await create_user(db_session)
    create_response = await client.post(
        "/api/meals", headers=auth(user), json=_create_payload(note="會被清空的備註")
    )
    meal_id = create_response.json()["id"]

    response = await client.patch(f"/api/meals/{meal_id}", headers=auth(user), json={"note": None})

    assert response.status_code == 200
    assert response.json()["note"] is None


async def test_explicit_null_eaten_at_is_rejected_with_422(client, db_session):
    user = await create_user(db_session)
    create_response = await client.post("/api/meals", headers=auth(user), json=_create_payload())
    meal_id = create_response.json()["id"]

    response = await client.patch(
        f"/api/meals/{meal_id}", headers=auth(user), json={"eaten_at": None}
    )

    assert response.status_code == 422


async def test_explicit_null_meal_type_is_rejected_with_422(client, db_session):
    user = await create_user(db_session)
    create_response = await client.post("/api/meals", headers=auth(user), json=_create_payload())
    meal_id = create_response.json()["id"]

    response = await client.patch(
        f"/api/meals/{meal_id}", headers=auth(user), json={"meal_type": None}
    )

    assert response.status_code == 422


# ---------------------------------------------------------------------------
# Task 11: DELETE /api/meals/{id}
# ---------------------------------------------------------------------------


async def test_deleting_own_meal_returns_204_then_404_on_reread(client, db_session):
    user = await create_user(db_session)
    create_response = await client.post("/api/meals", headers=auth(user), json=_create_payload())
    meal_id = create_response.json()["id"]

    response = await client.delete(f"/api/meals/{meal_id}", headers=auth(user))
    assert response.status_code == 204

    reread = await client.get(f"/api/meals/{meal_id}", headers=auth(user))
    assert reread.status_code == 404


async def test_deleting_someone_elses_meal_is_not_found_and_meal_still_exists(client, db_session):
    """「回 404」跟「沒有真的刪掉」是兩件事 —— 用真的重查確認，不能只看狀態碼。
    一個「先刪除、再檢查權限」的實作會通過只斷言狀態碼的測試。
    """
    alice = await create_user(db_session)
    bob = await create_user(db_session)
    create_response = await client.post(
        "/api/meals", headers=auth(alice), json=_create_payload(note="愛麗絲的餐點")
    )
    meal_id = create_response.json()["id"]

    response = await client.delete(f"/api/meals/{meal_id}", headers=auth(bob))
    assert response.status_code == 404

    reread = await client.get(f"/api/meals/{meal_id}", headers=auth(alice))
    assert reread.status_code == 200
    assert reread.json()["note"] == "愛麗絲的餐點"


async def test_deleting_a_nonexistent_meal_is_not_found(client, db_session):
    user = await create_user(db_session)

    response = await client.delete("/api/meals/999999", headers=auth(user))

    assert response.status_code == 404


async def test_delete_meal_requires_authentication(client, db_session):
    user = await create_user(db_session)
    create_response = await client.post("/api/meals", headers=auth(user), json=_create_payload())
    meal_id = create_response.json()["id"]

    response = await client.delete(f"/api/meals/{meal_id}")

    assert response.status_code == 401
