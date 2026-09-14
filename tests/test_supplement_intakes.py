from decimal import Decimal

from app.models.supplement import SupplementIntake
from app.security.tokens import create_access_token
from tests.factories import create_intake, create_plan, create_supplement, create_user


def auth(user):
    return {"Authorization": f"Bearer {create_access_token(user.id)}"}


# ---------------------------------------------------------------------------
# Task 8: POST /api/supplement-intakes —— 快照（決定 1 + 決定 3）
# ---------------------------------------------------------------------------


async def test_create_intake_with_a_plan_returns_the_intake(client, db_session):
    user = await create_user(db_session)
    supplement = await create_supplement(
        db_session, created_by=user, owner=user, kcal=50, protein_g=5, fat_g=2, carb_g=3
    )
    plan = await create_plan(db_session, user=user, supplement=supplement)

    response = await client.post(
        "/api/supplement-intakes",
        headers=auth(user),
        json={
            "supplement_id": supplement.id,
            "plan_id": plan.id,
            "dose": "2",
            "taken_at": "2026-01-01T08:00:00Z",
        },
    )

    assert response.status_code == 201
    body = response.json()
    assert body["supplement_id"] == supplement.id
    assert body["plan_id"] == plan.id
    assert body["dose"] == "2.00"
    assert body["kcal"] == "100.00"
    assert body["protein_g"] == "10.00"
    assert body["fat_g"] == "4.00"
    assert body["carb_g"] == "6.00"


async def test_create_intake_without_a_plan_records_an_ad_hoc_intake(client, db_session):
    user = await create_user(db_session)
    supplement = await create_supplement(db_session, created_by=user, owner=user)

    response = await client.post(
        "/api/supplement-intakes",
        headers=auth(user),
        json={"supplement_id": supplement.id, "dose": "1", "taken_at": "2026-01-01T08:00:00Z"},
    )

    assert response.status_code == 201
    assert response.json()["plan_id"] is None


async def test_create_intake_snapshot_multiplies_serving_by_dose(client, db_session):
    """決定 1 的直接驗證：kcal_total = supplement.kcal * dose，用非整數的
    dose（1.5）確保這不是巧合的整數相乘。
    """
    user = await create_user(db_session)
    supplement = await create_supplement(
        db_session, created_by=user, owner=user, kcal=120, protein_g=20, fat_g=3, carb_g=5
    )

    response = await client.post(
        "/api/supplement-intakes",
        headers=auth(user),
        json={"supplement_id": supplement.id, "dose": "1.5", "taken_at": "2026-01-01T08:00:00Z"},
    )

    assert response.status_code == 201
    body = response.json()
    assert body["kcal"] == "180.00"
    assert body["protein_g"] == "30.00"
    assert body["fat_g"] == "4.50"
    assert body["carb_g"] == "7.50"


async def test_create_intake_rejects_a_supplement_i_cannot_see(client, db_session):
    alice = await create_user(db_session)
    bob = await create_user(db_session)
    alices_supplement = await create_supplement(db_session, created_by=alice, owner=alice)

    response = await client.post(
        "/api/supplement-intakes",
        headers=auth(bob),
        json={
            "supplement_id": alices_supplement.id,
            "dose": "1",
            "taken_at": "2026-01-01T08:00:00Z",
        },
    )

    assert response.status_code == 404


async def test_create_intake_rejects_someone_elses_plan(client, db_session):
    """補劑用全域的：讓 bob 看得到補劑本身，這樣失敗的原因只能是計畫的擁有權檢查，
    不是被補劑可見性先擋下來（避免兩個過濾器互相掩護，計畫 3 Task 17 的教訓）。
    """
    alice = await create_user(db_session)
    bob = await create_user(db_session)
    supplement = await create_supplement(db_session, created_by=alice)
    alices_plan = await create_plan(db_session, user=alice, supplement=supplement)

    response = await client.post(
        "/api/supplement-intakes",
        headers=auth(bob),
        json={
            "supplement_id": supplement.id,
            "plan_id": alices_plan.id,
            "dose": "1",
            "taken_at": "2026-01-01T08:00:00Z",
        },
    )

    assert response.status_code == 404


async def test_create_intake_rejects_a_plan_for_a_different_supplement(client, db_session):
    user = await create_user(db_session)
    supplement_a = await create_supplement(db_session, created_by=user, owner=user, name="補劑A")
    supplement_b = await create_supplement(db_session, created_by=user, owner=user, name="補劑B")
    plan_for_a = await create_plan(db_session, user=user, supplement=supplement_a)

    response = await client.post(
        "/api/supplement-intakes",
        headers=auth(user),
        json={
            "supplement_id": supplement_b.id,
            "plan_id": plan_for_a.id,
            "dose": "1",
            "taken_at": "2026-01-01T08:00:00Z",
        },
    )

    assert response.status_code == 422


async def test_create_intake_rejects_non_positive_dose(client, db_session):
    user = await create_user(db_session)
    supplement = await create_supplement(db_session, created_by=user, owner=user)

    response = await client.post(
        "/api/supplement-intakes",
        headers=auth(user),
        json={"supplement_id": supplement.id, "dose": "0", "taken_at": "2026-01-01T08:00:00Z"},
    )

    assert response.status_code == 422


async def test_create_intake_requires_authentication(client, db_session):
    user = await create_user(db_session)
    supplement = await create_supplement(db_session, created_by=user, owner=user)

    response = await client.post(
        "/api/supplement-intakes",
        json={"supplement_id": supplement.id, "dose": "1", "taken_at": "2026-01-01T08:00:00Z"},
    )

    assert response.status_code == 401


async def test_changing_a_supplements_kcal_does_not_change_an_already_recorded_intake(
    client, db_session
):
    """凍結歷史：陷阱 1 第三次出現，形狀跟計畫 2（revision 指標）、計畫 3
    （quantity_g）一樣：寫入 -> 改來源 -> 重讀 -> 數值必須不動。

    P1 沒有編輯補劑的端點（規格第 7.5 節只有 GET 與 POST），所以「改來源」
    直接改資料庫的補劑列 —— 跟計畫 3 測 quantity_g 的 portion 測試同一招。
    """
    user = await create_user(db_session)
    supplement = await create_supplement(
        db_session, created_by=user, owner=user, kcal=50, protein_g=5, fat_g=2, carb_g=3
    )

    response = await client.post(
        "/api/supplement-intakes",
        headers=auth(user),
        json={
            "supplement_id": supplement.id,
            "dose": "2",
            "taken_at": "2026-01-01T08:00:00Z",
        },
    )
    assert response.status_code == 201
    body = response.json()
    intake_id = body["id"]
    assert body["kcal"] == "100.00"

    # 直接改資料庫的補劑列，模擬「補劑主檔被改」——供應商換了配方、或使用者
    # 自己發現印錯了。這個改動之後不能連動到已經打卡的歷史紀錄。
    supplement.kcal = Decimal("9999")
    supplement.protein_g = Decimal("9999")
    supplement.fat_g = Decimal("9999")
    supplement.carb_g = Decimal("9999")
    await db_session.commit()

    # 強制丟掉 identity map 的快取，確保下面查到的是資料庫裡真正的值
    # （同 test_meals_create.py 的凍結測試）。
    db_session.expire_all()

    reloaded = await db_session.get(SupplementIntake, intake_id)
    assert reloaded is not None
    assert reloaded.kcal == Decimal("100.00")
    assert reloaded.protein_g == Decimal("10.00")
    assert reloaded.fat_g == Decimal("4.00")
    assert reloaded.carb_g == Decimal("6.00")


# ---------------------------------------------------------------------------
# Task 9: DELETE /api/supplement-intakes/{id}
# ---------------------------------------------------------------------------


async def test_delete_intake_deletes_own_intake(client, db_session):
    user = await create_user(db_session)
    supplement = await create_supplement(db_session, created_by=user, owner=user)
    intake = await create_intake(db_session, user=user, supplement=supplement)
    intake_id = intake.id

    response = await client.delete(f"/api/supplement-intakes/{intake_id}", headers=auth(user))

    assert response.status_code == 204
    still_there = await db_session.get(SupplementIntake, intake_id)
    assert still_there is None


async def test_delete_intake_rejects_someone_elses_intake_and_leaves_it_intact(
    client, db_session
):
    """光看狀態碼不夠：先刪除、再檢查擁有權的實作狀態碼一樣是 404
    （計畫 3 Task 11、本計畫 Task 7 都實測過這個坑），要真的重查那一筆
    才能確認它還在。
    """
    alice = await create_user(db_session)
    bob = await create_user(db_session)
    supplement = await create_supplement(db_session, created_by=alice, owner=alice)
    intake = await create_intake(db_session, user=alice, supplement=supplement)
    intake_id = intake.id

    response = await client.delete(f"/api/supplement-intakes/{intake_id}", headers=auth(bob))

    assert response.status_code == 404
    still_there = await db_session.get(SupplementIntake, intake_id)
    assert still_there is not None


async def test_delete_intake_returns_404_for_a_nonexistent_intake(client, db_session):
    user = await create_user(db_session)

    response = await client.delete("/api/supplement-intakes/999999", headers=auth(user))

    assert response.status_code == 404


async def test_delete_intake_requires_authentication(client, db_session):
    user = await create_user(db_session)
    supplement = await create_supplement(db_session, created_by=user, owner=user)
    intake = await create_intake(db_session, user=user, supplement=supplement)

    response = await client.delete(f"/api/supplement-intakes/{intake.id}")

    assert response.status_code == 401
