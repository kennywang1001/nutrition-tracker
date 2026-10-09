"""`GET /api/social/meals/{id}`：誰看得到一餐、看到什麼（社群規格 §4.1、§4.2、§5.1）。"""

from datetime import datetime

import pytest
from sqlalchemy import event

from app.models.friendship import FriendshipStatus
from tests.factories import (
    create_comment,
    create_friendship,
    create_like,
    create_meal,
    create_user,
)
from tests.social_helpers import MISSING, auth, make_cast, unfriend


@pytest.fixture
async def cast(db_session):
    return await make_cast(db_session)


async def _read(client, viewer, meal_id):
    return await client.get(f"/api/social/meals/{meal_id}", headers=auth(viewer))


# ---------- §4.1：看不看得到 ----------


@pytest.mark.parametrize(
    ("who", "public", "private"),
    [
        ("alice", 200, 200),
        ("bob", 200, 404),
        ("carol", 200, 404),
        ("dan", 404, 404),
        ("eve", 404, 404),
    ],
)
async def test_who_can_open_a_meal(client, db_session, cast, who, public, private):
    viewer = getattr(cast, who)

    assert (await _read(client, viewer, cast.meal.id)).status_code == public

    cast.meal.is_private = True
    await db_session.commit()
    assert (await _read(client, viewer, cast.meal.id)).status_code == private


async def test_cannot_see_and_does_not_exist_are_the_same_response(client, cast):
    hidden = await _read(client, cast.eve, cast.meal.id)
    missing = await _read(client, cast.eve, MISSING)
    own_endpoint = await client.get(f"/api/meals/{MISSING}", headers=auth(cast.eve))

    assert hidden.status_code == missing.status_code == 404
    assert hidden.content == missing.content == own_endpoint.content


@pytest.mark.parametrize("why", ["stranger", "pending", "private", "unfriended"])
async def test_every_way_of_not_seeing_is_the_same_404(client, db_session, cast, why):
    """陌生人、邀請還在等、好友但這一餐是私人的、已經解除——四種都跟「id 不存在」
    **逐字相同**：猜 id 的人分不出這一餐存不存在，也分不出是哪一種看不到。

    每一種都先確認這條路徑是通的（主人打同一個網址是 200），404 才不是路徑打錯。"""
    viewer = {
        "stranger": cast.eve,
        "pending": cast.dan,
        "private": cast.bob,
        "unfriended": cast.bob,
    }[why]
    if why == "private":
        cast.meal.is_private = True
        await db_session.commit()
    if why == "unfriended":
        await unfriend(db_session, cast.alice, cast.bob)
    assert (await _read(client, cast.alice, cast.meal.id)).status_code == 200

    hidden = await _read(client, viewer, cast.meal.id)
    missing = await _read(client, viewer, MISSING)

    assert hidden.status_code == missing.status_code == 404
    assert hidden.content == missing.content
    assert hidden.json()["error"]["code"] == "MEAL_NOT_FOUND"
    assert hidden.headers["content-type"] == missing.headers["content-type"]


async def test_it_needs_a_login(client, cast):
    assert (await client.get(f"/api/social/meals/{cast.meal.id}")).status_code == 401


@pytest.mark.parametrize("meal_id", [0, -1, 2**63])
async def test_an_id_that_cannot_be_a_meal_is_422_not_500(client, cast, meal_id):
    assert (await _read(client, cast.alice, meal_id)).status_code == 422


async def test_unfriending_closes_the_door(client, db_session, cast):
    assert (await _read(client, cast.bob, cast.meal.id)).status_code == 200
    await unfriend(db_session, cast.alice, cast.bob)
    assert (await _read(client, cast.bob, cast.meal.id)).status_code == 404
    # 小卡不受影響：關的是鮑伯那一扇，不是整個端點。
    assert (await _read(client, cast.carol, cast.meal.id)).status_code == 200


async def test_an_invitation_the_owner_sent_opens_nothing_until_it_is_accepted(
    client, db_session, cast
):
    """阿丁那一筆是「別人邀主人」；這裡是另一個方向——主人邀了人、對方還沒接受。
    兩個方向都不算好友。接受之後同一個網址就是 200：前面的 404 不是路徑打錯。"""
    frank = await create_user(db_session, display_name="阿福")
    invitation = await create_friendship(
        db_session, cast.alice, frank, status=FriendshipStatus.PENDING
    )
    assert invitation.requested_by == cast.alice.id
    assert (await _read(client, frank, cast.meal.id)).status_code == 404

    invitation.status = FriendshipStatus.ACCEPTED
    invitation.accepted_at = datetime.fromisoformat("2026-10-06T05:00:00+00:00")
    await db_session.commit()

    assert (await _read(client, frank, cast.meal.id)).status_code == 200


async def test_a_friend_of_a_friend_is_still_a_stranger(client, db_session, cast):
    """小卡有好友（愛麗絲），但不是鮑伯的好友：鮑伯的餐她看不到。
    陌生人伊芙一個好友都沒有，「有沒有任何好友」與「是不是**主人的**好友」在她身上
    分不出來——這一條才分得出來。"""
    bobs = await create_meal(db_session, user=cast.bob, items=[(cast.revision, 100)])

    assert (await _read(client, cast.alice, bobs.id)).status_code == 200
    assert (await _read(client, cast.bob, bobs.id)).status_code == 200
    hidden = await _read(client, cast.carol, bobs.id)

    assert hidden.status_code == 404
    assert hidden.content == (await _read(client, cast.carol, MISSING)).content


# ---------- 看到什麼 ----------


async def test_a_friend_sees_the_whitelisted_meal_and_nothing_private(client, db_session, cast):
    await create_like(db_session, meal=cast.meal, user=cast.carol)
    await create_comment(db_session, meal=cast.meal, user=cast.carol, body="好香")

    response = await _read(client, cast.bob, cast.meal.id)

    body = response.json()
    assert set(body) == {"meal", "is_mine", "likes", "comments", "comments_truncated"}
    assert body["is_mine"] is False
    assert set(body["meal"]) == {
        "id", "user", "eaten_at", "meal_type", "description", "items",
        "kcal", "protein_g", "fat_g", "carb_g", "has_photo",
        "like_count", "comment_count", "liked_by_me",
    }  # fmt: skip
    assert body["meal"]["id"] == cast.meal.id
    assert body["meal"]["user"] == {"id": cast.alice.id, "display_name": "愛麗絲"}
    assert body["meal"]["description"] == "滷肉飯配燙青菜"
    assert [item["food_name"] for item in body["meal"]["items"]] == ["愛麗絲的私房菜"]
    assert set(body["meal"]["items"][0]) == {"food_name", "quantity_g", "base_unit", "kcal"}
    assert body["likes"] == [{"display_name": "小卡", "is_me": False}]
    assert set(body["comments"][0]) == {
        "id", "display_name", "is_me", "can_delete", "body", "created_at",
    }  # fmt: skip
    # 描述在（上面斷言過），備註、餐費、email、食物 id 不在——同一個回應裡兩種都有才算數。
    secrets = ("今天心情很差", "4321.75", "food_id", "note", "cost", "photo_path", "@example.com")
    for secret in secrets:
        assert secret not in response.text


async def test_the_owner_gets_the_same_whitelist(client, cast):
    response = await _read(client, cast.alice, cast.meal.id)

    assert response.json()["is_mine"] is True
    assert response.json()["meal"]["description"] == "滷肉飯配燙青菜"
    assert "今天心情很差" not in response.text and "4321.75" not in response.text
    assert "@example.com" not in response.text


async def test_mutual_friends_of_the_owner_see_each_other(client, db_session, cast):
    """規格 D3：鮑伯與小卡不是好友，但在愛麗絲的餐上看得到彼此。"""
    await create_like(db_session, meal=cast.meal, user=cast.carol)
    await create_comment(db_session, meal=cast.meal, user=cast.carol, body="好香")
    await create_comment(db_session, meal=cast.meal, user=cast.alice, body="謝謝")
    await create_comment(db_session, meal=cast.meal, user=cast.bob, body="我也要")

    body = (await _read(client, cast.bob, cast.meal.id)).json()

    rows = [(c["display_name"], c["body"], c["is_me"], c["can_delete"]) for c in body["comments"]]
    assert rows == [
        ("小卡", "好香", False, False),
        ("愛麗絲", "謝謝", False, False),
        ("鮑伯", "我也要", True, True),
    ]
    assert (body["meal"]["like_count"], body["meal"]["comment_count"]) == (1, 3)
    assert body["meal"]["liked_by_me"] is False


async def test_the_owner_can_delete_every_comment(client, db_session, cast):
    await create_comment(db_session, meal=cast.meal, user=cast.carol)
    await create_comment(db_session, meal=cast.meal, user=cast.alice)

    body = (await _read(client, cast.alice, cast.meal.id)).json()

    rows = [(c["is_me"], c["can_delete"]) for c in body["comments"]]
    assert rows == [(False, True), (True, True)]


async def test_the_one_who_liked_is_marked_as_me(client, db_session, cast):
    await create_like(db_session, meal=cast.meal, user=cast.carol)
    await create_like(db_session, meal=cast.meal, user=cast.bob)

    body = (await _read(client, cast.bob, cast.meal.id)).json()

    # 依按讚的先後；「是不是我」由伺服器算，回應裡沒有任何人的 id（規格 D9）。
    assert body["likes"] == [
        {"display_name": "小卡", "is_me": False},
        {"display_name": "鮑伯", "is_me": True},
    ]
    assert (body["meal"]["like_count"], body["meal"]["liked_by_me"]) == (2, True)


# ---------- §4.2：解除之後 ----------


async def test_an_unfriended_persons_likes_and_comments_vanish_for_everyone_then_return(
    client, db_session, cast
):
    """過濾看的是「作者與主人」的關係：看的人是小卡（她一直看得到這一餐），被解除的是鮑伯。"""
    await create_like(db_session, meal=cast.meal, user=cast.bob)
    await create_like(db_session, meal=cast.meal, user=cast.carol)
    await create_comment(db_session, meal=cast.meal, user=cast.bob, body="鮑伯說")
    await create_comment(db_session, meal=cast.meal, user=cast.carol, body="小卡說")

    async def seen():
        body = (await _read(client, cast.carol, cast.meal.id)).json()
        return (
            [like["display_name"] for like in body["likes"]],
            [c["body"] for c in body["comments"]],
            body["meal"]["like_count"],
            body["meal"]["comment_count"],
        )

    assert await seen() == (["鮑伯", "小卡"], ["鮑伯說", "小卡說"], 2, 2)

    await unfriend(db_session, cast.alice, cast.bob)
    assert await seen() == (["小卡"], ["小卡說"], 1, 1)
    # 主人看到的也一樣。
    owner_view = (await _read(client, cast.alice, cast.meal.id)).json()
    assert owner_view["meal"]["like_count"] == 1 and len(owner_view["comments"]) == 1
    assert "鮑伯" not in str(owner_view["likes"]) + str(owner_view["comments"])

    await create_friendship(db_session, cast.alice, cast.bob)
    assert await seen() == (["鮑伯", "小卡"], ["鮑伯說", "小卡說"], 2, 2)


async def test_a_pending_request_does_not_count_as_a_friend(client, db_session, cast):
    await create_like(db_session, meal=cast.meal, user=cast.dan)
    await create_comment(db_session, meal=cast.meal, user=cast.dan)

    body = (await _read(client, cast.bob, cast.meal.id)).json()

    assert (body["likes"], body["comments"]) == ([], [])
    assert (body["meal"]["like_count"], body["meal"]["comment_count"]) == (0, 0)


async def test_someone_elses_friend_does_not_count_on_this_meal(client, db_session, cast):
    """小卡是愛麗絲的好友、不是鮑伯的：她在**鮑伯的**餐上留下的列不算。
    「作者有沒有任何好友」與「作者是不是這一餐主人的好友」是兩件事——
    阿丁與伊芙一個好友都沒有，分不出來。"""
    bobs = await create_meal(db_session, user=cast.bob, items=[(cast.revision, 100)])
    await create_like(db_session, meal=bobs, user=cast.carol)
    await create_comment(db_session, meal=bobs, user=cast.carol, body="不該出現")
    await create_like(db_session, meal=bobs, user=cast.alice)
    await create_comment(db_session, meal=bobs, user=cast.alice, body="該出現")

    body = (await _read(client, cast.alice, bobs.id)).json()

    assert body["likes"] == [{"display_name": "愛麗絲", "is_me": True}]
    assert [c["body"] for c in body["comments"]] == ["該出現"]
    assert (body["meal"]["like_count"], body["meal"]["comment_count"]) == (1, 1)


async def test_a_self_like_row_never_counts(client, db_session, cast):
    """端點會擋（Task 3）；這條守的是就算有那樣一列，數字也不算它。"""
    await create_like(db_session, meal=cast.meal, user=cast.alice)

    body = (await _read(client, cast.alice, cast.meal.id)).json()

    meal = body["meal"]
    assert (body["likes"], meal["like_count"], meal["liked_by_me"]) == ([], 0, False)


async def test_going_private_keeps_what_was_written_for_the_owner(client, db_session, cast):
    await create_like(db_session, meal=cast.meal, user=cast.bob)
    await create_comment(db_session, meal=cast.meal, user=cast.bob, body="留著")
    cast.meal.is_private = True
    await db_session.commit()

    body = (await _read(client, cast.alice, cast.meal.id)).json()

    assert [c["body"] for c in body["comments"]] == ["留著"]
    assert body["meal"]["like_count"] == 1


# ---------- 上限、liked_by_me、卡片上的數字 ----------


async def test_only_the_latest_hundred_comments_oldest_first(client, db_session, cast):
    for index in range(101):
        await create_comment(db_session, meal=cast.meal, user=cast.bob, body=f"第{index}則")

    body = (await _read(client, cast.carol, cast.meal.id)).json()

    assert body["comments_truncated"] is True
    assert [c["body"] for c in body["comments"]] == [f"第{index}則" for index in range(1, 101)]
    assert body["meal"]["comment_count"] == 101  # 數字是全部，不是顯示出來的


async def test_exactly_a_hundred_is_not_truncated(client, db_session, cast):
    for index in range(100):
        await create_comment(db_session, meal=cast.meal, user=cast.bob, body=f"第{index}則")

    body = (await _read(client, cast.carol, cast.meal.id)).json()

    assert body["comments_truncated"] is False and len(body["comments"]) == 100


async def test_the_feed_and_the_day_carry_the_same_numbers(client, db_session, cast):
    await create_like(db_session, meal=cast.meal, user=cast.bob)
    await create_like(db_session, meal=cast.meal, user=cast.eve)  # 陌生人的列：不算
    await create_comment(db_session, meal=cast.meal, user=cast.carol)

    feed = (await client.get("/api/friends/feed", headers=auth(cast.bob))).json()
    day = (
        await client.get(
            f"/api/friends/{cast.alice.id}/meals?date=2026-10-06", headers=auth(cast.bob)
        )
    ).json()
    as_carol = (await client.get("/api/friends/feed", headers=auth(cast.carol))).json()

    def numbers(meal):
        return (meal["like_count"], meal["comment_count"], meal["liked_by_me"])

    assert numbers(feed["meals"][0]) == numbers(day["meals"][0]) == (1, 1, True)
    assert numbers(as_carol["meals"][0]) == (1, 1, False)


async def test_each_meal_in_the_feed_carries_its_own_numbers(client, db_session, cast):
    """兩餐、數字不一樣：`GROUP BY` 分錯或把數字對到別餐，一餐的測試看不出來。"""
    second = await create_meal(
        db_session,
        user=cast.alice,
        eaten_at=datetime.fromisoformat("2026-10-07T04:00:00+00:00"),
        items=[(cast.revision, 100)],
    )
    await create_like(db_session, meal=cast.meal, user=cast.bob)
    await create_like(db_session, meal=cast.meal, user=cast.carol)
    await create_comment(db_session, meal=second, user=cast.carol)
    await create_comment(db_session, meal=second, user=cast.alice)
    await create_comment(db_session, meal=second, user=cast.bob)

    feed = (await client.get("/api/friends/feed", headers=auth(cast.bob))).json()

    by_id = {
        meal["id"]: (meal["like_count"], meal["comment_count"], meal["liked_by_me"])
        for meal in feed["meals"]
    }
    assert by_id == {cast.meal.id: (2, 0, True), second.id: (0, 3, False)}


async def test_the_feed_does_not_query_per_meal(client, db_session, db_connection, cast):
    """1 餐與 6 餐的 SELECT 次數一樣（每一餐都有讚與留言——沒有的話少查也看不出來）。"""
    seen: list[str] = []

    def record(conn, cursor, statement, parameters, context, executemany):
        if statement.lstrip().upper().startswith("SELECT"):
            seen.append(statement)

    async def selects() -> int:
        seen.clear()
        event.listen(db_connection.sync_connection, "before_cursor_execute", record)
        try:
            response = await client.get("/api/friends/feed", headers=auth(cast.bob))
        finally:
            event.remove(db_connection.sync_connection, "before_cursor_execute", record)
        assert response.status_code == 200
        return len(seen)

    await create_like(db_session, meal=cast.meal, user=cast.carol)
    await create_comment(db_session, meal=cast.meal, user=cast.carol)
    one = await selects()
    for hour in range(5):
        meal = await create_meal(
            db_session,
            user=cast.alice,
            eaten_at=datetime.fromisoformat(f"2026-10-07T0{hour}:00:00+00:00"),
            items=[(cast.revision, 100)],
        )
        await create_like(db_session, meal=meal, user=cast.carol)
        await create_comment(db_session, meal=meal, user=cast.carol)

    assert one > 0  # 真的有數到東西
    assert await selects() == one
