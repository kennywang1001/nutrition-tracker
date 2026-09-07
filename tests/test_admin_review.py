from app.models.user import UserRole
from app.security.tokens import create_token
from tests.factories import create_food, create_pending_revision, create_user


def auth(user):
    return {"Authorization": f"Bearer {create_token(user.id, 'access')}"}


async def test_approving_moves_the_pointer_and_changes_what_users_see(client, db_session):
    admin = await create_user(db_session, role=UserRole.ADMIN)
    user = await create_user(db_session)
    food = await create_food(db_session, created_by=admin, kcal=70)
    revision = await create_pending_revision(db_session, food=food, created_by=user, kcal=75)

    response = await client.post(
        f"/api/admin/food-revisions/{revision.id}/approve", headers=auth(admin)
    )

    assert response.status_code == 200
    assert response.json()["status"] == "approved"
    assert response.json()["reviewed_by"] == admin.id

    read = await client.get(f"/api/foods/{food.id}", headers=auth(user))
    assert read.json()["nutrition"]["kcal"] == "75.00"


async def test_approving_does_not_change_history(client, db_session):
    """核准新版本之後，舊版本仍然在歷史裡，而且數值沒有被改動。"""
    admin = await create_user(db_session, role=UserRole.ADMIN)
    user = await create_user(db_session)
    food = await create_food(db_session, created_by=admin, kcal=70)
    revision = await create_pending_revision(db_session, food=food, created_by=user, kcal=75)

    await client.post(f"/api/admin/food-revisions/{revision.id}/approve", headers=auth(admin))

    history = await client.get(f"/api/foods/{food.id}/revisions", headers=auth(user))
    values = {item["kcal"] for item in history.json()}
    assert values == {"70.00", "75.00"}


async def test_a_normal_user_cannot_approve(client, db_session):
    admin = await create_user(db_session, role=UserRole.ADMIN)
    user = await create_user(db_session)
    food = await create_food(db_session, created_by=admin)
    revision = await create_pending_revision(db_session, food=food, created_by=user)

    response = await client.post(
        f"/api/admin/food-revisions/{revision.id}/approve", headers=auth(user)
    )

    assert response.status_code == 403


async def test_approving_an_already_reviewed_revision_returns_409(client, db_session):
    admin = await create_user(db_session, role=UserRole.ADMIN)
    user = await create_user(db_session)
    food = await create_food(db_session, created_by=admin)
    revision = await create_pending_revision(db_session, food=food, created_by=user)

    await client.post(f"/api/admin/food-revisions/{revision.id}/approve", headers=auth(admin))
    again = await client.post(
        f"/api/admin/food-revisions/{revision.id}/approve", headers=auth(admin)
    )

    assert again.status_code == 409
    assert again.json()["error"]["code"] == "REVISION_NOT_PENDING"


async def test_approving_a_nonexistent_revision_returns_404(client, db_session):
    admin = await create_user(db_session, role=UserRole.ADMIN)

    response = await client.post(
        "/api/admin/food-revisions/999999/approve", headers=auth(admin)
    )

    assert response.status_code == 404


async def test_approving_frees_the_slot_for_a_new_pending_edit(client, db_session):
    """核准之後，同一個食物才能再接受新的待審編輯。"""
    admin = await create_user(db_session, role=UserRole.ADMIN)
    user = await create_user(db_session)
    food = await create_food(db_session, created_by=admin)
    revision = await create_pending_revision(db_session, food=food, created_by=user)

    await client.post(f"/api/admin/food-revisions/{revision.id}/approve", headers=auth(admin))

    response = await client.post(
        f"/api/foods/{food.id}/revisions",
        headers=auth(user),
        json={"nutrition": {"kcal": "1", "protein_g": "1", "fat_g": "1", "carb_g": "1"}},
    )

    assert response.status_code == 201


async def test_admin_sees_the_pending_queue(client, db_session):
    admin = await create_user(db_session, role=UserRole.ADMIN)
    user = await create_user(db_session, display_name="提案的人")
    food = await create_food(db_session, created_by=admin, name="7-11 茶葉蛋", kcal=70)
    revision = await create_pending_revision(
        db_session, food=food, created_by=user, kcal=75, change_note="標示改了"
    )

    response = await client.get("/api/admin/food-revisions", headers=auth(admin))

    assert response.status_code == 200
    body = response.json()
    assert len(body) == 1
    assert body[0]["id"] == revision.id
    assert body[0]["food_name"] == "7-11 茶葉蛋"
    assert body[0]["change_note"] == "標示改了"
    assert body[0]["kcal"] == "75.00"
    # 審核者需要看到「現在是多少」才能判斷這個提案合不合理
    assert body[0]["current_kcal"] == "70.00"
    assert body[0]["created_by_name"] == "提案的人"


async def test_the_queue_shows_the_proposers_name_not_the_food_creators(client, db_session):
    """全域食物的建立者與提案者通常不同人 —— join 錯欄位也會產生看起來合理的名字。"""
    creator = await create_user(db_session, display_name="建立者")
    proposer = await create_user(db_session, display_name="提案者")
    admin = await create_user(db_session, role=UserRole.ADMIN)
    food = await create_food(db_session, created_by=creator)
    await create_pending_revision(db_session, food=food, created_by=proposer)

    response = await client.get("/api/admin/food-revisions", headers=auth(admin))

    assert response.json()[0]["created_by_name"] == "提案者"
    assert response.json()[0]["created_by"] == proposer.id


async def test_a_normal_user_cannot_see_the_queue(client, db_session):
    user = await create_user(db_session)

    response = await client.get("/api/admin/food-revisions", headers=auth(user))

    assert response.status_code == 403
    assert response.json()["error"]["code"] == "FORBIDDEN"


async def test_the_queue_requires_authentication(client):
    response = await client.get("/api/admin/food-revisions")

    assert response.status_code == 401


async def test_the_queue_only_contains_pending_revisions(client, db_session):
    admin = await create_user(db_session, role=UserRole.ADMIN)
    user = await create_user(db_session)
    # create_food 產生的第一版是 approved，不該出現在佇列裡
    food = await create_food(db_session, created_by=admin)
    await create_pending_revision(db_session, food=food, created_by=user)

    response = await client.get("/api/admin/food-revisions", headers=auth(admin))

    assert len(response.json()) == 1
    assert response.json()[0]["status"] == "pending"


async def test_rejecting_records_the_reason_and_leaves_the_pointer_alone(client, db_session):
    admin = await create_user(db_session, role=UserRole.ADMIN)
    user = await create_user(db_session)
    food = await create_food(db_session, created_by=admin, kcal=70)
    revision = await create_pending_revision(db_session, food=food, created_by=user, kcal=700)

    response = await client.post(
        f"/api/admin/food-revisions/{revision.id}/reject",
        headers=auth(admin),
        json={"reason": "熱量對不上三大營養素"},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "rejected"
    assert body["reject_reason"] == "熱量對不上三大營養素"
    assert body["is_current"] is False

    read = await client.get(f"/api/foods/{food.id}", headers=auth(user))
    assert read.json()["nutrition"]["kcal"] == "70.00"


async def test_rejecting_requires_a_reason(client, db_session):
    admin = await create_user(db_session, role=UserRole.ADMIN)
    user = await create_user(db_session)
    food = await create_food(db_session, created_by=admin)
    revision = await create_pending_revision(db_session, food=food, created_by=user)

    response = await client.post(
        f"/api/admin/food-revisions/{revision.id}/reject",
        headers=auth(admin),
        json={"reason": ""},
    )

    assert response.status_code == 422


async def test_a_normal_user_cannot_reject(client, db_session):
    admin = await create_user(db_session, role=UserRole.ADMIN)
    user = await create_user(db_session)
    food = await create_food(db_session, created_by=admin)
    revision = await create_pending_revision(db_session, food=food, created_by=user)

    response = await client.post(
        f"/api/admin/food-revisions/{revision.id}/reject",
        headers=auth(user),
        json={"reason": "不行"},
    )

    assert response.status_code == 403


async def test_rejecting_frees_the_slot_for_a_new_pending_edit(client, db_session):
    admin = await create_user(db_session, role=UserRole.ADMIN)
    user = await create_user(db_session)
    food = await create_food(db_session, created_by=admin)
    revision = await create_pending_revision(db_session, food=food, created_by=user)

    await client.post(
        f"/api/admin/food-revisions/{revision.id}/reject",
        headers=auth(admin),
        json={"reason": "數值不對"},
    )

    response = await client.post(
        f"/api/foods/{food.id}/revisions",
        headers=auth(user),
        json={"nutrition": {"kcal": "1", "protein_g": "1", "fat_g": "1", "carb_g": "1"}},
    )

    assert response.status_code == 201


async def test_the_rejected_revision_stays_in_the_history(client, db_session):
    """駁回不是刪除 —— 誰提了什麼、為什麼被拒，都要留著。"""
    admin = await create_user(db_session, role=UserRole.ADMIN)
    user = await create_user(db_session)
    food = await create_food(db_session, created_by=admin)
    revision = await create_pending_revision(db_session, food=food, created_by=user)

    await client.post(
        f"/api/admin/food-revisions/{revision.id}/reject",
        headers=auth(admin),
        json={"reason": "數值不對"},
    )

    history = await client.get(f"/api/foods/{food.id}/revisions", headers=auth(user))
    rejected = [r for r in history.json() if r["id"] == revision.id]
    assert len(rejected) == 1
    assert rejected[0]["reject_reason"] == "數值不對"
