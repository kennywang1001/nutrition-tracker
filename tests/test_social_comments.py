"""留言的新增與刪除（社群規格 §5.3、§5.4）。"""

import pytest
from sqlalchemy import select

from app.models.social import MealComment
from app.ratelimit import COMMENT_LIMIT
from tests.factories import create_comment, create_friendship, create_meal
from tests.social_helpers import MISSING, auth, make_cast, unfriend


@pytest.fixture
async def cast(db_session):
    return await make_cast(db_session)


def _url(meal_id, comment_id=None) -> str:
    base = f"/api/social/meals/{meal_id}/comments"
    return base if comment_id is None else f"{base}/{comment_id}"


async def _post(client, user, meal_id, body="看起來好好吃"):
    return await client.post(_url(meal_id), headers=auth(user), json={"body": body})


async def _bodies(db_session, meal) -> list[str]:
    rows = await db_session.scalars(
        select(MealComment.body).where(MealComment.meal_id == meal.id).order_by(MealComment.id)
    )
    return list(rows)


# ---------- 新增 ----------


async def test_a_friend_comments_and_everyone_who_can_see_the_meal_reads_it(client, cast):
    response = await _post(client, cast.bob, cast.meal.id, "好吃嗎")

    assert response.status_code == 201
    created = response.json()
    assert set(created) == {"id", "display_name", "is_me", "can_delete", "body", "created_at"}
    assert (created["display_name"], created["is_me"], created["can_delete"]) == (
        "鮑伯",
        True,
        True,
    )
    assert created["body"] == "好吃嗎"
    assert created["created_at"].endswith(("Z", "+00:00"))
    # 不外流（D9）：回應裡沒有 email，也沒有任何一個 id 以外的「是誰」。
    assert "@example.com" not in response.text and "user_id" not in response.text

    seen = await client.get(f"/api/social/meals/{cast.meal.id}", headers=auth(cast.carol))
    assert [(c["id"], c["body"], c["is_me"]) for c in seen.json()["comments"]] == [
        (created["id"], "好吃嗎", False)
    ]


async def test_the_owner_commenting_on_their_own_meal_is_marked_as_theirs(client, cast):
    """主人可以留言（D2）。回應的 `is_me`／`can_delete` 是對「送出的人」算的。"""
    response = await _post(client, cast.alice, cast.meal.id, "謝謝")

    assert response.status_code == 201
    created = response.json()
    assert (created["display_name"], created["is_me"], created["can_delete"]) == (
        "愛麗絲",
        True,
        True,
    )


async def test_the_owner_can_comment_even_on_a_private_meal(client, db_session, cast):
    """先看得到一次（鮑伯 201），關起來之後才是 404——只斷言 404 的話網址打錯也會綠。"""
    assert (await _post(client, cast.bob, cast.meal.id, "關門之前")).status_code == 201
    cast.meal.is_private = True
    await db_session.commit()

    assert (await _post(client, cast.alice, cast.meal.id, "自己的筆記")).status_code == 201
    hidden = await _post(client, cast.bob, cast.meal.id)
    missing = await _post(client, cast.bob, MISSING)
    assert hidden.status_code == missing.status_code == 404
    assert hidden.content == missing.content
    assert await _bodies(db_session, cast.meal) == ["關門之前", "自己的筆記"]


async def test_a_comment_lands_on_that_meal_only(client, db_session, cast):
    other = await create_meal(db_session, user=cast.alice, items=[(cast.revision, 100)])

    assert (await _post(client, cast.bob, cast.meal.id, "這一餐的")).status_code == 201

    assert await _bodies(db_session, cast.meal) == ["這一餐的"]
    assert await _bodies(db_session, other) == []


async def test_the_body_is_cleaned_into_one_safe_line(client, db_session, cast):
    """換行、Tab、NUL 變成空白並壓成一個；格式字元（雙向控制字元 U+202E、零寬空白 U+200B）
    直接拿掉——不是換成空白，它們本來就沒有寬度。表情符號裡的 ZWJ 與 VS16（U+FE0F）留著。"""
    family = "".join(chr(code) for code in (0x1F468, 0x200D, 0x1F469, 0x200D, 0x1F467))
    heart = chr(0x2764) + chr(0xFE0F)
    parts = ["  好吃\n\t嗎", chr(0x202E), "真", chr(0x200B), "的", chr(0), " ", family, heart]
    raw = "".join(parts) + chr(0x200D) + "  "  # 結尾多一個沒有夾在兩個字中間的 ZWJ

    response = await _post(client, cast.bob, cast.meal.id, raw)

    assert response.status_code == 201
    assert response.json()["body"] == f"好吃 嗎真的 {family}{heart}"
    [stored] = await _bodies(db_session, cast.meal)
    assert stored == f"好吃 嗎真的 {family}{heart}"
    # 存進去的那一列裡沒有雙向控制字元與零寬空白；ZWJ 只剩表情符號裡的那兩個。
    assert chr(0x202E) not in stored and chr(0x200B) not in stored
    assert stored.count(chr(0x200D)) == 2


@pytest.mark.parametrize(
    ("body", "status"),
    [
        ("字" * 200, 201),
        ("字" * 201, 422),
        # 上限算的是清理之後：200 個字＋一堆會被清掉的空白仍然是 200。
        ("字" * 200 + " \n" * 100, 201),
        (chr(0x1F600) * 200, 201),  # 一個表情符號算一個字（code point），不是兩個
        (chr(0x1F600) * 201, 422),
        ("字", 201),
        ("", 422),
        ("   \n\t ", 422),
        (chr(0x202E) + chr(0), 422),  # 清完是空的
        # 只有看不見的字（審查 M2）：以前存得進去，畫面上是一則空的留言。
        (chr(0x200B), 422),
        (chr(0x200B) + " " + chr(0xFEFF) + chr(0x2060) + chr(0x200C), 422),
        (chr(0x200D), 422),  # 單獨的 ZWJ 也是看不見的
        # 200 個字中間夾了看不見的字：量的是清完之後的長度。
        (("字" + chr(0x200B)) * 200, 201),
        ("字" * 1001, 422),  # 清理之前的上限
        # 清理之前的上限**自己**擋的那一格：清完只剩一個字，200 那一道管不到它。
        ("字" + " " * 999, 201),
        ("字" + " " * 1000, 422),
    ],
    # 明寫 id：參數裡有控制字元與一千個字，不要讓 pytest 自己拿去當測試名稱。
    ids=[
        "200",
        "201",
        "200-padded",
        "emoji-200",
        "emoji-201",
        "one",
        "empty",
        "blank",
        "control",
        "zero-width",
        "zero-width-mixed",
        "lone-zwj",
        "200-with-zero-width",
        "raw",
        "raw-1000-padded",
        "raw-1001-padded",
    ],
)
async def test_the_length_limit_applies_after_cleaning(client, db_session, cast, body, status):
    response = await _post(client, cast.bob, cast.meal.id, body)

    assert response.status_code == status
    assert len(await _bodies(db_session, cast.meal)) == (1 if status == 201 else 0)


async def test_the_body_must_be_a_string(client, cast):
    for payload in ({}, {"body": None}, {"body": 5}, {"body": ["a"]}):
        response = await client.post(_url(cast.meal.id), headers=auth(cast.bob), json=payload)
        assert response.status_code == 422, payload


@pytest.mark.parametrize("who", ["dan", "eve"])
async def test_who_cannot_see_the_meal_cannot_comment(client, db_session, cast, who):
    viewer = getattr(cast, who)
    # 同一個網址、同一個 body，好友是 201：下面的 404 不是路徑或 body 打錯。
    assert (await _post(client, cast.carol, cast.meal.id, "看得到的人")).status_code == 201

    hidden = await _post(client, viewer, cast.meal.id)
    missing = await _post(client, viewer, MISSING)

    assert hidden.status_code == missing.status_code == 404
    assert hidden.content == missing.content
    assert hidden.json()["error"]["code"] == "MEAL_NOT_FOUND"
    assert await _bodies(db_session, cast.meal) == ["看得到的人"]


async def test_a_friend_of_a_friend_cannot_comment(client, db_session, cast):
    """伊芙是鮑伯的好友、不是愛麗絲的。`make_cast` 的阿丁與伊芙一個已接受的好友都沒有，
    分不出「主人的好友」與「有任何一個好友」——這一條補上那一格。"""
    await create_friendship(db_session, cast.eve, cast.bob)

    hidden = await _post(client, cast.eve, cast.meal.id)
    missing = await _post(client, cast.eve, MISSING)

    assert hidden.status_code == missing.status_code == 404
    assert hidden.content == missing.content
    assert await _bodies(db_session, cast.meal) == []
    # 她的好友（鮑伯）照樣可以。
    assert (await _post(client, cast.bob, cast.meal.id)).status_code == 201


async def test_after_unfriending_no_more_comments(client, db_session, cast):
    assert (await _post(client, cast.bob, cast.meal.id, "之前")).status_code == 201
    await unfriend(db_session, cast.alice, cast.bob)

    hidden = await _post(client, cast.bob, cast.meal.id, "之後")
    missing = await _post(client, cast.bob, MISSING, "之後")
    assert hidden.status_code == missing.status_code == 404
    assert hidden.content == missing.content
    assert await _bodies(db_session, cast.meal) == ["之前"]


async def test_comments_are_limited_per_person(client, cast):
    # 規格 D20 的數字釘在這裡：下面的迴圈用的是同一個常數，改了常數測試會跟著走。
    assert COMMENT_LIMIT == 20
    for index in range(COMMENT_LIMIT):
        assert (await _post(client, cast.bob, cast.meal.id, f"第{index}則")).status_code == 201

    blocked = await _post(client, cast.bob, cast.meal.id, "太多了")

    assert blocked.status_code == 429
    assert blocked.json()["error"]["code"] == "TOO_MANY_COMMENTS"
    assert 1 <= int(blocked.headers["Retry-After"]) <= 60
    assert (await _post(client, cast.carol, cast.meal.id)).status_code == 201


async def test_the_limit_counts_attempts_on_meals_you_cannot_see(client, cast):
    """限速在可見性之前（規格 §5.3 的順序）：拿 id 亂試的人也會用完額度。"""
    for _ in range(COMMENT_LIMIT):
        assert (await _post(client, cast.eve, cast.meal.id)).status_code == 404

    assert (await _post(client, cast.eve, cast.meal.id)).status_code == 429


@pytest.mark.parametrize("meal_id", [0, -1, 2**63])
async def test_an_id_that_cannot_be_a_meal_is_422_not_500(client, cast, meal_id):
    assert (await _post(client, cast.bob, meal_id)).status_code == 422
    assert (
        await client.delete(_url(meal_id, 1), headers=auth(cast.bob))
    ).status_code == 422
    assert (
        await client.delete(_url(cast.meal.id, meal_id), headers=auth(cast.bob))
    ).status_code == 422


# ---------- 刪除 ----------


async def _delete(client, user, meal_id, comment_id):
    return await client.delete(_url(meal_id, comment_id), headers=auth(user))


async def test_the_author_deletes_their_own_and_only_that_one(client, db_session, cast):
    mine = await create_comment(db_session, meal=cast.meal, user=cast.bob, body="我的")
    await create_comment(db_session, meal=cast.meal, user=cast.bob, body="也是我的")
    mine_id = mine.id

    response = await _delete(client, cast.bob, cast.meal.id, mine_id)

    assert response.status_code == 204 and response.content == b""
    assert await _bodies(db_session, cast.meal) == ["也是我的"]
    # 再刪一次：已經不在了。
    again = await _delete(client, cast.bob, cast.meal.id, mine_id)
    assert again.status_code == 404
    error = again.json()["error"]
    assert (error["code"], error["message"]) == ("COMMENT_NOT_FOUND", "找不到這則留言")


async def test_the_owner_deletes_anyones_comment_on_their_meal(client, db_session, cast):
    theirs = await create_comment(db_session, meal=cast.meal, user=cast.carol, body="小卡的")
    await create_comment(db_session, meal=cast.meal, user=cast.bob, body="鮑伯的")

    assert (await _delete(client, cast.alice, cast.meal.id, theirs.id)).status_code == 204
    assert await _bodies(db_session, cast.meal) == ["鮑伯的"]


async def test_a_third_person_cannot_delete_someone_elses_comment(client, db_session, cast):
    """小卡看得到鮑伯的留言（所以「看不到這一餐」那道過濾無效），但那不是她的、餐也不是她的。"""
    theirs = await create_comment(db_session, meal=cast.meal, user=cast.bob, body="鮑伯的")
    owners = await create_comment(db_session, meal=cast.meal, user=cast.alice, body="主人的")
    seen = await client.get(f"/api/social/meals/{cast.meal.id}", headers=auth(cast.carol))
    assert [(c["body"], c["can_delete"]) for c in seen.json()["comments"]] == [
        ("鮑伯的", False),
        ("主人的", False),
    ]

    refused = await _delete(client, cast.carol, cast.meal.id, theirs.id)
    refused_owners = await _delete(client, cast.carol, cast.meal.id, owners.id)
    missing = await _delete(client, cast.carol, cast.meal.id, MISSING)

    assert refused.status_code == refused_owners.status_code == missing.status_code == 404
    assert refused.content == refused_owners.content == missing.content
    assert refused.json()["error"]["code"] == "COMMENT_NOT_FOUND"
    assert await _bodies(db_session, cast.meal) == ["鮑伯的", "主人的"]


async def test_owning_another_meal_does_not_let_you_delete_through_it(client, db_session, cast):
    """IDOR：小卡是**她自己那一餐**的主人；把別的餐的留言 id 掛在自己的餐底下刪。"""
    theirs = await create_comment(db_session, meal=cast.meal, user=cast.bob, body="鮑伯的")
    carols_meal = await create_meal(db_session, user=cast.carol)

    response = await _delete(client, cast.carol, carols_meal.id, theirs.id)

    assert response.status_code == 404
    assert response.json()["error"]["code"] == "COMMENT_NOT_FOUND"
    assert await _bodies(db_session, cast.meal) == ["鮑伯的"]


async def test_a_comment_is_only_deletable_under_its_own_meal(client, db_session, cast):
    """同一個主人的兩餐：留言在第一餐，網址寫第二餐。主人與作者都看得到兩餐、都有權刪那一則，
    擋下來的只剩「它屬於路徑上的這一餐」那一個條件。"""
    other = await create_meal(db_session, user=cast.alice, items=[(cast.revision, 100)])
    theirs = await create_comment(db_session, meal=cast.meal, user=cast.bob, body="鮑伯的")

    for who in (cast.alice, cast.bob):
        response = await _delete(client, who, other.id, theirs.id)
        assert response.status_code == 404
        assert response.json()["error"]["code"] == "COMMENT_NOT_FOUND"
    assert await _bodies(db_session, cast.meal) == ["鮑伯的"]


@pytest.mark.parametrize("who", ["dan", "eve"])
async def test_who_cannot_see_the_meal_cannot_delete(client, db_session, cast, who):
    viewer = getattr(cast, who)
    own = await create_comment(db_session, meal=cast.meal, user=viewer, body="混進來的")

    response = await _delete(client, viewer, cast.meal.id, own.id)
    missing = await _delete(client, viewer, MISSING, own.id)

    assert response.status_code == 404
    assert response.json()["error"]["code"] == "MEAL_NOT_FOUND"
    assert response.content == missing.content
    assert await _bodies(db_session, cast.meal) == ["混進來的"]


async def test_a_friend_of_a_friend_cannot_delete(client, db_session, cast):
    """伊芙是鮑伯的好友、不是愛麗絲的：連她自己（混進來的）那一則都刪不到。"""
    await create_friendship(db_session, cast.eve, cast.bob)
    own = await create_comment(db_session, meal=cast.meal, user=cast.eve, body="混進來的")
    bobs = await create_comment(db_session, meal=cast.meal, user=cast.bob, body="鮑伯的")

    for comment in (own, bobs):
        response = await _delete(client, cast.eve, cast.meal.id, comment.id)
        assert response.status_code == 404
        assert response.json()["error"]["code"] == "MEAL_NOT_FOUND"
    assert await _bodies(db_session, cast.meal) == ["混進來的", "鮑伯的"]


async def test_an_unfriended_author_can_no_longer_delete(client, db_session, cast):
    """規格 §9.1 第 2 點（已知限制）：看不到那一餐了，留言被藏起來、也收不回來。"""
    mine = await create_comment(db_session, meal=cast.meal, user=cast.bob, body="我的")
    gone = await create_comment(db_session, meal=cast.meal, user=cast.bob, body="先刪一則")
    mine_id = mine.id
    # 還是好友的時候刪得掉——同一個人、同一種網址。
    assert (await _delete(client, cast.bob, cast.meal.id, gone.id)).status_code == 204
    await unfriend(db_session, cast.alice, cast.bob)

    refused = await _delete(client, cast.bob, cast.meal.id, mine_id)
    missing = await _delete(client, cast.bob, MISSING, mine_id)
    assert refused.status_code == 404
    assert refused.json()["error"]["code"] == "MEAL_NOT_FOUND"
    assert refused.content == missing.content
    assert await _bodies(db_session, cast.meal) == ["我的"]
    # 主人還是刪得掉——就算它現在不顯示。
    assert (await _delete(client, cast.alice, cast.meal.id, mine_id)).status_code == 204
    assert await _bodies(db_session, cast.meal) == []


async def test_going_private_the_author_cannot_delete_but_the_owner_can(client, db_session, cast):
    """D5：關門之後好友連自己的留言都刪不到（看不到那一餐）；主人照樣管得到。"""
    mine = await create_comment(db_session, meal=cast.meal, user=cast.bob, body="我的")
    mine_id = mine.id
    cast.meal.is_private = True
    await db_session.commit()

    refused = await _delete(client, cast.bob, cast.meal.id, mine_id)
    assert refused.status_code == 404
    assert refused.json()["error"]["code"] == "MEAL_NOT_FOUND"
    assert await _bodies(db_session, cast.meal) == ["我的"]

    assert (await _delete(client, cast.alice, cast.meal.id, mine_id)).status_code == 204


async def test_both_writes_are_committed(client, db_session, cast):
    """共用 session 的夾具看得到沒 commit 的寫入——端點忘了 commit 也會綠。
    這裡在端點回來之後 rollback 一次：沒 commit 的東西會跟著不見（handover §6 第 11 種）。"""
    old = await create_comment(db_session, meal=cast.meal, user=cast.bob, body="要刪的")
    meal_id, old_id = cast.meal.id, old.id
    bob, alice = auth(cast.bob), auth(cast.alice)

    assert (await client.delete(_url(meal_id, old_id), headers=alice)).status_code == 204
    await db_session.rollback()
    assert (await client.post(_url(meal_id), headers=bob, json={"body": "新的"})).status_code == 201
    await db_session.rollback()

    rows = await db_session.scalars(
        select(MealComment.body).where(MealComment.meal_id == meal_id).order_by(MealComment.id)
    )
    assert list(rows) == ["新的"]


async def test_comments_need_a_login(client, db_session, cast):
    comment = await create_comment(db_session, meal=cast.meal, user=cast.bob, body="還在")

    assert (await client.post(_url(cast.meal.id), json={"body": "嗨"})).status_code == 401
    assert (await client.delete(_url(cast.meal.id, comment.id))).status_code == 401
    assert await _bodies(db_session, cast.meal) == ["還在"]
