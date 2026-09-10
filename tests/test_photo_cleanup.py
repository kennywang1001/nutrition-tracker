"""孤兒照片清理（P4 計畫 Task 6，見陷阱 5）。

規格第 8 節：兩種孤兒的嚴重性不對稱 —— 多一個沒人引用的檔案只是浪費磁碟，
少一個被引用的檔案是壞掉的功能。所以 DB 是權威來源，檔案允許落後。

陷阱 5 的核心風險：一張剛寫入、DB 還沒 commit 的照片，在掃描眼中就是孤兒。
上傳與 commit 之間的間隔是毫秒級，所以只刪修改時間早於某個閾值（預設 24 小時）
的檔案 —— 這個閾值刻意做成可傳入的參數，這裡直接釘住預設值與「閾值真的會
改變行為」，避免日後有人「順手簡化」成拿掉這層緩衝。
"""

import os
import time
from pathlib import Path

import pytest

from app.cli import DEFAULT_ORPHAN_MIN_AGE_HOURS, build_parser, cleanup_orphan_photos
from app.config import settings
from tests.factories import create_meal, create_user

HOUR = 3600


def _write_file(path: Path, *, age_hours: float) -> None:
    """在 path 寫一個檔案，並把 mtime 設成 age_hours 小時前。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"fake jpeg bytes")
    stamp = time.time() - age_hours * HOUR
    os.utime(path, (stamp, stamp))


@pytest.fixture(autouse=True)
def _photo_dir_in_tmp_path(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    # 絕對不能讓測試寫進真的 data/photos —— 跟 tests/test_photo_storage.py 同一個理由。
    monkeypatch.setattr(settings, "photo_dir", str(tmp_path))


async def test_a_referenced_file_is_not_deleted(db_session, tmp_path):
    user = await create_user(db_session)
    rel_path = f"{user.id}/referenced.jpg"
    _write_file(tmp_path / rel_path, age_hours=48)  # 夠舊，年齡本身不是它沒被刪的原因
    await create_meal(db_session, user=user, photo_path=rel_path)

    result = await cleanup_orphan_photos(db_session)

    assert (tmp_path / rel_path).exists()
    assert rel_path not in result.deleted


async def test_an_unreferenced_and_old_file_is_deleted(db_session, tmp_path):
    user = await create_user(db_session)
    rel_path = f"{user.id}/orphan.jpg"
    _write_file(tmp_path / rel_path, age_hours=48)

    result = await cleanup_orphan_photos(db_session)

    assert not (tmp_path / rel_path).exists()
    assert rel_path in result.deleted


async def test_an_unreferenced_but_recent_file_is_not_deleted(db_session, tmp_path):
    """陷阱 5 的競態緩衝：剛寫入、DB 還沒 commit 的照片不該被當成孤兒刪掉。"""
    user = await create_user(db_session)
    rel_path = f"{user.id}/just-uploaded.jpg"
    _write_file(tmp_path / rel_path, age_hours=0.01)  # 幾十秒前，遠低於門檻

    result = await cleanup_orphan_photos(db_session)

    assert (tmp_path / rel_path).exists()
    assert rel_path not in result.deleted


def test_default_min_age_hours_is_24():
    # 釘住預設值本身：這個常數是計畫陷阱 5 建議的緩衝寬度，
    # 不該被「順手簡化」成別的值而不被注意到。
    assert DEFAULT_ORPHAN_MIN_AGE_HOURS == 24


async def test_min_age_hours_is_a_real_parameter_not_a_hardcoded_constant(db_session, tmp_path):
    """用一個跟預設值（24 小時）行為不同的自訂閾值，證明它真的會改變行為 ——
    不是一個看起來能傳、實際上被忽略的參數。
    """
    user = await create_user(db_session)
    rel_path = f"{user.id}/two-hours-old.jpg"
    _write_file(tmp_path / rel_path, age_hours=2)

    # 預設 24 小時的門檻下，2 小時前的檔案不會被刪。
    default_result = await cleanup_orphan_photos(db_session)
    assert (tmp_path / rel_path).exists()
    assert rel_path not in default_result.deleted

    # 自訂成 1 小時的門檻下，同一個檔案該被刪。
    custom_result = await cleanup_orphan_photos(db_session, min_age_hours=1)
    assert not (tmp_path / rel_path).exists()
    assert rel_path in custom_result.deleted


async def test_dry_run_reports_but_does_not_delete(db_session, tmp_path):
    user = await create_user(db_session)
    rel_path = f"{user.id}/orphan.jpg"
    _write_file(tmp_path / rel_path, age_hours=48)

    result = await cleanup_orphan_photos(db_session, dry_run=True)

    assert (tmp_path / rel_path).exists(), "dry-run 不該真的刪除任何檔案"
    assert rel_path in result.deleted, "dry-run 仍然要回報「會刪除」的候選名單"
    assert result.dry_run is True


async def test_unexpected_file_in_the_directory_does_not_crash(db_session, tmp_path):
    """資料夾裡有非預期的檔案（不是任何使用者資料夾底下的 .jpg）時不炸。"""
    user = await create_user(db_session)
    referenced_path = f"{user.id}/keep.jpg"
    _write_file(tmp_path / referenced_path, age_hours=48)
    await create_meal(db_session, user=user, photo_path=referenced_path)

    stray_file = tmp_path / "stray.txt"
    _write_file(stray_file, age_hours=48)
    (tmp_path / "an-empty-directory").mkdir()

    result = await cleanup_orphan_photos(db_session)

    assert (tmp_path / referenced_path).exists()
    assert not stray_file.exists()  # 沒被引用、夠舊 -> 照樣當孤兒清掉，不因為長相特殊而崩潰
    assert "stray.txt" in result.deleted


async def test_photo_dir_that_does_not_exist_does_not_crash(db_session, tmp_path, monkeypatch):
    missing_dir = tmp_path / "does-not-exist"
    monkeypatch.setattr(settings, "photo_dir", str(missing_dir))

    result = await cleanup_orphan_photos(db_session)

    assert result.deleted == ()
    assert result.failed == ()


async def test_reports_how_many_files_it_deleted(db_session, tmp_path):
    user = await create_user(db_session)
    for i in range(3):
        _write_file(tmp_path / f"{user.id}/orphan-{i}.jpg", age_hours=48)
    referenced_path = f"{user.id}/keep.jpg"
    _write_file(tmp_path / referenced_path, age_hours=48)
    await create_meal(db_session, user=user, photo_path=referenced_path)

    result = await cleanup_orphan_photos(db_session)

    assert len(result.deleted) == 3


async def test_a_file_that_cannot_be_deleted_does_not_abort_the_whole_run(
    db_session, tmp_path, monkeypatch
):
    """刪不掉的檔案（例如權限問題）不讓整個指令失敗 —— 跟 delete_photo() 同一個
    best-effort 原則。用 monkeypatch 模擬其中一個檔案刪除時拋 OSError，
    確認其餘檔案仍然照常被刪、失敗的那個被記錄下來而不是讓整輪清理中止。
    """
    user = await create_user(db_session)
    bad_path = f"{user.id}/undeletable.jpg"
    good_path = f"{user.id}/deletable.jpg"
    _write_file(tmp_path / bad_path, age_hours=48)
    _write_file(tmp_path / good_path, age_hours=48)

    real_unlink = Path.unlink

    def fake_unlink(self: Path, *args: object, **kwargs: object) -> None:
        if self.name == "undeletable.jpg":
            raise PermissionError("simulated permission error")
        real_unlink(self, *args, **kwargs)  # type: ignore[arg-type]

    monkeypatch.setattr(Path, "unlink", fake_unlink)

    result = await cleanup_orphan_photos(db_session)

    assert (tmp_path / bad_path).exists(), "刪除失敗的檔案應該留在原地"
    assert not (tmp_path / good_path).exists(), "同一輪裡其他能刪的檔案不該被一起擋下"
    assert bad_path in result.failed
    assert good_path in result.deleted


def test_cli_parser_requires_a_subcommand():
    with pytest.raises(SystemExit):
        build_parser().parse_args([])


def test_cli_parser_accepts_create_admin_subcommand():
    args = build_parser().parse_args(["create-admin", "a@example.com", "password123", "顯示名稱"])

    assert args.command == "create-admin"
    assert args.email == "a@example.com"
    assert args.password == "password123"
    assert args.display_name == "顯示名稱"


def test_cli_parser_accepts_cleanup_photos_subcommand_with_options():
    args = build_parser().parse_args(
        ["cleanup-photos", "--dry-run", "--min-age-hours", "1.5"]
    )

    assert args.command == "cleanup-photos"
    assert args.dry_run is True
    assert args.min_age_hours == 1.5


def test_cli_parser_cleanup_photos_defaults_to_no_dry_run_and_default_age():
    args = build_parser().parse_args(["cleanup-photos"])

    assert args.dry_run is False
    assert args.min_age_hours == DEFAULT_ORPHAN_MIN_AGE_HOURS
