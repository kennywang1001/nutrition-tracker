from fastapi import FastAPI

from app.api.routes import health

app = FastAPI(title="飲食紀錄 API", version="0.1.0")
app.include_router(health.router, prefix="/api")
