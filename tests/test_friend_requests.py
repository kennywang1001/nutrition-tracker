import pytest
from sqlalchemy import func, select

from app.friend_codes import format_friend_code
from app.models.friendship import Friendship, FriendshipStatus
from app.security.tokens import create_access_token
from tests.factories import create_friendship, create_user


def auth(user):
    return {"Authorization": f"Bearer {create_access_token(user.id)}"}


async def _send(client, sender, code: str):
    return await client.post("/api/friends/requests", headers=auth(sender), json={"code": code})


async def _count(db_session) -> int:
    return await db_session.scalar(select(func.count()).select_from(Friendship))


async def test_sending_a_request_by_code(client, db_session):
    alice = await create_user(db_session, display_name="愛麗絲")
    bob = await create_user(db_session, display_name="鮑伯")
    alice_id, bob_id = alice.id, bob.id

    # 小寫、帶連字號：抄錯格式不該被拒絕。
    response = await _send(client, alice, format_friend_code(bob.friend_code).lower())

    assert response.status_code == 201
    assert response.json() == {
        "status": "pending",
        "person": {"id": bob_id, "display_name": "鮑伯"},
    }
    await db_session.rollback()
    row = await db_session.scalar(select(Friendship))
    assert row is not None
    assert (row.user_a, row.user_b) == tuple(sorted((alice_id, bob_id)))
    assert row.requested_by == alice_id
    assert row.status is FriendshipStatus.PENDING
    assert row.accepted_at is None


@pytest.mark.parametrize("whose", ["mine", "nobody"])
async def test_my_own_code_and_an_unknown_code_are_the_same_404(client, db_session, whose):
    alice = await create_user(db_session)
    code = alice.friend_code if whose == "mine" else "22222222"

    response = await _send(client, alice, code)

    assert response.status_code == 404
    assert response.json()["error"]["code"] == "FRIEND_CODE_NOT_FOUND"
    assert await _count(db_session) == 0


async def test_sending_twice_is_409_and_keeps_one_row(client, db_session):
    alice = await create_user(db_session)
    bob = await create_user(db_session)

    await _send(client, alice, bob.friend_code)
    again = await _send(client, alice, bob.friend_code)

    assert again.status_code == 409
    assert again.json()["error"]["code"] == "REQUEST_PENDING"
    assert await _count(db_session) == 1


async def test_sending_to_a_friend_is_409(client, db_session):
    alice = await create_user(db_session)
    bob = await create_user(db_session)
    await create_friendship(db_session, alice, bob)

    response = await _send(client, alice, bob.friend_code)

    assert response.status_code == 409
    assert response.json()["error"]["code"] == "ALREADY_FRIENDS"


async def test_when_the_other_side_already_asked_sending_makes_you_friends(client, db_session):
    alice = await create_user(db_session)
    bob = await create_user(db_session, display_name="鮑伯")
    await create_friendship(
        db_session, alice, bob, status=FriendshipStatus.PENDING, requested_by=bob
    )
    bob_id = bob.id

    response = await _send(client, alice, bob.friend_code)

    assert response.status_code == 200
    assert response.json() == {
        "status": "accepted",
        "person": {"id": bob_id, "display_name": "鮑伯"},
    }
    await db_session.rollback()
    row = await db_session.scalar(select(Friendship))
    assert row is not None
    assert row.status is FriendshipStatus.ACCEPTED
    assert row.accepted_at is not None
    assert await _count(db_session) == 1


async def test_a_simultaneous_send_from_the_other_side_turns_into_acceptance(
    client, db_session, monkeypatch
):
    """兩人同時互送：我查的時候還沒有那一列，INSERT 時對方已經寫進去了
    （計畫「與規格的差異」第 4 點：用 monkeypatch 讓第一次查詢看不到）。"""
    alice = await create_user(db_session)
    bob = await create_user(db_session)
    await create_friendship(
        db_session, alice, bob, status=FriendshipStatus.PENDING, requested_by=bob
    )
    from app.api.routes import friends as friends_routes

    real_load_pair = friends_routes._load_pair
    calls = 0

    async def first_lookup_sees_nothing(db, user_a, user_b):
        nonlocal calls
        calls += 1
        if calls == 1:
            return None
        return await real_load_pair(db, user_a, user_b)

    monkeypatch.setattr(friends_routes, "_load_pair", first_lookup_sees_nothing)

    response = await _send(client, alice, bob.friend_code)

    assert response.status_code == 200
    assert response.json()["status"] == "accepted"
    await db_session.rollback()
    assert await _count(db_session) == 1
    row = await db_session.scalar(select(Friendship))
    assert row is not None
    assert row.status is FriendshipStatus.ACCEPTED


async def test_listing_requests_splits_incoming_and_outgoing_without_emails(client, db_session):
    me = await create_user(db_session)
    carol = await create_user(db_session, display_name="卡蘿")
    dave = await create_user(db_session, display_name="戴夫")
    erin = await create_user(db_session, display_name="艾琳")
    incoming = await create_friendship(
        db_session, me, carol, status=FriendshipStatus.PENDING, requested_by=carol
    )
    outgoing = await create_friendship(
        db_session, me, dave, status=FriendshipStatus.PENDING, requested_by=me
    )
    await create_friendship(db_session, me, erin)

    response = await client.get("/api/friends/requests", headers=auth(me))

    assert response.status_code == 200
    body = response.json()
    assert [(r["id"], r["person"]["display_name"]) for r in body["incoming"]] == [
        (incoming.id, "卡蘿")
    ]
    assert [(r["id"], r["person"]["display_name"]) for r in body["outgoing"]] == [
        (outgoing.id, "戴夫")
    ]
    assert "@" not in response.text


async def test_only_the_receiver_can_accept(client, db_session):
    alice = await create_user(db_session, display_name="愛麗絲")
    bob = await create_user(db_session)
    stranger = await create_user(db_session)
    request = await create_friendship(
        db_session, alice, bob, status=FriendshipStatus.PENDING, requested_by=alice
    )
    request_id, alice_id = request.id, alice.id

    by_sender = await client.post(f"/api/friends/requests/{request_id}/accept", headers=auth(alice))
    by_stranger = await client.post(
        f"/api/friends/requests/{request_id}/accept", headers=auth(stranger)
    )
    by_receiver = await client.post(f"/api/friends/requests/{request_id}/accept", headers=auth(bob))
    again = await client.post(f"/api/friends/requests/{request_id}/accept", headers=auth(bob))

    for response in (by_sender, by_stranger, again):
        assert response.status_code == 404
        assert response.json()["error"]["code"] == "FRIEND_REQUEST_NOT_FOUND"
    assert by_receiver.status_code == 200
    assert by_receiver.json()["id"] == alice_id
    assert by_receiver.json()["display_name"] == "愛麗絲"
    await db_session.rollback()
    await db_session.refresh(request)
    assert request.status is FriendshipStatus.ACCEPTED


@pytest.mark.parametrize("who", ["sender", "receiver"])
async def test_declining_or_withdrawing_deletes_the_request(client, db_session, who):
    alice = await create_user(db_session)
    bob = await create_user(db_session)
    request = await create_friendship(
        db_session, alice, bob, status=FriendshipStatus.PENDING, requested_by=alice
    )
    actor = alice if who == "sender" else bob

    response = await client.delete(f"/api/friends/requests/{request.id}", headers=auth(actor))

    assert response.status_code == 204
    await db_session.rollback()
    assert await _count(db_session) == 0


async def test_strangers_and_friendships_cannot_be_deleted_as_requests(client, db_session):
    alice = await create_user(db_session)
    bob = await create_user(db_session)
    stranger = await create_user(db_session)
    pending = await create_friendship(
        db_session, alice, bob, status=FriendshipStatus.PENDING, requested_by=alice
    )
    carol = await create_user(db_session)
    accepted = await create_friendship(db_session, alice, carol)

    by_stranger = await client.delete(f"/api/friends/requests/{pending.id}", headers=auth(stranger))
    accepted_one = await client.delete(
        f"/api/friends/requests/{accepted.id}", headers=auth(alice)
    )

    for response in (by_stranger, accepted_one):
        assert response.status_code == 404
        assert response.json()["error"]["code"] == "FRIEND_REQUEST_NOT_FOUND"
    await db_session.rollback()
    assert await _count(db_session) == 2


async def test_after_a_decline_you_can_ask_again(client, db_session):
    alice = await create_user(db_session)
    bob = await create_user(db_session)
    first = await _send(client, alice, bob.friend_code)
    request_id = (
        await client.get("/api/friends/requests", headers=auth(bob))
    ).json()["incoming"][0]["id"]
    await client.delete(f"/api/friends/requests/{request_id}", headers=auth(bob))

    second = await _send(client, alice, bob.friend_code)

    assert first.status_code == 201
    assert second.status_code == 201


async def test_the_friend_list_has_only_accepted_friends_sorted_by_name(client, db_session):
    me = await create_user(db_session)
    zed = await create_user(db_session, display_name="Zed")
    amy = await create_user(db_session, display_name="Amy")
    waiting = await create_user(db_session, display_name="Waiting")
    await create_friendship(db_session, me, zed)
    await create_friendship(db_session, amy, me)
    await create_friendship(
        db_session, me, waiting, status=FriendshipStatus.PENDING, requested_by=me
    )

    response = await client.get("/api/friends", headers=auth(me))

    assert response.status_code == 200
    assert [friend["display_name"] for friend in response.json()] == ["Amy", "Zed"]
    assert all(set(friend) == {"id", "display_name", "since"} for friend in response.json())


@pytest.mark.parametrize("side", ["first", "second"])
async def test_either_side_can_unfriend(client, db_session, side):
    alice = await create_user(db_session)
    bob = await create_user(db_session)
    await create_friendship(db_session, alice, bob)
    actor, other = (alice, bob) if side == "first" else (bob, alice)

    response = await client.delete(f"/api/friends/{other.id}", headers=auth(actor))

    assert response.status_code == 204
    await db_session.rollback()
    assert await _count(db_session) == 0


async def test_unfriending_someone_who_is_not_a_friend_is_404(client, db_session):
    alice = await create_user(db_session)
    bob = await create_user(db_session)
    stranger = await create_user(db_session)
    await create_friendship(
        db_session, alice, bob, status=FriendshipStatus.PENDING, requested_by=alice
    )

    pending = await client.delete(f"/api/friends/{bob.id}", headers=auth(alice))
    nobody = await client.delete(f"/api/friends/{stranger.id}", headers=auth(alice))

    for response in (pending, nobody):
        assert response.status_code == 404
        assert response.json()["error"]["code"] == "FRIEND_NOT_FOUND"
    await db_session.rollback()
    assert await _count(db_session) == 1


async def test_the_database_refuses_a_self_friendship_and_a_reversed_pair(db_session):
    from sqlalchemy.exc import IntegrityError

    alice = await create_user(db_session)
    db_session.add(
        Friendship(
            user_a=alice.id,
            user_b=alice.id,
            requested_by=alice.id,
            status=FriendshipStatus.PENDING,
        )
    )
    with pytest.raises(IntegrityError, match="ck_friendships_ordered_pair"):
        await db_session.flush()
