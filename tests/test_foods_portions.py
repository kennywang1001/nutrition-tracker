from app.models.user import UserRole
from app.security.tokens import create_token
from tests.factories import create_food, create_portion, create_user


def auth(user):
    return {"Authorization": f"Bearer {create_token(user.id, 'access')}"}


async def test_anyone_can_add_a_personal_portion_to_a_global_food(client, db_session):
    """「一碗」因人而異 —— 任何人都可以在任何食物上加自己的份量。"""
    admin = await create_user(db_session)
    user = await create_user(db_session)
    food = await create_food(db_session, created_by=admin)

    response = await client.post(
        f"/api/foods/{food.id}/portions",
        headers=auth(user),
        json={"label": "我的碗", "grams": "230"},
    )

    assert response.status_code == 201
    body = response.json()
    assert body["is_global"] is False
    assert body["grams"] == "230.00"


async def test_listing_portions_shows_global_and_own_but_not_others(client, db_session):
    admin = await create_user(db_session)
    alice = await create_user(db_session)
    bob = await create_user(db_session)
    food = await create_food(db_session, created_by=admin)
    await create_portion(db_session, food=food, label="1 碗", grams=200)
    await create_portion(db_session, food=food, label="愛麗絲的碗", grams=180, owner=alice)
    await create_portion(db_session, food=food, label="鮑伯的碗", grams=260, owner=bob)

    response = await client.get(f"/api/foods/{food.id}/portions", headers=auth(alice))

    labels = {item["label"] for item in response.json()}
    assert labels == {"1 碗", "愛麗絲的碗"}


async def test_a_normal_user_cannot_create_a_global_portion(client, db_session):
    admin = await create_user(db_session)
    user = await create_user(db_session)
    food = await create_food(db_session, created_by=admin)

    response = await client.post(
        f"/api/foods/{food.id}/portions",
        headers=auth(user),
        json={"label": "1 碗", "grams": "200", "is_global": True},
    )

    assert response.status_code == 403
    assert response.json()["error"]["code"] == "FORBIDDEN"


async def test_an_admin_can_create_a_global_portion(client, db_session):
    admin = await create_user(db_session, role=UserRole.ADMIN)
    food = await create_food(db_session, created_by=admin)

    response = await client.post(
        f"/api/foods/{food.id}/portions",
        headers=auth(admin),
        json={"label": "1 碗", "grams": "200", "is_global": True},
    )

    assert response.status_code == 201
    assert response.json()["is_global"] is True


async def test_duplicate_label_for_the_same_owner_is_rejected(client, db_session):
    admin = await create_user(db_session)
    user = await create_user(db_session)
    food = await create_food(db_session, created_by=admin)
    await create_portion(db_session, food=food, label="我的碗", owner=user)

    response = await client.post(
        f"/api/foods/{food.id}/portions",
        headers=auth(user),
        json={"label": "我的碗", "grams": "999"},
    )

    assert response.status_code == 409
    assert response.json()["error"]["code"] == "PORTION_EXISTS"


async def test_two_users_can_use_the_same_label(client, db_session):
    admin = await create_user(db_session)
    alice = await create_user(db_session)
    bob = await create_user(db_session)
    food = await create_food(db_session, created_by=admin)
    await create_portion(db_session, food=food, label="1 碗", owner=alice)

    response = await client.post(
        f"/api/foods/{food.id}/portions",
        headers=auth(bob),
        json={"label": "1 碗", "grams": "260"},
    )

    assert response.status_code == 201


async def test_adding_a_portion_to_another_users_food_returns_404(client, db_session):
    alice = await create_user(db_session)
    bob = await create_user(db_session)
    food = await create_food(db_session, created_by=alice, owner=alice)

    response = await client.post(
        f"/api/foods/{food.id}/portions",
        headers=auth(bob),
        json={"label": "1 碗", "grams": "200"},
    )

    assert response.status_code == 404


async def test_grams_must_be_positive(client, db_session):
    admin = await create_user(db_session)
    user = await create_user(db_session)
    food = await create_food(db_session, created_by=admin)

    response = await client.post(
        f"/api/foods/{food.id}/portions",
        headers=auth(user),
        json={"label": "空碗", "grams": "0"},
    )

    assert response.status_code == 422
