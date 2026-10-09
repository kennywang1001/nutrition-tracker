"""社群三張表的資料庫保證（社群規格 §3）。這裡全部直接寫資料庫——端點的規則在別的檔案。"""

import pytest
from sqlalchemy import delete, func, select, text
from sqlalchemy.exc import IntegrityError

from app.models.meal import Meal
from app.models.social import MealComment, MealLike, Notification, NotificationType
from app.models.user import User
from tests.factories import create_comment, create_like, create_meal, create_user


@pytest.fixture
async def scene(db_session):
    owner = await create_user(db_session, display_name="主人")
    fan = await create_user(db_session, display_name="粉絲")
    meal = await create_meal(db_session, user=owner)
    return owner, fan, meal


async def _refused(db_session, sql: str, **params) -> str:
    """這個 INSERT 被資料庫擋下來 → 回錯誤訊息（裡面有約束的名字）。
    用 savepoint 包住：共用 session 整個 rollback 的話，之後的物件都會過期。"""
    with pytest.raises(IntegrityError) as caught:
        async with db_session.begin_nested():
            await db_session.execute(text(sql), params)
    return str(caught.value.orig)


async def _counts(db_session) -> tuple[int, int, int]:
    likes, comments, notes = [
        await db_session.scalar(select(func.count()).select_from(model))
        for model in (MealLike, MealComment, Notification)
    ]
    return likes, comments, notes


_LIKE = "INSERT INTO meal_likes (meal_id, user_id) VALUES (:meal, :user)"
_COMMENT = "INSERT INTO meal_comments (meal_id, user_id, body) VALUES (:meal, :user, :body)"
_NOTE = (
    "INSERT INTO notifications (user_id, actor_id, type, meal_id, comment_id)"
    " VALUES (:to, :by, :type, :meal, :comment)"
)


async def test_one_like_per_person_per_meal(db_session, scene):
    owner, fan, meal = scene
    await create_like(db_session, meal=meal, user=fan)
    other_meal = await create_meal(db_session, user=owner)

    error = await _refused(db_session, _LIKE, meal=meal.id, user=fan.id)

    assert "uq_meal_likes_meal_id_user_id" in error
    # 同一個人對另一餐、另一個人對同一餐都可以：擋的是那一對，不是其中一欄。
    await create_like(db_session, meal=other_meal, user=fan)
    await create_like(db_session, meal=meal, user=owner)


@pytest.mark.parametrize(("length", "ok"), [(0, False), (1, True), (200, True), (201, False)])
async def test_the_database_bounds_a_comments_length(db_session, scene, length, ok):
    owner, fan, meal = scene
    params = {"meal": meal.id, "user": fan.id, "body": "字" * length}
    if ok:
        await db_session.execute(text(_COMMENT), params)
    else:
        assert "ck_meal_comments_body_length" in await _refused(db_session, _COMMENT, **params)


async def test_a_notification_cannot_be_to_yourself(db_session, scene):
    owner, _, _ = scene
    error = await _refused(
        db_session, _NOTE, to=owner.id, by=owner.id, type="friend_accepted", meal=None, comment=None
    )
    assert "ck_notifications_not_self" in error


@pytest.mark.parametrize(
    ("kind", "with_meal", "with_comment"),
    [
        ("like", False, False),
        ("like", True, True),
        ("comment", True, False),
        ("comment", False, True),
        ("friend_request", True, False),
        ("friend_accepted", True, True),
        ("poke", False, False),
        ("poke", True, False),
    ],
)
async def test_a_notifications_shape_must_match_its_type(
    db_session, scene, kind, with_meal, with_comment
):
    owner, fan, meal = scene
    comment = await create_comment(db_session, meal=meal, user=fan)
    error = await _refused(
        db_session,
        _NOTE,
        to=owner.id,
        by=fan.id,
        type=kind,
        meal=meal.id if with_meal else None,
        comment=comment.id if with_comment else None,
    )
    assert "ck_notifications_shape_matches_type" in error


@pytest.mark.parametrize(
    ("kind", "with_meal", "with_comment"),
    [
        ("like", True, False),
        ("comment", True, True),
        ("friend_request", False, False),
        ("friend_accepted", False, False),
    ],
)
async def test_the_four_right_shapes_are_accepted(db_session, scene, kind, with_meal, with_comment):
    """上面那一條只證明「錯的被擋」。一條把什麼都擋掉的 CHECK 也會讓它全綠——
    這條是另一半：四種對的形狀真的寫得進去。"""
    owner, fan, meal = scene
    comment = await create_comment(db_session, meal=meal, user=fan)

    await db_session.execute(
        text(_NOTE),
        {
            "to": owner.id,
            "by": fan.id,
            "type": kind,
            "meal": meal.id if with_meal else None,
            "comment": comment.id if with_comment else None,
        },
    )

    assert (await _counts(db_session))[2] == 1


async def test_only_one_like_notification_per_actor_and_meal(db_session, scene):
    owner, fan, meal = scene
    first = await create_comment(db_session, meal=meal, user=fan, body="一")
    second = await create_comment(db_session, meal=meal, user=fan, body="二")
    like = {"to": owner.id, "by": fan.id, "type": "like", "meal": meal.id, "comment": None}
    await db_session.execute(text(_NOTE), like)

    assert "uq_notifications_like" in await _refused(db_session, _NOTE, **like)
    # 部分索引只管讚：同一個人在同一餐的兩則留言各有一則通知。
    for comment in (first, second):
        await db_session.execute(text(_NOTE), {**like, "type": "comment", "comment": comment.id})


async def _fill(db_session, owner, fan, meal) -> MealComment:
    await create_like(db_session, meal=meal, user=fan)
    comment = await create_comment(db_session, meal=meal, user=fan)
    db_session.add_all(
        [
            Notification(
                user_id=owner.id, actor_id=fan.id, type=NotificationType.LIKE, meal_id=meal.id
            ),
            Notification(
                user_id=owner.id,
                actor_id=fan.id,
                type=NotificationType.COMMENT,
                meal_id=meal.id,
                comment_id=comment.id,
            ),
        ]
    )
    await db_session.commit()
    return comment


async def test_deleting_a_meal_takes_everything_on_it_and_nothing_else(db_session, scene):
    owner, fan, meal = scene
    await _fill(db_session, owner, fan, meal)
    kept = await create_meal(db_session, user=owner)
    await _fill(db_session, owner, fan, kept)
    assert await _counts(db_session) == (2, 2, 4)

    await db_session.execute(delete(Meal).where(Meal.id == meal.id))
    await db_session.commit()

    # 另一餐的那一份還在：刪的是「這一餐的」，不是整張表（規矩 3）。
    assert await _counts(db_session) == (1, 1, 2)


async def test_deleting_a_comment_takes_only_its_notification(db_session, scene):
    owner, fan, meal = scene
    comment = await _fill(db_session, owner, fan, meal)

    await db_session.execute(delete(MealComment).where(MealComment.id == comment.id))
    await db_session.commit()

    assert await _counts(db_session) == (1, 0, 1)  # 讚與讚的通知還在


async def test_deleting_a_user_takes_what_they_did(db_session, scene):
    """現在沒有刪帳號的路（規格 §3.5）——這條守的是哪天有了，不會被 FK 擋成 500。"""
    owner, fan, meal = scene
    await _fill(db_session, owner, fan, meal)
    bystander = await create_user(db_session)
    await create_like(db_session, meal=meal, user=bystander)

    await db_session.execute(delete(User).where(User.id == fan.id))
    await db_session.commit()

    assert await _counts(db_session) == (1, 0, 0)
