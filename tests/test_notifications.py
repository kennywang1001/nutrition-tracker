"""通知：誰收到、什麼時候消失、已讀（社群規格 §4.3、§5.5、D11–D15）。"""

from datetime import UTC, datetime

import pytest
from sqlalchemy import func, select, update

from app.friend_codes import format_friend_code
from app.models.friendship import FriendshipStatus
from app.models.social import Notification, NotificationType
from tests.factories import create_comment, create_friendship, create_meal
from tests.social_helpers import MISSING, auth, make_cast, unfriend


@pytest.fixture
async def cast(db_session):
    return await make_cast(db_session)


async def _like(client, user, meal):
    response = await client.put(f"/api/social/meals/{meal.id}/like", headers=auth(user))
    assert response.status_code == 200


async def _unlike(client, user, meal):
    response = await client.delete(f"/api/social/meals/{meal.id}/like", headers=auth(user))
    assert response.status_code == 200


async def _comment(client, user, meal, body="好吃嗎") -> int:
    response = await client.post(
        f"/api/social/meals/{meal.id}/comments", headers=auth(user), json={"body": body}
    )
    assert response.status_code == 201
    return response.json()["id"]


async def _inbox(client, user) -> list[dict]:
    response = await client.get("/api/notifications", headers=auth(user))
    assert response.status_code == 200
    assert set(response.json()) == {"items"}
    return response.json()["items"]


async def _unread(client, user) -> int:
    response = await client.get("/api/notifications/unread-count", headers=auth(user))
    assert response.status_code == 200
    assert set(response.json()) == {"count"}
    return response.json()["count"]


def _who_did_what(items) -> list[tuple[str, str]]:
    return [(item["actor_name"], item["type"]) for item in items]


async def _rows(db_session) -> int:
    return await db_session.scalar(select(func.count()).select_from(Notification))


# ---------- 寫入 ----------


async def test_a_like_tells_the_owner_and_nobody_else(client, cast):
    await _like(client, cast.bob, cast.meal)

    [item] = await _inbox(client, cast.alice)
    assert set(item) == {
        "id",
        "type",
        "actor_name",
        "meal",
        "comment_preview",
        "created_at",
        "is_read",
    }
    assert (item["type"], item["actor_name"], item["is_read"]) == ("like", "鮑伯", False)
    assert item["meal"] == {
        "id": cast.meal.id,
        "meal_type": "lunch",
        "eaten_at": "2026-10-06T04:00:00Z",
    }
    assert item["comment_preview"] is None
    assert item["created_at"].endswith(("Z", "+00:00"))
    assert await _unread(client, cast.alice) == 1
    # 按的人自己、同一餐上的另一個好友：都沒有通知，未讀數也是 0。
    assert await _inbox(client, cast.bob) == [] and await _inbox(client, cast.carol) == []
    assert await _unread(client, cast.bob) == 0 and await _unread(client, cast.carol) == 0


async def test_the_owner_trying_to_like_their_own_meal_writes_nothing(client, db_session, cast):
    response = await client.put(f"/api/social/meals/{cast.meal.id}/like", headers=auth(cast.alice))

    assert response.status_code == 422
    assert await _rows(db_session) == 0


async def test_liking_twice_or_unliking_and_reliking_never_piles_up(client, db_session, cast):
    await _like(client, cast.bob, cast.meal)
    await _like(client, cast.bob, cast.meal)
    assert _who_did_what(await _inbox(client, cast.alice)) == [("鮑伯", "like")]
    assert await _rows(db_session) == 1

    await _unlike(client, cast.bob, cast.meal)
    assert await _inbox(client, cast.alice) == []
    assert await _rows(db_session) == 0

    await _like(client, cast.bob, cast.meal)
    assert _who_did_what(await _inbox(client, cast.alice)) == [("鮑伯", "like")]
    assert await _rows(db_session) == 1


async def test_unliking_only_removes_my_like_notification_for_that_meal(client, db_session, cast):
    """收回的那個 DELETE 有四個條件（收件人、動作者、餐、種類）：這裡每一個都有一則
    「只差那一個條件」的通知，收回之後它們都要還在。"""
    other = await create_meal(db_session, user=cast.alice, items=[(cast.revision, 100)])
    await _like(client, cast.bob, cast.meal)
    await _like(client, cast.carol, cast.meal)  # 另一個動作者
    await _comment(client, cast.bob, cast.meal)  # 另一個種類
    await _like(client, cast.bob, other)  # 另一餐

    await _unlike(client, cast.bob, cast.meal)

    items = await _inbox(client, cast.alice)
    assert [(i["actor_name"], i["type"], i["meal"]["id"]) for i in items] == [
        ("鮑伯", "like", other.id),
        ("鮑伯", "comment", cast.meal.id),
        ("小卡", "like", cast.meal.id),
    ]


async def test_a_comment_tells_only_the_owner(client, db_session, cast):
    """不做「跟著這串留言」（D11）：小卡先留過言，鮑伯再留，小卡不會收到。
    主人在自己的餐留言：沒有人收到。"""
    await _comment(client, cast.carol, cast.meal, "先留的")
    await _comment(client, cast.bob, cast.meal, "後留的")
    await _comment(client, cast.alice, cast.meal, "主人回覆")

    items = await _inbox(client, cast.alice)
    assert [(i["actor_name"], i["type"], i["comment_preview"]) for i in items] == [
        ("鮑伯", "comment", "後留的"),
        ("小卡", "comment", "先留的"),
    ]
    assert items[0]["meal"] == {
        "id": cast.meal.id,
        "meal_type": "lunch",
        "eaten_at": "2026-10-06T04:00:00Z",
    }
    assert await _inbox(client, cast.carol) == [] and await _inbox(client, cast.bob) == []
    assert await _rows(db_session) == 2


async def test_every_comment_gets_its_own_notification(client, cast):
    """留言不像讚：同一個人在同一餐留兩則就是兩則通知，各自帶自己的預覽。"""
    first = await _comment(client, cast.bob, cast.meal, "第一則")
    await _comment(client, cast.bob, cast.meal, "第二則")

    items = await _inbox(client, cast.alice)
    assert [i["comment_preview"] for i in items] == ["第二則", "第一則"]

    # 刪掉第一則：只帶走它自己的通知。
    deleted = await client.delete(
        f"/api/social/meals/{cast.meal.id}/comments/{first}", headers=auth(cast.bob)
    )
    assert deleted.status_code == 204
    assert [i["comment_preview"] for i in await _inbox(client, cast.alice)] == ["第二則"]


@pytest.mark.parametrize(
    ("length", "preview"),
    [(1, "字"), (40, "字" * 40), (41, "字" * 40 + "…")],
    ids=["1", "40", "41"],
)
async def test_the_preview_is_the_first_forty_characters(client, cast, length, preview):
    await _comment(client, cast.bob, cast.meal, "字" * length)

    [item] = await _inbox(client, cast.alice)
    assert item["comment_preview"] == preview


async def test_nothing_private_rides_along(client, cast):
    await _like(client, cast.bob, cast.meal)
    await _comment(client, cast.bob, cast.meal, "看得到的預覽")

    response = await client.get("/api/notifications", headers=auth(cast.alice))

    assert "看得到的預覽" in response.text  # 預覽在（下面那些才不是空轉）
    for secret in ("@example.com", "actor_id", "user_id", "今天心情很差", "4321.75"):
        assert secret not in response.text


# ---------- 什麼時候消失（§4.3） ----------


async def test_deleting_the_comment_or_the_meal_takes_the_notifications(client, db_session, cast):
    comment_id = await _comment(client, cast.bob, cast.meal)
    await _like(client, cast.carol, cast.meal)

    deleted = await client.delete(
        f"/api/social/meals/{cast.meal.id}/comments/{comment_id}", headers=auth(cast.bob)
    )
    assert deleted.status_code == 204
    assert _who_did_what(await _inbox(client, cast.alice)) == [("小卡", "like")]

    assert (
        await client.delete(f"/api/meals/{cast.meal.id}", headers=auth(cast.alice))
    ).status_code == 204
    assert await _inbox(client, cast.alice) == []
    assert await _unread(client, cast.alice) == 0
    assert await _rows(db_session) == 0


async def test_unfriending_hides_their_notifications_until_they_are_back(client, db_session, cast):
    """鮑伯另外有一個好友（伊芙）：解除之後他仍然「有好友」，只是不是愛麗絲的——
    把過濾寫成「動作者有任何一個好友」的話，這裡看得出來。
    中間還經過一次「鮑伯重新送邀請、還在等」：等的時候讚與留言的通知仍然不顯示。"""
    await create_friendship(db_session, cast.bob, cast.eve)
    await _like(client, cast.bob, cast.meal)
    await _comment(client, cast.bob, cast.meal, "不該留在通知裡的預覽")
    await _like(client, cast.carol, cast.meal)
    assert await _unread(client, cast.alice) == 3
    assert "不該留在通知裡的預覽" in (
        await client.get("/api/notifications", headers=auth(cast.alice))
    ).text

    await unfriend(db_session, cast.alice, cast.bob)

    response = await client.get("/api/notifications", headers=auth(cast.alice))
    assert _who_did_what(response.json()["items"]) == [("小卡", "like")]
    assert "不該留在通知裡的預覽" not in response.text
    assert "鮑伯" not in response.text
    assert await _unread(client, cast.alice) == 1

    await create_friendship(db_session, cast.bob, cast.alice, status=FriendshipStatus.PENDING)
    response = await client.get("/api/notifications", headers=auth(cast.alice))
    assert _who_did_what(response.json()["items"]) == [("小卡", "like")]
    assert "不該留在通知裡的預覽" not in response.text
    assert await _unread(client, cast.alice) == 1

    await unfriend(db_session, cast.alice, cast.bob)  # 把等著的那一列拿掉
    await create_friendship(db_session, cast.alice, cast.bob)
    assert _who_did_what(await _inbox(client, cast.alice)) == [
        ("小卡", "like"),
        ("鮑伯", "comment"),
        ("鮑伯", "like"),
    ]
    assert await _unread(client, cast.alice) == 3


async def test_going_private_keeps_the_owners_notifications(client, db_session, cast):
    """D5：那是主人自己的餐，關門不影響她看到別人已經留下的東西。"""
    await _like(client, cast.bob, cast.meal)
    await _comment(client, cast.bob, cast.meal, "關門之前留的")
    cast.meal.is_private = True
    await db_session.commit()

    items = await _inbox(client, cast.alice)
    assert [(i["actor_name"], i["type"], i["comment_preview"]) for i in items] == [
        ("鮑伯", "comment", "關門之前留的"),
        ("鮑伯", "like", None),
    ]
    assert items[0]["meal"]["id"] == cast.meal.id
    assert await _unread(client, cast.alice) == 2


# ---------- 清單的上限與順序 ----------


async def test_the_latest_fifty_newest_first(client, db_session, cast):
    for index in range(51):
        comment = await create_comment(
            db_session, meal=cast.meal, user=cast.bob, body=f"第{index}則"
        )
        db_session.add(
            Notification(
                user_id=cast.alice.id,
                actor_id=cast.bob.id,
                type=NotificationType.COMMENT,
                meal_id=cast.meal.id,
                comment_id=comment.id,
            )
        )
    await db_session.commit()

    items = await _inbox(client, cast.alice)

    assert [item["comment_preview"] for item in items] == [
        f"第{index}則" for index in range(50, 0, -1)
    ]
    assert await _unread(client, cast.alice) == 51  # 未讀數不受 50 則的上限影響


# ---------- 已讀 ----------


async def _read_all(client, user, up_to):
    return await client.post(
        "/api/notifications/read-all", headers=auth(user), json={"up_to": up_to}
    )


async def test_read_all_marks_up_to_what_was_seen_and_no_further(client, cast):
    await _like(client, cast.bob, cast.meal)
    await _comment(client, cast.bob, cast.meal)
    seen = await _inbox(client, cast.alice)
    await _like(client, cast.carol, cast.meal)  # 清單載入之後才到的

    response = await _read_all(client, cast.alice, seen[0]["id"])

    assert response.status_code == 200
    assert response.json() == {"count": 1}
    after = await _inbox(client, cast.alice)
    assert [(i["actor_name"], i["is_read"]) for i in after] == [
        ("小卡", False),
        ("鮑伯", True),
        ("鮑伯", True),
    ]
    assert await _unread(client, cast.alice) == 1


async def test_read_all_cannot_touch_someone_elses(client, db_session, cast):
    await _like(client, cast.bob, cast.meal)
    [item] = await _inbox(client, cast.alice)

    response = await _read_all(client, cast.bob, item["id"] + 1000)

    assert response.status_code == 200
    assert response.json() == {"count": 0}
    assert await _unread(client, cast.alice) == 1
    [still] = await _inbox(client, cast.alice)
    assert still["is_read"] is False


async def test_read_all_also_marks_what_is_hidden_right_now(client, db_session, cast):
    """規格 §4.3：`read-all` 不套可見性——解除好友時看不到的那一則一起標掉，
    重新加好友之後它回來是已讀的，不會憑空多一個未讀。"""
    await _like(client, cast.bob, cast.meal)
    await _like(client, cast.carol, cast.meal)
    await unfriend(db_session, cast.alice, cast.bob)
    [visible] = await _inbox(client, cast.alice)
    assert visible["actor_name"] == "小卡"

    assert (await _read_all(client, cast.alice, visible["id"])).json() == {"count": 0}

    await create_friendship(db_session, cast.alice, cast.bob)
    assert [(i["actor_name"], i["is_read"]) for i in await _inbox(client, cast.alice)] == [
        ("小卡", True),
        ("鮑伯", True),
    ]
    assert await _unread(client, cast.alice) == 0


async def test_reading_again_does_not_restamp_what_was_already_read(client, db_session, cast):
    """共用交易裡 `now()` 不會動（整條測試是同一個外層交易）——比兩次的時間看不出差別。
    所以直接把已讀時間改成很久以前，看它有沒有被蓋掉。"""
    await _like(client, cast.bob, cast.meal)
    [item] = await _inbox(client, cast.alice)
    long_ago = datetime(2020, 1, 1, tzinfo=UTC)
    await db_session.execute(update(Notification).values(read_at=long_ago))
    await db_session.commit()

    await _read_all(client, cast.alice, item["id"])

    assert await db_session.scalar(select(Notification.read_at)) == long_ago


async def test_read_all_is_committed(client, db_session, cast):
    """共用 session 看得到沒 commit 的寫入；rollback 一次，沒 commit 的已讀會跟著不見。"""
    await _like(client, cast.bob, cast.meal)
    [item] = await _inbox(client, cast.alice)
    alice = auth(cast.alice)

    response = await client.post(
        "/api/notifications/read-all", headers=alice, json={"up_to": item["id"]}
    )
    assert response.json() == {"count": 0}
    await db_session.rollback()

    unread = await client.get("/api/notifications/unread-count", headers=alice)
    assert unread.json() == {"count": 0}


@pytest.mark.parametrize(
    "payload",
    [{}, {"up_to": 0}, {"up_to": -1}, {"up_to": 2**63}, {"up_to": "x"}, {"up_to": None}],
    ids=["missing", "zero", "negative", "too-big", "not-a-number", "null"],
)
async def test_read_all_validates_its_body(client, cast, payload):
    response = await client.post(
        "/api/notifications/read-all", headers=auth(cast.alice), json=payload
    )
    assert response.status_code == 422


async def test_read_all_accepts_the_largest_id_and_an_id_that_is_not_there(client, cast):
    await _like(client, cast.bob, cast.meal)

    assert (await _read_all(client, cast.alice, 2**63 - 1)).json() == {"count": 0}
    assert (await _read_all(client, cast.alice, MISSING)).status_code == 200


async def test_all_three_need_a_login(client):
    assert (await client.get("/api/notifications")).status_code == 401
    assert (await client.get("/api/notifications/unread-count")).status_code == 401
    assert (await client.post("/api/notifications/read-all", json={"up_to": 1})).status_code == 401


# ---------- 好友的通知（規格 D14、§5.7） ----------


async def _send_request(client, sender, target):
    response = await client.post(
        "/api/friends/requests",
        headers=auth(sender),
        json={"code": format_friend_code(target.friend_code)},
    )
    assert response.status_code in (200, 201), response.text
    return response


async def _pending_id(client, user, box: str, other) -> int:
    """`user` 的收件匣（incoming）或寄件匣（outgoing）裡，跟 `other` 的那一個邀請。
    用人去找：`make_cast` 裡阿丁給愛麗絲的邀請一直都在。"""
    requests = (await client.get("/api/friends/requests", headers=auth(user))).json()
    [request] = [r for r in requests[box] if r["person"]["id"] == other.id]
    return request["id"]


async def _accept(client, receiver, sender):
    request_id = await _pending_id(client, receiver, "incoming", sender)
    response = await client.post(
        f"/api/friends/requests/{request_id}/accept", headers=auth(receiver)
    )
    assert response.status_code == 200, response.text


async def _turn_down(client, who, box: str, other):
    request_id = await _pending_id(client, who, box, other)
    response = await client.delete(f"/api/friends/requests/{request_id}", headers=auth(who))
    assert response.status_code == 204, response.text


async def test_a_friend_request_tells_the_receiver(client, db_session, cast):
    response = await _send_request(client, cast.eve, cast.alice)
    assert response.status_code == 201 and response.json()["status"] == "pending"

    [item] = await _inbox(client, cast.alice)
    assert (item["type"], item["actor_name"], item["meal"], item["comment_preview"]) == (
        "friend_request",
        "伊芙",
        None,
        None,
    )
    assert item["is_read"] is False
    assert await _unread(client, cast.alice) == 1
    # 送的人自己、愛麗絲的好友：都沒有。
    assert await _inbox(client, cast.eve) == [] and await _inbox(client, cast.bob) == []
    assert await _rows(db_session) == 1


async def test_accepting_tells_the_sender_and_retires_the_request_notice(client, cast):
    await _send_request(client, cast.eve, cast.alice)
    assert len(await _inbox(client, cast.alice)) == 1

    await _accept(client, cast.alice, cast.eve)

    [item] = await _inbox(client, cast.eve)
    assert (item["type"], item["actor_name"], item["meal"], item["comment_preview"]) == (
        "friend_accepted",
        "愛麗絲",
        None,
        None,
    )
    assert await _unread(client, cast.eve) == 1
    # 邀請不在等了：收件人那一則不再顯示，未讀數也不算它。
    assert await _inbox(client, cast.alice) == []
    assert await _unread(client, cast.alice) == 0


@pytest.mark.parametrize(
    ("who_deletes", "box", "other"),
    [("alice", "incoming", "eve"), ("eve", "outgoing", "alice")],
    ids=["rejected", "withdrawn"],
)
async def test_rejecting_or_withdrawing_hides_the_request_notice(
    client, cast, who_deletes, box, other
):
    await _send_request(client, cast.eve, cast.alice)
    assert len(await _inbox(client, cast.alice)) == 1

    await _turn_down(client, getattr(cast, who_deletes), box, getattr(cast, other))

    assert await _inbox(client, cast.alice) == []
    assert await _unread(client, cast.alice) == 0
    # 沒有人因為拒絕或收回收到通知。
    assert await _inbox(client, cast.eve) == []


async def test_sending_to_someone_who_already_asked_makes_friends_and_tells_them(
    client, db_session, cast
):
    """阿丁的邀請還在等（`make_cast`）；愛麗絲用他的好友碼送邀請 → 直接成立。"""
    response = await _send_request(client, cast.alice, cast.dan)

    assert response.json()["status"] == "accepted"
    assert _who_did_what(await _inbox(client, cast.dan)) == [("愛麗絲", "friend_accepted")]
    assert await _inbox(client, cast.alice) == []
    assert await _rows(db_session) == 1


async def test_a_request_that_is_refused_writes_nothing(client, db_session, cast):
    """已經是好友（409）、已經送過（409）、自己的碼與不存在的碼（404）：都沒有通知。"""
    for sender, code, status in [
        (cast.bob, format_friend_code(cast.alice.friend_code), 409),
        (cast.dan, format_friend_code(cast.alice.friend_code), 409),
        (cast.eve, format_friend_code(cast.eve.friend_code), 404),
    ]:
        response = await client.post(
            "/api/friends/requests", headers=auth(sender), json={"code": code}
        )
        assert response.status_code == status, response.text

    assert await _rows(db_session) == 0


async def test_asking_again_after_a_rejection_leaves_one_fresh_notice(client, db_session, cast):
    await _send_request(client, cast.eve, cast.alice)
    [first] = await _inbox(client, cast.alice)
    await client.post(
        "/api/notifications/read-all", headers=auth(cast.alice), json={"up_to": first["id"]}
    )
    await _turn_down(client, cast.alice, "incoming", cast.eve)

    await _send_request(client, cast.eve, cast.alice)

    [again] = await _inbox(client, cast.alice)  # 一則，不是兩則
    assert again["id"] != first["id"] and again["is_read"] is False
    assert await _rows(db_session) == 1


async def test_an_old_request_notice_does_not_resurface_when_i_ask_them(client, cast):
    """伊芙邀愛麗絲、愛麗絲拒絕；後來換愛麗絲邀伊芙。這一對現在又有一列「在等」，
    但那是愛麗絲送的——愛麗絲那則舊的「伊芙想加你為好友」不能跟著冒出來。"""
    await _send_request(client, cast.eve, cast.alice)
    await _turn_down(client, cast.alice, "incoming", cast.eve)

    await _send_request(client, cast.alice, cast.eve)

    assert await _inbox(client, cast.alice) == []
    assert _who_did_what(await _inbox(client, cast.eve)) == [("愛麗絲", "friend_request")]


async def test_a_request_to_someone_else_does_not_revive_my_notice(client, cast):
    """伊芙邀愛麗絲、被拒絕；伊芙接著邀鮑伯（那一個還在等）。愛麗絲的通知看的是
    「伊芙給**我**的邀請還在不在」，不是「伊芙有沒有任何一個邀請在等」。"""
    await _send_request(client, cast.eve, cast.alice)
    await _turn_down(client, cast.alice, "incoming", cast.eve)

    await _send_request(client, cast.eve, cast.bob)

    assert await _inbox(client, cast.alice) == []
    assert _who_did_what(await _inbox(client, cast.bob)) == [("伊芙", "friend_request")]


async def test_unfriending_hides_the_accepted_notice(client, db_session, cast):
    """伊芙另外還有鮑伯這個好友：解除之後她仍然「有好友」，只是不是愛麗絲。"""
    await create_friendship(db_session, cast.eve, cast.bob)
    await _send_request(client, cast.eve, cast.alice)
    await _accept(client, cast.alice, cast.eve)
    assert len(await _inbox(client, cast.eve)) == 1

    await unfriend(db_session, cast.alice, cast.eve)

    assert await _inbox(client, cast.eve) == []
    assert await _unread(client, cast.eve) == 0


async def test_becoming_friends_again_keeps_their_older_notifications(client, db_session, cast):
    """好友通知「只留最新一則」的那個 DELETE 不能掃到讚與留言的通知。"""
    await _like(client, cast.bob, cast.meal)
    await _comment(client, cast.bob, cast.meal, "解除之前留的")
    await unfriend(db_session, cast.alice, cast.bob)
    await _send_request(client, cast.bob, cast.alice)
    # 邀請還在等：看得到的只有邀請那一則，讚與留言的還藏著。
    assert _who_did_what(await _inbox(client, cast.alice)) == [("鮑伯", "friend_request")]

    await _accept(client, cast.alice, cast.bob)

    assert _who_did_what(await _inbox(client, cast.alice)) == [
        ("鮑伯", "comment"),
        ("鮑伯", "like"),
    ]
    assert _who_did_what(await _inbox(client, cast.bob)) == [("愛麗絲", "friend_accepted")]


async def test_each_direction_keeps_its_own_notice(client, db_session, cast):
    """「只留最新一則」是**同一個方向**的：愛麗絲接受伊芙時刪的是（伊芙 ← 愛麗絲）那一則，
    不是（愛麗絲 ← 伊芙）的，也不是別人的。"""
    await _send_request(client, cast.eve, cast.alice)
    await _send_request(client, cast.eve, cast.bob)
    await _accept(client, cast.alice, cast.eve)

    # 愛麗絲 ← 伊芙（邀請，藏起來了）、鮑伯 ← 伊芙（邀請）、伊芙 ← 愛麗絲（接受）。
    assert await _rows(db_session) == 3
    assert _who_did_what(await _inbox(client, cast.bob)) == [("伊芙", "friend_request")]
    assert _who_did_what(await _inbox(client, cast.eve)) == [("愛麗絲", "friend_accepted")]

    # 同一個收件人、另一個動作者：小卡也邀鮑伯，伊芙那一則還在。
    await _send_request(client, cast.carol, cast.bob)
    assert _who_did_what(await _inbox(client, cast.bob)) == [
        ("小卡", "friend_request"),
        ("伊芙", "friend_request"),
    ]


async def test_the_friend_notices_are_committed_with_the_request(client, db_session, cast):
    """共用 session 看得到沒 commit 的寫入。端點回來之後 rollback 一次：通知如果是在
    commit 之後才寫的（不在邀請的那個交易裡），這裡會不見。"""
    alice, eve = auth(cast.alice), auth(cast.eve)
    code = format_friend_code(cast.alice.friend_code)

    sent = await client.post("/api/friends/requests", headers=eve, json={"code": code})
    assert sent.status_code == 201
    await db_session.rollback()
    [notice] = (await client.get("/api/notifications", headers=alice)).json()["items"]
    assert notice["type"] == "friend_request"

    requests = (await client.get("/api/friends/requests", headers=alice)).json()
    [request_id] = [r["id"] for r in requests["incoming"] if r["person"]["display_name"] == "伊芙"]
    accepted = await client.post(f"/api/friends/requests/{request_id}/accept", headers=alice)
    assert accepted.status_code == 200
    await db_session.rollback()
    [notice] = (await client.get("/api/notifications", headers=eve)).json()["items"]
    assert notice["type"] == "friend_accepted"
