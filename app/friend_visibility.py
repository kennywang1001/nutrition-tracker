"""好友讀取的唯一入口（好友規格 §1.2、§4.3）。

**這個模組與 `app/api/routes/friends.py` 是整個後端唯二碰 `Friendship` 的地方**
（`tests/test_friend_meals.py` 的掃描測試守著）。既有端點不 import 這裡——
它們照舊只回自己的資料。
"""


def ordered_pair(first: int, second: int) -> tuple[int, int]:
    """`friendships` 的 `(user_a, user_b)`：小的在前（CHECK `user_a < user_b`）。"""
    return (first, second) if first < second else (second, first)
