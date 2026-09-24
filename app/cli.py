import argparse
import asyncio
import logging
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, cast

from sqlalchemy import CursorResult, delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.db import SessionLocal
from app.models.meal import Meal
from app.models.session import RefreshSession
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


async def _upsert_account(
    db: AsyncSession,
    email: str,
    password: str,
    display_name: str,
    *,
    role: UserRole,
    on_existing_admin: str | None = None,
) -> tuple[User, bool]:
    """建立或更新一個帳號。

    `on_existing_admin` 不是 `None` 時，遇到既有的管理員就拋
    `ValueError(on_existing_admin)` 而**什麼都不改** —— 見 `create_regular_user`。
    """
    if len(password) < MIN_PASSWORD_LENGTH:
        raise ValueError(f"密碼至少 {MIN_PASSWORD_LENGTH} 個字元")

    email = email.strip().lower()

    user = await db.scalar(select(User).where(User.email == email))
    created = user is None

    if user is not None and on_existing_admin is not None and user.role is UserRole.ADMIN:
        # 在 **任何** 欄位被改之前就退出。拋在賦值之後的話，雖然沒 commit，
        # 但這個 session 裡的物件已經髒了 —— 之後任何一次 autoflush
        # （例如同一個 session 再發一條 SELECT）都會把它送進資料庫。
        #
        # 實測過（P3-B 計畫二 Task 1）：弄髒物件之後
        #   session.refresh(obj)          → 髒值被丟掉，讀回資料庫裡的值
        #   session.scalar(select(...))   → autoflush，髒值真的寫進去了
        #
        # 所以 `tests/test_cli.py` 那條測試刻意用 select 而不是 refresh ——
        # 用 refresh 的話，把這個 raise 延後到賦值之後，測試依然全綠。
        raise ValueError(on_existing_admin)

    if user is None:
        user = User(email=email, display_name=display_name)
        db.add(user)

    user.password_hash = hash_password(password)
    user.display_name = display_name
    user.role = role

    await db.commit()
    await db.refresh(user)
    return user, created


async def create_admin(
    db: AsyncSession, email: str, password: str, display_name: str
) -> tuple[User, bool]:
    """建立管理員帳號；若 email 已存在則提升為管理員並更新密碼。

    回傳 (user, created)，created 為 False 代表是提升既有帳號 —— 打錯 email 時
    會靜默重設別人的密碼，所以呼叫端必須把這件事講清楚。
    """
    return await _upsert_account(db, email, password, display_name, role=UserRole.ADMIN)


async def create_regular_user(
    db: AsyncSession, email: str, password: str, display_name: str
) -> tuple[User, bool]:
    """建立一般使用者帳號；若 email 已存在且本來就是一般使用者，更新密碼與名稱。

    回傳 (user, created)。

    **對既有管理員的行為刻意跟 `create_admin` 不對稱：拒絕，而且什麼都不改。**

    `create_admin` 對既有帳號是「提升」。如果這裡對既有帳號是「降級」，那麼
    打錯一個 email 就會把管理員默默降成一般使用者 —— 而那件事沒有任何畫面會
    顯示出來，要到下一次登入發現進不去審核佇列才知道。

    提升是可逆的（再跑一次 `create-admin`）；在「你不知道它發生了」的情況下
    降級不是。真的要降級，請明確地用資料庫改，那至少是一個你知道自己在做的動作。
    """
    return await _upsert_account(
        db,
        email,
        password,
        display_name,
        role=UserRole.USER,
        on_existing_admin="這個 email 已經是管理員，不會被降級；真要降級請直接改資料庫",
    )


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


async def cleanup_expired_sessions(db: AsyncSession, *, dry_run: bool = False) -> int:
    """刪掉 `expires_at` 已過的 refresh session 列，回傳筆數。

    **只看 `expires_at`，不看 `revoked_at`。** 一列已撤銷但還沒過期的紀錄，
    正是「這張票已經死了、而且是這樣死的」的唯一證據：提早刪掉的話，
    `rotate_session` 查不到列，走的是「找不到」那條路 —— 回應同樣是 401，
    測試同樣是綠的，但重用偵測的證據沒了，真正的攻擊會被降級成一次
    普通的失敗。過期之後才刪，那時 JWT 的 `exp` 已經自己擋住了。
    """
    cutoff = datetime.now(UTC)

    if dry_run:
        count = await db.scalar(
            select(func.count())
            .select_from(RefreshSession)
            .where(RefreshSession.expires_at < cutoff)
        )
        return count or 0

    # 單一 statement，不是「撈出來再一列一列 delete」——
    # 這張表每台活躍裝置每天長約 100 列，把幾千個 ORM 物件載進記憶體
    # 只為了刪掉它們，是沒有必要的。
    result = await db.execute(delete(RefreshSession).where(RefreshSession.expires_at < cutoff))
    await db.commit()
    # AsyncSession.execute() 的靜態型別是 Result[Any]——rowcount 定義在
    # CursorResult 上，但那正是 DML 陳述式實際回傳的物件。
    return cast(CursorResult[Any], result).rowcount


def _non_negative_hours(value: str) -> float:
    """`--min-age-hours` 不接受負數。

    負數會讓 `cutoff` 跑到未來，於是**每一個**檔案都「夠舊」——
    陷阱 5 的競態防護完全失效，包含一張剛寫入、DB 還沒 commit 的照片。
    `argparse` 的 `type=float` 不會擋這個，所以自己擋。

    0 是允許的：那是「我確定現在沒有上傳在進行，全部清掉」的刻意用法。
    """
    hours = float(value)
    if hours < 0:
        raise argparse.ArgumentTypeError(
            f"--min-age-hours 不能是負數（給了 {hours}）——"
            "負數會讓所有檔案都被視為夠舊，等於關掉防止刪到進行中上傳的保護。"
        )
    return hours


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="python -m app.cli")
    subparsers = parser.add_subparsers(dest="command", required=True)

    create_admin_parser = subparsers.add_parser("create-admin", help="建立或提升管理員帳號")
    create_admin_parser.add_argument("email")
    create_admin_parser.add_argument("password")
    create_admin_parser.add_argument("display_name")

    create_user_parser = subparsers.add_parser(
        "create-user", help="建立或更新一般使用者帳號（不會降級既有的管理員）"
    )
    create_user_parser.add_argument("email")
    create_user_parser.add_argument("password")
    create_user_parser.add_argument("display_name")

    cleanup_parser = subparsers.add_parser(
        "cleanup-photos", help="清理 photo_dir 底下沒被引用的孤兒照片"
    )
    cleanup_parser.add_argument(
        "--dry-run", action="store_true", help="只列出會刪除的檔案，不真的刪"
    )
    cleanup_parser.add_argument(
        "--min-age-hours",
        type=_non_negative_hours,
        default=DEFAULT_ORPHAN_MIN_AGE_HOURS,
        help=f"只刪除修改時間早於這個小時數之前的檔案（預設 {DEFAULT_ORPHAN_MIN_AGE_HOURS}）",
    )

    cleanup_sessions_parser = subparsers.add_parser(
        "cleanup-sessions", help="刪除已過期的 refresh session 紀錄"
    )
    cleanup_sessions_parser.add_argument(
        "--dry-run", action="store_true", help="只計算筆數，不真的刪"
    )

    return parser


async def _run_create_admin(email: str, password: str, display_name: str) -> None:
    async with SessionLocal() as db:
        user, created = await create_admin(db, email, password, display_name)
        if created:
            print(f"管理員帳號已建立：{user.email} (id={user.id})")
        else:
            print(f"既有帳號已提升為管理員，密碼已重設：{user.email} (id={user.id})")


async def _run_create_user(email: str, password: str, display_name: str) -> None:
    async with SessionLocal() as db:
        user, created = await create_regular_user(db, email, password, display_name)
        if created:
            print(f"一般使用者帳號已建立：{user.email} (id={user.id})")
        else:
            print(f"既有帳號的密碼已重設：{user.email} (id={user.id})")


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


async def _run_cleanup_sessions(*, dry_run: bool) -> None:
    async with SessionLocal() as db:
        count = await cleanup_expired_sessions(db, dry_run=dry_run)

    verb = "會刪除" if dry_run else "已刪除"
    print(f"{verb} {count} 筆過期的 refresh session")


async def _main(argv: list[str] | None = None) -> None:
    args = build_parser().parse_args(argv)
    if args.command == "create-admin":
        await _run_create_admin(args.email, args.password, args.display_name)
    elif args.command == "create-user":
        await _run_create_user(args.email, args.password, args.display_name)
    elif args.command == "cleanup-photos":
        await _run_cleanup_photos(dry_run=args.dry_run, min_age_hours=args.min_age_hours)
    elif args.command == "cleanup-sessions":
        await _run_cleanup_sessions(dry_run=args.dry_run)


if __name__ == "__main__":
    asyncio.run(_main())
