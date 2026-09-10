from datetime import date

import pytest

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


# ---------------------------------------------------------------------------
# Task 5: PATCH /api/targets/{id} —— 關閉舊期間、開新期間（決定 1）。
# ---------------------------------------------------------------------------


async def test_update_target_closes_old_period_and_opens_new_one(client, db_session):
    """最重要的斷言：舊列的四個營養素、label 完全沒變。這是有效期間制的意義
    所在——一個「直接改舊列數值」的實作會讓「改完之後查得到新目標值」這種
    測試通過，但會摧毀 4b 的 /stats/range 賴以計算歷史達成率的基礎。
    """
    user = await create_user(db_session)
    target = await create_target(
        db_session,
        user=user,
        kcal=1800,
        protein_g=120,
        fat_g=60,
        carb_g=200,
        label="減脂期",
        effective_from=date(2026, 1, 1),
    )
    headers = auth(user)
    old_target_id = target.id

    response = await client.patch(
        f"/api/targets/{old_target_id}",
        headers=headers,
        json={"kcal": "2200", "label": "增肌期", "effective_from": "2026-06-01"},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["kcal"] == "2200.00"
    assert body["label"] == "增肌期"
    # 沒提到的欄位沿用舊列的值。
    assert body["protein_g"] == "120.00"
    assert body["fat_g"] == "60.00"
    assert body["carb_g"] == "200.00"
    assert body["effective_from"] == "2026-06-01"
    assert body["effective_to"] is None
    new_target_id = body["id"]
    assert new_target_id != old_target_id

    listing = (await client.get("/api/targets", headers=headers)).json()
    assert len(listing) == 2
    by_id = {t["id"]: t for t in listing}

    old_row = by_id[old_target_id]
    assert old_row["kcal"] == "1800.00"  # <- 最重要的斷言
    assert old_row["protein_g"] == "120.00"
    assert old_row["fat_g"] == "60.00"
    assert old_row["carb_g"] == "200.00"
    assert old_row["label"] == "減脂期"
    assert old_row["effective_from"] == "2026-01-01"
    assert old_row["effective_to"] == "2026-06-01"

    new_row = by_id[new_target_id]
    assert new_row["kcal"] == "2200.00"
    assert new_row["effective_from"] == "2026-06-01"
    assert new_row["effective_to"] is None


async def test_update_target_rejects_someone_elses_target(client, db_session):
    alice = await create_user(db_session)
    bob = await create_user(db_session)
    target = await create_target(db_session, user=alice, effective_from=date(2026, 1, 1))

    response = await client.patch(
        f"/api/targets/{target.id}",
        headers=auth(bob),
        json={"kcal": "2200"},
    )

    assert response.status_code == 404


async def test_update_target_rejects_effective_from_not_after_old_effective_from(
    client, db_session
):
    """生效日必須晚於舊列的 effective_from——跟資料庫的 effective_range
    CHECK（effective_to > effective_from）是同一條規則：UPDATE 舊列會把
    effective_to 設成這個生效日。
    """
    user = await create_user(db_session)
    target = await create_target(db_session, user=user, effective_from=date(2026, 1, 1))

    response = await client.patch(
        f"/api/targets/{target.id}",
        headers=auth(user),
        json={"kcal": "2200", "effective_from": "2026-01-01"},
    )

    assert response.status_code == 422


async def test_update_target_defaults_effective_from_to_today_in_users_timezone(
    client, db_session, monkeypatch
):
    """省略 effective_from 時預設「使用者時區的今天」，不是 UTC 今天、也不是
    `date.today()`（陷阱 3 + 計畫 3 Task 9 的教訓，monkeypatch 對象是
    app/api/routes/targets.py 的 today_in_timezone，同
    test_supplement_plans.py 的做法——不用真的時鐘就能測「沒帶時預設今天」
    這件事，不會讓測試變成時間依賴的。
    """
    user = await create_user(db_session)  # 預設時區 Asia/Taipei
    target = await create_target(db_session, user=user, effective_from=date(2026, 1, 1))
    fixed_today = date(2026, 5, 10)
    monkeypatch.setattr("app.api.routes.targets.today_in_timezone", lambda _tz: fixed_today)

    response = await client.patch(
        f"/api/targets/{target.id}",
        headers=auth(user),
        json={"kcal": "2200"},
    )

    assert response.status_code == 200
    assert response.json()["effective_from"] == "2026-05-10"


async def test_update_target_requires_authentication(client, db_session):
    user = await create_user(db_session)
    target = await create_target(db_session, user=user, effective_from=date(2026, 1, 1))

    response = await client.patch(
        f"/api/targets/{target.id}",
        json={"kcal": "2200"},
    )

    assert response.status_code == 401


async def test_update_target_returns_409_when_new_period_overlaps_another_target(
    client, db_session
):
    """關閉舊期間、開新期間的 INSERT 一樣受 EXCLUDE 約束保護：新期間往後
    延伸太多，撞上另一筆已經存在的目標。這裡也要接 IntegrityError 並
    rollback（繼承規矩第 3 條），而且要驗證同一個 session 之後還能正常用。
    """
    user = await create_user(db_session)
    target_to_patch = await create_target(
        db_session,
        user=user,
        kcal=1800,
        effective_from=date(2026, 1, 1),
        effective_to=date(2026, 6, 1),
    )
    await create_target(
        db_session,
        user=user,
        kcal=2000,
        effective_from=date(2026, 8, 1),
        effective_to=None,
    )
    headers = auth(user)
    target_id = target_to_patch.id

    response = await client.patch(
        f"/api/targets/{target_id}",
        headers=headers,
        json={"kcal": "2200", "effective_from": "2026-07-01"},
    )

    assert response.status_code == 409
    assert response.json()["error"]["code"] == "TARGET_OVERLAPS"

    # rollback 是否必要要靠「同一個 session 之後還能用」驗證：漏掉的話這裡
    # 會拋 PendingRollbackError，而不是單純讓上面的斷言變紅。
    listing = (await client.get("/api/targets", headers=headers)).json()
    assert len(listing) == 2
    # 衝突的交易要整個復原，含 UPDATE 那一半——舊列不能維持「已關閉」的
    # 半吊子狀態。
    unchanged = next(t for t in listing if t["id"] == target_id)
    assert unchanged["effective_to"] == "2026-06-01"


async def test_update_target_rejects_explicit_null_effective_from(client, db_session):
    """陷阱 3 的哨兵：effective_from 對應 NOT NULL 欄位，顯式 null 必須擋在
    這裡，不能一路流到 setattr 撞上資料庫（計畫 3 Task 3 的教訓）。
    """
    user = await create_user(db_session)
    target = await create_target(db_session, user=user, effective_from=date(2026, 1, 1))

    response = await client.patch(
        f"/api/targets/{target.id}",
        headers=auth(user),
        json={"effective_from": None},
    )

    assert response.status_code == 422


# --- 陷阱 3 的顯式 null 矩陣：kcal / protein_g / fat_g / carb_g / label ------
# 這五個欄位在資料庫都允許 NULL，跟 effective_from 不同，顯式 null 必須放行、
# 語意是「清除這個欄位」；沒提到則沿用舊列的值。


@pytest.mark.parametrize(
    ("field", "old_response"),
    [
        ("kcal", "1800.00"),
        ("protein_g", "120.00"),
        ("fat_g", "60.00"),
        ("carb_g", "200.00"),
        ("label", "減脂期"),
    ],
)
async def test_update_target_field_absent_carries_over_old_value(
    client, db_session, field, old_response
):
    user = await create_user(db_session)
    target = await create_target(
        db_session,
        user=user,
        kcal=1800,
        protein_g=120,
        fat_g=60,
        carb_g=200,
        label="減脂期",
        effective_from=date(2026, 1, 1),
    )

    response = await client.patch(
        f"/api/targets/{target.id}",
        headers=auth(user),
        json={"effective_from": "2026-06-01"},
    )

    assert response.status_code == 200
    assert response.json()[field] == old_response


@pytest.mark.parametrize("field", ["kcal", "protein_g", "fat_g", "carb_g", "label"])
async def test_update_target_field_explicit_null_clears_it(client, db_session, field):
    user = await create_user(db_session)
    target = await create_target(
        db_session,
        user=user,
        kcal=1800,
        protein_g=120,
        fat_g=60,
        carb_g=200,
        label="減脂期",
        effective_from=date(2026, 1, 1),
    )

    response = await client.patch(
        f"/api/targets/{target.id}",
        headers=auth(user),
        json={"effective_from": "2026-06-01", field: None},
    )

    assert response.status_code == 200
    assert response.json()[field] is None


@pytest.mark.parametrize(
    ("field", "value", "expected"),
    [
        ("kcal", "2200", "2200.00"),
        ("protein_g", "180", "180.00"),
        ("fat_g", "70", "70.00"),
        ("carb_g", "250", "250.00"),
        ("label", "增肌期", "增肌期"),
    ],
)
async def test_update_target_field_explicit_value_sets_it(
    client, db_session, field, value, expected
):
    user = await create_user(db_session)
    target = await create_target(
        db_session,
        user=user,
        kcal=1800,
        protein_g=120,
        fat_g=60,
        carb_g=200,
        label="減脂期",
        effective_from=date(2026, 1, 1),
    )

    response = await client.patch(
        f"/api/targets/{target.id}",
        headers=auth(user),
        json={"effective_from": "2026-06-01", field: value},
    )

    assert response.status_code == 200
    assert response.json()[field] == expected


async def test_update_target_effective_to_absent_defaults_to_open_ended(client, db_session):
    user = await create_user(db_session)
    target = await create_target(db_session, user=user, effective_from=date(2026, 1, 1))

    response = await client.patch(
        f"/api/targets/{target.id}",
        headers=auth(user),
        json={"effective_from": "2026-06-01"},
    )

    assert response.status_code == 200
    assert response.json()["effective_to"] is None


async def test_update_target_effective_to_explicit_null_is_also_open_ended(client, db_session):
    """跟省略效果相同：都合法，都代表新期間沒有結束日。"""
    user = await create_user(db_session)
    target = await create_target(db_session, user=user, effective_from=date(2026, 1, 1))

    response = await client.patch(
        f"/api/targets/{target.id}",
        headers=auth(user),
        json={"effective_from": "2026-06-01", "effective_to": None},
    )

    assert response.status_code == 200
    assert response.json()["effective_to"] is None


async def test_update_target_effective_to_explicit_value_bounds_the_new_period(
    client, db_session
):
    user = await create_user(db_session)
    target = await create_target(db_session, user=user, effective_from=date(2026, 1, 1))

    response = await client.patch(
        f"/api/targets/{target.id}",
        headers=auth(user),
        json={"effective_from": "2026-06-01", "effective_to": "2026-09-01"},
    )

    assert response.status_code == 200
    assert response.json()["effective_to"] == "2026-09-01"


async def test_update_target_rejects_effective_to_not_after_its_own_effective_from(
    client, db_session
):
    user = await create_user(db_session)
    target = await create_target(db_session, user=user, effective_from=date(2026, 1, 1))

    response = await client.patch(
        f"/api/targets/{target.id}",
        headers=auth(user),
        json={"effective_from": "2026-06-01", "effective_to": "2026-06-01"},
    )

    assert response.status_code == 422
