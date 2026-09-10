from fastapi import FastAPI

from app.api.routes import (
    admin_foods,
    auth,
    foods,
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

app = FastAPI(title="飲食紀錄 API", version="0.1.0")
register_error_handlers(app)
app.include_router(health.router, prefix="/api")
app.include_router(auth.router, prefix="/api")
app.include_router(me.router, prefix="/api")
app.include_router(foods.router, prefix="/api")
app.include_router(admin_foods.router, prefix="/api")
app.include_router(meals.router, prefix="/api")
app.include_router(supplements.router, prefix="/api")
app.include_router(supplement_plans.router, prefix="/api")
app.include_router(supplement_intakes.router, prefix="/api")
app.include_router(targets.router, prefix="/api")
app.include_router(stats.router, prefix="/api")
