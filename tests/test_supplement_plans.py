from datetime import date
from decimal import Decimal

from app.models.supplement import SupplementIntake, SupplementPlan, TimeOfDay
from app.security.tokens import create_access_token
from tests.factories import create_intake, create_plan, create_supplement, create_user


def auth(user):
    return {"Authorization": f"Bearer {create_access_token(user.id)}"}


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


# ---------------------------------------------------------------------------
# Task 6: PATCH /api/supplement-plans/{id} —— 關閉舊期間、開新期間（陷阱 3）。
# ---------------------------------------------------------------------------


async def test_update_plan_closes_old_period_and_opens_new_one(client, db_session):
    """最重要的斷言：舊列的 dose 沒變。這是有效期間制的意義所在 ——
    一個「直接改舊列數值」的實作會讓「改了之後查得到新劑量」這種測試通過，
    但會摧毀 4b 依從率賴以計算的歷史。
    """
    user = await create_user(db_session)
    supplement = await create_supplement(db_session, created_by=user, owner=user)
    plan = await create_plan(
        db_session,
        user=user,
        supplement=supplement,
        dose=1,
        time_of_day=TimeOfDay.MORNING,
        effective_from=date(2026, 1, 1),
    )
    headers = auth(user)
    old_plan_id = plan.id

    response = await client.patch(
        f"/api/supplement-plans/{old_plan_id}",
        headers=headers,
        json={"dose": "2", "effective_date": "2026-06-01"},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["dose"] == "2.00"
    assert body["time_of_day"] == "morning"
    assert body["effective_from"] == "2026-06-01"
    assert body["effective_to"] is None
    new_plan_id = body["id"]
    assert new_plan_id != old_plan_id

    listing = (await client.get("/api/supplement-plans", headers=headers)).json()
    assert len(listing) == 2
    by_id = {p["id"]: p for p in listing}

    old_row = by_id[old_plan_id]
    assert old_row["dose"] == "1.00"  # <- 最重要的斷言
    assert old_row["time_of_day"] == "morning"
    assert old_row["effective_from"] == "2026-01-01"
    assert old_row["effective_to"] == "2026-06-01"

    new_row = by_id[new_plan_id]
    assert new_row["dose"] == "2.00"
    assert new_row["effective_from"] == "2026-06-01"
    assert new_row["effective_to"] is None


async def test_update_plan_rejects_someone_elses_plan(client, db_session):
    alice = await create_user(db_session)
    bob = await create_user(db_session)
    supplement = await create_supplement(db_session, created_by=alice, owner=alice)
    plan = await create_plan(db_session, user=alice, supplement=supplement)

    response = await client.patch(
        f"/api/supplement-plans/{plan.id}",
        headers=auth(bob),
        json={"dose": "2"},
    )

    assert response.status_code == 404


async def test_update_plan_rejects_effective_date_not_after_old_effective_from(
    client, db_session
):
    """生效日必須晚於舊列的 effective_from —— 跟資料庫的
    effective_range CHECK（`effective_to > effective_from`）是同一條規則：
    UPDATE 舊列會把 effective_to 設成這個生效日。
    """
    user = await create_user(db_session)
    supplement = await create_supplement(db_session, created_by=user, owner=user)
    plan = await create_plan(
        db_session, user=user, supplement=supplement, effective_from=date(2026, 1, 1)
    )

    response = await client.patch(
        f"/api/supplement-plans/{plan.id}",
        headers=auth(user),
        json={"dose": "2", "effective_date": "2026-01-01"},
    )

    assert response.status_code == 422


async def test_update_plan_defaults_effective_date_to_today_in_users_timezone(
    client, db_session, monkeypatch
):
    """省略 effective_date 時預設「使用者時區的今天」，不是 UTC 今天、
    也不是 `date.today()`（陷阱 3 + 計畫 3 Task 9 的教訓，monkeypatch
    對象是 app/days.py 的 today_in_timezone，同 test_meals_read.py 的做法）。
    """
    user = await create_user(db_session)  # 預設時區 Asia/Taipei
    supplement = await create_supplement(db_session, created_by=user, owner=user)
    plan = await create_plan(
        db_session, user=user, supplement=supplement, effective_from=date(2026, 1, 1)
    )
    fixed_today = date(2026, 5, 10)
    monkeypatch.setattr(
        "app.api.routes.supplement_plans.today_in_timezone", lambda _tz: fixed_today
    )

    response = await client.patch(
        f"/api/supplement-plans/{plan.id}",
        headers=auth(user),
        json={"dose": "2"},
    )

    assert response.status_code == 200
    assert response.json()["effective_from"] == "2026-05-10"


async def test_update_plan_rejects_explicit_null(client, db_session):
    """計畫 3 Task 3 的哨兵陷阱：`X | None = None` 讓「沒帶」跟「明確送 null」
    都通過型別檢查，沒有驗證器的話 null 會一路流到 setattr 撞上 NOT NULL。
    """
    user = await create_user(db_session)
    supplement = await create_supplement(db_session, created_by=user, owner=user)
    plan = await create_plan(db_session, user=user, supplement=supplement)

    response = await client.patch(
        f"/api/supplement-plans/{plan.id}",
        headers=auth(user),
        json={"dose": None},
    )

    assert response.status_code == 422


async def test_update_plan_requires_authentication(client, db_session):
    user = await create_user(db_session)
    supplement = await create_supplement(db_session, created_by=user, owner=user)
    plan = await create_plan(db_session, user=user, supplement=supplement)

    response = await client.patch(
        f"/api/supplement-plans/{plan.id}",
        json={"dose": "2"},
    )

    assert response.status_code == 401


async def test_update_plan_returns_409_when_new_period_overlaps_another_plan(
    client, db_session
):
    """關閉舊期間、開新期間的 INSERT 一樣受 EXCLUDE 約束保護：
    新期間往後延伸太多，撞上另一筆已經存在的計畫。這裡也要接
    IntegrityError 並 rollback（繼承規矩第 3 條），而且要驗證同一個
    session 之後還能正常用 —— 計畫 5 實測發現的「拿掉 rollback 全綠」
    那個坑，這裡也要防。
    """
    user = await create_user(db_session)
    supplement = await create_supplement(db_session, created_by=user, owner=user)
    plan_to_patch = await create_plan(
        db_session,
        user=user,
        supplement=supplement,
        time_of_day=TimeOfDay.MORNING,
        effective_from=date(2026, 1, 1),
        effective_to=date(2026, 6, 1),
    )
    await create_plan(
        db_session,
        user=user,
        supplement=supplement,
        time_of_day=TimeOfDay.MORNING,
        effective_from=date(2026, 8, 1),
        effective_to=None,
    )
    headers = auth(user)
    plan_id = plan_to_patch.id

    response = await client.patch(
        f"/api/supplement-plans/{plan_id}",
        headers=headers,
        json={"dose": "2", "effective_date": "2026-07-01"},
    )

    assert response.status_code == 409

    # rollback 是否必要要靠「同一個 session 之後還能用」驗證：漏掉的話
    # 這裡會拋 PendingRollbackError，而不是單純讓上面的斷言變紅。
    listing = (await client.get("/api/supplement-plans", headers=headers)).json()
    assert len(listing) == 2
    # 衝突的交易要整個復原，含 UPDATE 那一半 —— 舊列不能維持「已關閉」的
    # 半吊子狀態。
    unchanged = next(p for p in listing if p["id"] == plan_id)
    assert unchanged["effective_to"] == "2026-06-01"


# ---------------------------------------------------------------------------
# Task 7: DELETE /api/supplement-plans/{id}
# ---------------------------------------------------------------------------


async def test_delete_plan_deletes_own_plan(client, db_session):
    user = await create_user(db_session)
    supplement = await create_supplement(db_session, created_by=user, owner=user)
    plan = await create_plan(db_session, user=user, supplement=supplement)
    plan_id = plan.id

    response = await client.delete(f"/api/supplement-plans/{plan_id}", headers=auth(user))

    assert response.status_code == 204
    still_there = await db_session.get(SupplementPlan, plan_id)
    assert still_there is None


async def test_delete_plan_rejects_someone_elses_plan_and_leaves_it_intact(
    client, db_session
):
    """光看狀態碼不夠：計畫 3 Task 11 實測過「先刪除、再檢查擁有權」的
    實作狀態碼一樣是 404，要真的重查那一筆才能確認它還在。
    """
    alice = await create_user(db_session)
    bob = await create_user(db_session)
    supplement = await create_supplement(db_session, created_by=alice, owner=alice)
    plan = await create_plan(db_session, user=alice, supplement=supplement)
    plan_id = plan.id

    response = await client.delete(f"/api/supplement-plans/{plan_id}", headers=auth(bob))

    assert response.status_code == 404
    still_there = await db_session.get(SupplementPlan, plan_id)
    assert still_there is not None


async def test_delete_plan_returns_404_for_a_nonexistent_plan(client, db_session):
    user = await create_user(db_session)

    response = await client.delete("/api/supplement-plans/999999", headers=auth(user))

    assert response.status_code == 404


async def test_delete_plan_requires_authentication(client, db_session):
    user = await create_user(db_session)
    supplement = await create_supplement(db_session, created_by=user, owner=user)
    plan = await create_plan(db_session, user=user, supplement=supplement)

    response = await client.delete(f"/api/supplement-plans/{plan.id}")

    assert response.status_code == 401


async def test_delete_plan_orphans_its_intakes_instead_of_deleting_them(client, db_session):
    """`supplement_intakes.plan_id` 是 ON DELETE SET NULL：打卡紀錄是歷史，
    不能因為計畫被刪而消失，但它不再屬於任何計畫。這是資料庫層的行為，
    ORM 端的 identity map 不會自動知道 —— 必須 `refresh()` 之後才能看到
    真正的資料庫狀態，不能只看 Python 物件裡舊的快取值。
    """
    user = await create_user(db_session)
    supplement = await create_supplement(db_session, created_by=user, owner=user)
    plan = await create_plan(db_session, user=user, supplement=supplement)
    intake = await create_intake(
        db_session,
        user=user,
        supplement=supplement,
        plan=plan,
        dose=2,
        kcal=20,
        protein_g=4,
        fat_g=2,
        carb_g=1,
    )
    intake_id = intake.id
    plan_id = plan.id

    response = await client.delete(f"/api/supplement-plans/{plan_id}", headers=auth(user))

    assert response.status_code == 204

    await db_session.refresh(intake)
    refreshed = await db_session.get(SupplementIntake, intake_id)
    assert refreshed is not None
    assert refreshed.plan_id is None
    assert refreshed.dose == Decimal("2.00")
    assert refreshed.kcal == Decimal("20.00")
    assert refreshed.protein_g == Decimal("4.00")
    assert refreshed.fat_g == Decimal("2.00")
    assert refreshed.carb_g == Decimal("1.00")
