from fastapi import APIRouter, Depends

from app.api.deps import get_current_user
from app.models.user import User
from app.schemas.auth import UserResponse

router = APIRouter(tags=["me"])


@router.get("/me", response_model=UserResponse)
async def read_me(user: User = Depends(get_current_user)) -> User:
    return user
