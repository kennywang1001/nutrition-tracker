from fastapi import FastAPI

from app.api.routes import auth, health
from app.errors import register_error_handlers

app = FastAPI(title="飲食紀錄 API", version="0.1.0")
register_error_handlers(app)
app.include_router(health.router, prefix="/api")
app.include_router(auth.router, prefix="/api")
