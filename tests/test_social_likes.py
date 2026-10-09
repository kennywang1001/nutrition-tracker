"""`PUT`／`DELETE /api/social/meals/{id}/like`（社群規格 §5.2）與卡片上的數字（§5.6）。"""

import io
from datetime import datetime

import pytest
from PIL import Image
from sqlalchemy import delete, select

from app.models.meal import Meal, MealItem
from app.models.social import MealLike, Notification, NotificationType
from app.ratelimit import LIKE_LIMIT
from tests.factories import create_comment, create_friendship, create_like, create_meal
from tests.social_helpers import MISSING, auth, make_cast, unfriend


@pytest.fixture
async def cast(db_session):
    return await make_cast(db_session)


def _url(meal_id) -> str:
    return f"/api/social/meals/{meal_id}/like"


async def _likers(db_session, meal) -> list[int]:
    rows = await db_session.scalars(
        select(MealLike.user_id).where(MealLike.meal_id == meal.id).order_by(MealLike.id)
    )
    return list(rows)


async def test_like_then_take_it_back(client, db_session, cast):
    first = await client.put(_url(cast.meal.id), headers=auth(cast.bob))
    second = await client.put(_url(cast.meal.id), headers=auth(cast.carol))

    assert first.status_code == 200
    assert first.json() == {"like_count": 1, "liked_by_me": True}
    assert second.json() == {"like_count": 2, "liked_by_me": True}

    gone = await client.delete(_url(cast.meal.id), headers=auth(cast.bob))

    assert gone.status_code == 200
    assert gone.json() == {"like_count": 1, "liked_by_me": False}
    # 刪的是「我的」那一列，不是這一餐全部的讚。
    assert await _likers(db_session, cast.meal) == [cast.carol.id]


async def test_a_like_lands_on_that_meal_only(client, db_session, cast):
    other = await create_meal(db_session, user=cast.alice, items=[(cast.revision, 100)])
    await create_like(db_session, meal=other, user=cast.bob)

    liked = await client.put(_url(cast.meal.id), headers=auth(cast.bob))
    assert liked.json() == {"like_count": 1, "liked_by_me": True}
    assert await _likers(db_session, other) == [cast.bob.id]

    # 收回的也只是這一餐的：另一餐那一個還在。
    await client.delete(_url(cast.meal.id), headers=auth(cast.bob))
    assert await _likers(db_session, cast.meal) == []
    assert await _likers(db_session, other) == [cast.bob.id]


async def test_both_directions_are_idempotent(client, db_session, cast):
    for _ in range(2):
        liked = await client.put(_url(cast.meal.id), headers=auth(cast.bob))
        assert (liked.status_code, liked.json()["like_count"]) == (200, 1)
    assert await _likers(db_session, cast.meal) == [cast.bob.id]

    for _ in range(2):
        gone = await client.delete(_url(cast.meal.id), headers=auth(cast.bob))
        assert (gone.status_code, gone.json()) == (200, {"like_count": 0, "liked_by_me": False})
    never = await client.delete(_url(cast.meal.id), headers=auth(cast.carol))
    assert never.status_code == 200


async def test_the_owner_cannot_like_their_own_meal(client, db_session, cast):
    response = await client.put(_url(cast.meal.id), headers=auth(cast.alice))

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "CANNOT_LIKE_OWN_MEAL"
    assert await _likers(db_session, cast.meal) == []
    # 收回沒有東西可以收，照樣是 200（冪等）。
    assert (await client.delete(_url(cast.meal.id), headers=auth(cast.alice))).status_code == 200


@pytest.mark.parametrize("method", ["put", "delete"])
@pytest.mark.parametrize("who", ["dan", "eve"])
async def test_who_cannot_see_the_meal_cannot_touch_its_likes(
    client, db_session, cast, method, who
):
    viewer = getattr(cast, who)
    await create_like(db_session, meal=cast.meal, user=viewer)  # DELETE 有東西可以刪才算數

    hidden = await client.request(method, _url(cast.meal.id), headers=auth(viewer))
    missing = await client.request(method, _url(MISSING), headers=auth(viewer))

    assert hidden.status_code == missing.status_code == 404
    assert hidden.content == missing.content
    assert hidden.json()["error"]["code"] == "MEAL_NOT_FOUND"
    assert await _likers(db_session, cast.meal) == [viewer.id]  # 沒有多一列、也沒有被刪


async def test_a_meal_gone_private_can_be_neither_liked_nor_unliked(client, db_session, cast):
    assert (await client.put(_url(cast.meal.id), headers=auth(cast.bob))).status_code == 200
    cast.meal.is_private = True
    await db_session.commit()

    refused_like = await client.put(_url(cast.meal.id), headers=auth(cast.carol))
    refused_unlike = await client.delete(_url(cast.meal.id), headers=auth(cast.bob))
    missing = await client.put(_url(MISSING), headers=auth(cast.carol))

    assert refused_like.status_code == refused_unlike.status_code == 404
    # 跟不存在逐字相同：好友也分不出「關起來了」與「刪掉了」。
    assert refused_like.content == refused_unlike.content == missing.content
    assert await _likers(db_session, cast.meal) == [cast.bob.id]


async def test_after_unfriending_the_like_stays_hidden_until_they_are_friends_again(
    client, db_session, cast
):
    await client.put(_url(cast.meal.id), headers=auth(cast.bob))
    await unfriend(db_session, cast.alice, cast.bob)

    refused_unlike = await client.delete(_url(cast.meal.id), headers=auth(cast.bob))
    refused_like = await client.put(_url(cast.meal.id), headers=auth(cast.bob))
    missing = await client.put(_url(MISSING), headers=auth(cast.bob))
    assert refused_unlike.status_code == refused_like.status_code == 404
    assert refused_unlike.content == refused_like.content == missing.content
    # 小卡按讚拿到的數字不含鮑伯那一個。
    as_carol = await client.put(_url(cast.meal.id), headers=auth(cast.carol))
    assert as_carol.json() == {"like_count": 1, "liked_by_me": True}

    await create_friendship(db_session, cast.alice, cast.bob)
    again = await client.put(_url(cast.meal.id), headers=auth(cast.bob))
    assert again.json() == {"like_count": 2, "liked_by_me": True}
    assert len(await _likers(db_session, cast.meal)) == 2  # 鮑伯原本那一列一直都在，沒有多一列


async def test_a_friend_of_a_friend_cannot_like(client, db_session, cast):
    """小卡是愛麗絲的好友、不是鮑伯的：鮑伯的餐她按不到。愛麗絲按得到（同一個網址是通的）。"""
    bobs = await create_meal(db_session, user=cast.bob, items=[(cast.revision, 100)])

    assert (await client.put(_url(bobs.id), headers=auth(cast.alice))).status_code == 200
    assert (await client.put(_url(bobs.id), headers=auth(cast.carol))).status_code == 404
    assert await _likers(db_session, bobs) == [cast.alice.id]


async def test_it_needs_a_login(client, db_session, cast):
    assert (await client.put(_url(cast.meal.id))).status_code == 401
    assert (await client.delete(_url(cast.meal.id))).status_code == 401
    assert await _likers(db_session, cast.meal) == []


@pytest.mark.parametrize("method", ["put", "delete"])
async def test_an_id_that_cannot_be_a_meal_is_422_not_500(client, cast, method):
    response = await client.request(method, _url(2**63), headers=auth(cast.bob))

    assert response.status_code == 422


async def test_likes_and_unlikes_share_one_budget_per_person(client, cast):
    for index in range(LIKE_LIMIT):
        method = "put" if index % 2 == 0 else "delete"
        ok = await client.request(method, _url(cast.meal.id), headers=auth(cast.bob))
        assert ok.status_code == 200

    for method in ("put", "delete"):
        blocked = await client.request(method, _url(cast.meal.id), headers=auth(cast.bob))
        assert blocked.status_code == 429
        assert blocked.json()["error"]["code"] == "TOO_MANY_LIKES"
        assert 1 <= int(blocked.headers["Retry-After"]) <= 60
    # 額度是每個人的。
    assert (await client.put(_url(cast.meal.id), headers=auth(cast.carol))).status_code == 200


async def test_guessing_ids_runs_into_the_limit_before_the_lookup(client, cast):
    for _ in range(LIKE_LIMIT):
        assert (await client.put(_url(MISSING), headers=auth(cast.eve))).status_code == 404
    assert (await client.put(_url(MISSING), headers=auth(cast.eve))).status_code == 429


# ---------- 自己的餐點清單（`MealResponse`） ----------


def _jpeg() -> bytes:
    buffer = io.BytesIO()
    Image.new("RGB", (40, 30), color=(200, 100, 50)).save(buffer, format="JPEG")
    return buffer.getvalue()


async def _own_views(client, db_session, cast) -> dict[str, tuple[int, int]]:
    """**每一條**回 `MealResponse` 的路徑看到的 (讚, 留言)——六條都走，漏一條就是那一條
    可以悄悄回 0（計畫原本只走四條，改項目與上傳照片是補上的）。"""
    me = auth(cast.alice)
    meal_id = cast.meal.id
    item_id = await db_session.scalar(
        select(MealItem.id).where(MealItem.meal_id == meal_id).order_by(MealItem.id).limit(1)
    )
    responses = {
        "read": await client.get(f"/api/meals/{meal_id}", headers=me),
        "list": await client.get("/api/meals?date=2026-10-06", headers=me),
        "patch": await client.patch(f"/api/meals/{meal_id}", headers=me, json={"note": "改"}),
        "add_item": await client.post(
            f"/api/meals/{meal_id}/items",
            headers=me,
            json={"food_id": cast.food.id, "quantity": "50"},
        ),
        "patch_item": await client.patch(
            f"/api/meals/{meal_id}/items/{item_id}", headers=me, json={"quantity": "120"}
        ),
        "photo": await client.post(
            f"/api/meals/{meal_id}/photo",
            headers=me,
            files={"file": ("lunch.jpg", _jpeg(), "image/jpeg")},
        ),
    }
    views = {}
    for name, response in responses.items():
        assert response.status_code in (200, 201), (name, response.text)
        body = response.json()[0] if name == "list" else response.json()
        assert body["id"] == meal_id, name
        assert "liked_by_me" not in body  # 規格「與原始決定的差異」第 3 點
        views[name] = (body["like_count"], body["comment_count"])
    return views


async def test_every_path_that_returns_my_meal_carries_the_numbers(client, db_session, cast):
    await create_like(db_session, meal=cast.meal, user=cast.bob)
    await create_like(db_session, meal=cast.meal, user=cast.eve)  # 陌生人的列：不算
    await create_comment(db_session, meal=cast.meal, user=cast.carol)
    await create_comment(db_session, meal=cast.meal, user=cast.alice)

    views = await _own_views(client, db_session, cast)
    assert len(views) == 6
    assert set(views.values()) == {(1, 2)}, views

    await unfriend(db_session, cast.alice, cast.bob)
    await unfriend(db_session, cast.alice, cast.carol)
    views = await _own_views(client, db_session, cast)
    assert set(views.values()) == {(0, 1)}, views


async def test_my_list_gives_each_meal_its_own_numbers(client, db_session, cast):
    """同一天兩餐、數字不一樣：把數字對到別餐、或整頁共用一個數字，一餐的測試看不出來。"""
    second = await create_meal(
        db_session,
        user=cast.alice,
        eaten_at=datetime.fromisoformat("2026-10-06T10:00:00+00:00"),
        items=[(cast.revision, 100)],
    )
    await create_like(db_session, meal=cast.meal, user=cast.bob)
    await create_like(db_session, meal=cast.meal, user=cast.carol)
    await create_comment(db_session, meal=second, user=cast.bob)

    listed = (await client.get("/api/meals?date=2026-10-06", headers=auth(cast.alice))).json()

    assert {meal["id"]: (meal["like_count"], meal["comment_count"]) for meal in listed} == {
        cast.meal.id: (2, 0),
        second.id: (0, 1),
    }


async def test_a_new_meal_starts_at_zero(client, cast):
    response = await client.post(
        "/api/meals",
        headers=auth(cast.alice),
        json={"eaten_at": "2026-10-06T05:00:00+00:00", "meal_type": "snack", "items": []},
    )

    assert response.status_code == 201
    assert (response.json()["like_count"], response.json()["comment_count"]) == (0, 0)


async def test_my_own_endpoints_still_refuse_a_friends_meal(client, db_session, cast):
    """`/api/meals` 多了兩個數字，**沒有**多讀得到任何人的餐：鮑伯是好友、這一餐他在社群的
    端點看得到（同一個 id 是 200），但 `/api/meals/{id}` 照舊是 404——不會順便把備註與
    餐費給他。"""
    assert (
        await client.get(f"/api/social/meals/{cast.meal.id}", headers=auth(cast.bob))
    ).status_code == 200

    own = await client.get(f"/api/meals/{cast.meal.id}", headers=auth(cast.bob))
    listed = await client.get("/api/meals?date=2026-10-06", headers=auth(cast.bob))

    assert own.status_code == 404
    assert listed.json() == []


async def test_both_writes_are_committed(client, db_session, cast):
    """共用 session 的夾具看得到沒 commit 的寫入——端點把 commit 寫成 flush 也會綠
    （審查 M1：原本只有 e2e 守著這兩個 commit）。這裡在端點回來之後 rollback 一次：
    沒 commit 的東西會跟著不見（handover §6 第 11 種）。讚與它的通知是同一個交易，兩個都看。"""
    meal_id, alice_id, bob_id = cast.meal.id, cast.alice.id, cast.bob.id
    bob = auth(cast.bob)

    async def stored() -> tuple[list[int], list[tuple[int, int]]]:
        likers = await db_session.scalars(
            select(MealLike.user_id).where(MealLike.meal_id == meal_id)
        )
        notices = await db_session.execute(
            select(Notification.user_id, Notification.actor_id).where(
                Notification.meal_id == meal_id, Notification.type == NotificationType.LIKE
            )
        )
        return list(likers), [tuple(row) for row in notices]

    assert (await client.put(_url(meal_id), headers=bob)).status_code == 200
    await db_session.rollback()
    assert await stored() == ([bob_id], [(alice_id, bob_id)])

    assert (await client.delete(_url(meal_id), headers=bob)).status_code == 200
    await db_session.rollback()
    assert await stored() == ([], [])


@pytest.mark.parametrize("method", ["put", "delete"])
async def test_the_meal_vanishing_right_after_the_commit_is_not_a_500(
    client, db_session, cast, monkeypatch, method
):
    """審查 M4 順便檢查的：按讚與收回在 commit **之後**才讀數字（留言以前在同一個位置
    `refresh`，那一餐或那則留言被刪掉就是 500）。這裡把空檔做成確定會發生的——commit
    一回來主人就把整餐刪掉。讀的是數字不是那一列，所以是 200 與 0，不是例外。
    小卡先按了一個讚：餐還在的話數字不會是 0。"""
    meal_id = cast.meal.id
    await create_like(db_session, meal=cast.meal, user=cast.carol)
    await create_like(db_session, meal=cast.meal, user=cast.bob)
    real_commit = db_session.commit

    async def commit_then_the_owner_deletes_the_meal() -> None:
        await real_commit()
        await db_session.execute(delete(Meal).where(Meal.id == meal_id))
        await real_commit()

    monkeypatch.setattr(db_session, "commit", commit_then_the_owner_deletes_the_meal)

    response = await client.request(method, _url(meal_id), headers=auth(cast.bob))

    assert response.status_code == 200
    assert response.json() == {"like_count": 0, "liked_by_me": False}
    monkeypatch.undo()
    assert await db_session.scalar(select(Meal.id).where(Meal.id == meal_id)) is None
