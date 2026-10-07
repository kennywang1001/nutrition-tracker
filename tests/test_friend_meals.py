import re
from datetime import datetime
from pathlib import Path

import pytest
from PIL import Image

from app.models.food import FoodRevision
from app.models.friendship import FriendshipStatus
from app.security.tokens import create_access_token
from app.storage.photos import save_photo
from tests.factories import (
    create_expense,
    create_food,
    create_friendship,
    create_meal,
    create_plan,
    create_supplement,
    create_target,
    create_user,
)


def auth(user):
    return {"Authorization": f"Bearer {create_access_token(user.id)}"}


def _jpeg() -> bytes:
    import io

    buffer = io.BytesIO()
    Image.new("RGB", (40, 30), color=(200, 100, 50)).save(buffer, format="JPEG")
    return buffer.getvalue()


@pytest.fixture
async def pals(db_session):
    """愛麗絲與鮑伯是好友。食物刻意用愛麗絲的**私人**食物：好友看得到她吃了
    什麼（名字），但私人食物的 id 不能外流。"""
    alice = await create_user(db_session, display_name="愛麗絲")
    bob = await create_user(db_session, display_name="鮑伯")
    await create_friendship(db_session, alice, bob)
    food = await create_food(db_session, created_by=alice, owner=alice, name="愛麗絲的私房菜")
    revision = await db_session.get(FoodRevision, food.current_revision_id)
    assert revision is not None
    return alice, bob, food, revision


async def _meal(db_session, user, revision, *, at: str, private: bool = False, **extra):
    meal = await create_meal(
        db_session,
        user=user,
        eaten_at=datetime.fromisoformat(at),
        items=[(revision, 150)],
        **extra,
    )
    if private:
        meal.is_private = True
        await db_session.commit()
    return meal


# ---------- 看得到 ----------


async def test_a_friends_shared_meal_shows_in_the_feed_with_only_the_whitelisted_fields(
    client, db_session, pals
):
    alice, bob, food, revision = pals
    photo = save_photo(_jpeg(), user_id=alice.id)
    meal = await _meal(
        db_session,
        alice,
        revision,
        at="2026-10-06T04:00:00+00:00",
        note="今天心情很差",
        photo_path=photo,
    )
    await create_expense(db_session, user=alice, amount=180, meal=meal)

    response = await client.get("/api/friends/feed", headers=auth(bob))

    assert response.status_code == 200
    body = response.json()
    assert body["next_cursor"] is None
    [shared] = body["meals"]
    assert shared["id"] == meal.id
    assert shared["user"] == {"id": alice.id, "display_name": "愛麗絲"}
    assert shared["has_photo"] is True
    assert [item["food_name"] for item in shared["items"]] == ["愛麗絲的私房菜"]
    assert set(shared) == {
        "id", "user", "eaten_at", "meal_type", "items",
        "kcal", "protein_g", "fat_g", "carb_g", "has_photo",
    }
    assert set(shared["items"][0]) == {"food_name", "quantity_g", "kcal"}
    # 測試資料裡真的有餐費、備註、照片路徑、私人食物——上面的白名單比對才不是空轉；
    # 再用文字確認一次備註與照片路徑沒有從別的欄位漏出去。
    assert "今天心情很差" not in response.text
    assert photo not in response.text
    assert "food_id" not in response.text


async def test_a_friends_day_uses_the_friends_timezone(client, db_session, pals):
    alice, bob, _, revision = pals
    alice.timezone = "America/New_York"
    await db_session.commit()
    # 紐約 10/5 晚上 11 點＝UTC 10/6 03:00；台北看來是 10/6，但對愛麗絲是 10/5。
    late = await _meal(db_session, alice, revision, at="2026-10-06T03:00:00+00:00")
    next_day = await _meal(db_session, alice, revision, at="2026-10-06T05:00:00+00:00")

    oct5 = await client.get(
        f"/api/friends/{alice.id}/meals", headers=auth(bob), params={"date": "2026-10-05"}
    )
    oct6 = await client.get(
        f"/api/friends/{alice.id}/meals", headers=auth(bob), params={"date": "2026-10-06"}
    )

    assert oct5.status_code == 200
    assert oct5.json()["friend"] == {"id": alice.id, "display_name": "愛麗絲"}
    assert oct5.json()["day"] == "2026-10-05"
    assert [m["id"] for m in oct5.json()["meals"]] == [late.id]
    assert [m["id"] for m in oct6.json()["meals"]] == [next_day.id]


async def test_a_friends_photo(client, db_session, pals):
    alice, bob, _, revision = pals
    meal = await _meal(
        db_session,
        alice,
        revision,
        at="2026-10-06T04:00:00+00:00",
        photo_path=save_photo(_jpeg(), user_id=alice.id),
    )

    response = await client.get(
        f"/api/friends/{alice.id}/meals/{meal.id}/photo", headers=auth(bob)
    )

    assert response.status_code == 200
    assert response.headers["content-type"] == "image/jpeg"


# ---------- 看不到 ----------


async def test_a_private_meal_is_invisible_everywhere(client, db_session, pals):
    alice, bob, _, revision = pals
    hidden = await _meal(
        db_session,
        alice,
        revision,
        at="2026-10-06T04:00:00+00:00",
        private=True,
        photo_path=save_photo(_jpeg(), user_id=alice.id),
    )
    shared = await _meal(db_session, alice, revision, at="2026-10-06T06:00:00+00:00")

    feed = await client.get("/api/friends/feed", headers=auth(bob))
    day = await client.get(
        f"/api/friends/{alice.id}/meals", headers=auth(bob), params={"date": "2026-10-06"}
    )
    photo = await client.get(
        f"/api/friends/{alice.id}/meals/{hidden.id}/photo", headers=auth(bob)
    )

    assert [m["id"] for m in feed.json()["meals"]] == [shared.id]
    assert [m["id"] for m in day.json()["meals"]] == [shared.id]
    assert photo.status_code == 404
    assert photo.json()["error"]["code"] == "MEAL_NOT_FOUND"


async def test_a_pending_request_shows_nothing(client, db_session):
    alice = await create_user(db_session)
    bob = await create_user(db_session)
    await create_friendship(
        db_session, alice, bob, status=FriendshipStatus.PENDING, requested_by=bob
    )
    await create_meal(db_session, user=alice)

    feed = await client.get("/api/friends/feed", headers=auth(bob))
    day = await client.get(f"/api/friends/{alice.id}/meals", headers=auth(bob))

    assert feed.json() == {"meals": [], "next_cursor": None}
    assert day.status_code == 404
    assert day.json()["error"]["code"] == "FRIEND_NOT_FOUND"


async def test_unfriending_hides_everything_again(client, db_session, pals):
    alice, bob, _, revision = pals
    meal = await _meal(
        db_session,
        alice,
        revision,
        at="2026-10-06T04:00:00+00:00",
        photo_path=save_photo(_jpeg(), user_id=alice.id),
    )
    before = await client.get("/api/friends/feed", headers=auth(bob))
    assert [m["id"] for m in before.json()["meals"]] == [meal.id]

    await client.delete(f"/api/friends/{alice.id}", headers=auth(bob))
    feed = await client.get("/api/friends/feed", headers=auth(bob))
    day = await client.get(f"/api/friends/{alice.id}/meals", headers=auth(bob))
    photo = await client.get(
        f"/api/friends/{alice.id}/meals/{meal.id}/photo", headers=auth(bob)
    )

    assert feed.json()["meals"] == []
    assert day.status_code == 404
    assert photo.status_code == 404


async def test_strangers_see_nothing(client, db_session, pals):
    alice, _, _, revision = pals
    stranger = await create_user(db_session)
    meal = await _meal(
        db_session,
        alice,
        revision,
        at="2026-10-06T04:00:00+00:00",
        photo_path=save_photo(_jpeg(), user_id=alice.id),
    )

    feed = await client.get("/api/friends/feed", headers=auth(stranger))
    day = await client.get(f"/api/friends/{alice.id}/meals", headers=auth(stranger))
    photo = await client.get(
        f"/api/friends/{alice.id}/meals/{meal.id}/photo", headers=auth(stranger)
    )

    assert feed.json()["meals"] == []
    assert day.status_code == 404
    assert photo.status_code == 404


async def test_my_own_meals_are_not_in_my_feed(client, db_session, pals):
    alice, bob, _, revision = pals
    await _meal(db_session, bob, revision, at="2026-10-06T04:00:00+00:00")

    response = await client.get("/api/friends/feed", headers=auth(bob))

    assert response.json()["meals"] == []


async def test_the_photo_needs_the_friend_and_the_meal_to_match(client, db_session, pals):
    """愛麗絲的 id 配卡蘿（也是鮑伯的好友）的餐 → 404。"""
    alice, bob, _, revision = pals
    carol = await create_user(db_session)
    await create_friendship(db_session, bob, carol)
    carols_meal = await _meal(
        db_session,
        carol,
        revision,
        at="2026-10-06T04:00:00+00:00",
        photo_path=save_photo(_jpeg(), user_id=carol.id),
    )

    response = await client.get(
        f"/api/friends/{alice.id}/meals/{carols_meal.id}/photo", headers=auth(bob)
    )

    assert response.status_code == 404
    assert response.json()["error"]["code"] == "MEAL_NOT_FOUND"


# ---------- 分頁 ----------


async def test_paging_with_equal_times_neither_repeats_nor_skips(client, db_session, pals):
    alice, bob, _, revision = pals
    same_time = "2026-10-06T04:00:00+00:00"
    meals = [await _meal(db_session, alice, revision, at=same_time) for _ in range(3)]
    older = await _meal(db_session, alice, revision, at="2026-10-05T04:00:00+00:00")

    first = await client.get("/api/friends/feed", headers=auth(bob), params={"limit": 2})
    second = await client.get(
        "/api/friends/feed",
        headers=auth(bob),
        params={"limit": 2, "before": first.json()["next_cursor"]},
    )

    first_ids = [m["id"] for m in first.json()["meals"]]
    second_ids = [m["id"] for m in second.json()["meals"]]
    expected = sorted((m.id for m in meals), reverse=True) + [older.id]
    assert first_ids + second_ids == expected
    assert second.json()["next_cursor"] is None


@pytest.mark.parametrize("limit", [0, 51])
async def test_the_page_size_is_bounded(client, db_session, pals, limit):
    _, bob, _, _ = pals

    response = await client.get("/api/friends/feed", headers=auth(bob), params={"limit": limit})

    assert response.status_code == 422


async def test_a_garbled_cursor_is_422(client, db_session, pals):
    _, bob, _, _ = pals

    response = await client.get(
        "/api/friends/feed", headers=auth(bob), params={"before": "not-a-cursor"}
    )

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "INVALID_CURSOR"


# ---------- 隔離不變：在兩人「是好友」的狀態下，既有端點照樣 404 ----------


async def test_being_friends_does_not_open_any_existing_endpoint(client, db_session, pals):
    alice, bob, food, revision = pals
    meal = await _meal(
        db_session,
        alice,
        revision,
        at="2026-10-06T04:00:00+00:00",
        photo_path=save_photo(_jpeg(), user_id=alice.id),
    )
    expense = await create_expense(db_session, user=alice, amount=99)
    target = await create_target(db_session, user=alice)
    supplement = await create_supplement(db_session, created_by=alice, owner=alice)
    plan = await create_plan(db_session, user=alice, supplement=supplement)

    responses = [
        await client.get(f"/api/meals/{meal.id}", headers=auth(bob)),
        await client.get(f"/api/meals/{meal.id}/photo", headers=auth(bob)),
        await client.get(f"/api/foods/{food.id}", headers=auth(bob)),
        await client.patch(f"/api/expenses/{expense.id}", headers=auth(bob), json={"amount": "1"}),
        await client.patch(f"/api/targets/{target.id}", headers=auth(bob), json={"kcal": "1"}),
        await client.patch(
            f"/api/supplement-plans/{plan.id}", headers=auth(bob), json={"dose": "1"}
        ),
    ]

    assert [r.status_code for r in responses] == [404] * len(responses)


# ---------- 掃描 ----------


def test_only_the_friend_modules_touch_the_friendship_table():
    """規格 §1.2：好友的讀取只有一個入口。其他模組碰到 Friendship，就是有人把
    「我或我的好友」塞進了既有端點——那正是 38 條隔離測試抓不到的失敗模式。"""
    root = Path(__file__).resolve().parent.parent / "app"
    allowed = {
        root / "models" / "friendship.py",
        root / "models" / "__init__.py",
        root / "friend_visibility.py",
        root / "api" / "routes" / "friends.py",
    }
    pattern = re.compile(r"\bFriendship\b|\bfriendships\b")
    offenders = [
        str(path.relative_to(root))
        for path in root.rglob("*.py")
        if path not in allowed and pattern.search(path.read_text(encoding="utf-8"))
    ]
    assert offenders == []
