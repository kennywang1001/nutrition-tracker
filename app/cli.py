import argparse
import asyncio

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import SessionLocal
from app.models.user import User, UserRole
from app.security.password import hash_password

MIN_PASSWORD_LENGTH = 8


async def create_admin(
    db: AsyncSession, email: str, password: str, display_name: str
) -> User:
    """建立管理員帳號；若 email 已存在則提升為管理員並更新密碼。"""
    if len(password) < MIN_PASSWORD_LENGTH:
        raise ValueError(f"密碼至少 {MIN_PASSWORD_LENGTH} 個字元")

    user = await db.scalar(select(User).where(User.email == email))
    if user is None:
        user = User(email=email, password_hash=hash_password(password), display_name=display_name)
        db.add(user)

    user.password_hash = hash_password(password)
    user.display_name = display_name
    user.role = UserRole.ADMIN

    await db.commit()
    await db.refresh(user)
    return user


async def _main(email: str, password: str, display_name: str) -> None:
    async with SessionLocal() as db:
        user = await create_admin(db, email, password, display_name)
        print(f"管理員帳號已建立：{user.email} (id={user.id})")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="建立管理員帳號")
    parser.add_argument("email")
    parser.add_argument("password")
    parser.add_argument("display_name")
    args = parser.parse_args()
    asyncio.run(_main(args.email, args.password, args.display_name))
