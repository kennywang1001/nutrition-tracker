from datetime import date

from app.security.tokens import create_token
from tests.factories import create_target, create_user


def auth(user):
    return {"Authorization": f"Bearer {create_token(user.id, 'access')}"}


# ---------------------------------------------------------------------------
# Task 4: GET / POST /api/targets
# ---------------------------------------------------------------------------


async def test_create_target_returns_the_target(client, db_session):
    user = await create_user(db_session)

    response = await client.post(
        "/api/targets",
        headers=auth(user),
        json={
            "kcal": "2000",
            "protein_g": "150",
            "fat_g": "60",
            "carb_g": "200",
            "label": "增肌期",
            "effective_from": "2026-01-01",
        },
    )

    assert response.status_code == 201
    body = response.json()
    assert body["kcal"] == "2000.00"
    assert body["protein_g"] == "150.00"
    assert body["fat_g"] == "60.00"
    assert body["carb_g"] == "200.00"
    assert body["label"] == "增肌期"
    assert body["effective_from"] == "2026-01-01"
    assert body["effective_to"] is None


async def test_create_target_allows_kcal_only(client, db_session):
    """陷阱 3：規格第 6.5 節允許只設熱量目標，三大營養素留空。"""
    user = await create_user(db_session)

    response = await client.post(
        "/api/targets",
        headers=auth(user),
        json={"kcal": "2000", "effective_from": "2026-01-01"},
    )

    assert response.status_code == 201
    body = response.json()
    assert body["kcal"] == "2000.00"
    assert body["protein_g"] is None
    assert body["fat_g"] is None
    assert body["carb_g"] is None
    assert body["label"] is None


async def test_create_target_requires_authentication(client, db_session):
    response = await client.post(
        "/api/targets",
        json={"kcal": "2000", "effective_from": "2026-01-01"},
    )

    assert response.status_code == 401


async def test_create_target_rejects_effective_to_not_after_effective_from(client, db_session):
    user = await create_user(db_session)

    response = await client.post(
        "/api/targets",
        headers=auth(user),
        json={
            "kcal": "2000",
            "effective_from": "2026-01-01",
            "effective_to": "2026-01-01",
        },
    )

    assert response.status_code == 422


async def test_create_target_rejects_negative_kcal(client, db_session):
    user = await create_user(db_session)

    response = await client.post(
        "/api/targets",
        headers=auth(user),
        json={"kcal": "-1", "effective_from": "2026-01-01"},
    )

    assert response.status_code == 422


async def test_create_target_rejects_overlapping_period(client, db_session):
    """決定 1 的 API 層實證：EXCLUDE 約束觸發的 IntegrityError 要變成 409，
    不是 500，而且 rollback 之後這個 session 還要能繼續用（繼承規矩第 3、4 條）。
    """
    user = await create_user(db_session)
    headers = auth(user)

    first = await client.post(
        "/api/targets",
        headers=headers,
        json={
            "kcal": "2000",
            "effective_from": "2026-01-01",
            "effective_to": "2026-06-01",
        },
    )
    assert first.status_code == 201

    second = await client.post(
        "/api/targets",
        headers=headers,
        json={
            "kcal": "2200",
            "effective_from": "2026-03-01",
            "effective_to": "2026-09-01",
        },
    )

    assert second.status_code == 409
    assert second.json()["error"]["code"] == "TARGET_OVERLAPS"

    # rollback 是否真的必要，要靠「同一個 session 之後還能用」驗證：漏掉的話
    # 這裡會拋 PendingRollbackError，不是單純讓上面的斷言變紅。
    listing = await client.get("/api/targets", headers=headers)
    assert listing.status_code == 200
    assert len(listing.json()) == 1


async def test_list_targets_requires_authentication(client, db_session):
    response = await client.get("/api/targets")

    assert response.status_code == 401


async def test_list_targets_returns_only_my_targets(client, db_session):
    alice = await create_user(db_session)
    bob = await create_user(db_session)
    await create_target(db_session, user=alice, kcal=2000, effective_from=date(2026, 1, 1))
    await create_target(db_session, user=bob, kcal=1800, effective_from=date(2026, 1, 1))

    response = await client.get("/api/targets", headers=auth(alice))

    assert response.status_code == 200
    body = response.json()
    assert len(body) == 1
    assert body[0]["kcal"] == "2000.00"


async def test_list_targets_returns_all_periods_including_closed_ones(client, db_session):
    user = await create_user(db_session)
    await create_target(
        db_session,
        user=user,
        kcal=1800,
        effective_from=date(2026, 1, 1),
        effective_to=date(2026, 6, 1),
    )
    await create_target(
        db_session, user=user, kcal=2000, effective_from=date(2026, 6, 1), effective_to=None
    )

    response = await client.get("/api/targets", headers=auth(user))

    assert response.status_code == 200
    assert len(response.json()) == 2


async def test_get_target_by_date_returns_the_effective_one(client, db_session):
    user = await create_user(db_session)
    await create_target(
        db_session,
        user=user,
        kcal=1800,
        effective_from=date(2026, 1, 1),
        effective_to=date(2026, 6, 1),
    )
    await create_target(
        db_session, user=user, kcal=2000, effective_from=date(2026, 6, 1), effective_to=None
    )

    response = await client.get("/api/targets?date=2026-07-01", headers=auth(user))

    assert response.status_code == 200
    body = response.json()
    assert body["kcal"] == "2000.00"


async def test_get_target_by_date_respects_half_open_boundary(client, db_session):
    """`[)` 邊界：effective_to 那一天本身已經不屬於這個期間（跟 EXCLUDE 約束
    用的 daterange('[)') 是同一個規則，兩處不能有一處用 <=）。
    """
    user = await create_user(db_session)
    await create_target(
        db_session,
        user=user,
        kcal=1800,
        effective_from=date(2026, 1, 1),
        effective_to=date(2026, 6, 1),
    )

    inside = await client.get("/api/targets?date=2026-05-31", headers=auth(user))
    boundary = await client.get("/api/targets?date=2026-06-01", headers=auth(user))

    assert inside.status_code == 200
    assert inside.json()["kcal"] == "1800.00"
    assert boundary.status_code == 200
    assert boundary.json() is None


async def test_get_target_by_date_returns_null_when_outside_any_period(client, db_session):
    user = await create_user(db_session)
    await create_target(
        db_session,
        user=user,
        kcal=1800,
        effective_from=date(2026, 3, 1),
        effective_to=date(2026, 6, 1),
    )

    response = await client.get("/api/targets?date=2026-01-01", headers=auth(user))

    assert response.status_code == 200
    assert response.json() is None


async def test_get_target_by_date_returns_null_not_404_when_no_target_ever_set(
    client, db_session
):
    """Task 4 的核心教訓：「沒設目標」是正常狀態，不是 404。使用者從未叫過
    POST /api/targets，這裡也要是 200 + null。
    """
    user = await create_user(db_session)

    response = await client.get("/api/targets?date=2026-01-01", headers=auth(user))

    assert response.status_code == 200
    assert response.json() is None


async def test_get_target_by_date_does_not_leak_other_users_targets(client, db_session):
    alice = await create_user(db_session)
    bob = await create_user(db_session)
    await create_target(db_session, user=bob, kcal=1800, effective_from=date(2026, 1, 1))

    response = await client.get("/api/targets?date=2026-02-01", headers=auth(alice))

    assert response.status_code == 200
    assert response.json() is None
