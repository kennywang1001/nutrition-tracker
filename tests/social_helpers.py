"""社群測試共用的一組人與小工具。"""

from datetime import datetime
from decimal import Decimal
from types import SimpleNamespace

from sqlalchemy import delete

from app.models.food import FoodRevision
from app.models.friendship import Friendship, FriendshipStatus
from app.security.tokens import create_access_token
from tests.factories import (
    create_expense,
    create_food,
    create_friendship,
    create_meal,
    create_user,
)

MISSING = 2**62  # 一定不存在的 id


def auth(user):
    return {"Authorization": f"Bearer {create_access_token(user.id)}"}


async def make_cast(db_session) -> SimpleNamespace:
    """愛麗絲是主人。鮑伯與小卡是她的好友、**彼此不是**；阿丁的邀請還在等；伊芙是陌生人。
    那一餐真的有餐費、備註、私人食物——「沒有外流」才不是空轉。
    餐費刻意是 4321.75：短的數字（180）會剛好出現在 id 或熱量裡。"""
    alice, bob, carol, dan, eve = [
        await create_user(db_session, display_name=name)
        for name in ("愛麗絲", "鮑伯", "小卡", "阿丁", "伊芙")
    ]
    await create_friendship(db_session, alice, bob)
    await create_friendship(db_session, carol, alice)
    await create_friendship(db_session, dan, alice, status=FriendshipStatus.PENDING)
    food = await create_food(db_session, created_by=alice, owner=alice, name="愛麗絲的私房菜")
    revision = await db_session.get(FoodRevision, food.current_revision_id)
    assert revision is not None
    meal = await create_meal(
        db_session,
        user=alice,
        eaten_at=datetime.fromisoformat("2026-10-06T04:00:00+00:00"),
        items=[(revision, 150)],
        note="今天心情很差",
        description="滷肉飯配燙青菜",
    )
    await create_expense(db_session, user=alice, amount=Decimal("4321.75"), meal=meal)
    return SimpleNamespace(
        alice=alice, bob=bob, carol=carol, dan=dan, eve=eve, meal=meal, food=food, revision=revision
    )


async def unfriend(db_session, one, other) -> None:
    user_a, user_b = sorted((one.id, other.id))
    deleted = await db_session.scalar(
        delete(Friendship)
        .where(Friendship.user_a == user_a, Friendship.user_b == user_b)
        .returning(Friendship.id)
    )
    assert deleted is not None  # 真的有東西可以解除
    await db_session.commit()
