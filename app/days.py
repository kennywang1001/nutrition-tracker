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


def month_bounds(year: int, month: int, tz_name: str) -> tuple[datetime, datetime]:
    """回傳該使用者當地某一個月的 UTC 起訖，半開區間 [start, end)。

    **刻意建立在 `day_bounds()` 之上，而不是自己組 datetime。** 時區轉換只有
    一份實作，這個函式就不可能跟 `day_bounds` 對「當地午夜是 UTC 幾點」
    有不同的看法——而那種不一致的具體表現，是每個月的第一筆與最後一筆支出
    跑到隔壁月去（規格 §5.4）。

    12 月的下個月是隔年 1 月。`month + 1` 會變成 13，`date(2026, 13, 1)`
    直接拋 ValueError——這是這個函式唯一會寫錯的地方，而且**一年只有一個月
    會錯**，所以測試寫死 12 月（`tests/test_days.py`）。
    """
    start, _ = day_bounds(date(year, month, 1), tz_name)
    next_year, next_month = (year + 1, 1) if month == 12 else (year, month + 1)
    next_start, _ = day_bounds(date(next_year, next_month, 1), tz_name)
    return start, next_start


def this_month_in_timezone(tz_name: str) -> tuple[int, int]:
    """使用者當地的「這個月」，回 (year, month)。

    給 `GET /api/expenses` 與 `GET /api/expenses/summary` 省略 `month=` 時
    當預設值用（規格 §5.3）。

    建立在 `today_in_timezone()` 之上、而且是模組內查找——理由跟那個函式的
    docstring 一樣：測試沒辦法 monkeypatch `datetime.now()`，只能替換我們
    自己的薄函式。
    """
    today = today_in_timezone(tz_name)
    return today.year, today.month
