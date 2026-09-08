from app.security.tokens import create_token
from tests.factories import create_supplement, create_user


def auth(user):
    return {"Authorization": f"Bearer {create_token(user.id, 'access')}"}


async def test_create_plan_returns_the_plan(client, db_session):
    user = await create_user(db_session)
    supplement = await create_supplement(db_session, created_by=user, owner=user)

    response = await client.post(
        "/api/supplement-plans",
        headers=auth(user),
        json={
            "supplement_id": supplement.id,
            "dose": "2",
            "time_of_day": "morning",
            "effective_from": "2026-01-01",
        },
    )

    assert response.status_code == 201
    body = response.json()
    assert body["supplement_id"] == supplement.id
    assert body["dose"] == "2.00"
    assert body["time_of_day"] == "morning"
    assert body["effective_from"] == "2026-01-01"
    assert body["effective_to"] is None


async def test_create_plan_requires_authentication(client, db_session):
    user = await create_user(db_session)
    supplement = await create_supplement(db_session, created_by=user, owner=user)

    response = await client.post(
        "/api/supplement-plans",
        json={
            "supplement_id": supplement.id,
            "dose": "1",
            "time_of_day": "morning",
            "effective_from": "2026-01-01",
        },
    )

    assert response.status_code == 401


async def test_list_plans_requires_authentication(client):
    response = await client.get("/api/supplement-plans")

    assert response.status_code == 401


async def test_list_plans_returns_only_my_plans(client, db_session):
    alice = await create_user(db_session)
    bob = await create_user(db_session)
    supplement = await create_supplement(db_session, created_by=alice)

    await client.post(
        "/api/supplement-plans",
        headers=auth(alice),
        json={
            "supplement_id": supplement.id,
            "dose": "1",
            "time_of_day": "morning",
            "effective_from": "2026-01-01",
        },
    )
    await client.post(
        "/api/supplement-plans",
        headers=auth(bob),
        json={
            "supplement_id": supplement.id,
            "dose": "1",
            "time_of_day": "evening",
            "effective_from": "2026-01-01",
        },
    )

    response = await client.get("/api/supplement-plans", headers=auth(alice))

    assert response.status_code == 200
    body = response.json()
    assert len(body) == 1
    assert body[0]["time_of_day"] == "morning"


async def test_create_plan_rejects_a_supplement_i_cannot_see(client, db_session):
    alice = await create_user(db_session)
    bob = await create_user(db_session)
    alices_supplement = await create_supplement(db_session, created_by=alice, owner=alice)

    response = await client.post(
        "/api/supplement-plans",
        headers=auth(bob),
        json={
            "supplement_id": alices_supplement.id,
            "dose": "1",
            "time_of_day": "morning",
            "effective_from": "2026-01-01",
        },
    )

    assert response.status_code == 404


async def test_create_plan_rejects_effective_to_not_after_effective_from(client, db_session):
    user = await create_user(db_session)
    supplement = await create_supplement(db_session, created_by=user, owner=user)

    response = await client.post(
        "/api/supplement-plans",
        headers=auth(user),
        json={
            "supplement_id": supplement.id,
            "dose": "1",
            "time_of_day": "morning",
            "effective_from": "2026-01-01",
            "effective_to": "2026-01-01",
        },
    )

    assert response.status_code == 422


async def test_create_plan_rejects_overlapping_plan_for_the_same_time_of_day(
    client, db_session
):
    """決定 2 的 API 層實證：EXCLUDE 約束觸發的 IntegrityError 要變成 409，不是 500。"""
    user = await create_user(db_session)
    supplement = await create_supplement(db_session, created_by=user, owner=user)
    # 把之後兩次請求要用的值先存成區域變數：第二次請求會在路由裡觸發
    # rollback()，那會讓 identity map 裡所有物件過期，包含這裡抓著的
    # user / supplement（繼承規矩第 3 條）。
    headers = auth(user)
    supplement_id = supplement.id

    first = await client.post(
        "/api/supplement-plans",
        headers=headers,
        json={
            "supplement_id": supplement_id,
            "dose": "1",
            "time_of_day": "morning",
            "effective_from": "2026-01-01",
            "effective_to": "2026-06-01",
        },
    )
    assert first.status_code == 201

    second = await client.post(
        "/api/supplement-plans",
        headers=headers,
        json={
            "supplement_id": supplement_id,
            "dose": "1",
            "time_of_day": "morning",
            "effective_from": "2026-03-01",
            "effective_to": "2026-09-01",
        },
    )

    assert second.status_code == 409
    assert second.json()["error"]["code"] == "PLAN_OVERLAPS"

    # rollback 是否真的必要，要靠「同一個 session 之後還能用」來驗證
    # （繼承規矩第 3 條）：漏掉 rollback 的話，這個 session 之後任何操作都會
    # 拋 PendingRollbackError，而不是單純讓上面兩個斷言變紅。用同一個
    # client（背後是同一個 db_session）再打一次列表端點，證明它還能正常用，
    # 而且只有第一筆計畫真的被存下來。
    listing = await client.get("/api/supplement-plans", headers=headers)
    assert listing.status_code == 200
    assert len(listing.json()) == 1


async def test_create_plan_allows_overlapping_plan_for_a_different_time_of_day(
    client, db_session
):
    """同補劑早上一顆、睡前一顆是合理的，不能被誤擋（規格決定 2 的另一半）。"""
    user = await create_user(db_session)
    supplement = await create_supplement(db_session, created_by=user, owner=user)
    headers = auth(user)
    supplement_id = supplement.id

    first = await client.post(
        "/api/supplement-plans",
        headers=headers,
        json={
            "supplement_id": supplement_id,
            "dose": "1",
            "time_of_day": "morning",
            "effective_from": "2026-01-01",
            "effective_to": "2026-06-01",
        },
    )
    assert first.status_code == 201

    second = await client.post(
        "/api/supplement-plans",
        headers=headers,
        json={
            "supplement_id": supplement_id,
            "dose": "1",
            "time_of_day": "bedtime",
            "effective_from": "2026-03-01",
            "effective_to": "2026-09-01",
        },
    )

    assert second.status_code == 201
