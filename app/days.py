from datetime import UTC, date, datetime, time, timedelta
from zoneinfo import ZoneInfo


def day_bounds(day: date, tz_name: str) -> tuple[datetime, datetime]:
    """回傳該使用者當地某一天的 UTC 起訖，半開區間 [start, end)。"""
    tz = ZoneInfo(tz_name)
    start = datetime.combine(day, time.min, tzinfo=tz)
    end = datetime.combine(day + timedelta(days=1), time.min, tzinfo=tz)
    return start.astimezone(UTC), end.astimezone(UTC)


def today_in_timezone(tz_name: str) -> date:
    """使用者當地的「今天」。給 `GET /api/meals?date=` 省略 date 時當預設值用。

    抽成獨立函式（而不是直接在呼叫端寫 `datetime.now(UTC).astimezone(...)`）
    是刻意留一個可以在測試裡替換的接縫：`datetime.datetime` 是不可變的
    C 型別，測試沒辦法直接 monkeypatch 它的 `now()`；替換一個自己寫的
    薄函式，才能在不依賴真實時鐘的情況下測「沒帶 date 時預設今天」這件事。
    """
    return datetime.now(UTC).astimezone(ZoneInfo(tz_name)).date()
