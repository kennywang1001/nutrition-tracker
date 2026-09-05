from app.security.tokens import create_token
from tests.factories import create_food, create_pending_revision, create_user


def auth(user):
    return {"Authorization": f"Bearer {create_token(user.id, 'access')}"}


async def test_revision_history_lists_all_versions_newest_first(client, db_session):
    admin = await create_user(db_session)
    user = await create_user(db_session)
    food = await create_food(db_session, created_by=admin, kcal=70)
    await create_pending_revision(db_session, food=food, created_by=user, kcal=75)

    response = await client.get(f"/api/foods/{food.id}/revisions", headers=auth(user))

    assert response.status_code == 200
    body = response.json()
    assert len(body) == 2
    assert body[0]["kcal"] == "75.00"
    assert body[0]["status"] == "pending"
    assert body[1]["status"] == "approved"
    assert body[1]["is_current"] is True
    assert body[0]["is_current"] is False


async def test_revision_history_of_another_users_food_returns_404(client, db_session):
    alice = await create_user(db_session)
    bob = await create_user(db_session)
    food = await create_food(db_session, created_by=alice, owner=alice)

    response = await client.get(f"/api/foods/{food.id}/revisions", headers=auth(bob))

    assert response.status_code == 404


async def test_revision_history_requires_authentication(client, db_session):
    admin = await create_user(db_session)
    food = await create_food(db_session, created_by=admin)

    response = await client.get(f"/api/foods/{food.id}/revisions")

    assert response.status_code == 401
