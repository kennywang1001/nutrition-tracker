from datetime import UTC, date, datetime, timedelta

import pytest

from app import days
from app.days import day_bounds, month_bounds


def test_taipei_day_starts_at_16_00_utc_the_day_before():
    start, end = day_bounds(date(2026, 9, 4), "Asia/Taipei")
    assert start == datetime(2026, 9, 3, 16, 0, tzinfo=UTC)
    assert end == datetime(2026, 9, 4, 16, 0, tzinfo=UTC)


def test_a_spring_forward_day_is_23_hours_long():
    # 美東 2026-03-08 進入日光節約時間，這一天只有 23 小時
    start, end = day_bounds(date(2026, 3, 8), "America/New_York")
    assert end - start == timedelta(hours=23)


def test_a_fall_back_day_is_25_hours_long():
    # 美東 2026-11-01 退出日光節約時間，這一天有 25 小時
    start, end = day_bounds(date(2026, 11, 1), "America/New_York")
    assert end - start == timedelta(hours=25)


@pytest.mark.parametrize(
    ("tz_name", "day"),
    [
        ("America/New_York", date(2026, 3, 7)),
        ("America/New_York", date(2026, 3, 8)),
        ("America/New_York", date(2026, 10, 31)),
        ("America/New_York", date(2026, 11, 1)),
        # 這兩個時區的日光節約切換點就在午夜，當地的 00:00 根本不存在
        ("America/Havana", date(2026, 3, 8)),
        ("America/Santiago", date(2026, 9, 6)),
    ],
)
def test_consecutive_days_tile_the_timeline_with_no_gap_or_overlap(tz_name, day):
    """今天的結束必須恰好等於明天的開始 —— 半開區間才不會漏算或重複算一餐。"""
    _, end = day_bounds(day, tz_name)
    next_start, _ = day_bounds(day + timedelta(days=1), tz_name)
    assert end == next_start


def test_a_day_whose_local_midnight_does_not_exist_still_works():
    """古巴 2026-03-08 當地沒有 00:00 這一刻，但這一天依然要有明確的起訖。"""
    start, end = day_bounds(date(2026, 3, 8), "America/Havana")
    assert end - start == timedelta(hours=23)


def test_an_unknown_timezone_raises():
    with pytest.raises(Exception):  # noqa: B017 - 刻意不指定型別，只斷言「有拋」
        day_bounds(date(2026, 9, 4), "Mars/Olympus")


def test_the_timezone_database_is_actually_available():
    """守住「CI 綠、本機紅」的平台分裂：tzdata 沒裝時這個測試會第一個爆，
    而且訊息直接指向原因，不會讓人以為是日界線算錯。"""
    import importlib.util

    assert importlib.util.find_spec("tzdata") is not None, (
        "缺少 tzdata 套件；Windows 沒有系統時區資料庫，見計畫的「執行前提」"
    )


def test_month_bounds_taipei_september():
    """台北 9 月 1 日 00:00 = UTC 8 月 31 日 16:00（UTC+8）。

    這條測試守的是「月初不是 UTC 月初」。如果 month_bounds 忘了帶時區、
    直接用 datetime(year, month, 1)，start 會是 2026-09-01T00:00+00:00，
    這條就會紅。
    """
    start, end = month_bounds(2026, 9, "Asia/Taipei")

    assert start == datetime(2026, 8, 31, 16, 0, tzinfo=UTC)
    assert end == datetime(2026, 9, 30, 16, 0, tzinfo=UTC)


def test_month_bounds_december_rolls_over_to_next_year():
    """12 月的下個月是**隔年**1 月。

    `month + 1` 在 12 月會變成 13，datetime(2026, 13, 1) 直接拋 ValueError。
    這是這個函式唯一會寫錯的一行，而且**一年只有一個月會錯**——
    所以這條測試必須寫死 12 月，不能用 today()。
    """
    start, end = month_bounds(2026, 12, "Asia/Taipei")

    assert start == datetime(2026, 11, 30, 16, 0, tzinfo=UTC)
    assert end == datetime(2026, 12, 31, 16, 0, tzinfo=UTC)


def test_month_bounds_is_half_open():
    """[start, end)：end 是下個月的第一刻，不是這個月的最後一刻。

    如果寫成 23:59:59，恰好落在那一秒的支出會從兩個月份都消失。
    """
    _, september_end = month_bounds(2026, 9, "Asia/Taipei")
    october_start, _ = month_bounds(2026, 10, "Asia/Taipei")

    assert september_end == october_start


def test_month_bounds_utc_user():
    start, end = month_bounds(2026, 2, "UTC")

    assert start == datetime(2026, 2, 1, 0, 0, tzinfo=UTC)
    assert end == datetime(2026, 3, 1, 0, 0, tzinfo=UTC)


def test_this_month_in_timezone_matches_today(monkeypatch):
    """用 today_in_timezone 當接縫替換，不依賴真實時鐘。

    `datetime.datetime` 是不可變的 C 型別，測試沒辦法 monkeypatch 它的 now()
    ——這正是 today_in_timezone 當初被抽成獨立函式的原因（見它的 docstring）。
    this_month_in_timezone 必須建立在它之上，才繼承得到這個接縫。
    """
    monkeypatch.setattr(days, "today_in_timezone", lambda tz_name: date(2026, 12, 31))

    assert days.this_month_in_timezone("Asia/Taipei") == (2026, 12)
