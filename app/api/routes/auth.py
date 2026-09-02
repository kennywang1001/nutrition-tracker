from fastapi import APIRouter, Depends, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_db
from app.errors import ConflictError
from app.models.user import User
from app.schemas.auth import RegisterRequest, UserResponse
from app.security.password import hash_password

router = APIRouter(prefix="/auth", tags=["auth"])


@router.post("/register", status_code=status.HTTP_201_CREATED, response_model=UserResponse)
async def register(payload: RegisterRequest, db: AsyncSession = Depends(get_db)) -> User:
    existing = await db.scalar(select(User).where(User.email == payload.email))
    if existing is not None:
        raise ConflictError("EMAIL_TAKEN", "這個 email 已經註冊過了")

    user = User(
        email=payload.email,
        password_hash=hash_password(payload.password),
        display_name=payload.display_name,
    )
    db.add(user)
    await db.commit()
    await db.refresh(user)
    return user
