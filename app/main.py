import logging

from fastapi import FastAPI

from app.api.routes import (
    admin_foods,
    admin_invites,
    admin_users,
    ai,
    auth,
    expenses,
    export,
    foods,
    friends,
    health,
    me,
    meals,
    stats,
    supplement_intakes,
    supplement_plans,
    supplements,
    targets,
)
from app.errors import register_error_handlers

# 稽核紀錄（帳號設定規格決定 17）：uvicorn 的預設設定只替 uvicorn.* 掛 handler，
# app.* 的 INFO 會落到 Python 的 lastResort（只輸出 WARNING 以上）——實測看不到。
# 這裡讓 app.* 自己輸出 INFO。propagate 照舊：root 沒有 handler 時不會重複印；
# pytest 的 caplog 掛在 root，照樣收得到。
_app_logger = logging.getLogger("app")
_app_logger.setLevel(logging.INFO)
if not _app_logger.handlers:
    _handler = logging.StreamHandler()
    _handler.setFormatter(logging.Formatter("%(levelname)s:     %(name)s: %(message)s"))
    _app_logger.addHandler(_handler)

app = FastAPI(title="飲食紀錄 API", version="0.1.0")
register_error_handlers(app)
app.include_router(health.router, prefix="/api")
app.include_router(auth.router, prefix="/api")
app.include_router(me.router, prefix="/api")
app.include_router(foods.router, prefix="/api")
app.include_router(friends.router, prefix="/api")
app.include_router(admin_foods.router, prefix="/api")
app.include_router(admin_invites.router, prefix="/api")
app.include_router(admin_users.router, prefix="/api")
app.include_router(meals.router, prefix="/api")
app.include_router(supplements.router, prefix="/api")
app.include_router(supplement_plans.router, prefix="/api")
app.include_router(supplement_intakes.router, prefix="/api")
app.include_router(targets.router, prefix="/api")
app.include_router(stats.router, prefix="/api")
app.include_router(ai.router, prefix="/api")
app.include_router(expenses.router, prefix="/api")
app.include_router(export.router, prefix="/api")
