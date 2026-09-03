# P1 計畫 1：專案骨架 + 認證 實作計畫

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立可用 `docker compose up` 啟動的 FastAPI + PostgreSQL 專案骨架，完成使用者註冊、登入、JWT 驗證與角色權限，並建立整個 P1 後續都會依賴的測試基礎設施。

**Architecture:** 單一 FastAPI 應用，async SQLAlchemy 2.0 連 PostgreSQL 16，Alembic 管理 schema。測試跑真的 PostgreSQL（不用 SQLite），每個測試包在資料庫交易內、跑完 rollback，因此測試之間完全隔離且不需清資料。錯誤回應統一格式，由 exception handler 集中處理。

**Tech Stack:** Python 3.12、FastAPI、SQLAlchemy 2.0 (async) + asyncpg、Alembic、Pydantic v2 + pydantic-settings、PyJWT、argon2-cffi、pytest + pytest-asyncio + httpx、ruff、mypy、Docker Compose

**規格來源：** [docs/superpowers/specs/2026-09-02-diet-tracker-p1-design.md](../specs/2026-09-02-diet-tracker-p1-design.md) 第 4、6.1、7.1、9、10 節

---

## 檔案結構

實作完成後的專案長相：

```
pyproject.toml            依賴範圍、ruff / mypy / pytest 設定
requirements-lock.txt     實際鎖定的版本（CI 與新 clone 用）
Dockerfile                API 容器
docker-compose.yml        api + db 服務
alembic.ini               Alembic 設定
.env.example              環境變數範本
.github/workflows/ci.yml  CI

app/
  main.py                 FastAPI app 組裝（唯一組裝點）
  config.py               設定（pydantic-settings）
  db.py                   async engine / session / get_db
  errors.py               AppError 家族 + exception handlers
  cli.py                  建立管理員帳號的命令
  models/
    base.py               DeclarativeBase
    user.py               User / UserRole
  schemas/
    auth.py               註冊、登入、token 的請求與回應
  security/
    password.py           Argon2 雜湊與驗證
    tokens.py             JWT 建立與解碼
  api/
    deps.py               get_current_user / require_admin
    routes/
      health.py           健康檢查
      auth.py             註冊、登入、換發 token
      me.py               目前使用者

migrations/
  env.py
  versions/0001_create_users.py

tests/
  conftest.py             測試資料庫、交易隔離、HTTP client
  factories.py            測試資料產生器
  test_health.py
  test_config.py
  test_password.py
  test_tokens.py
  test_errors.py
  test_auth_register.py
  test_auth_login.py
  test_auth_me.py
  test_auth_refresh.py
  test_deps_admin.py
  test_cli.py
```

**分割原則：** 依「職責」而非「技術層」分。`security/` 裡的兩個檔案彼此不相依，各自可獨立測試。`api/routes/` 一個檔案一組端點。之後計畫 2~4 會在 `models/`、`schemas/`、`api/routes/` 各加自己的檔案，不動既有檔案。

---

## 執行前提

- 本機已安裝 Docker Desktop 與 Python 3.12
- 每個 Task 結束都要 commit
- 每個 Task 的測試步驟都要真的執行並看到預期輸出，不可跳過

---

### Task 1: 專案骨架與工具設定

**Files:**
- Create: `pyproject.toml`
- Create: `.env.example`
- Create: `requirements-lock.txt`
- Create: `app/__init__.py`
- Create: `tests/__init__.py`

- [ ] **Step 1: 建立 `pyproject.toml`**

```toml
[project]
name = "wallet"
version = "0.1.0"
description = "飲食紀錄系統"
requires-python = ">=3.12"
dependencies = [
    "fastapi>=0.115",
    "uvicorn[standard]>=0.32",
    "sqlalchemy[asyncio]>=2.0.36",
    "asyncpg>=0.30",
    "alembic>=1.14",
    "pydantic[email]>=2.9",
    "pydantic-settings>=2.6",
    "pyjwt>=2.10",
    "argon2-cffi>=23.1",
    "python-multipart>=0.0.17",
]

[project.optional-dependencies]
dev = [
    "pytest>=8.3",
    "pytest-asyncio>=0.24",
    "pytest-cov>=6.0",
    "httpx>=0.27",
    "ruff>=0.8",
    "mypy>=1.13",
]

[build-system]
requires = ["setuptools>=68"]
build-backend = "setuptools.build_meta"

[tool.setuptools.packages.find]
include = ["app*"]

[tool.ruff]
line-length = 100
target-version = "py312"

[tool.ruff.lint]
select = ["E", "F", "I", "N", "UP", "B", "SIM", "ASYNC"]

[tool.ruff.lint.flake8-bugbear]
# FastAPI 的依賴注入就是把 Depends() 寫在參數預設值，B008 會誤判
extend-immutable-calls = [
    "fastapi.Depends",
    "fastapi.params.Depends",
    "fastapi.Query",
    "fastapi.Path",
    "fastapi.Body",
    "fastapi.Security",
]

[tool.mypy]
python_version = "3.12"
strict = true
# FastAPI 的路由裝飾器沒有型別註記，strict 模式會全部報錯
disallow_untyped_decorators = false
plugins = ["pydantic.mypy"]

[[tool.mypy.overrides]]
module = ["tests.*"]
disallow_untyped_defs = false

[[tool.mypy.overrides]]
# asyncpg 沒有型別標記；之後攔截 IntegrityError.orig 時會需要
module = ["asyncpg.*"]
ignore_missing_imports = true

[tool.pytest.ini_options]
asyncio_mode = "auto"
asyncio_default_fixture_loop_scope = "function"
testpaths = ["tests"]
```

> **三個非顯而易見的設定，各自擋掉一個之後才會爆的問題：**
>
> - `extend-immutable-calls`：不加的話，Task 11 寫下第一個 `Depends(get_db)` 時
>   `ruff check` 就會失敗（B008 規則認為不該在參數預設值裡呼叫函式），而 CI 是綁定
>   lint 的，等於整條線斷掉。
> - `asyncio_default_fixture_loop_scope`：pytest-asyncio 1.x 沒設這個會每次跳警告，
>   而且 Task 7 的交易隔離 fixture 會踩到 event loop 不一致的問題。
> - `asyncpg` 的 mypy override：`strict` 模式下 import 沒有型別標記的套件會直接報錯。

- [ ] **Step 2: 建立 `.env.example`**

```
DATABASE_URL=postgresql+asyncpg://wallet:wallet@localhost:5433/wallet
TEST_DATABASE_URL=postgresql+asyncpg://wallet:wallet@localhost:5433/wallet_test
JWT_SECRET=dev-secret-change-me-in-production
PHOTO_DIR=data/photos
```

- [ ] **Step 3: 建立空的套件檔案**

```bash
mkdir -p app tests
touch app/__init__.py tests/__init__.py
```

- [ ] **Step 4: 建立虛擬環境並安裝**

```bash
python -m venv .venv
.venv/Scripts/activate      # Windows
pip install -e ".[dev]"
```

Expected: 安裝成功，無錯誤。

- [ ] **Step 5: 驗證工具可跑**

Run: `ruff check .`
Expected: `All checks passed!`

Run: `pytest`
Expected: `collected 0 items` / `no tests ran`（`pytest` 沒有測試時 exit code 是 5，這是正常的）

- [ ] **Step 6: 鎖定依賴版本**

```bash
pip freeze --exclude-editable > requirements-lock.txt
```

`--exclude-editable` 是必要的：constraints 檔不能包含 editable 安裝的 `wallet` 自己，
含進去整個檔案就不能用。

驗證它真的能當 constraints 檔用：

```bash
pip install --dry-run -c requirements-lock.txt -e ".[dev]"
```

> **為什麼要 lockfile：** `pyproject.toml` 只寫下限（`mypy>=1.13`），實際解析出來的是
> mypy **2.3.1** —— 跨了一個大版本。pytest 8.3→9.1、pytest-asyncio 0.24→1.4 也一樣。
> 這個專案是要放上 GitHub 讓別人 clone 的，半年後重新解析會得到完全不同的版本組合，
> 然後跑不起來。
>
> 分工是：`pyproject.toml` 負責「相容範圍」，`requirements-lock.txt` 負責
> 「CI 跟新 clone 實際拿到什麼」。

- [ ] **Step 7: Commit**

```bash
git add pyproject.toml .env.example app/__init__.py tests/__init__.py requirements-lock.txt
git commit -m "chore: 建立專案骨架與工具設定"
```

---

### Task 2: 健康檢查端點

先做一個不需要資料庫的端點，確認 FastAPI 與測試流程能跑通。

**Files:**
- Create: `app/main.py`
- Create: `app/api/__init__.py`, `app/api/routes/__init__.py`
- Create: `app/api/routes/health.py`
- Test: `tests/test_health.py`

- [ ] **Step 1: 寫失敗的測試**

`tests/test_health.py`:

```python
from httpx import ASGITransport, AsyncClient

from app.main import app


async def test_health_returns_ok():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.get("/api/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}
```

- [ ] **Step 2: 執行測試，確認失敗**

Run: `pytest tests/test_health.py -v`
Expected: FAIL，`ModuleNotFoundError: No module named 'app.main'`

- [ ] **Step 3: 寫最小實作**

```bash
mkdir -p app/api/routes
touch app/api/__init__.py app/api/routes/__init__.py
```

`app/api/routes/health.py`:

```python
from fastapi import APIRouter

router = APIRouter(tags=["health"])


@router.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}
```

`app/main.py`:

```python
from fastapi import FastAPI

from app.api.routes import health

app = FastAPI(title="飲食紀錄 API", version="0.1.0")
app.include_router(health.router, prefix="/api")
```

- [ ] **Step 4: 執行測試，確認通過**

Run: `pytest tests/test_health.py -v`
Expected: `1 passed`

- [ ] **Step 5: Commit**

```bash
git add app/main.py app/api tests/test_health.py
git commit -m "feat: 新增健康檢查端點"
```

---

### Task 3: Docker Compose 環境

**Files:**
- Create: `Dockerfile`
- Create: `.dockerignore`
- Create: `docker-compose.yml`

- [ ] **Step 1: 建立 `Dockerfile`**

```dockerfile
FROM python:3.12-slim

WORKDIR /app

COPY pyproject.toml requirements-lock.txt ./
COPY app/__init__.py ./app/__init__.py
RUN pip install --no-cache-dir -c requirements-lock.txt -e ".[dev]"

COPY . .

EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
```

> **三個設計決定：**
>
> 1. **只 COPY `app/__init__.py`，不是整個 `app/`** —— 這是 layer 快取的關鍵。
>
>    editable 安裝需要 setuptools 找得到套件，但它只需要一個標記檔就夠
>    （安裝產生的 finder 裡只存一筆 `{'app': '/app/app'}`，submodule 是 import
>    當下才即時解析的）。
>
>    如果照直覺 `COPY app ./app`，那麼**每次改任何一行程式碼都會讓下面那個
>    pip install layer 失效** —— 在這台機器上是 950 秒。而且完全白花，因為
>    compose 用 `./app:/app/app` 把它整個蓋掉了，執行時根本沒用到 build 時複製的那份。
>
> 2. **用 `-c requirements-lock.txt`** —— 容器裡的版本跟本機、CI 完全一致。
>    lockfile 是在 Windows 上凍結的，但它只是版本約束，pip 會自己抓 Linux 的 wheel。
>
> 3. **沒有 `build-essential`** —— 所有依賴（asyncpg、argon2-cffi、pydantic-core、
>    ruff、mypy）在 PyPI 上都有 Linux 預編譯的 wheel，不需要編譯器。省下約 200MB
>    的 apt 下載，image 也小得多 —— 這對要部到 NAS 的專案是實質差別。
>    如果 pip 真的因為缺編譯器而失敗，再把它加回來（並記錄是哪個套件需要）。

- [ ] **Step 2: 建立 `.dockerignore`**

```
.venv/
.git/
**/__pycache__/
*.pyc
**/.pytest_cache/
**/.mypy_cache/
**/.ruff_cache/
*.egg-info/
htmlcov/
.coverage
data/photos/
docs/
.env
.env.*
!.env.example
```

> **兩個容易寫錯的地方：**
>
> 1. **`.env` 必須排除。** `Dockerfile` 最後是 `COPY . .`，會把整個目錄複製進 image。
>    `.gitignore` 已經排除 `.env`（只保留 `.env.example`），代表每個開發者本機都會有
>    一份填了真實密鑰的 `.env`。沒排除的話，那份檔案會被烤進 image 的某一層，
>    之後任何人 `docker run wallet-api cat /app/.env` 就看得到 —— 而這個 repo 是公開的。
>    `.env.*` 會連 `.env.example` 一起吃掉，所以要用 `!.env.example` 撈回來，
>    而且順序不能反（後面的樣式優先）。
>
> 2. **`.dockerignore` 的目錄樣式不會遞迴比對。** 跟 `.gitignore` 不同，
>    寫 `__pycache__/` 只會比對根目錄那一個，`app/api/routes/__pycache__` 不會被排除。
>    要寫 `**/__pycache__/`。不加的話，主機 Python 3.13 產生的 `.pyc` 會被烤進
>    3.12 的 image 裡。

- [ ] **Step 3: 建立 `docker-compose.yml`**

```yaml
services:
  db:
    # 釘死 patch 版本：後面會用到 PostgreSQL 16 特有的 NULLS NOT DISTINCT 與
    # btree_gist EXCLUDE 約束，而且資料目錄放在具名 volume 裡，不該讓它悄悄漂移。
    # （Dockerfile 的 python:3.12-slim 則刻意保持浮動，基底 image 要能持續收到安全更新。）
    image: postgres:16.15
    environment:
      POSTGRES_USER: wallet
      POSTGRES_PASSWORD: wallet
      POSTGRES_DB: wallet
    ports:
      # 主機用 5433，避免跟開發機上其他專案的 PostgreSQL 撞埠。
      # 容器之間仍走 5432（見下面 api 的 DATABASE_URL），CI 也用 5432（runner 是乾淨的）。
      - "5433:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U wallet -d wallet"]
      interval: 5s
      timeout: 5s
      retries: 10

  api:
    build: .
    depends_on:
      db:
        condition: service_healthy
    environment:
      DATABASE_URL: postgresql+asyncpg://wallet:wallet@db:5432/wallet
      JWT_SECRET: dev-secret-change-me-in-production
      PHOTO_DIR: /app/data/photos
    ports:
      - "8000:8000"
    volumes:
      - ./app:/app/app
      - photos:/app/data/photos
    command: uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload

volumes:
  pgdata:
  photos:
```

- [ ] **Step 4: 啟動並驗證**

Run: `docker compose up -d --build`
Expected: 兩個服務都起來，`docker compose ps` 顯示 db 為 healthy

Run: `curl http://localhost:8000/api/health`
Expected: `{"status":"ok"}`

Run: `curl -s -o /dev/null -w "%{http_code}" http://localhost:8000/docs`
Expected: `200`

- [ ] **Step 5: Commit**

```bash
git add Dockerfile .dockerignore docker-compose.yml
git commit -m "chore: 新增 Docker Compose 開發環境"
```

---

### Task 4: 設定管理

**Files:**
- Create: `app/config.py`
- Test: `tests/test_config.py`

- [ ] **Step 1: 寫失敗的測試**

`tests/test_config.py`:

```python
from app.config import Settings


def test_settings_have_sensible_defaults():
    settings = Settings()

    assert settings.jwt_algorithm == "HS256"
    assert settings.access_token_ttl_minutes == 15
    assert settings.refresh_token_ttl_days == 14


def test_settings_can_be_overridden():
    settings = Settings(jwt_secret="from-test", access_token_ttl_minutes=1)

    assert settings.jwt_secret == "from-test"
    assert settings.access_token_ttl_minutes == 1
```

- [ ] **Step 2: 執行測試，確認失敗**

Run: `pytest tests/test_config.py -v`
Expected: FAIL，`ModuleNotFoundError: No module named 'app.config'`

- [ ] **Step 3: 寫最小實作**

`app/config.py`:

```python
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str = "postgresql+asyncpg://wallet:wallet@localhost:5433/wallet"
    jwt_secret: str = "dev-secret-change-me-in-production"
    jwt_algorithm: str = "HS256"
    access_token_ttl_minutes: int = 15
    refresh_token_ttl_days: int = 14
    photo_dir: str = "data/photos"


settings = Settings()
```

- [ ] **Step 4: 執行測試，確認通過**

Run: `pytest tests/test_config.py -v`
Expected: `2 passed`

- [ ] **Step 5: Commit**

```bash
git add app/config.py tests/test_config.py
git commit -m "feat: 新增設定管理"
```

---

### Task 5: 資料庫連線與 Alembic

**Files:**
- Create: `app/db.py`
- Create: `app/models/__init__.py`, `app/models/base.py`
- Create: `alembic.ini`, `migrations/env.py`（由 `alembic init` 產生後修改）

- [ ] **Step 1: 建立 Declarative Base**

```bash
mkdir -p app/models
touch app/models/__init__.py
```

`app/models/base.py`:

```python
from sqlalchemy import MetaData
from sqlalchemy.orm import DeclarativeBase

# 不設命名慣例的話，PostgreSQL 會自己幫 CHECK 約束取名（food_revisions_check、
# food_revisions_check1…），編號依約束加入的順序決定，從模型讀不出來。
# 後果不只是名字醜：alembic revision --autogenerate 會因為對不上名字，
# 對「完全沒改過」的 CHECK 約束產生 remove_constraint，照著跑就真的把約束刪掉。
NAMING_CONVENTION = {
    "ix": "ix_%(column_0_label)s",
    "uq": "uq_%(table_name)s_%(column_0_N_name)s",
    "ck": "ck_%(table_name)s_%(constraint_name)s",
    "fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s",
    "pk": "pk_%(table_name)s",
}


class Base(DeclarativeBase):
    metadata = MetaData(naming_convention=NAMING_CONVENTION)
```

> **這是本計畫裡「現在做很便宜、以後做很貴」最極端的例子。**
>
> 實測：把 spec 裡的 `foods` / `food_revisions` 用模型建出來，資料庫跟模型**完全同步**
> 的情況下跑 Alembic 的 `compare_metadata`，它照樣吐出 **2 個 `remove_constraint`**。
> 相信 autogenerate 的人跑下去，就真的刪掉了正確的約束。P1 的 spec 有 15 個以上的
> CHECK 約束。
>
> 現在做：10 行。等到十幾張表、幾十個 migration 之後再做：要對每個實際存在的資料庫
> 查 `pg_constraint` 問出 PostgreSQL 到底取了什麼名字（因為推不出來），再逐一寫
> `ALTER TABLE ... RENAME CONSTRAINT`。
>
> **代價：`ck` 用了 `%(constraint_name)s`，所以每個 `CheckConstraint` 都必須明確給
> `name=`**，否則 SQLAlchemy 在定義表的當下就拋 `InvalidRequestError`。這是刻意的 ——
> 逼你把名字當成一個決定來下，而不是交給資料庫亂取。

- [ ] **Step 2: 建立資料庫連線模組**

`app/db.py`:

```python
from collections.abc import AsyncIterator

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.config import settings

engine = create_async_engine(settings.database_url, pool_pre_ping=True)
SessionLocal = async_sessionmaker(engine, expire_on_commit=False)


async def get_db() -> AsyncIterator[AsyncSession]:
    async with SessionLocal() as session:
        yield session
```

- [ ] **Step 3: 初始化 Alembic（async 樣板）**

Run: `alembic init -t async migrations`
Expected: 產生 `alembic.ini` 與 `migrations/` 目錄

- [ ] **Step 4: 修改 `migrations/env.py`**

把檔案開頭的 import 區塊之後、`config = context.config` 之前，加入：

```python
from app.config import settings
from app.models.base import Base
```

然後把 `target_metadata = None` 改成：

```python
target_metadata = Base.metadata
```

並在 `config = context.config` 之後加入一行，讓連線字串來自環境變數而非 `alembic.ini`：

```python
# ConfigParser 會把 % 當成字串插值的起頭，密碼裡的 %40 之類會讓它直接崩。
# 這裡先跳脫，讀取時 ConfigParser 會還原成單一個 %。
config.set_main_option("sqlalchemy.url", settings.database_url.replace("%", "%%"))
```

> **為什麼要 `.replace("%", "%%")`：** Alembic 的 `Config` 用的是開啟插值的
> `ConfigParser`（它需要 `%(here)s`），而 `set_main_option` 是寫進那個 parser。
> 密碼含 `%` 就會拋 `ValueError: invalid interpolation syntax`，而且是**每一個**
> Alembic 指令都崩。
>
> 開發密碼是 `wallet`，沒有 `%`，所以這個 bug 會一路潛伏到 P4 換上真正的隨機密碼
> （`%40` 是 `@` 的 URL 編碼）才爆 —— 而且爆的時候錯誤訊息完全不會指向密碼。

- [ ] **Step 5: 驗證 Alembic 可執行**

Run: `alembic current`
Expected: 無錯誤（尚無 migration，輸出為空）

- [ ] **Step 6: Commit**

```bash
git add app/db.py app/models alembic.ini migrations
git commit -m "feat: 新增資料庫連線與 Alembic 設定"
```

---

### Task 6: User model 與第一個 migration

**Files:**
- Create: `app/models/user.py`
- Create: `migrations/versions/0001_create_users.py`

- [ ] **Step 1: 建立 User model**

`app/models/user.py`:

```python
import enum
from datetime import datetime

from sqlalchemy import BigInteger, DateTime, Enum, Identity, Text, func
from sqlalchemy.dialects.postgresql import CITEXT
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class UserRole(enum.StrEnum):
    USER = "user"
    ADMIN = "admin"


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(BigInteger, Identity(always=True), primary_key=True)
    email: Mapped[str] = mapped_column(CITEXT(), unique=True, nullable=False)
    password_hash: Mapped[str] = mapped_column(Text, nullable=False)
    display_name: Mapped[str] = mapped_column(Text, nullable=False)
    role: Mapped[UserRole] = mapped_column(
        Enum(UserRole, name="user_role", values_callable=lambda e: [m.value for m in e]),
        nullable=False,
        default=UserRole.USER,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )
```

- [ ] **Step 2: 讓 Alembic 認得這個 model**

不要在 `migrations/env.py` 裡逐一 import 每個 model。改成集中在 `app/models/__init__.py`：

`app/models/__init__.py`（原本是空的）：

```python
from app.models.base import Base
from app.models.user import User

__all__ = ["Base", "User"]
```

然後把 `migrations/env.py` 裡的

```python
from app.models.base import Base
```

改成

```python
from app.models import Base
```

> **為什麼要這樣，而不是在 `env.py` 裡逐一 import：**
>
> Alembic 的 `--autogenerate` 只看得到已經被 import 進 `Base.metadata` 的 model。
> 漏掉一個，它不會報錯 —— 它會**認為那張表該被刪掉**，然後產生一個 `drop_table`。
> 這是 Alembic 最常見也最危險的坑。
>
> 接下來三個計畫會再加十張以上的表。把註冊點放在 `app/models/__init__.py`，
> 新增 model 的人就是在同一個目錄裡工作，順手就會加上；放在三層目錄外的
> `migrations/env.py`，遲早會漏。
>
> **`__all__` 是必要的，不是裝飾。** `mypy` 開了 `strict`，其中的
> `no_implicit_reexport` 會讓 `from app.models import Base` 報
> `Module "app.models" does not explicitly export attribute "Base"`。
> 列進 `__all__` 才算顯式匯出。

- [ ] **Step 3: 手寫第一個 migration**

`migrations/versions/0001_create_users.py`:

```python
"""create users table and required extensions

Revision ID: 0001
Revises:
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import CITEXT, ENUM

revision: str = "0001"
down_revision: str | None = None
branch_labels: Sequence[str] | None = None
depends_on: Sequence[str] | None = None


def upgrade() -> None:
    # citext: email 比對不分大小寫
    # btree_gist: user_targets 的 EXCLUDE 期間不重疊約束（計畫 4 會用到）
    # pg_trgm: 食物名稱模糊搜尋（計畫 2 會用到）
    op.execute("CREATE EXTENSION IF NOT EXISTS citext")
    op.execute("CREATE EXTENSION IF NOT EXISTS btree_gist")
    op.execute("CREATE EXTENSION IF NOT EXISTS pg_trgm")

    user_role = sa.Enum("user", "admin", name="user_role")
    user_role.create(op.get_bind())

    op.create_table(
        "users",
        sa.Column("id", sa.BigInteger, sa.Identity(always=True), nullable=False),
        sa.Column("email", CITEXT(), nullable=False),
        sa.Column("password_hash", sa.Text, nullable=False),
        sa.Column("display_name", sa.Text, nullable=False),
        # 注意：這裡不能直接用上面的 user_role，見下方說明
        sa.Column(
            "role",
            ENUM("user", "admin", name="user_role", create_type=False),
            nullable=False,
            server_default="user",
        ),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.PrimaryKeyConstraint("id", name="pk_users"),
    )
    op.create_unique_constraint("uq_users_email", "users", ["email"])


def downgrade() -> None:
    op.drop_table("users")
    sa.Enum(name="user_role").drop(op.get_bind())
```

> **PostgreSQL enum 在 migration 裡的陷阱（後面每個 enum 都會遇到）：**
>
> 直覺寫法是先 `user_role.create(op.get_bind())` 建好型別，再把同一個 `user_role`
> 物件當成欄位型別丟進 `op.create_table`。這樣會失敗：
>
> ```
> asyncpg.exceptions.DuplicateObjectError: type "user_role" already exists
> [SQL: CREATE TYPE user_role AS ENUM ('user', 'admin')]
> ```
>
> 原因是**沒有綁定到 `MetaData` 的 `sa.Enum`，在建表時會自己再發一次
> `CREATE TYPE`，而且 `checkfirst=False` 是寫死的**（見 SQLAlchemy 的
> `named_types.py` 中 `_on_table_create`）。兩道 `CREATE TYPE` 在同一個交易裡撞在一起。
>
> 陷阱裡還有陷阱：`sa.Enum(..., create_type=False)` **會被靜默忽略** ——
> `create_type` 只存在於 `postgresql.ENUM`，泛型的 `sa.Enum` 連這個屬性都沒有。
>
> 正解：型別的建立與刪除交給 `sa.Enum(...).create()` / `.drop()` 明確管理，
> **欄位型別則用 `postgresql.ENUM(..., create_type=False)`**。
>
> **計畫 2～4 的每一個 enum 都要這樣處理** —— `meal_type`、`revision_status`、
> `base_unit`、`time_of_day`。
>
> **手寫 migration 的約束名稱要跟 `NAMING_CONVENTION` 對齊。**
>
> `op.create_table` 用的是 Alembic 自己的 metadata，**不會**套用我們在
> `app/models/base.py` 設的命名慣例。所以主鍵要明確寫 `name="pk_users"`，
> 否則 PostgreSQL 會取名 `users_pkey`，跟模型端算出來的 `pk_users` 對不上。
>
> `uq_users_email` 剛好就是慣例算出來的名字（`uq_%(table_name)s_%(column_0_N_name)s`），
> 不用另外處理。

- [ ] **Step 4: 對開發資料庫執行 migration**

Run: `docker compose up -d db`
Run: `alembic upgrade head`
Expected: 輸出 `Running upgrade  -> 0001, create users table and required extensions`

- [ ] **Step 5: 驗證資料表確實建立**

Run:
```bash
docker compose exec -T db psql -U wallet -d wallet -c "\d users"
```
Expected: 列出 `users` 的欄位，`email` 型別是 `citext`，`role` 型別是 `user_role`

- [ ] **Step 6: 驗證 downgrade 可逆**

Run: `alembic downgrade base`
Expected: 成功，無錯誤

Run: `alembic upgrade head`
Expected: 成功

> 這一步很重要。migration 只能往前跑、不能回退的專案，日後改 schema 會很痛。

- [ ] **Step 7: 驗證模型與 migration 沒有漂移**

```bash
alembic check
```

Expected: `No new upgrade operations detected.`

> **這是防呆，不是儀式。** 手寫 migration 時，`op.create_unique_constraint` 之類的
> 操作都強制要給名字，所以不會退回 PostgreSQL 自動命名 —— 但沒有任何機制擋住你
> 打錯字，或是取一個「看起來很合理但跟慣例算出來的不一樣」的名字。
>
> 名字對不上的後果，就是前面那個 CHECK 約束的 bug：autogenerate 會產生一組
> 假的 drop + create。
>
> `alembic check` 做的就是「產生一個 autogenerate revision，看它是不是空的」，
> 但不會真的產生檔案 —— 不用記得去刪。
>
> **之後每個手寫 migration 的 task 都要做這一步**，而且 Task 17 會把它放進 CI，
> 讓它從「要記得做的習慣」變成「跳不過的關卡」。

- [ ] **Step 8: Commit**

```bash
git add app/models/user.py app/models/__init__.py migrations/env.py \
        migrations/versions/0001_create_users.py
git commit -m "feat: 新增 users 資料表與必要的 PostgreSQL 擴充"
```

---

### Task 7: 測試基礎設施

**這是整個 P1 最重要的一個 Task。** 後面所有測試都靠它。

**Files:**
- Create: `tests/conftest.py`
- Test: `tests/test_infra.py`

- [ ] **Step 1: 寫失敗的測試**

`tests/test_infra.py`:

```python
from sqlalchemy import select

from app.models.user import User


async def test_db_session_works(db_session):
    user = User(email="infra@example.com", password_hash="x", display_name="Infra")
    db_session.add(user)
    await db_session.commit()

    found = await db_session.scalar(select(User).where(User.email == "infra@example.com"))
    assert found is not None
    assert found.display_name == "Infra"


async def test_each_test_starts_with_a_clean_database(db_session):
    """上一個測試 commit 了一個使用者，這個測試不該看到它。"""
    found = await db_session.scalar(select(User).where(User.email == "infra@example.com"))
    assert found is None


async def test_client_can_reach_the_api(client):
    response = await client.get("/api/health")
    assert response.status_code == 200
```

- [ ] **Step 2: 執行測試，確認失敗**

Run: `pytest tests/test_infra.py -v`
Expected: FAIL，`fixture 'db_session' not found`

- [ ] **Step 3: 寫測試基礎設施**

`tests/conftest.py`:

```python
import asyncio
import os
import subprocess
import sys
from collections.abc import AsyncIterator

import asyncpg
import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncSession, create_async_engine

from app.db import get_db
from app.main import app

TEST_DATABASE_URL = os.environ.get(
    "TEST_DATABASE_URL",
    "postgresql+asyncpg://wallet:wallet@localhost:5433/wallet_test",
)


async def _recreate_test_database() -> None:
    """砍掉重建測試資料庫。

    為什麼是「每次砍掉重建」而不是「不存在才建」：

    `alembic upgrade head` 只看 revision id，不看檔案內容。開發中原地修改某個
    migration（這個專案已經改過 0001 兩次）不會改變 revision id，所以對一個
    舊的測試資料庫來說，upgrade head 什麼都不做、直接成功。

    而 `alembic check` 救不了這一種：它對「被 owned sequence 支撐的整數欄位」
    有一個內建啟發式，會當成 SERIAL 直接略過比對（log 會印
    `assuming SERIAL and omitting`），所以「serial 改成 GENERATED ALWAYS AS
    IDENTITY」這種漂移它看不見 —— 而那正好是這個專案真的發生過的改動。

    每次從零重建就沒有這個問題：根本不存在舊狀態可以比對錯。
    """
    base, db_name = TEST_DATABASE_URL.rsplit("/", 1)
    admin_dsn = base.replace("postgresql+asyncpg://", "postgresql://") + "/postgres"

    connection = await asyncpg.connect(admin_dsn)
    try:
        # WITH (FORCE) 會踢掉殘留連線（PostgreSQL 13+）。
        # 前一次測試異常中斷留下的連線，否則會讓 DROP 卡住。
        await connection.execute(f'DROP DATABASE IF EXISTS "{db_name}" WITH (FORCE)')
        await connection.execute(f'CREATE DATABASE "{db_name}"')
    finally:
        await connection.close()


@pytest.fixture(scope="session")
def migrated_database() -> None:
    """整個測試 session 只跑一次：建立測試資料庫並套用所有 migration。"""
    asyncio.run(_recreate_test_database())
    env = {**os.environ, "DATABASE_URL": TEST_DATABASE_URL}

    # 用 sys.executable -m alembic 而不是裸的 "alembic"：
    # 本機開發時 venv 不一定有 activate，裸指令不保證找得到。
    # 這樣寫在 Windows 本機跟 Linux CI 上行為一致。
    subprocess.run(
        [sys.executable, "-m", "alembic", "upgrade", "head"],
        check=True,
        env=env,
    )

    # alembic check 比對「實際 schema vs Base.metadata」，抓得到一般的漂移
    # （欄位增減、型別、約束）。
    # 但它有一個盲區：owned sequence 支撐的整數欄位會被當成 SERIAL 略過比對，
    # 所以 serial ↔ IDENTITY 這類改動它看不見。真正的保證是上面的「砍掉重建」，
    # 這一行是額外的第二道防線。
    subprocess.run(
        [sys.executable, "-m", "alembic", "check"],
        check=True,
        env=env,
    )


@pytest_asyncio.fixture
async def db_connection(migrated_database: None) -> AsyncIterator[AsyncConnection]:
    """每個測試開一個外層交易，測試結束整個 rollback。

    這就是測試隔離的核心：測試裡即使呼叫了 commit，也只是 commit 到
    savepoint，最外層交易一 rollback，資料庫就回到測試開始前的狀態。
    因此測試之間互不干擾，也完全不需要手動清資料。
    """
    engine = create_async_engine(TEST_DATABASE_URL)
    async with engine.connect() as connection:
        transaction = await connection.begin()
        try:
            yield connection
        finally:
            await transaction.rollback()
    await engine.dispose()


@pytest_asyncio.fixture
async def db_session(db_connection: AsyncConnection) -> AsyncIterator[AsyncSession]:
    session = AsyncSession(
        bind=db_connection,
        join_transaction_mode="create_savepoint",
        # 跟 app/db.py 的 SessionLocal 一致。少了這個，commit 之後物件屬性會過期，
        # 下次同步存取就炸 MissingGreenlet，而錯誤訊息完全看不出是這個原因。
        expire_on_commit=False,
    )
    try:
        yield session
    finally:
        await session.close()


@pytest_asyncio.fixture
async def client(db_session: AsyncSession) -> AsyncIterator[AsyncClient]:
    """讓 API 使用測試的 session，這樣 API 寫入的資料也會被 rollback。"""

    # 這裡是刻意「不」模仿 app/db.py 的 `async with SessionLocal() as session:` 寫法。
    # session 是 fixture 擁有的，必須活過整個測試，不能被 FastAPI 的依賴清理關掉 ——
    # 否則任何一個「請求失敗後繼續斷言」的測試都會壞掉（例如註冊重複 email 那組）。
    async def override_get_db() -> AsyncIterator[AsyncSession]:
        yield db_session

    app.dependency_overrides[get_db] = override_get_db
    transport = ASGITransport(app=app)
    try:
        async with AsyncClient(transport=transport, base_url="http://test") as async_client:
            yield async_client
    finally:
        app.dependency_overrides.clear()
```

- [ ] **Step 4: 執行測試，確認通過**

Run: `docker compose up -d db`
Run: `pytest tests/test_infra.py -v`
Expected: `11 passed`

特別確認 `test_each_test_starts_with_a_clean_database` 通過 —— 它證明了交易隔離真的有效。

> **這組 fixture 的三個已知邊界，後續 task 要記得：**
>
> 1. **`client` 只覆寫 `get_db`。** 之後如果有哪個依賴自己另外開資料庫連線
>    （沒有走 `get_db`），它的寫入就跑在交易隔離外面，測試之間會互相污染。
>    **所有資料庫存取都必須經過 `get_db`。**
> 2. **`app.dependency_overrides.clear()` 會清掉全部覆寫**，不只 `get_db`。
>    目前只有一個覆寫所以沒差；哪天有 fixture 想在 `client` 之上再疊一層覆寫，
>    要記得這件事。
> 3. **每個測試都會新建一個 engine。** 正確但不省 —— 實測每個測試約 52ms 的
>    基礎設施成本，150 個測試約 7.7 秒。現在不痛，等到真的痛了再改成
>    session 級 engine（連線與交易仍維持每測試一份）。
> 4. **`db.commit()` 失敗之後，一定要 `await db.rollback()` 才能再用那個 session。**
>    `IntegrityError` 之後任何操作都會拋 `PendingRollbackError`。
>    正式環境的 session 是每請求一份，壞掉就算了；但**測試的 session 是整個測試共用的**，
>    所以某個 handler 漏掉 rollback，會讓同一個測試後面所有的 `client` 呼叫跟
>    `db_session` 查詢全部爆掉，而且錯誤訊息看起來跟真正的原因完全無關。
>
> **不要把 `tests/test_health.py` 改成用這裡的 `client` fixture。**
>
> 本 Task 之後，`test_health.py` 跟 `test_infra.py::test_client_can_reach_the_api`
> 看起來在測同一件事，很容易讓人想「順手合併掉重複」。不可以。
>
> `client` fixture 相依於 `db_session` → `db_connection` → `migrated_database`，
> 需要一個活著的 PostgreSQL。`test_health.py` 目前是**整個測試套件裡唯一不需要
> 任何基礎設施就能跑的測試** —— 它的用途正是在資料庫還沒接上時，證明
> FastAPI 本身是活的。合併掉就失去這個診斷能力了。
>
> 在 `test_health.py` 加一行註解說明它為什麼不用 `client` fixture，避免日後有人
> （或某個 agent）反射性地又想合併。

- [ ] **Step 5: Commit**

```bash
git add tests/conftest.py tests/test_infra.py
git commit -m "test: 建立測試基礎設施（真實 PostgreSQL + 交易隔離）"
```

---

### Task 8: 密碼雜湊

**Files:**
- Create: `app/security/__init__.py`, `app/security/password.py`
- Create: `tests/factories.py`
- Test: `tests/test_password.py`

- [ ] **Step 1: 寫失敗的測試**

`tests/test_password.py`:

```python
from app.security.password import hash_password, verify_password


def test_hash_is_not_the_plain_password():
    hashed = hash_password("my-secret-password")
    assert hashed != "my-secret-password"
    assert hashed.startswith("$argon2")


def test_same_password_produces_different_hashes():
    """每次雜湊都要用不同的 salt，否則相同密碼的使用者會有相同雜湊值。"""
    assert hash_password("same") != hash_password("same")


def test_verify_accepts_the_correct_password():
    hashed = hash_password("my-secret-password")
    assert verify_password("my-secret-password", hashed) is True


def test_verify_rejects_the_wrong_password():
    hashed = hash_password("my-secret-password")
    assert verify_password("wrong-password", hashed) is False


def test_verify_rejects_a_malformed_hash():
    assert verify_password("anything", "not-a-real-hash") is False
```

- [ ] **Step 2: 執行測試，確認失敗**

Run: `pytest tests/test_password.py -v`
Expected: FAIL，`ModuleNotFoundError: No module named 'app.security'`

- [ ] **Step 3: 寫最小實作**

```bash
mkdir -p app/security
touch app/security/__init__.py
```

`app/security/password.py`:

```python
from argon2 import PasswordHasher
from argon2.exceptions import Argon2Error, InvalidHashError

_hasher = PasswordHasher()


def hash_password(password: str) -> str:
    return _hasher.hash(password)


def verify_password(password: str, password_hash: str) -> bool:
    try:
        return _hasher.verify(password_hash, password)
    except (Argon2Error, InvalidHashError):
        return False
```

> **兩個例外都要列，不是多寫的。** 直覺會以為 `InvalidHashError` 是
> `Argon2Error` 的子類，可以省掉一個。實測（argon2-cffi 25.1.0）不是：
>
> ```
> InvalidHashError    → ValueError          （不是 Argon2Error 的子類）
> VerifyMismatchError → Argon2Error 的子類
> ```
>
> 兩者走的是不同路徑：**密碼錯誤**拋 `VerifyMismatchError`，**雜湊字串格式壞掉**
> 拋 `InvalidHashError`。少寫 `InvalidHashError`，遇到壞掉的雜湊值會直接往外拋，
> 而不是回傳 `False` —— 也就是資料庫裡有一筆髒資料，就會讓登入端點回 500 而非 401。
>
> 另外，`_hasher.verify()` 只會回傳 `True` 或拋例外，永遠不會回 `False`。
> 所以 `return _hasher.verify(...)` 這個寫法看起來有點怪，但是正確的。

- [ ] **Step 4: 執行測試，確認通過**

Run: `pytest tests/test_password.py -v`
Expected: `5 passed`

- [ ] **Step 5: 建立測試資料產生器**

後面每個需要使用者的測試都會用到它。集中在一處，避免每個測試各自手刻。

`tests/factories.py`:

```python
from itertools import count

from sqlalchemy.ext.asyncio import AsyncSession

from app.models.user import User, UserRole
from app.security.password import hash_password

DEFAULT_PASSWORD = "correct-horse-battery"

_email_counter = count(1)


def _next_email() -> str:
    return f"user{next(_email_counter)}@example.com"


async def create_user(
    db_session: AsyncSession,
    *,
    email: str | None = None,
    password: str = DEFAULT_PASSWORD,
    display_name: str = "測試使用者",
    role: UserRole = UserRole.USER,
) -> User:
    user = User(
        email=email or _next_email(),
        password_hash=hash_password(password),
        display_name=display_name,
        role=role,
    )
    db_session.add(user)
    await db_session.commit()
    # 嚴格來說這行是多餘的：測試 session 設了 expire_on_commit=False，屬性不會過期，
    # 而 PostgreSQL 的 INSERT 走 RETURNING，id / created_at 在 commit 當下就填好了。
    # 保留是為了穩健 —— 日後若有欄位是靠 trigger 或 generated column 產生的，
    # RETURNING 不一定涵蓋得到，那時這行就有意義了。測試工廠寧可多一次查詢。
    await db_session.refresh(user)
    return user
```

> `_counter` 是模組層級的可變狀態，跨整個測試 session 共用。這是安全的：
> 測試序列執行，而且 rollback 不會回捲計數器 —— 最多產生跳號，不會撞名。

Run: `pytest -v`
Expected: 全部通過（`factories.py` 目前還沒有測試用到，只需確認 import 不出錯）

- [ ] **Step 6: Commit**

```bash
git add app/security tests/test_password.py tests/factories.py
git commit -m "feat: 新增 Argon2 密碼雜湊"
```

---

### Task 9: JWT token

**Files:**
- Create: `app/security/tokens.py`
- Test: `tests/test_tokens.py`

- [ ] **Step 1: 寫失敗的測試**

`tests/test_tokens.py`:

```python
import pytest

from app.security.tokens import TokenError, create_token, decode_token


def test_access_token_round_trip():
    token = create_token(user_id=42, token_type="access")
    assert decode_token(token, expected_type="access") == 42


def test_refresh_token_round_trip():
    token = create_token(user_id=7, token_type="refresh")
    assert decode_token(token, expected_type="refresh") == 7


def test_refresh_token_is_rejected_where_an_access_token_is_expected():
    """這是重要的安全性質：長效的 refresh token 不可以拿來直接存取 API。"""
    token = create_token(user_id=1, token_type="refresh")
    with pytest.raises(TokenError):
        decode_token(token, expected_type="access")


def test_access_token_is_rejected_where_a_refresh_token_is_expected():
    token = create_token(user_id=1, token_type="access")
    with pytest.raises(TokenError):
        decode_token(token, expected_type="refresh")


def test_tampered_token_is_rejected():
    token = create_token(user_id=1, token_type="access")
    tampered = token[:-4] + "AAAA"
    with pytest.raises(TokenError):
        decode_token(tampered, expected_type="access")


def test_garbage_is_rejected():
    with pytest.raises(TokenError):
        decode_token("this-is-not-a-token", expected_type="access")


def test_expired_token_is_rejected(monkeypatch):
    from app.config import settings

    monkeypatch.setattr(settings, "access_token_ttl_minutes", -1)
    token = create_token(user_id=1, token_type="access")

    with pytest.raises(TokenError):
        decode_token(token, expected_type="access")


def _forge(payload: dict[str, object]) -> str:
    """繞過 create_token，直接用同一把密鑰簽一個任意 payload 的 token。"""
    import jwt as pyjwt

    from app.config import settings

    return pyjwt.encode(payload, settings.jwt_secret, algorithm=settings.jwt_algorithm)


def test_forged_token_with_non_numeric_sub_raises_token_error():
    """簽章有效但 payload 形狀不對，也必須是 TokenError，不能是 ValueError。

    呼叫端（get_current_user）只接 TokenError，其他例外會變成 500。
    """
    now = datetime.now(UTC)
    forged = _forge(
        {"sub": "not-a-number", "type": "access", "iat": now, "exp": now + timedelta(minutes=15)}
    )
    with pytest.raises(TokenError):
        decode_token(forged, expected_type="access")


def test_forged_token_without_sub_raises_token_error():
    now = datetime.now(UTC)
    forged = _forge({"type": "access", "iat": now, "exp": now + timedelta(minutes=15)})
    with pytest.raises(TokenError):
        decode_token(forged, expected_type="access")


def test_forged_token_without_exp_is_rejected():
    """沒有 exp 的 token 不能被接受 —— 否則它永遠不會過期。"""
    forged = _forge({"sub": "1", "type": "access", "iat": datetime.now(UTC)})
    with pytest.raises(TokenError):
        decode_token(forged, expected_type="access")
```

檔案開頭的 import 要加上：

```python
from datetime import UTC, datetime, timedelta
```

> **這三個測試用 `_forge` 繞過 `create_token`，是刻意的。**
> 它們要模擬的正是「攻擊者拿到密鑰之後能做什麼」，所以不能經過正常的簽發路徑。

- [ ] **Step 2: 執行測試，確認失敗**

Run: `pytest tests/test_tokens.py -v`
Expected: FAIL，`ModuleNotFoundError: No module named 'app.security.tokens'`

- [ ] **Step 3: 寫最小實作**

`app/security/tokens.py`:

```python
from datetime import UTC, datetime, timedelta
from typing import Any, Literal

import jwt

from app.config import settings

TokenType = Literal["access", "refresh"]


class TokenError(Exception):
    """token 無效、過期，或類型不符。"""


def create_token(user_id: int, token_type: TokenType) -> str:
    now = datetime.now(UTC)
    ttl = (
        timedelta(minutes=settings.access_token_ttl_minutes)
        if token_type == "access"
        else timedelta(days=settings.refresh_token_ttl_days)
    )
    payload = {
        "sub": str(user_id),
        "type": token_type,
        "iat": now,
        "exp": now + ttl,
    }
    return jwt.encode(payload, settings.jwt_secret, algorithm=settings.jwt_algorithm)


def decode_token(token: str, expected_type: TokenType) -> int:
    try:
        payload: dict[str, Any] = jwt.decode(
            token,
            settings.jwt_secret,
            algorithms=[settings.jwt_algorithm],
            # 預設只在 exp 存在時才驗證它 —— 少了 exp 的偽造 token 會永遠有效。
            options={"require": ["exp", "iat", "sub", "type"]},
        )
    except jwt.PyJWTError as exc:
        raise TokenError("token 無效或已過期") from exc

    if payload.get("type") != expected_type:
        raise TokenError("token 類型不正確")

    try:
        return int(payload["sub"])
    except (KeyError, ValueError, TypeError) as exc:
        raise TokenError("token payload 格式不正確") from exc
```

> **這個模組唯一對外可見的失敗方式，必須是 `TokenError`。**
>
> 直覺會覺得 `int(payload["sub"])` 不可能拋 `ValueError` —— 因為 `create_token`
> 是唯一的簽發者，而它永遠寫 `str(user_id)`。這個推理有一個致命前提：
> **簽發需要密鑰，而密鑰是私密的。**
>
> 但這個專案的 `jwt_secret` 預設值是 `"dev-secret-change-me-in-production"`
> 這個字面字串，而 repo 是公開的。加上 P4 那條（沒設環境變數會靜默用預設值），
> 任何知道這個公開字串的人都能簽出一個 `sub` 不是數字的合法 token。
>
> 而 Task 13 的 `get_current_user` 只接 `TokenError` —— 所以那個 `ValueError`
> 會逃逸出去變成 500，而且是未經認證就能觸發的。
>
> （更正一個常見的誤解：Starlette 在 `debug=False` 下**不會**把堆疊追蹤送給客戶端，
> 實測回的是 `text/plain` 的 `Internal Server Error`。所以這不是資訊洩漏，
> 是可遠端觸發的錯誤 —— 嚴重性低一級，但仍然不該存在。）
>
> **「以目前的呼叫端來看不可達」，對一個作為整個 API 安全邊界的模組來說是錯的標準。**
> 正確的標準是：對外只拋一種例外，因為所有呼叫端都是照那個假設寫的。

- [ ] **Step 4: 執行測試，確認通過**

Run: `pytest tests/test_tokens.py -v`
Expected: `10 passed`

- [ ] **Step 5: Commit**

```bash
git add app/security/tokens.py tests/test_tokens.py
git commit -m "feat: 新增 JWT token 建立與驗證"
```

> **已知限制：** refresh token 是無狀態的，無法在到期前撤銷。若日後需要「登出所有裝置」
> 功能，要另建 refresh token 資料表。這在 P1 範圍外，但要知道這個限制存在。

---

### Task 10: 統一錯誤格式

**Files:**
- Create: `app/errors.py`
- Modify: `app/main.py`
- Test: `tests/test_errors.py`

- [ ] **Step 1: 寫失敗的測試**

`tests/test_errors.py`:

```python
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from pydantic import BaseModel

from app.errors import ConflictError, NotFoundError, register_error_handlers


class Payload(BaseModel):
    count: int


def build_app() -> FastAPI:
    test_app = FastAPI()
    register_error_handlers(test_app)

    @test_app.get("/missing")
    async def missing() -> None:
        raise NotFoundError("FOOD_NOT_FOUND", "找不到該食物")

    @test_app.post("/conflict")
    async def conflict(payload: Payload) -> None:
        raise ConflictError("EMAIL_TAKEN", "這個 email 已經註冊過了")

    return test_app


async def request(method: str, path: str, **kwargs):
    transport = ASGITransport(app=build_app())
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        return await client.request(method, path, **kwargs)


async def test_app_error_uses_the_standard_envelope():
    response = await request("GET", "/missing")

    assert response.status_code == 404
    assert response.json() == {
        "error": {"code": "FOOD_NOT_FOUND", "message": "找不到該食物", "details": {}}
    }


async def test_conflict_error_returns_409():
    response = await request("POST", "/conflict", json={"count": 1})

    assert response.status_code == 409
    assert response.json()["error"]["code"] == "EMAIL_TAKEN"


async def test_validation_error_uses_the_same_envelope():
    response = await request("POST", "/conflict", json={"count": "not-a-number"})

    assert response.status_code == 422
    body = response.json()
    assert body["error"]["code"] == "VALIDATION_ERROR"
    assert "errors" in body["error"]["details"]
```

- [ ] **Step 2: 執行測試，確認失敗**

Run: `pytest tests/test_errors.py -v`
Expected: FAIL，`ModuleNotFoundError: No module named 'app.errors'`

- [ ] **Step 3: 寫最小實作**

`app/errors.py`:

```python
import logging
from typing import Any

from fastapi import FastAPI, Request, status
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

logger = logging.getLogger(__name__)


class AppError(Exception):
    def __init__(
        self,
        code: str,
        message: str,
        status_code: int,
        details: dict[str, Any] | None = None,
    ) -> None:
        self.code = code
        self.message = message
        self.status_code = status_code
        self.details = details or {}
        super().__init__(message)


class NotFoundError(AppError):
    def __init__(self, code: str, message: str, details: dict[str, Any] | None = None) -> None:
        super().__init__(code, message, status.HTTP_404_NOT_FOUND, details)


class ConflictError(AppError):
    def __init__(self, code: str, message: str, details: dict[str, Any] | None = None) -> None:
        super().__init__(code, message, status.HTTP_409_CONFLICT, details)


class UnauthorizedError(AppError):
    def __init__(self, code: str, message: str, details: dict[str, Any] | None = None) -> None:
        super().__init__(code, message, status.HTTP_401_UNAUTHORIZED, details)


class ForbiddenError(AppError):
    def __init__(self, code: str, message: str, details: dict[str, Any] | None = None) -> None:
        super().__init__(code, message, status.HTTP_403_FORBIDDEN, details)


def _envelope(code: str, message: str, details: dict[str, Any]) -> dict[str, Any]:
    return {"error": {"code": code, "message": message, "details": details}}


def _sanitize_validation_errors(errors: list[Any]) -> list[Any]:
    """移除 Pydantic 回傳的 input 欄位。

    Pydantic v2 預設會把使用者送進來的原始值一起放進錯誤裡，而 FastAPI 沒有提供
    關掉它的設定。密碼太短時，那個密碼就會出現在 422 的回應 body 裡 ——
    而 4xx 的 body 會進到反向代理的存取紀錄、瀏覽器開發者工具、
    以及前端的錯誤回報服務。
    loc / type / msg 都保留，診斷資訊已經足夠。
    """
    return [{key: value for key, value in error.items() if key != "input"} for error in errors]


def register_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(AppError)
    async def handle_app_error(_: Request, exc: AppError) -> JSONResponse:
        return JSONResponse(
            status_code=exc.status_code,
            content=jsonable_encoder(_envelope(exc.code, exc.message, exc.details)),
        )

    @app.exception_handler(RequestValidationError)
    async def handle_validation_error(_: Request, exc: RequestValidationError) -> JSONResponse:
        return JSONResponse(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            content=_envelope(
                "VALIDATION_ERROR",
                "輸入資料格式錯誤",
                {"errors": _sanitize_validation_errors(jsonable_encoder(exc.errors()))},
            ),
        )

    @app.exception_handler(StarletteHTTPException)
    async def handle_http_exception(_: Request, exc: StarletteHTTPException) -> JSONResponse:
        return JSONResponse(
            status_code=exc.status_code,
            content=_envelope("HTTP_ERROR", str(exc.detail), {}),
            headers=exc.headers,
        )

    @app.exception_handler(Exception)
    async def handle_unexpected_error(_: Request, exc: Exception) -> JSONResponse:
        logger.exception("未預期的錯誤")
        return JSONResponse(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            content=_envelope("INTERNAL_ERROR", "系統發生未預期的錯誤", {}),
        )
```

> **四個 handler，各自堵一個洞：**
>
> 1. **`AppError` 的 content 要包 `jsonable_encoder`。** `JSONResponse` 內部用的是
>    原生 `json.dumps`，沒有 `default=` —— `details` 裡放 `date`、`Decimal` 或 enum
>    就會在渲染中途拋 `TypeError`，而那個例外不在任何 handler 的守備範圍，
>    變成 500。而規格第 9 節的「期間重疊 → 409」情境，本來就要把日期範圍放進
>    `details` 才講得清楚是哪一段衝突。
>
> 2. **`_sanitize_validation_errors` 拿掉 `input` 欄位。** Pydantic v2 預設會把
>    使用者送進來的原始值放進錯誤裡。密碼太短時，那個密碼就出現在 422 的 body。
>    FastAPI 寫死了 `include_url=False` 卻沒開放 `include_input`，而且 handler 拿到
>    的已經是展開好的 dict list —— 所以只能在這裡後處理，沒有上游的解法。
>    （`ctx` 實測是安全的，只有 `{"min_length": 8}` 之類的靜態資訊。）
>
> 3. **`StarletteHTTPException` 的 handler。** 沒有它，任何不存在的路徑會回
>    FastAPI 原本的 `{"detail": "Not Found"}`，不是我們的信封 —— 一個號稱
>    「統一錯誤格式」的 API，最容易被外面探測到的回應反而是不統一的那個。
>    `headers=exc.headers` 要保留，否則將來有依賴拋 401 帶 `WWW-Authenticate`
>    會掉header。
>
> 4. **catch-all `Exception` handler。** 沒有它，未預期的例外回的是 `text/plain`
>    的 `Internal Server Error`，前端不能假設「所有非 2xx 都是 JSON」。
>
>    **這個不會讓測試看不到真正的錯誤** —— Starlette 的 `ServerErrorMiddleware`
>    呼叫完 handler 之後仍然會把原例外重新拋出，而 `conftest.py` 的
>    `ASGITransport` 用預設的 `raise_app_exceptions=True`，所以 pytest 看到的
>    還是真的例外，不是被吞掉的 500。這件事實測確認過。

- [ ] **Step 4: 在主 app 註冊**

`app/main.py` 改為：

```python
from fastapi import FastAPI

from app.api.routes import health
from app.errors import register_error_handlers

app = FastAPI(title="飲食紀錄 API", version="0.1.0")
register_error_handlers(app)
app.include_router(health.router, prefix="/api")
```

- [ ] **Step 5: 執行測試，確認通過**

Run: `pytest tests/test_errors.py -v`
Expected: `11 passed`

- [ ] **Step 6: Commit**

```bash
git add app/errors.py app/main.py tests/test_errors.py
git commit -m "feat: 新增統一錯誤回應格式"
```

---

### Task 11: 註冊 API

**Files:**
- Create: `app/schemas/__init__.py`, `app/schemas/auth.py`
- Create: `app/api/routes/auth.py`
- Modify: `app/main.py`
- Test: `tests/test_auth_register.py`

- [ ] **Step 1: 寫失敗的測試**

`tests/test_auth_register.py`:

```python
from sqlalchemy import select

from app.models.user import User, UserRole
from tests.factories import create_user


async def test_register_creates_a_user(client, db_session):
    response = await client.post(
        "/api/auth/register",
        json={"email": "new@example.com", "password": "a-good-password", "display_name": "阿明"},
    )

    assert response.status_code == 201
    body = response.json()
    assert body["email"] == "new@example.com"
    assert body["display_name"] == "阿明"
    assert body["role"] == "user"

    user = await db_session.scalar(select(User).where(User.email == "new@example.com"))
    assert user is not None
    assert user.role is UserRole.USER


async def test_register_never_returns_the_password(client):
    response = await client.post(
        "/api/auth/register",
        json={"email": "new@example.com", "password": "a-good-password", "display_name": "阿明"},
    )

    assert "password" not in response.text
    assert "password_hash" not in response.json()


async def test_register_stores_a_hash_not_the_plain_password(client, db_session):
    await client.post(
        "/api/auth/register",
        json={"email": "new@example.com", "password": "a-good-password", "display_name": "阿明"},
    )

    user = await db_session.scalar(select(User).where(User.email == "new@example.com"))
    assert user is not None
    assert user.password_hash != "a-good-password"


async def test_register_rejects_a_duplicate_email(client, db_session):
    await create_user(db_session, email="taken@example.com")

    response = await client.post(
        "/api/auth/register",
        json={"email": "taken@example.com", "password": "a-good-password", "display_name": "阿明"},
    )

    assert response.status_code == 409
    assert response.json()["error"]["code"] == "EMAIL_TAKEN"


async def test_register_treats_email_case_insensitively(client, db_session):
    """citext 讓 Taken@example.com 與 taken@example.com 視為同一個帳號。"""
    await create_user(db_session, email="taken@example.com")

    response = await client.post(
        "/api/auth/register",
        json={"email": "TAKEN@example.com", "password": "a-good-password", "display_name": "阿明"},
    )

    assert response.status_code == 409


async def test_register_rejects_a_short_password(client):
    response = await client.post(
        "/api/auth/register",
        json={"email": "new@example.com", "password": "zqxjv", "display_name": "阿明"},
    )

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "VALIDATION_ERROR"
    # 錯誤回應不能把使用者送進來的密碼回吐 —— 4xx 的 body 會進到反向代理的存取紀錄、
    # 瀏覽器開發者工具、前端的錯誤回報服務。Task 10 的 handler 會把 input 欄位拿掉。
    assert "zqxjv" not in response.text
```

> **測試密碼不能隨便取。** 第一次寫這個測試時用的是 `"short"`，結果永遠失敗 ——
> 因為 `"short"` 是 Pydantic 錯誤型別標籤 `"string_too_short"` 的子字串，
> 而那個標籤是**應該**留在回應裡的診斷資訊。
>
> 看起來像修正沒生效，實際上是測試設計有問題。`"zqxjv"` 跟 Pydantic / FastAPI
> 會吐出的任何字串都不相交（`string_too_short`、
> `String should have at least 8 characters`、`{"min_length": 8}`）。
>
> **這類「用子字串比對來斷言某個東西不存在」的測試都有這個風險**，取值時要避開
> 對方詞彙表裡的字。

```python
async def test_register_rejects_an_invalid_email(client):
    response = await client.post(
        "/api/auth/register",
        json={"email": "not-an-email", "password": "a-good-password", "display_name": "阿明"},
    )

    assert response.status_code == 422
```

- [ ] **Step 2: 執行測試，確認失敗**

Run: `pytest tests/test_auth_register.py -v`
Expected: FAIL，全部 404（路由不存在）

- [ ] **Step 3: 寫 schema**

```bash
mkdir -p app/schemas
touch app/schemas/__init__.py
```

`app/schemas/auth.py`:

```python
import re

from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator

from app.models.user import UserRole

# C0 控制字元 + DEL + C1。顯示用名稱裡不該出現任何一個。
# 其中 \x00 特別重要：它通得過 Pydantic，然後被 PostgreSQL 拒收，
# 變成一個未經認證就能觸發的 500。
_CONTROL_CHARACTERS = re.compile(r"[\x00-\x1f\x7f-\x9f]")


class RegisterRequest(BaseModel):
    email: EmailStr
    # 上限跟 Argon2 無關 —— 實測雜湊耗時與輸入長度無關（8 字元與 100 萬字元都約 70ms），
    # 因為 Argon2 會先把輸入吸收成固定大小再進記憶體硬化階段。
    # 這個上限單純是請求體衛生：限制客戶端能讓伺服器解析與複製多少資料。
    password: str = Field(min_length=8, max_length=128)
    display_name: str = Field(min_length=1, max_length=50)

    @field_validator("email")
    @classmethod
    def _normalise_email(cls, value: str) -> str:
        return value.strip().lower()

    @field_validator("display_name")
    @classmethod
    def _clean_display_name(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("顯示名稱不能只有空白")
        if _CONTROL_CHARACTERS.search(value):
            raise ValueError("顯示名稱不能包含控制字元")
        return value


class LoginRequest(BaseModel):
    email: EmailStr
    password: str

    @field_validator("email")
    @classmethod
    def _normalise_email(cls, value: str) -> str:
        return value.strip().lower()


class RefreshRequest(BaseModel):
    refresh_token: str


class UserResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    email: str
    display_name: str
    role: UserRole


class TokenResponse(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"
```

> **`display_name` 的驗證擋的是一個真實的 bug。**
>
> `"A B"` 是合法的 JSON、合法的 Python 字串，通得過 Pydantic 的長度檢查 ——
> 然後 PostgreSQL 拒收（`invalid byte sequence for encoding "UTF8": 0x00`），
> 變成一個未經認證、單一請求就能觸發的 500。
>
> **這是「跨技術邊界」的典型盲點：兩層各自都對，但它們接受的東西不是同一組。**
> Pydantic 驗的是「是不是 1 到 50 字元的字串」，PostgreSQL 驗的是「這些位元組
> 能不能存」—— 中間那個差集沒有人負責。
>
> 順帶一提，**現在的測試套件抓不到這種回歸**：`ASGITransport` 預設
> `raise_app_exceptions=True`，例外會直接拋進測試裡，而不是回傳 500。
> 所以這個測試失敗的樣子是「測試爆炸」而不是「斷言不符」。
>
> （Unicode 的格式字元 —— 例如 RTL 覆寫 U+202E、零寬空格 U+200B —— 沒有擋。
> 它們是顯示層的偽裝手法，而且擋掉會誤傷某些語言的正常用字，留給 P3 的前端處理。）

- [ ] **Step 4: 寫路由**

`app/api/routes/auth.py`:

```python
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
```

> **已知的競態，本 task 不處理：** 這裡是「先 SELECT 查有沒有、再 INSERT」。
> 兩個同時進來的相同 email 註冊請求，兩邊的 SELECT 都會查不到，然後第二個 INSERT
> 撞上 `uq_users_email`，拋 `IntegrityError` —— 現在會變成
> `500 INTERNAL_ERROR`，而不是預期的 `409 EMAIL_TAKEN`。
>
> 對單人使用的 NAS 部署來說幾乎不可能發生，而且順序執行的測試套件也測不到它。
> 真要處理的話，要在 `commit()` 外面包 `except IntegrityError`，並且**記得先
> `await db.rollback()`**（見 Task 7 的第四個邊界）—— 漏掉 rollback 會讓同一個
> 測試後面所有的資料庫操作全部爆掉。
>
> 留給日後的併發強化，不是現在。

- [ ] **Step 5: 掛上路由**

`app/main.py` 改為：

```python
from fastapi import FastAPI

from app.api.routes import auth, health
from app.errors import register_error_handlers

app = FastAPI(title="飲食紀錄 API", version="0.1.0")
register_error_handlers(app)
app.include_router(health.router, prefix="/api")
app.include_router(auth.router, prefix="/api")
```

- [ ] **Step 6: 執行測試，確認通過**

Run: `pytest tests/test_auth_register.py -v`
Expected: `11 passed`

- [ ] **Step 7: Commit**

```bash
git add app/schemas app/api/routes/auth.py app/main.py tests/test_auth_register.py
git commit -m "feat: 新增使用者註冊 API"
```

---

### Task 12: 登入 API

**Files:**
- Modify: `app/api/routes/auth.py`
- Modify: `app/security/password.py`（加一個假雜湊常數，見下方時間側通道說明）
- Test: `tests/test_auth_login.py`

- [ ] **Step 1: 寫失敗的測試**

`tests/test_auth_login.py`:

```python
from app.security.tokens import decode_token
from tests.factories import DEFAULT_PASSWORD, create_user


async def test_login_returns_tokens(client, db_session):
    user = await create_user(db_session, email="me@example.com")

    response = await client.post(
        "/api/auth/login",
        json={"email": "me@example.com", "password": DEFAULT_PASSWORD},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["token_type"] == "bearer"
    assert decode_token(body["access_token"], expected_type="access") == user.id
    assert decode_token(body["refresh_token"], expected_type="refresh") == user.id


async def test_login_rejects_a_wrong_password(client, db_session):
    await create_user(db_session, email="me@example.com")

    response = await client.post(
        "/api/auth/login",
        json={"email": "me@example.com", "password": "wrong-password"},
    )

    assert response.status_code == 401
    assert response.json()["error"]["code"] == "INVALID_CREDENTIALS"


async def test_login_rejects_an_unknown_email(client):
    response = await client.post(
        "/api/auth/login",
        json={"email": "nobody@example.com", "password": "any-password"},
    )

    assert response.status_code == 401
    assert response.json()["error"]["code"] == "INVALID_CREDENTIALS"


async def test_login_does_not_reveal_whether_an_email_exists(client, db_session):
    """帳號不存在與密碼錯誤必須回完全相同的訊息。

    否則攻擊者可以用不同的錯誤訊息，逐一測出系統裡有哪些 email 註冊過。
    """
    await create_user(db_session, email="me@example.com")

    wrong_password = await client.post(
        "/api/auth/login",
        json={"email": "me@example.com", "password": "wrong-password"},
    )
    unknown_email = await client.post(
        "/api/auth/login",
        json={"email": "nobody@example.com", "password": "wrong-password"},
    )

    assert wrong_password.status_code == unknown_email.status_code
    assert wrong_password.json() == unknown_email.json()


async def test_login_is_case_insensitive_on_email(client, db_session):
    await create_user(db_session, email="me@example.com")

    response = await client.post(
        "/api/auth/login",
        json={"email": "ME@EXAMPLE.COM", "password": DEFAULT_PASSWORD},
    )

    assert response.status_code == 200
```

- [ ] **Step 2: 執行測試，確認失敗**

Run: `pytest tests/test_auth_login.py -v`
Expected: FAIL，全部 404

- [ ] **Step 3: 寫實作**

在 `app/api/routes/auth.py` 的 import 區加入：

```python
from app.errors import ConflictError, UnauthorizedError
from app.schemas.auth import LoginRequest, RegisterRequest, TokenResponse, UserResponse
from app.security.password import DUMMY_PASSWORD_HASH, hash_password, verify_password
from app.security.tokens import create_token
```

並在檔案末端加入：

先在 `app/security/password.py` 末端加一個常數：

```python
# 登入時「帳號不存在」的分支也要跑一次完整的 Argon2 驗證，讓兩條路徑耗時一致。
# 放在這裡而不是路由裡，是因為它跟 _hasher 的參數綁在一起 ——
# 日後調整 Argon2 參數時，這個假雜湊會自動跟著更新。
DUMMY_PASSWORD_HASH = _hasher.hash("no-such-account-dummy-password")
```

然後在 `app/api/routes/auth.py` 加入：

```python
@router.post("/login", response_model=TokenResponse)
async def login(payload: LoginRequest, db: AsyncSession = Depends(get_db)) -> TokenResponse:
    user = await db.scalar(select(User).where(User.email == payload.email))

    # 帳號不存在時，拿假雜湊跑一次驗證。
    # 不能寫成 `user is None or not verify_password(...)` —— Python 會短路，
    # 帳號不存在的請求根本不會跑 Argon2，回應快 70 毫秒（實測 0.0002ms vs 73.8ms）。
    # 那個時間差就能測出哪些 email 註冊過，而這正是下面「回相同錯誤」要防的事。
    password_hash = user.password_hash if user is not None else DUMMY_PASSWORD_HASH
    password_ok = verify_password(payload.password, password_hash)

    # 帳號不存在與密碼錯誤回相同的錯誤，避免洩漏哪些 email 註冊過
    if user is None or not password_ok:
        raise UnauthorizedError("INVALID_CREDENTIALS", "email 或密碼不正確")

    return TokenResponse(
        access_token=create_token(user.id, "access"),
        refresh_token=create_token(user.id, "refresh"),
    )
```

> **不要為這件事寫時間斷言測試。** 時間相關的測試在 CI 上必然不穩定。
> 程式碼加上那段註解就夠了 —— 註解才是防止有人「順手」把它改回短路寫法的東西。

- [ ] **Step 4: 執行測試，確認通過**

Run: `pytest tests/test_auth_login.py -v`
Expected: `5 passed`

- [ ] **Step 5: Commit**

```bash
git add app/api/routes/auth.py tests/test_auth_login.py
git commit -m "feat: 新增登入 API"
```

---

### Task 13: 目前使用者（get_current_user + /api/me）

**Files:**
- Create: `app/api/deps.py`
- Create: `app/api/routes/me.py`
- Modify: `app/main.py`
- Test: `tests/test_auth_me.py`

- [ ] **Step 1: 寫失敗的測試**

`tests/test_auth_me.py`:

```python
from app.security.tokens import create_token
from tests.factories import create_user


async def test_me_returns_the_current_user(client, db_session):
    user = await create_user(db_session, email="me@example.com", display_name="阿明")
    token = create_token(user.id, "access")

    response = await client.get("/api/me", headers={"Authorization": f"Bearer {token}"})

    assert response.status_code == 200
    body = response.json()
    assert body["id"] == user.id
    assert body["email"] == "me@example.com"
    assert body["display_name"] == "阿明"


async def test_me_requires_a_token(client):
    response = await client.get("/api/me")

    assert response.status_code == 401
    assert response.json()["error"]["code"] == "NOT_AUTHENTICATED"


async def test_me_rejects_a_refresh_token(client, db_session):
    """refresh token 是長效憑證，不可以拿來直接存取 API。"""
    user = await create_user(db_session)
    token = create_token(user.id, "refresh")

    response = await client.get("/api/me", headers={"Authorization": f"Bearer {token}"})

    assert response.status_code == 401
    assert response.json()["error"]["code"] == "INVALID_TOKEN"


async def test_me_rejects_garbage(client):
    response = await client.get("/api/me", headers={"Authorization": "Bearer not-a-token"})

    assert response.status_code == 401


async def test_me_rejects_a_token_for_a_deleted_user(client):
    """token 簽章有效，但使用者已不存在。"""
    token = create_token(999_999, "access")

    response = await client.get("/api/me", headers={"Authorization": f"Bearer {token}"})

    assert response.status_code == 401
```

- [ ] **Step 2: 執行測試，確認失敗**

Run: `pytest tests/test_auth_me.py -v`
Expected: FAIL，全部 404

- [ ] **Step 3: 寫依賴**

`app/api/deps.py`:

```python
from fastapi import Depends
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_db
from app.errors import ForbiddenError, UnauthorizedError
from app.models.user import User, UserRole
from app.security.tokens import TokenError, decode_token

_bearer = HTTPBearer(auto_error=False)


async def get_current_user(
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
    db: AsyncSession = Depends(get_db),
) -> User:
    if credentials is None:
        raise UnauthorizedError("NOT_AUTHENTICATED", "需要登入")

    try:
        user_id = decode_token(credentials.credentials, expected_type="access")
    except TokenError as exc:
        raise UnauthorizedError("INVALID_TOKEN", "token 無效或已過期") from exc

    user = await db.get(User, user_id)
    if user is None:
        raise UnauthorizedError("INVALID_TOKEN", "token 無效或已過期")

    return user


async def require_admin(user: User = Depends(get_current_user)) -> User:
    if user.role is not UserRole.ADMIN:
        raise ForbiddenError("FORBIDDEN", "需要管理員權限")
    return user
```

- [ ] **Step 4: 寫路由**

`app/api/routes/me.py`:

```python
from fastapi import APIRouter, Depends

from app.api.deps import get_current_user
from app.models.user import User
from app.schemas.auth import UserResponse

router = APIRouter(tags=["me"])


@router.get("/me", response_model=UserResponse)
async def read_me(user: User = Depends(get_current_user)) -> User:
    return user
```

- [ ] **Step 5: 掛上路由**

`app/main.py` 改為：

```python
from fastapi import FastAPI

from app.api.routes import auth, health, me
from app.errors import register_error_handlers

app = FastAPI(title="飲食紀錄 API", version="0.1.0")
register_error_handlers(app)
app.include_router(health.router, prefix="/api")
app.include_router(auth.router, prefix="/api")
app.include_router(me.router, prefix="/api")
```

- [ ] **Step 6: 執行測試，確認通過**

Run: `pytest tests/test_auth_me.py -v`
Expected: `5 passed`

- [ ] **Step 7: Commit**

```bash
git add app/api/deps.py app/api/routes/me.py app/main.py tests/test_auth_me.py
git commit -m "feat: 新增目前使用者端點與 JWT 驗證依賴"
```

---

### Task 14: 換發 token

**Files:**
- Modify: `app/api/routes/auth.py`
- Test: `tests/test_auth_refresh.py`

- [ ] **Step 1: 寫失敗的測試**

`tests/test_auth_refresh.py`:

```python
from app.security.tokens import create_token, decode_token
from tests.factories import create_user


async def test_refresh_returns_a_new_access_token(client, db_session):
    user = await create_user(db_session)
    refresh_token = create_token(user.id, "refresh")

    response = await client.post("/api/auth/refresh", json={"refresh_token": refresh_token})

    assert response.status_code == 200
    body = response.json()
    assert decode_token(body["access_token"], expected_type="access") == user.id


async def test_refresh_rejects_an_access_token(client, db_session):
    """拿 access token 來換發，必須被擋下。"""
    user = await create_user(db_session)
    access_token = create_token(user.id, "access")

    response = await client.post("/api/auth/refresh", json={"refresh_token": access_token})

    assert response.status_code == 401
    assert response.json()["error"]["code"] == "INVALID_TOKEN"


async def test_refresh_rejects_garbage(client):
    response = await client.post("/api/auth/refresh", json={"refresh_token": "nope"})

    assert response.status_code == 401


async def test_refresh_rejects_a_token_for_a_deleted_user(client):
    refresh_token = create_token(999_999, "refresh")

    response = await client.post("/api/auth/refresh", json={"refresh_token": refresh_token})

    assert response.status_code == 401
```

- [ ] **Step 2: 執行測試，確認失敗**

Run: `pytest tests/test_auth_refresh.py -v`
Expected: FAIL，全部 404

- [ ] **Step 3: 寫實作**

在 `app/api/routes/auth.py` 的 import 區補上：

```python
from app.schemas.auth import LoginRequest, RefreshRequest, RegisterRequest, TokenResponse, UserResponse
from app.security.tokens import TokenError, create_token, decode_token
```

並在檔案末端加入：

```python
@router.post("/refresh", response_model=TokenResponse)
async def refresh(payload: RefreshRequest, db: AsyncSession = Depends(get_db)) -> TokenResponse:
    try:
        user_id = decode_token(payload.refresh_token, expected_type="refresh")
    except TokenError as exc:
        raise UnauthorizedError("INVALID_TOKEN", "token 無效或已過期") from exc

    user = await db.get(User, user_id)
    if user is None:
        raise UnauthorizedError("INVALID_TOKEN", "token 無效或已過期")

    return TokenResponse(
        access_token=create_token(user.id, "access"),
        refresh_token=create_token(user.id, "refresh"),
    )
```

- [ ] **Step 4: 執行測試，確認通過**

Run: `pytest tests/test_auth_refresh.py -v`
Expected: `4 passed`

- [ ] **Step 5: Commit**

```bash
git add app/api/routes/auth.py tests/test_auth_refresh.py
git commit -m "feat: 新增 token 換發 API"
```

---

### Task 15: 管理員權限依賴

`require_admin` 已在 Task 13 寫好，這個 Task 只補測試。

不建立正式的測試用端點 —— 那會在正式程式碼裡留下只為測試存在的路由。改為在測試檔內
組一個小 app 來驗證這個依賴。

**Files:**
- Test: `tests/test_deps_admin.py`

- [ ] **Step 1: 寫失敗的測試**

`tests/test_deps_admin.py`:

```python
from fastapi import Depends, FastAPI
from httpx import ASGITransport, AsyncClient

from app.api.deps import require_admin
from app.db import get_db
from app.errors import register_error_handlers
from app.models.user import User, UserRole
from app.security.tokens import create_token
from tests.factories import create_user


def build_admin_app(db_session) -> FastAPI:
    test_app = FastAPI()
    register_error_handlers(test_app)

    @test_app.get("/admin-only")
    async def admin_only(user: User = Depends(require_admin)) -> dict[str, int]:
        return {"user_id": user.id}

    async def override_get_db():
        yield db_session

    test_app.dependency_overrides[get_db] = override_get_db
    return test_app


async def call_admin_endpoint(db_session, token: str | None):
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    transport = ASGITransport(app=build_admin_app(db_session))
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        return await client.get("/admin-only", headers=headers)


async def test_admin_can_access(db_session):
    admin = await create_user(db_session, role=UserRole.ADMIN)

    response = await call_admin_endpoint(db_session, create_token(admin.id, "access"))

    assert response.status_code == 200
    assert response.json() == {"user_id": admin.id}


async def test_normal_user_is_forbidden(db_session):
    user = await create_user(db_session, role=UserRole.USER)

    response = await call_admin_endpoint(db_session, create_token(user.id, "access"))

    assert response.status_code == 403
    assert response.json()["error"]["code"] == "FORBIDDEN"


async def test_anonymous_is_unauthenticated(db_session):
    response = await call_admin_endpoint(db_session, token=None)

    assert response.status_code == 401
    assert response.json()["error"]["code"] == "NOT_AUTHENTICATED"
```

- [ ] **Step 2: 執行測試**

Run: `pytest tests/test_deps_admin.py -v`
Expected: `3 passed`（`require_admin` 已存在，這裡是補測試，測試應直接通過）

若失敗，代表 Task 13 的 `require_admin` 有問題，回頭修正。

- [ ] **Step 3: Commit**

```bash
git add tests/test_deps_admin.py
git commit -m "test: 新增管理員權限依賴的測試"
```

---

### Task 16: 建立管理員帳號的命令

解決規格第 12 節待決問題 #1。計畫 2 的審核 API 需要有管理員帳號才能測試。

**Files:**
- Create: `app/cli.py`
- Test: `tests/test_cli.py`

- [ ] **Step 1: 寫失敗的測試**

`tests/test_cli.py`:

```python
import pytest
from sqlalchemy import select

from app.cli import create_admin
from app.models.user import User, UserRole
from app.security.password import verify_password
from tests.factories import create_user


async def test_create_admin_creates_an_admin_user(db_session):
    await create_admin(db_session, "boss@example.com", "a-good-password", "老闆")

    user = await db_session.scalar(select(User).where(User.email == "boss@example.com"))
    assert user is not None
    assert user.role is UserRole.ADMIN
    assert verify_password("a-good-password", user.password_hash)


async def test_create_admin_promotes_an_existing_user(db_session):
    existing = await create_user(db_session, email="boss@example.com", role=UserRole.USER)

    await create_admin(db_session, "boss@example.com", "a-new-password", "老闆")

    await db_session.refresh(existing)
    assert existing.role is UserRole.ADMIN


async def test_create_admin_rejects_a_short_password(db_session):
    with pytest.raises(ValueError, match="密碼至少 8 個字元"):
        await create_admin(db_session, "boss@example.com", "short", "老闆")
```

- [ ] **Step 2: 執行測試，確認失敗**

Run: `pytest tests/test_cli.py -v`
Expected: FAIL，`ModuleNotFoundError: No module named 'app.cli'`

- [ ] **Step 3: 寫實作**

`app/cli.py`:

```python
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
```

- [ ] **Step 4: 執行測試，確認通過**

Run: `pytest tests/test_cli.py -v`
Expected: `11 passed`

- [ ] **Step 5: 對開發資料庫實際跑一次**

Run:
```bash
python -m app.cli admin@example.com admin-password-123 管理員
```
Expected: `管理員帳號已建立：admin@example.com (id=…)`

- [ ] **Step 6: Commit**

```bash
git add app/cli.py tests/test_cli.py
git commit -m "feat: 新增建立管理員帳號的命令"
```

---

### Task 17: CI

**Files:**
- Create: `.github/workflows/ci.yml`
- Create: `README.md`

- [ ] **Step 1: 建立 CI 設定**

`.github/workflows/ci.yml`:

```yaml
name: CI

on:
  push:
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest

    services:
      postgres:
        image: postgres:16
        env:
          POSTGRES_USER: wallet
          POSTGRES_PASSWORD: wallet
          POSTGRES_DB: wallet
        ports:
          - 5432:5432
        options: >-
          --health-cmd "pg_isready -U wallet"
          --health-interval 5s
          --health-timeout 5s
          --health-retries 10

    env:
      DATABASE_URL: postgresql+asyncpg://wallet:wallet@localhost:5432/wallet
      TEST_DATABASE_URL: postgresql+asyncpg://wallet:wallet@localhost:5432/wallet_test
      JWT_SECRET: ci-secret

    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-python@v5
        with:
          python-version: "3.12"
          cache: pip

      - name: 安裝依賴
        # 用 lockfile 當 constraints，確保 CI 跟本機拿到完全相同的版本
        run: pip install -c requirements-lock.txt -e ".[dev]"

      - name: Lint
        run: ruff check .

      - name: 型別檢查
        run: mypy app

      # 模型與 migration 漂移檢查：跑完所有 migration 後，模型不該再產生任何差異。
      # 手寫 migration 的約束名稱只要跟 NAMING_CONVENTION 差一個字，這裡就會紅。
      - name: Migration 漂移檢查
        run: |
          alembic upgrade head
          alembic check

      - name: 測試
        run: pytest --cov=app --cov-report=term-missing
```

- [ ] **Step 2: 本機跑一次完整檢查**

Run: `ruff check .`
Expected: `All checks passed!`

Run: `mypy app`
Expected: `Success: no issues found`

Run: `pytest --cov=app --cov-report=term-missing`
Expected: 全部通過

- [ ] **Step 3: 建立 README**

`README.md`:

```markdown
# 飲食紀錄系統

記錄每日三大營養素與補劑攝取，支援拍照與 AI 營養素分析。

## 開發環境

需求：Docker Desktop、Python 3.12

```bash
python -m venv .venv
.venv/Scripts/activate          # Windows；macOS/Linux 用 source .venv/bin/activate
pip install -c requirements-lock.txt -e ".[dev]"

cp .env.example .env
docker compose up -d db
alembic upgrade head
```

啟動 API：

```bash
docker compose up -d
```

開 http://localhost:8000/docs 看 API 文件。

## 測試

測試跑**真的 PostgreSQL**，不用 SQLite 代替 —— 因為專案用到 `EXCLUDE` 約束、
`citext`、`pg_trgm`，SQLite 都沒有，用它測等於測了一個跟正式環境不同的系統。

```bash
docker compose up -d db
pytest
```

每個測試包在資料庫交易內、跑完 rollback，因此測試之間完全隔離，也不需要手動清資料。

## 建立管理員帳號

```bash
python -m app.cli <email> <password> <顯示名稱>
```

## 設計文件

- [P1 設計規格](docs/superpowers/specs/2026-09-02-diet-tracker-p1-design.md)
```

- [ ] **Step 4: Commit**

```bash
git add .github README.md
git commit -m "chore: 新增 CI 與 README"
```

---

## 完成驗收

計畫 1 完成時，以下每一項都要親自跑過並看到預期結果：

- [ ] `docker compose up -d --build` 後，`curl http://localhost:8000/api/health` 回 `{"status":"ok"}`
- [ ] `http://localhost:8000/docs` 打得開，列出 register / login / refresh / me
- [ ] `alembic downgrade base` 後再 `alembic upgrade head`，兩次都成功
- [ ] `pytest` 全部通過
- [ ] `ruff check .` 無錯誤
- [ ] `mypy app` 無錯誤
- [ ] `python -m app.cli admin@example.com admin-password-123 管理員` 成功建立管理員

## 已知的小問題（不阻擋，下次動到該檔案時順手修）

- **`app/schemas/auth.py` 的 `_CONTROL_CHARACTERS` 該再納入 bidi 覆寫字元**
  （`‪-‮`、`⁦-⁩`）。這跟 ZWJ / ZWNJ 不同 —— 後者在波斯語、
  阿拉伯語、印度語系的正常人名裡有作用，擋掉會誤傷；前者是狹窄、明確的顯示偽裝
  手法，GitHub 之類的服務就是只擋這一段。
  而且這不只是前端的事：**決策 4 的管理員審核佇列會顯示提案者身分供信任判斷**，
  那是 P1/P2 的介面。
- **`_normalise_email` 在 `RegisterRequest` 跟 `LoginRequest` 重複了兩份。**
  改成 Pydantic v2 的 annotated 型別別名會比現在更短：
  `NormalisedEmail = Annotated[EmailStr, AfterValidator(str.strip), AfterValidator(str.lower)]`。
  兩份還在「rule of three」的容忍範圍內，但後面幾個計畫還會加更多 schema。

- `.dockerignore` 的 `*.egg-info/` 少了 `**/` 前綴，跟原本 `__pycache__/` 是同一類錯誤。
  目前零影響 —— setuptools 只會在專案根目錄產生 egg-info，不會有巢狀的，而且
  image 裡那份是 `pip install -e .` 在容器內重新產生的，不是從主機複製進去的。

## 後續任務：session 撤銷（不是 P4 的事，要自己一個 task）

**這一項刻意不放進下面的 P4 清單。** 那份清單是部署維運的雜項（compose 密鑰、
restart 政策、healthcheck），氛圍是「記錄一下、不急」。session 撤銷是應用層的
安全功能，放進去會被那個氛圍吃掉。

**問題：手機掉了怎麼辦。**

Task 14 的 `/api/auth/refresh` 每次呼叫都會發一張全新的 14 天 refresh token，
而且沒有重用偵測。所以 14 天不是上限，是一個**只要裝置持續使用就永遠不會關上的
滑動視窗**。撿到手機的人只要 app 正常運作，就能一直續下去。

而目前唯一的止血方式是**換掉 `JWT_SECRET`**，那會把所有使用者一起登出。
對「幾個使用者」的規模來說勉強可以接受，但這件事現在沒有寫在任何地方，
也沒有「只登出這一台」的能力。

**現在就該做的（零程式碼）：** 把「換掉 `JWT_SECRET` 可以強制登出所有 session」
寫進 README 的維運段落，當作緊急處置程序。

**真正的解法（獨立 task，建議排在 P2 或 P3，不要拖到 P4）：**

在 `users` 加一個 `tokens_valid_after timestamptz` 欄位，`get_current_user` 跟
refresh 端點都比對 token 的 `iat` 是否晚於它，再開一個 `POST /api/auth/logout-all`
把它設成 `now()`。

`iat` 現在就已經寫進 token 了（而且 PyJWT 2.13 本來就會驗證它不能是未來時間），
所以這個機制不需要改動 token 格式 —— 只要加一個欄位跟一個比對。

## 延後到 P4 的部署議題（審查過程中記錄，本計畫不處理）

- **密鑰硬編在 `docker-compose.yml` 裡。** `JWT_SECRET` 跟 PostgreSQL 密碼目前是明文字面值，
  不是 `${VAR}` 也沒有 `env_file:`。對開發用的 compose 這是合理的（`docker compose up`
  免設定就能跑），但 P4 必須改成：production 用獨立的 compose override，密鑰由
  Compose `secrets:` 或 NAS Container Manager 注入。

  **注意一個陷阱：把 `JWT_SECRET` 從 compose 拿掉，並不會讓它啟動失敗。**
  `app/config.py` 的 `jwt_secret` 欄位自己就有預設值
  （`"dev-secret-change-me-in-production"`），pydantic 會直接用它，然後 production
  就悄悄跑在開發密鑰上 —— 這比沒改還糟，因為你以為改好了。

  要真的 fail closed，必須動 `app/config.py`：把該欄位的預設值拿掉（變成必填，
  沒給就在 `Settings()` 建立時拋 `ValidationError`，也就是 import 時就崩），
  或加一個「production 模式下不得等於開發預設值」的驗證。

- **`extra="ignore"` 讓拼錯的環境變數被靜默吞掉。** 打成 `JWT_SECERT=...` 不會有任何
  警告，程式就用預設值跑起來。改成 `forbid` 不可行 —— `.env.example` 裡有
  `TEST_DATABASE_URL`，那是刻意不放進 `Settings` 的（測試直接讀 `os.environ`），
  `forbid` 會讓它直接炸掉。

  所以這一項的解法跟上一項是同一個：**只要密鑰沒有可用的預設值，拼錯就會變成
  大聲的啟動失敗，而不是安靜的錯誤行為。** 兩項要一起修，分開修會兩邊都不完整。
- **兩個服務都沒有 `restart:` 政策。** 開發時無所謂，P4 要明確決定（例如
  `restart: unless-stopped`）。
- **`api` 服務沒有 healthcheck。** `/api/health` 目前只有手動 curl 在用。
  P4 若要接 NAS 的容器健康檢查，考慮另開 `/api/health/ready` 做 `SELECT 1`，
  而不要改動 `/api/health` —— liveness 跟 readiness 混在一起，會讓資料庫短暫抖動
  觸發容器重啟，而重啟並不能解決資料庫的問題。

## 下一步

計畫 2（食物主檔 + 版本化 + 審核流程）在本計畫完成後撰寫。屆時要處理的核心問題：

- `foods` 與 `food_revisions` 的循環外鍵，需要 `DEFERRABLE INITIALLY DEFERRED`
- 私人食物編輯直接生效、全域食物編輯進入待審，兩條路徑共用同一張 revision 表
- 「待審版本不得出現在正式查詢結果」的測試
