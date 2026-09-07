from app.models.user import UserRole
from app.security.tokens import create_token
from tests.factories import create_food, create_pending_revision, create_user


def auth(user):
    return {"Authorization": f"Bearer {create_token(user.id, 'access')}"}


async def test_admin_sees_the_pending_queue(client, db_session):
    admin = await create_user(db_session, role=UserRole.ADMIN)
    user = await create_user(db_session)
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
