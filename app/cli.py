import argparse
import asyncio
import logging
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.db import SessionLocal
from app.models.meal import Meal
from app.models.user import User, UserRole
from app.security.password import hash_password

MIN_PASSWORD_LENGTH = 8

# P4 計畫 Task 6、陷阱 5：一張剛寫入、DB 還沒 commit 的照片，在掃描眼中就是
# 孤兒。上傳與 commit 之間的間隔是毫秒級，24 小時的緩衝遠遠足夠。
#
# 這個值刻意做成 cleanup_orphan_photos() 可傳入的參數，不是寫死在函式內部——
# 測試會直接釘住這個預設值（test_default_min_age_hours_is_24），也會證明
# 傳入不同的值真的會改變行為（test_min_age_hours_is_a_real_parameter...），
# 避免日後有人「順手簡化」成拿掉這層緩衝。
DEFAULT_ORPHAN_MIN_AGE_HOURS = 24.0

logger = logging.getLogger(__name__)


async def create_admin(
    db: AsyncSession, email: str, password: str, display_name: str
) -> tuple[User, bool]:
    """建立管理員帳號；若 email 已存在則提升為管理員並更新密碼。

    回傳 (user, created)，created 為 False 代表是提升既有帳號 —— 打錯 email 時
    會靜默重設別人的密碼，所以呼叫端必須把這件事講清楚。
    """
    if len(password) < MIN_PASSWORD_LENGTH:
        raise ValueError(f"密碼至少 {MIN_PASSWORD_LENGTH} 個字元")

    email = email.strip().lower()

    user = await db.scalar(select(User).where(User.email == email))
    created = user is None
    if user is None:
        user = User(email=email, display_name=display_name)
        db.add(user)

    user.password_hash = hash_password(password)
    user.display_name = display_name
    user.role = UserRole.ADMIN

    await db.commit()
    await db.refresh(user)
    return user, created


@dataclass(frozen=True)
class CleanupResult:
    """孤兒照片清理的結果。

    `deleted`：相對於 photo_dir 的路徑清單。`dry_run=False` 時是真的刪掉的
    檔案；`dry_run=True` 時是「會被刪掉」但沒有真的動手的候選名單 —— 呼叫端
    要看 `dry_run` 決定怎麼呈現這份清單，這裡不重複存兩份欄位。

    `failed`：嘗試刪除但失敗（例如權限問題）的檔案。跟
    `app/storage/photos.py` 的 `delete_photo()` 同一個 best-effort 原則：
    一個檔案刪不掉，不該讓同一輪裡其他檔案的清理跟著失敗。
    """

    dry_run: bool
    deleted: tuple[str, ...] = field(default_factory=tuple)
    failed: tuple[str, ...] = field(default_factory=tuple)


def _scan_and_clean(
    root: Path,
    referenced_paths: set[str | None],
    cutoff: float,
    *,
    dry_run: bool,
) -> tuple[list[str], list[str]]:
    """實際掃描檔案系統、視情況刪除 —— 刻意寫成一般的同步函式（不是 async def），
    被 `cleanup_orphan_photos()` 丟進 `asyncio.to_thread()` 呼叫：pathlib 的
    I/O 方法是阻塞呼叫，直接寫在 `async def` 裡會卡住 event loop（ruff 的
    ASYNC240 也會擋這件事）。跟 Task 3 把 Argon2 移出 event loop 是同一個理由。
    """
    if not root.is_dir():
        return [], []

    deleted: list[str] = []
    failed: list[str] = []
    for path in sorted(root.rglob("*")):
        if not path.is_file():
            continue

        rel_path = path.relative_to(root).as_posix()
        if rel_path in referenced_paths:
            continue

        try:
            mtime = path.stat().st_mtime
        except OSError:
            # 掃描到刪除之間檔案自己消失了（例如別的行程剛好處理掉了）——
            # 不是這個函式要處理的錯誤，跳過即可，不算失敗。
            continue

        if mtime > cutoff:
            continue  # 太新，可能是還沒 commit 的上傳（陷阱 5）

        if dry_run:
            deleted.append(rel_path)
            continue

        try:
            path.unlink()
            deleted.append(rel_path)
        except OSError:
            logger.warning("刪除孤兒照片失敗：%s", path, exc_info=True)
            failed.append(rel_path)

    return deleted, failed


async def cleanup_orphan_photos(
    db: AsyncSession,
    *,
    dry_run: bool = False,
    min_age_hours: float = DEFAULT_ORPHAN_MIN_AGE_HOURS,
) -> CleanupResult:
    """掃 `photo_dir`，刪掉 DB 完全沒引用、而且夠舊的檔案。

    規格第 8 節：兩種孤兒的嚴重性不對稱 —— 多一個沒人引用的檔案只是浪費磁碟，
    少一個被引用的檔案是壞掉的功能。所以這裡以 DB 為準：只刪「`meals.photo_path`
    完全沒提到」的檔案；DB 有 `photo_path` 但磁碟上檔案不存在的情況，
    是 `app/storage/photos.py` 的 `read_photo()` 呼叫端要處理的事，不是這裡。

    陷阱 5：只刪修改時間早於 `min_age_hours` 之前的檔案，避免刪掉一張剛寫入、
    交易還沒 commit 的照片 —— 那種檔案在掃描當下看起來跟孤兒一模一樣。
    """
    root = Path(settings.photo_dir)

    referenced_paths = set(
        (await db.scalars(select(Meal.photo_path).where(Meal.photo_path.is_not(None)))).all()
    )

    cutoff = datetime.now(UTC).timestamp() - min_age_hours * 3600

    deleted, failed = await asyncio.to_thread(
        _scan_and_clean, root, referenced_paths, cutoff, dry_run=dry_run
    )

    return CleanupResult(dry_run=dry_run, deleted=tuple(deleted), failed=tuple(failed))


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="python -m app.cli")
    subparsers = parser.add_subparsers(dest="command", required=True)

    create_admin_parser = subparsers.add_parser("create-admin", help="建立或提升管理員帳號")
    create_admin_parser.add_argument("email")
    create_admin_parser.add_argument("password")
    create_admin_parser.add_argument("display_name")

    cleanup_parser = subparsers.add_parser(
        "cleanup-photos", help="清理 photo_dir 底下沒被引用的孤兒照片"
    )
    cleanup_parser.add_argument(
        "--dry-run", action="store_true", help="只列出會刪除的檔案，不真的刪"
    )
    cleanup_parser.add_argument(
        "--min-age-hours",
        type=float,
        default=DEFAULT_ORPHAN_MIN_AGE_HOURS,
        help=f"只刪除修改時間早於這個小時數之前的檔案（預設 {DEFAULT_ORPHAN_MIN_AGE_HOURS}）",
    )

    return parser


async def _run_create_admin(email: str, password: str, display_name: str) -> None:
    async with SessionLocal() as db:
        user, created = await create_admin(db, email, password, display_name)
        if created:
            print(f"管理員帳號已建立：{user.email} (id={user.id})")
        else:
            print(f"既有帳號已提升為管理員，密碼已重設：{user.email} (id={user.id})")


async def _run_cleanup_photos(*, dry_run: bool, min_age_hours: float) -> None:
    async with SessionLocal() as db:
        result = await cleanup_orphan_photos(db, dry_run=dry_run, min_age_hours=min_age_hours)

    verb = "會刪除" if dry_run else "已刪除"
    print(f"{verb} {len(result.deleted)} 個孤兒照片檔案")
    for rel_path in result.deleted:
        print(f"  {rel_path}")
    if result.failed:
        print(f"刪除失敗 {len(result.failed)} 個檔案（已略過，不影響其餘檔案）：")
        for rel_path in result.failed:
            print(f"  {rel_path}")


async def _main(argv: list[str] | None = None) -> None:
    args = build_parser().parse_args(argv)
    if args.command == "create-admin":
        await _run_create_admin(args.email, args.password, args.display_name)
    elif args.command == "cleanup-photos":
        await _run_cleanup_photos(dry_run=args.dry_run, min_age_hours=args.min_age_hours)


if __name__ == "__main__":
    asyncio.run(_main())
