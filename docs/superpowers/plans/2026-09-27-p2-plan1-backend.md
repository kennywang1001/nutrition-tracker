# P2 計畫一：AI 分析的後端 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 做出 `POST /api/ai/analyze` —— 文字或圖片進去，一份的營養素估算加上一致性檢查出來，而且不落庫。

**Architecture:** LLM 藏在一個 Protocol 後面，由 FastAPI 依賴注入提供，所以測試能斷言「它一次都沒被呼叫」。一致性檢查是純函式，不碰網路。每日額度直接數 `ai_analyses` 的今日列數 —— 計數器與紀錄是同一份資料。

**Tech Stack:** Python 3.12 · FastAPI · SQLAlchemy 2.0 async · Alembic · Pydantic v2 · anthropic SDK · pytest

**規格：** [2026-09-27-p2-ai-analysis-design.md](../specs/2026-09-27-p2-ai-analysis-design.md)

---

## 這份計畫只做後端

規格 §10 說明了為什麼：前端需要一個真的能打的端點才寫得出有意義的 E2E，
而 mock 一個還不存在的 API 形狀正是這個專案踩過的「兩處講同一件事然後漂移」。

前端（兩個入口、確認／修改、一致性標記的顯示）是計畫二。

---

## 開工前必讀

### 1. 計畫的文字不是權威

發現實際情況跟這份計畫寫的不一樣就**停下來報告**，不要硬做，也不要自己悄悄
改方向繼續。前三份計畫每一個 task 的最有價值產出都是這種回報。

### 2. 突變步驟不預測哪一條測試會紅

> **必須成立：** 把 X 改成 Y 之後，至少一條測試紅，原因是 Z。
>
> **實測填回：** ——

**跑完全綠是一個發現，不是障礙。** 停下來報告。

### 3. 指令（Windows + Git Bash）

`ruff` / `mypy` / `pytest` 都不在 PATH 上，要用 venv 裡的：

```bash
cd F:/wallet && ./.venv/Scripts/python.exe -m pytest tests/test_ai_analyze.py -q
cd F:/wallet && ./.venv/Scripts/python.exe -m pytest -q          # 全套約 70 秒
cd F:/wallet && ./.venv/Scripts/ruff.exe check .
cd F:/wallet && ./.venv/Scripts/mypy.exe app
```

**不要跑 `ruff format`** —— CI 只跑 `ruff check .`，而這個 repo 有既有的格式
差異，跑 format 會重排一堆跟你無關的行。

### 4. 基準線

```
後端 pytest  512 passed
ruff check   All checks passed
mypy app     no issues in 50 source files
```

### 5. 加了 migration 之後要重建映像

`Dockerfile` 是 `COPY . .`，migration 檔案是烤進映像的，不是掛載的 ——
dev 的原始碼掛載只有 `./app`。症狀是 `relation "xxx" does not exist`，
而檔案明明在 repo 裡（handover §7）。

---

## 開工前已經查證過的事實

**每一項都是實際讀原始碼確認的。**

| 事實 | 出處 |
|---|---|
| `anthropic` **不在相依裡**，要加 | `pyproject.toml` |
| `pillow` 已經是相依（照片縮圖在用） | 同上 |
| `ServiceUnavailableError` / `TooManyRequestsError` / `PayloadTooLargeError` / `UnprocessableEntityError` **都已存在** | `app/errors.py` |
| 最新 migration 是 `0007_create_refresh_sessions`，**下一個是 0008** | `migrations/versions/` |
| migration 檔頭格式：`revision: str = "0007"` / `down_revision: str | None = "0006"` | `migrations/versions/0007_*.py` |
| `day_bounds(day: date, tz_name: str) -> tuple[datetime, datetime]`、`today_in_timezone(tz_name: str) -> date` | `app/days.py` |
| `food_revisions` 已有 `source` / `ai_confidence` / `ai_raw_response`，`create_food` **從來沒碰過它們** | `app/models/food.py`、`app/api/routes/foods.py` |
| `FoodCreateRequest` 目前是 `name` / `brand` / `nutrition` / `is_global` | `app/schemas/food.py` |
| `NutritionInput` 是**每 100g/ml** 的數值，`kcal` 0–10000、三個巨量 0–1000，都 `max_digits=8, decimal_places=2` | 同上 |
| 照片上限 `MAX_PHOTO_BYTES = 10 * 1024 * 1024`，錯誤碼 `PHOTO_TOO_LARGE` / `INVALID_PHOTO` | `app/api/routes/meals.py` |
| `settings.jwt_secret` **沒有預設值**（fail closed）；`photo_dir` 有預設 | `app/config.py` |

### 一個必須照抄的既有模式

`app/security/sessions.py` 的 `_reject() -> NoReturn` **在拋出例外之前先
`commit()`**。理由是重用偵測的紀錄必須留下，即使這次請求以錯誤結束。

**這份計畫的「失敗的呼叫也要記帳」需要完全相同的處理** —— 去讀那個函式，
照它的形狀寫。**不照做的後果是：LLM 回了垃圾（那次一樣花了錢），而
`ai_analyses` 裡沒有紀錄，額度也沒有扣。**

---

## 檔案結構

**新增：**

| 檔案 | 責任 |
|---|---|
| `app/ai/__init__.py` | 空 |
| `app/ai/consistency.py` | Atwater 一致性檢查。**純函式，不 import 任何網路或資料庫的東西** |
| `app/ai/estimator.py` | `NutritionEstimator` Protocol、`RawEstimate` 資料型別、Anthropic 實作 |
| `app/models/ai_analysis.py` | `AiAnalysis` 資料表 |
| `app/schemas/ai.py` | 請求與回應 |
| `app/api/routes/ai.py` | `POST /api/ai/analyze` |
| `migrations/versions/0008_create_ai_analyses.py` | migration |
| `tests/test_ai_consistency.py` | Task 3 |
| `tests/test_ai_analyze.py` | Task 5 |
| `tests/test_foods_ai_source.py` | Task 6 |

**修改：**

| 檔案 | 改什麼 | Task |
|---|---|---|
| `pyproject.toml` | 加 `anthropic` | 1 |
| `requirements-lock.txt` | 同步 | 1 |
| `app/config.py` | `anthropic_api_key` / `ai_model` / `ai_daily_limit` | 1 |
| `app/main.py` | 掛 `ai.router` | 5 |
| `app/schemas/food.py` | `FoodCreateRequest` 加三個欄位 | 6 |
| `app/api/routes/foods.py` | `create_food` 寫入那三個欄位 | 6 |
| `.env.production.example` | 加 `ANTHROPIC_API_KEY` | 1 |
| `docs/deployment.md` | 說明 AI 是選配 | 1 |

---

## Task 1: 相依、設定、與「沒有 key 就關閉」

> ## 實測記錄（已執行完畢，commit `cc8d809` + 後續修正）
>
> ### ⚠️ 計畫的檔案清單漏了 compose，而那會讓這整個 task 的成果在 production 永遠失效
>
> `docker-compose.yml` 與 `docker-compose.prod.yml` **都沒有把
> `ANTHROPIC_API_KEY` 傳進容器**，而這份計畫的「檔案結構」表格從頭到尾
> 沒有列它們。
>
> compose 的 `--env-file` 只用來做 **YAML 檔案本身的字串代換**，不會自動
> 把變數注入容器 —— 除非該 service 的 `environment:` 明確列出它。
> 所以就算使用者照著新寫的部署文件在 `.env.production` 填了金鑰，
> 容器裡的 `Settings()` 讀到的還是 `None`：**這個「選配功能」在原本的
> compose 設定下永遠開不了。**
>
> ### 補 compose 又引入第二個缺陷，而它比第一個更糟
>
> `ANTHROPIC_API_KEY: "${ANTHROPIC_API_KEY:-}"`（用 `:-` 不是 `:?`，因為它
> 是選配的）在沒設值時代換成**空字串**，不是「沒有這個變數」。實測
> `docker compose config` 的輸出確認：`ANTHROPIC_API_KEY: ""`。
>
> 而 Pydantic 會把空字串解析成 `""` 不是 `None`：
>
> ```
> ANTHROPIC_API_KEY="" → anthropic_api_key = ''   is None? False
> ```
>
> 於是 `get_estimator()` 不會拋 `AI_NOT_CONFIGURED`，而是拿一把空字串金鑰
> 去建 client —— 使用者看到的是來自 Anthropic 的認證錯誤，而不是「你沒設定
> AI」。**看起來是開著的比明確關閉更糟。**
>
> 修法：`app/config.py` 加 `_empty_key_is_no_key` validator（`mode="before"`），
> 空字串與全空白都正規化成 `None`。
>
> ### 這個缺陷只有在容器裡才看得到
>
> 本機直接跑 pytest 時 `.env` 裡根本沒有 `ANTHROPIC_API_KEY`，所以
> `anthropic_api_key` 是 `None`，一切正常。**只有 compose 起的容器會收到
> 空字串。** 是「只有部署環境看得到」的那一類。
>
> 補了兩條成對的測試（`monkeypatch.setenv`）：空字串變 `None`、
> **而真的金鑰不能被吃掉**。第二條是必要的 —— 只有第一條的話，一個
> 「永遠回 None」的 validator 也會全綠，而那會讓 AI 永遠開不了。
>
> 突變驗證：
>
> | 突變 | 結果 |
> |---|---|
> | 拿掉空字串正規化 | 「空字串等於沒有金鑰」紅 |
> | 改成永遠回 `None` | 「真的金鑰不能被吃掉」紅 |
>
> ### 另外兩件實測
>
> **`extra="ignore"` 也作用在建構子的關鍵字參數上。** 在 `ai_daily_limit`
> 這個欄位還不存在時，`Settings(jwt_secret=…, ai_daily_limit=0)` 不會報
> 「未知欄位」，而是**整個吞掉那個參數**、安靜地建出物件。所以任何地方把
> 設定欄位名打錯，Pydantic 都不會提醒 —— 寫測試時要小心。
>
> **`pip freeze` 會寫進一行 VCS 需求。** `pip install -e ".[dev]"` 把專案
> 自己裝成 editable 之後，`pip freeze` 會序列化成
> `-e git+https://…#egg=wallet`。那一行留在 lock 檔裡**會炸 Docker build**
> —— `Dockerfile` 用 `pip install -c requirements-lock.txt -e .`，而 pip
> 不允許 constraints 檔案裡有 editable/VCS 需求（實測
> `pip install --dry-run -c` 確認：`ERROR: Editable requirements are not
> allowed as constraints`）。已手動移除。

**Files:**
- Modify: `pyproject.toml`
- Modify: `requirements-lock.txt`
- Modify: `app/config.py`
- Modify: `.env.production.example`
- Modify: `docs/deployment.md`
- Test: `tests/test_config.py`（如果不存在就建）

### `anthropic_api_key` 刻意跟 `jwt_secret` 相反

`jwt_secret` 沒有預設值，是 **fail closed** —— 沒設就崩潰，因為「沒有密鑰」
等於「任何人都能偽造 token」。

`anthropic_api_key` 有預設值 `None`，**沒設就是功能關閉**。理由不同：
沒有 AI key 不會讓系統變得不安全，只是少一個功能。讓整個 app 因為少一個
選配功能而起不來是錯的取捨。

**但「關閉」必須是明講的**（`503 AI_NOT_CONFIGURED`），不是一個看起來壞掉
的樣子。

- [ ] **Step 1: 寫失敗的測試**

`tests/test_config.py`（先確認這個檔案存不存在，**存在的話加進去不要覆蓋**）：

```python
from app.config import Settings


def test_anthropic_key_defaults_to_none():
    """沒設 AI key 不該讓整個 app 起不來——它是選配功能，不是安全性設定。

    跟 jwt_secret 刻意相反：那個沒有預設值（fail closed），因為「沒有密鑰」
    等於「任何人都能偽造 token」。少一個 AI 功能不會讓系統變得不安全。
    """
    settings = Settings(jwt_secret="x" * 32)

    assert settings.anthropic_api_key is None
    assert settings.ai_daily_limit == 20
    assert settings.ai_model == "claude-sonnet-5"


def test_ai_daily_limit_must_be_positive():
    """0 或負數會讓每日上限的比較變成一個永遠成立或永遠不成立的條件——
    兩種都不是「關閉 AI」的正確表達方式（那是不設 key）。
    """
    import pytest

    with pytest.raises(ValueError):
        Settings(jwt_secret="x" * 32, ai_daily_limit=0)
```

- [ ] **Step 2: 跑測試確認它失敗**

```bash
cd F:/wallet && ./.venv/Scripts/python.exe -m pytest tests/test_config.py -q 2>&1 | tail -5
```

Expected: FAIL（`Settings` 沒有 `anthropic_api_key` 這個屬性，或
`extra="ignore"` 讓它被吞掉 —— **看清楚實際的失敗訊息，它會告訴你
`model_config` 的 `extra` 設定對這個測試的影響**）。

- [ ] **Step 3: 加設定**

`app/config.py` 的 `Settings` 裡，`photo_dir` 之後加：

```python
    # **刻意跟 jwt_secret 相反：有預設值。**
    #
    # jwt_secret 沒有預設是 fail closed —— 沒設等於任何人都能偽造 token，
    # 那種情況下安靜地跑起來比崩潰更糟。
    #
    # AI 不一樣：沒有 key 不會讓系統變得不安全，只是少一個功能。讓整個 app
    # 因為少一個選配功能而起不來是錯的取捨（規格 §4.1）。
    #
    # 但「關閉」必須是明講的 —— 端點回 503 AI_NOT_CONFIGURED，
    # 不是一個看起來壞掉的樣子。
    anthropic_api_key: str | None = None
    ai_model: str = "claude-sonnet-5"
    # 規格 §7：只算真的呼叫 LLM 的次數，失敗的也算（一樣花了錢）。
    ai_daily_limit: int = Field(20, gt=0)
```

- [ ] **Step 4: 加相依**

`pyproject.toml` 的 `dependencies` 加 `"anthropic>=0.40"`。

然後更新 lock：

```bash
cd F:/wallet && ./.venv/Scripts/python.exe -m pip install -e ".[dev]" 2>&1 | tail -3
cd F:/wallet && ./.venv/Scripts/python.exe -m pip freeze > requirements-lock.txt
```

> **`pip freeze` 會把整個環境的套件都寫進去。** 跑完用
> `git diff requirements-lock.txt` 看清楚多了什麼 —— 只該多 `anthropic`
> 與它的相依。如果多了一堆不相干的東西，**停下來報告**（代表 venv 裡有
> 手動裝過的東西）。

- [ ] **Step 5: 跑測試確認全綠**

- [ ] **Step 6: 文件**

`.env.production.example` 加：

```
# 選配：沒設的話 AI 分析功能整個關閉（端點回 503 AI_NOT_CONFIGURED），
# 其他功能不受影響。
ANTHROPIC_API_KEY=
```

`docs/deployment.md` 的「產生密鑰並填設定」那一節補一段說明 AI 是選配、
沒設會怎樣。**去讀那一節現在怎麼寫，用同樣的語氣。**

- [ ] **Step 7: 驗證與 commit**

```bash
cd F:/wallet && ./.venv/Scripts/python.exe -m pytest -q 2>&1 | tail -3
cd F:/wallet && ./.venv/Scripts/ruff.exe check . && ./.venv/Scripts/mypy.exe app
```

---

## Task 2: `ai_analyses` 資料表

> ## 實測記錄（已執行完畢，commit `0fe96db`）
>
> ### ⚠️ 這份計畫叫人去讀的檔案是錯的
>
> Step 1 寫「去讀 `app/models/food.py` 看 `RevisionStatus` 怎麼處理的，
> 照同一個作法」，並在旁邊引用 handover §7 的「`create_constraint=False`
> + 手寫 CheckConstraint」。**那兩件事對不上。**
>
> 這個 repo 裡**兩種 enum 寫法並存**，而它們解的是同一個問題的兩條路：
>
> | 檔案 | 寫法 | 怎麼避開漂移 |
> |---|---|---|
> | `food.py`（`RevisionStatus`）、`user.py`（`UserRole`） | `Enum(T, name=…, values_callable=…)` | **原生 PG ENUM**（`CREATE TYPE`）—— 型別本身就是約束，沒有 CHECK 可以漂移 |
> | `meal.py`（`MealType`）、`supplement.py`（`TimeOfDay`） | `native_enum=False, create_constraint=False` + `__table_args__` 手寫 `CheckConstraint` | 手寫的 CHECK 不是 type-bound，兩側比對得起來 |
>
> handover §7 記的那個坑（`create_constraint=True` 產生 **type-bound**
> CHECK，alembic 的比對器把它排除在 model 那一側，但 reflection 讀回來是
> 普通 CHECK，於是永久報漂移）是 **`meal.py` 踩的**，不是 `food.py`。
> `meal.py` 的原始碼註解把整個機制寫下來了。
>
> **執行者讀完兩個檔案、發現指示與引用的 handover 內容互相矛盾，選了
> handover 的實質內容而不是計畫的檔案指標，並回報。** 那是對的處理。
>
> ### 採用的是 `meal.py` 那一套，而它對 `kind` 確實比較好
>
> 原生 enum 之後要加值得用 `ALTER TYPE`（migration 會變麻煩）；
> VARCHAR + CHECK 改起來便宜。`kind` 之後很可能會多一個值
> （例如條碼掃描），所以這個選擇不只是「照著某個檔案抄」。
>
> ### `native_enum=False` 讓 Python 那一層完全不驗
>
> 實測：對 ORM 直接塞 `kind="video"`，**綁定參數時不會做 enum 成員查找**，
> 字串原樣送進 VARCHAR。約束完全是資料庫在把關。
>
> 所以那條測試斷言的是 `IntegrityError` 且訊息含 `kind_valid` ——
> 斷言 Python 端拋 `ValueError` 會是一條永遠不會紅的測試。
>
> ### 突變驗證
>
> 刪掉 model 的索引宣告（migration 保留）→ `alembic check` 報漂移：
>
> ```
> Detected removed index 'ix_ai_analyses_user_id_created_at' on 'ai_analyses'
> ERROR: New upgrade operations detected: [('remove_index', ...)]
> ```
>
> 改回來之後連續跑兩次 `alembic check` 都乾淨。
>
> ### 一個計畫沒寫但必要的步驟
>
> **新 model 要 import 進 `app/models/__init__.py`**，否則 alembic 的
> `target_metadata` 看不到這張表 —— 而失敗訊息會是「資料庫有、模型沒有」，
> 容易被誤讀成 migration 寫錯。

**Files:**
- Create: `app/models/ai_analysis.py`
- Create: `migrations/versions/0008_create_ai_analyses.py`
- Test: `tests/test_ai_analysis_model.py`

- [ ] **Step 1: 寫 model**

`app/models/ai_analysis.py`。**去讀 `app/models/session.py` 看這個專案的
model 長什麼樣**（命名慣例、`Mapped` 的用法、`__table_args__` 的寫法），
照它的形狀寫。

```python
class AiAnalysis(Base):
    """每一次真的呼叫 LLM 就寫一列 —— 成功與失敗都寫。

    **它同時是每日額度的計數器。** 規格 §7.2：額度直接數這張表今天的列數，
    不另設計數器 —— 計數器與實際紀錄不可能對不上，因為它們是同一份資料。

    既有的 `app/ratelimit.py` 是記憶體計數、重啟歸零（handover §8.2）。
    對「防濫用」可接受，對**花錢**不行：每次部署、每次 NAS 重開都會把上限
    清掉，而這個 app 的部署頻率不低。

    `input_hash` 是拿來觀察重複率的，**不是拿來還原輸入**（規格 §6：
    圖片送去辨識完就丟）。
    """

    __tablename__ = "ai_analyses"

    id: Mapped[int] = mapped_column(BigInteger, Identity(always=True), primary_key=True)
    user_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("users.id"), nullable=False
    )
    kind: Mapped[str] = mapped_column(Text, nullable=False)
    model: Mapped[str] = mapped_column(Text, nullable=False)
    input_hash: Mapped[str] = mapped_column(Text, nullable=False)
    succeeded: Mapped[bool] = mapped_column(Boolean, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
```

**`kind` 要不要加 CheckConstraint 限制成 `'text' | 'image'`** —— 這個
專案對 enum 有明確的立場（handover §7：`Enum(create_constraint=True)` 會讓
`alembic check` 永久報漂移，要用 `False` + 手寫 CheckConstraint，
**而且「只寫 `create_constraint=False` 卻忘了手寫約束」等於完全沒有約束**）。
去讀 `app/models/food.py` 看 `RevisionStatus` 怎麼處理的，照同一個作法。

> **`CheckConstraint(name=)` 給的是命名慣例的輸入，不是最終名稱**
> （handover §7 第一條，這個專案踩過）。

- [ ] **Step 2: 加索引**

額度查詢是 `WHERE user_id = ? AND created_at >= ?`。加一個複合索引
`ix_ai_analyses_user_id_created_at`。

**先想清楚順序**：`(user_id, created_at)` 而不是反過來 —— 篩選力來自
`user_id`。（P3-B 那次 `ix_meal_items_food_revision_id` 的教訓：規格假設
某個索引「就是為這個查詢而存在」，實測 `EXPLAIN` 發現它根本沒出現在計畫裡。
**這次不需要實測 EXPLAIN，因為資料量還太小，但順序的理由要寫進註解。**）

- [ ] **Step 3: 寫 migration**

`migrations/versions/0008_create_ai_analyses.py`，`down_revision = "0007"`。
照 `0007_create_refresh_sessions.py` 的形狀寫，**包含 `downgrade()`**。

- [ ] **Step 4: 套用並確認沒有漂移**

```bash
cd F:/wallet && docker compose up -d --build   # migration 要重建映像，見〈開工前必讀〉5
cd F:/wallet && ./.venv/Scripts/python.exe -m alembic upgrade head
cd F:/wallet && ./.venv/Scripts/python.exe -m alembic check
```

Expected: `alembic check` 說沒有漂移。

> **`alembic check` 連續跑兩次都要乾淨。** 這個專案踩過：某些宣告方式會讓
> 它每次都報 remove_index，永遠收斂不了（handover §7）。

- [ ] **Step 5: 突變驗證**

> **必須成立：** 把 model 裡的索引宣告刪掉（migration 保留），
> `alembic check` 必須報漂移。
>
> **實測填回：** ——
>
> 這一條在驗「model 是可信的單一事實來源」這件事本身。

- [ ] **Step 6: Commit**

---

## Task 3: 一致性檢查（純函式）

> ## 實測記錄（已執行完畢）
>
> 完全照計畫的測試與實作程式碼做，沒有跟計畫不一致的地方需要回報。
>
> 唯一一件計畫沒講、需要自己確認的事：測試檔案的 import 風格。計畫本身
> 這個 task 的測試不需要 `pytest`（沒有 `pytest.raises`），但為了跟既有
> 慣例一致還是檢查了 `tests/test_cli.py`、`tests/test_config.py`——兩者都
> 把 `import pytest` 放在檔案最上面，不是函式內部。這個 task 沒有機會
> 踩到那個坑，但確認了風格。
>
> 邊界案例的算術自己算過一遍：`400 × 0.25 = 100`，`atwater = 4×25 + 4×50 +
> 9×0 = 300`，`deviation = |400 − 300| = 100`，`threshold = max(100, 20) =
> 100`，`100 > 100` 為 False → 不標記。`401` 的話 `deviation = 101`，
> `threshold = max(401×0.25, 20) = 100.25`，`101 > 100.25` 為 True → 標記。
> 計畫寫的是對的。
>
> `Decimal.quantize` 沒有拋 `InvalidOperation`——這個 task 用到的數值都很小，
> 沒有觸及預設 context 的 28 位有效數字上限。

**這是規格 §2 的核心，而它刻意不是一個 LLM agent。**

**Files:**
- Create: `app/ai/__init__.py`（空）
- Create: `app/ai/consistency.py`
- Test: `tests/test_ai_consistency.py`

- [x] **Step 1: 寫失敗的測試**

```python
from decimal import Decimal

from app.ai.consistency import check_consistency


def _c(kcal: str, protein: str, fat: str, carb: str):
    return check_consistency(
        kcal=Decimal(kcal),
        protein_g=Decimal(protein),
        fat_g=Decimal(fat),
        carb_g=Decimal(carb),
    )


def test_atwater_is_4_4_9():
    """熱量 = 4×蛋白質 + 4×碳水 + 9×脂肪。"""
    result = _c("100.00", "10.00", "0.00", "15.00")

    assert result.atwater_kcal == Decimal("100.00")
    assert result.deviation == Decimal("0.00")
    assert result.flagged is False


def test_fat_is_nine_not_four():
    """脂肪是 9 不是 4——寫錯的話這一條會紅，而上面那條（脂肪 0）不會。

    這就是為什麼上面那條刻意把脂肪設成 0：它對係數錯誤零鑑別力。
    """
    result = _c("90.00", "0.00", "10.00", "0.00")

    assert result.atwater_kcal == Decimal("90.00")
    assert result.flagged is False


def test_flags_a_large_deviation():
    # atwater = 4×10 + 4×10 + 9×0 = 80；宣稱 500 大卡
    result = _c("500.00", "10.00", "0.00", "10.00")

    assert result.flagged is True


def test_does_not_flag_small_absolute_deviation_on_low_calorie_food():
    """**規格 §2.1 的絕對下限那一條。**

    青菜：宣稱 8 大卡，atwater 算出來 5 大卡。偏差 3 大卡 = 37.5%，
    百分比門檻（25%）會標記它——但 3 大卡沒有任何意義。

    只測百分比的話這個雜訊來源完全沒被守到，而它會讓每一樣低熱量食物
    都被標記——**每一筆都被標記等於沒有標記**。
    """
    result = _c("8.00", "0.50", "0.00", "0.75")

    assert result.deviation == Decimal("3.00")
    assert result.flagged is False


def test_flags_when_both_thresholds_are_exceeded():
    """偏差同時超過 25% 與 20 大卡才標記。

    400 大卡 vs atwater 300：偏差 100，超過 max(100, 20) 嗎？
    400 × 0.25 = 100，偏差剛好 100 —— 用 `>` 所以**不標記**。
    邊界值刻意測，因為 `>` 跟 `>=` 的差別在這裡是一個真實的判斷。
    """
    boundary = _c("400.00", "25.00", "0.00", "50.00")
    assert boundary.atwater_kcal == Decimal("300.00")
    assert boundary.deviation == Decimal("100.00")
    assert boundary.flagged is False

    over = _c("401.00", "25.00", "0.00", "50.00")
    assert over.flagged is True


def test_zero_kcal_does_not_divide_by_zero():
    """宣稱 0 大卡（零卡飲料）。百分比門檻是 0，絕對下限 20 接手。"""
    result = _c("0.00", "0.00", "0.00", "0.00")

    assert result.flagged is False
```

- [x] **Step 2: 跑測試確認它失敗**

```bash
cd F:/wallet && ./.venv/Scripts/python.exe -m pytest tests/test_ai_consistency.py -q 2>&1 | tail -5
```

Expected: `ModuleNotFoundError: No module named 'app.ai'`

**實測：** 確認如預期，`ModuleNotFoundError: No module named 'app.ai'`。

- [x] **Step 3: 寫實作**

`app/ai/consistency.py`：

```python
"""營養素一致性檢查 —— 純函式，不碰網路也不碰資料庫。

## 為什麼這不是一個 LLM agent

P1 規格 §11 把驗證設計成 pipeline 第 ④ 步的 LLM agent，並說那是
「這個作品集最有價值的部分：展示『我知道 LLM 會胡說，所以我設計了驗證層』」。

**但它要檢查的是算術。** 用 LLM 檢查算術，等於用一個會胡說的東西檢查另一個
會胡說的東西 —— 而且貴、慢、不可重現、測試只能 mock 它。

改成純函式之後：確定性、零成本、測得密、突變得了。**而規格想展示的那句話
在這個版本反而更成立 —— 因為驗證層本身不會胡說。**
"""

from dataclasses import dataclass
from decimal import Decimal

# Atwater 係數。蛋白質與碳水 4 kcal/g、脂肪 9 kcal/g。
_KCAL_PER_G_PROTEIN = Decimal(4)
_KCAL_PER_G_CARB = Decimal(4)
_KCAL_PER_G_FAT = Decimal(9)

# 相對門檻刻意寬鬆：Atwater 是近似值，酒精（7 kcal/g）與膳食纖維都會讓它偏。
# 太嚴會讓每一筆都被標記，而每一筆都被標記等於沒有標記。
_RELATIVE_THRESHOLD = Decimal("0.25")
# 絕對下限：低熱量食物的小小絕對差會變成很大的百分比（5 vs 8 大卡是 60%），
# 但 3 大卡沒有意義。少了這一條，每一樣青菜都會被標記。
_ABSOLUTE_FLOOR_KCAL = Decimal(20)

_CENTS = Decimal("0.01")


@dataclass(frozen=True)
class Consistency:
    atwater_kcal: Decimal
    deviation: Decimal
    flagged: bool


def check_consistency(
    *, kcal: Decimal, protein_g: Decimal, fat_g: Decimal, carb_g: Decimal
) -> Consistency:
    """宣稱的熱量跟三大營養素算出來的熱量差多少。

    `flagged` 為 True **不代表數字是錯的**，只代表「這組數字值得看一眼」。
    規格 §2.2：標記不擋人 —— AI 可能是對的而係數是近似的，硬擋會讓使用者
    記不了東西。
    """
    atwater = (
        protein_g * _KCAL_PER_G_PROTEIN
        + carb_g * _KCAL_PER_G_CARB
        + fat_g * _KCAL_PER_G_FAT
    ).quantize(_CENTS)
    deviation = abs(kcal - atwater).quantize(_CENTS)
    threshold = max(kcal * _RELATIVE_THRESHOLD, _ABSOLUTE_FLOOR_KCAL)

    return Consistency(
        atwater_kcal=atwater, deviation=deviation, flagged=deviation > threshold
    )
```

- [x] **Step 4: 跑測試確認全綠**

**實測：** `pytest tests/test_ai_consistency.py -q` → `6 passed`。

- [x] **Step 5: 突變驗證**

> **必須成立（一）：** 把 `_KCAL_PER_G_FAT` 從 9 改成 4，至少一條測試紅。
>
> **實測填回：** 紅了，且只紅一條——`test_fat_is_nine_not_four`：
> `assert Decimal('40.00') == Decimal('90.00')`（`atwater_kcal` 從 90 掉成
> 40，因為 `9×10` 變成 `4×10`）。其餘 5 條仍綠，包含刻意把脂肪設成 0
> 的 `test_atwater_is_4_4_9`——證實那條測試對這個係數確實零鑑別力，正是
> 測試註解裡講的原因。

> **必須成立（二）：** 把 `threshold` 的 `max(...)` 改成只有相對門檻
> （拿掉 `_ABSOLUTE_FLOOR_KCAL`），至少一條測試紅，而且紅的是低熱量那條。
>
> **實測填回：** 紅了，且正是低熱量那條——
> `test_does_not_flag_small_absolute_deviation_on_low_calorie_food`：
> `assert True is False`（`flagged` 從 False 變 True，因為門檻從
> `max(2.00, 20) = 20` 掉成 `2.00`，而偏差 3.00 > 2.00）。其餘 5 條仍綠。

> **必須成立（三）：** 把 `deviation > threshold` 改成 `>=`，至少一條測試紅。
>
> **實測填回：** 紅了，且正是邊界案例那條——
> `test_flags_when_both_thresholds_are_exceeded`：
> `assert True is False`（`boundary.flagged` 從 False 變 True，因為
> `deviation == threshold == 100.00` 時 `>=` 成立而 `>` 不成立）。其餘 5
> 條仍綠。三個突變測完都已改回原樣，`diff` 確認實作檔案跟突變前逐位元組
> 相同。

- [x] **Step 6: Commit**

---

## Task 4: Estimator Protocol 與 Anthropic 實作

> ## 實測記錄（已執行完畢，commit `ae78faf` + 後續修正）
>
> ### ⚠️ 這份計畫自己內部矛盾，而 Task 4 的指示是錯的那一邊
>
> | 出處 | 說什麼 |
> |---|---|
> | Task 4 Step 2（原文） | 拋 `UnprocessableEntityError("AI_BAD_RESPONSE")` → **422** |
> | 規格 §4.1 | `502 AI_BAD_RESPONSE` |
> | Task 5「五條必須成立的行為」第 4 條 | 回 **502** `AI_BAD_RESPONSE` |
>
> 而 `app/errors.py` **沒有任何映射到 502 的類別**，七個 task 也沒有一個把它
> 列進檔案清單。照 Task 4 字面做完，客戶端收到的是 422。
>
> **規格是對的。** 422 的意思是「**你**送的東西有問題」；LLM 回了不能解析的
> JSON 時，使用者送的請求完全沒問題 —— 回 422 等於把上游的失敗算在使用者
> 頭上，而使用者會去改一個沒有錯的輸入。
>
> 已加 `BadGatewayError`（502）到 `app/errors.py`，並把 `estimator.py` 的
> 四處 `AI_BAD_RESPONSE` 換過去。**`INVALID_PHOTO` 維持 422** —— 那個真的
> 是使用者送的東西有問題。
>
> 並補一條**直接讀 `status_code`** 的測試：
>
> ```python
> assert exc_info.value.status_code == 502
> ```
>
> **只斷言例外類別不夠** —— 那只證明「拋的是我們選的那個類別」，沒有證明
> 那個類別真的對應到 502。突變驗證：把 `BadGatewayError` 的狀態碼改成 422，
> 只有這條紅。
>
> ### `anthropic` 1.8.0 的形狀跟一般認知不同（全部讀原始碼確認）
>
> - **沒有** OpenAI 風格的 `response_format`，但有 `output_config`，
>   其中 `format: {"type": "json_schema", "schema": …}` 可要求結構化輸出。
>   這個版本還內建 `anthropic.transform_schema()` 可以直接從 pydantic model
>   生成那個 schema。
> - `.stream()` 有 `output_format=SomeModel` 會自動解析，
>   **但非串流的 `create()` 沒有** —— 還是要自己 `json.loads` + pydantic 驗證。
> - 圖片的 `media_type` 是 `Literal["image/jpeg", "image/png", "image/gif",
>   "image/webp"]`，**只有這四種**，不是任意字串。
> - 回應的 `Message.content` 是 `list[ContentBlock]`（判別聯集），
>   要 `isinstance(block, TextBlock)` 才拿得到 `.text`。
> - 這個版本底層用 `httpx2` 不是 `httpx`。
>
> ### 解析那一段拆成純函式並獨立測了
>
> `parse_raw_estimate(response_text: str) -> RawEstimate` 只吃字串、不碰網路，
> 測試在 `tests/test_ai_estimator.py`（計畫的檔案結構表沒列它 —— 執行者判斷
> 它不屬於 Task 5 的 `test_ai_analyze.py`，那個要留給 HTTP 端點與假 estimator
> 注入的測試）。15 條，0.07 秒，涵蓋規格 §8.2 要求的四類垃圾輸入。
>
> 其中兩條專門釘住 `raw` 的語意：**存的是 `json.loads` 出來的原始字典**
> （連 LLM 把數字包成字串這種怪癖都原樣保留），不是驗證後轉型過的 Decimal
> —— 那是最容易被「順手優化」寫錯的地方，而規格 §5 的「AI 常常錯很多嗎」
> 要靠它回答。
>
> ### 一處計畫沒要求的加法
>
> 用了 SDK 的 `output_config` structured output。**它不是安全網** ——
> `parse_raw_estimate()` 的 pydantic 驗證才是真正擋垃圾的那一層，拿掉
> `output_config` 整段邏輯依然成立。

**這個 task 的設計目標是讓 Task 5 能斷言「LLM 一次都沒被呼叫」。**

**Files:**
- Create: `app/ai/estimator.py`
- Test: 這個 task 不獨立測（真實作要打網路）。它由 Task 5 的假實作間接驗證。

- [ ] **Step 1: 定義 Protocol 與資料型別**

```python
"""LLM 估算的介面與實作。

**Protocol 不是為了「將來換供應商」寫的，是為了測試能斷言它沒被呼叫。**

規格 §8.3：「搜得到就不呼叫 LLM」這條保證，如果測試只斷言「回傳的營養素
等於食物庫裡那筆」，那麼一個**先呼叫 LLM、再用食物庫的值覆蓋**的實作
也會全綠 —— 而它每次都在花錢。必須斷言的是「那個方法被呼叫了 0 次」，
而那需要一個可以注入的假實作。
"""

from dataclasses import dataclass
from decimal import Decimal
from typing import Protocol


@dataclass(frozen=True)
class RawEstimate:
    """LLM 對「一份」的估算。

    **這是「一份」的值，不是每 100g。** 換算成 `NutritionInput` 要的
    每 100g 由 `app/api/routes/ai.py` 做一次，前端不重算（規格 §4.1）。
    """

    name: str
    brand: str | None
    serving_grams: Decimal
    # **欄位名帶 serving_ 前綴是刻意的。**
    #
    # `AnalyzedNutrition`（Task 5）有一組叫 `kcal` / `protein_g` / … 的欄位，
    # 而那組是**每 100g**。如果這裡也叫 `kcal`，兩個意義完全不同的東西
    # 就會共用同一個名字，而它們會在同一個檔案裡被同時操作（換算那一段）。
    #
    # 那正是這個專案反覆踩到的形狀：兩處講「同一個」東西，其實不是同一個。
    serving_kcal: Decimal
    serving_protein_g: Decimal
    serving_fat_g: Decimal
    serving_carb_g: Decimal
    confidence: Decimal
    raw: dict[str, object]


class NutritionEstimator(Protocol):
    async def estimate_text(self, text: str) -> RawEstimate: ...
    async def estimate_image(self, image: bytes, media_type: str) -> RawEstimate: ...
```

- [ ] **Step 2: 寫 Anthropic 實作**

用 `anthropic.AsyncAnthropic`，`settings.ai_model`，要求結構化 JSON 輸出。

**回傳的東西必須被驗證過才包成 `RawEstimate`** —— 規格 §8.2 要求
「LLM 回傳垃圾（缺欄位、負數、超出範圍、不是 JSON）都不能讓畫面炸掉」。

用一個 Pydantic model 解析 LLM 的 JSON，解析失敗就拋
`BadGatewayError("AI_BAD_RESPONSE", ...)` —— **502，不是 422**（見下）。

> **`raw` 欄位要存 LLM 原始回覆的 JSON**，不是解析後的物件 ——
> 規格 §5 的「AI 常常錯很多嗎」要靠它回答。

> **prompt 的文字留給你**（它需要對著真的 API 迭代，寫在計畫裡只會是猜測），
> 但有四個硬要求：
>
> 1. **要求它回 JSON**，欄位名跟 `RawEstimate` 對齊（含 `serving_` 前綴）
> 2. **要求它估「一份」是幾克** —— 那是 `serving_grams`，沒有它就換算不了
> 3. **要求它只回一樣食物**（規格 §9：這一版不做多食物辨識）。
>    照片裡有三樣菜時要它挑最主要的那一樣，而不是回一個陣列
> 4. **不要在 prompt 裡要求它自己檢查 Atwater** —— 那是 `consistency.py`
>    的工作，而那一層的價值就在於它不是 LLM 說的
>
> 寫完把實際的 prompt 貼進報告，我要看。

- [ ] **Step 3: 依賴注入**

在 `app/api/deps.py` 加：

```python
async def get_estimator() -> NutritionEstimator:
    """沒設 API key 就拋 503 —— 規格 §4.1：關閉必須是明講的，
    不是一個看起來壞掉的樣子。
    """
    if settings.anthropic_api_key is None:
        raise ServiceUnavailableError("AI_NOT_CONFIGURED", "AI 分析未設定")
    return AnthropicEstimator(...)
```

**去讀 `app/api/deps.py` 現有的依賴長什麼樣**，照同一個形狀。

- [ ] **Step 4: 驗證與 commit**

```bash
cd F:/wallet && ./.venv/Scripts/ruff.exe check . && ./.venv/Scripts/mypy.exe app
```

---

## Task 5: `POST /api/ai/analyze`

> ## 實測記錄（已執行完畢）
>
> ### 標題寫「五條」，內文列了七條——沿用內文，不是漏算
>
> 這個小節的標題是「五條必須成立的行為」，但底下的編號清單其實列了 1–7
> 七項。執行時以內文的七項為準（跟第 6、7 條各自獨立成一小節的事實一致），
> 標題文字本身沒有改，僅在這裡記錄這個既有的不一致，供之後校對計畫文字時
> 參考。
>
> ### 「食物庫搜得到就不呼叫 LLM」這一條，規格沒講死「搜」是什麼意思——這裡是實作時做的判斷
>
> 規格 §3 只說「先搜自己的食物庫（DB 查詢）」，沒有規定比對方式，也沒有
> 規定命中時的回應要長什麼樣（那個分支甚至不在規格 §4.1 的回應範例裡）。
> 讀完規格全文（尤其是「找到 → 直接選，結束」這句話）之後做了以下判斷，
> 都在 `app/api/routes/ai.py` 的 docstring 裡寫了理由：
>
> 1. **只有 `kind=text` 會搜**——`kind=image` 沒有文字可以拿來查食物庫，
>    一律直接進入額度檢查 + 呼叫 LLM。`test_library_search_only_applies_to_text_not_image`
>    釘住這件事：食物庫裡故意放一筆同名食物，圖片分析仍然呼叫了 LLM。
> 2. **比對方式是精確比對（不分大小寫，`ILIKE` 無萬用字元），不是子字串**——
>    這個文字欄位通常是一段描述（規格 §4.1 範例「一碗滷肉飯」），子字串
>    比對在多義詞情境下會不可預期地誤判「找到」。
> 3. **可見範圍是使用者看得到的食物（自己的 + 全域），跟 `search_foods`
>    同一個可見性規則**，不是規格字面「自己的食物庫」那麼窄——全域食物
>    （例如「白飯」）沒有理由要為它多花一次 LLM 呼叫。
> 4. **命中時 `analysis_id` 回 `null`**（`AnalyzeResponse.analysis_id` 因此
>    宣告成 `int | None`）——規格 §3 明講這條路徑「不計入每日上限」，而
>    額度就是直接數 `ai_analyses` 的列數（§7.2），兩者合起來代表這個分支
>    **不能**寫入 `ai_analyses`，所以沒有列可以參照。這是規格例文沒有涵蓋
>    到的分支，回應形狀是這個 task 自己補的決定，不是照抄規格的例子。
> 5. **命中時 `serving_grams` 固定回 `100.00`**，讓「一份」等於「每 100g」——
>    食物庫裡的資料本來就沒有「AI 估的一份是幾克」這個概念，用 100 讓
>    `serving_*` 與每 100g 的值自然相等，不需要另外杜撰一個假的份量。
> 6. **命中時 `confidence` 固定回 `1.00`**——這不是 AI 自陳值，是查到的、
>    已經驗證過的資料，用 1.00 表示「這不是估的」。
>
> ### `get_estimator()` 用一般的 `Depends()`，不是延後解析——這是刻意的取捨
>
> `estimator: NutritionEstimator = Depends(get_estimator)` 這個宣告方式，
> 代表 FastAPI 會在路由函式本體執行**之前**就解析這個依賴——如果沒設
> `ANTHROPIC_API_KEY`，`get_estimator()` 會在食物庫搜尋跑之前就先拋
> `AI_NOT_CONFIGURED`，即使這次呼叫其實靠食物庫短路就能滿足，也不例外。
>
> 這不是疏漏，是刻意的取捨，理由有兩個：(a) 七條必須成立的行為沒有一條
> 要求「沒設 key 但食物庫搜得到時仍要成功」，(b) 拿掉 `Depends()` 改成在
> 需要時才手動呼叫 `get_estimator()`，會讓 `app.dependency_overrides[get_estimator]`
> 這個注入機制失效（override 只對 FastAPI 解析的 `Depends()` 生效），而
> 計畫明講測試就是要用這個機制注入假 estimator。維持 `Depends()` 的形狀，
> 犧牲的是一個規格沒有要求的邊角案例。
>
> ### `MAX_PHOTO_BYTES` 沿用 `app/api/routes/meals.py` 既有的常數，跨路由 import
>
> 規格表格寫「沿用照片上傳既有的 `PHOTO_TOO_LARGE` / `INVALID_PHOTO` 慣例」，
> 但那個常數目前定義在 `app/api/routes/meals.py`（不是 `app/storage/photos.py`
> 這種共用模組）。這裡直接 `from app.api.routes.meals import MAX_PHOTO_BYTES`
> 重用同一個數字，而不是複製一份常數——兩份常數之後會漂移，是這個專案
> 反覆踩過的形狀。跨路由模組 import 一個常數在這個 codebase 沒有先例，
> 但沒有找到更好的位置：這個常數的本質是「上傳內容大小上限」，兩個端點
> 剛好都要用，搬到 `app/storage/photos.py` 或 `app/config.py` 都是合理的
> 後續重構方向，這個 task 沒有動它。
>
> ### 一個在突變驗證時抓到的測試自己的 bug——跟這個 task 要驗的東西無關，但值得記下來
>
> 第一版的「失敗也計入額度」測試在 `await db_session.rollback()` 之後，
> 用 `AiAnalysis.user_id == user.id` 查詢——`user.id` 是 rollback 之後才讀的
> ORM 屬性。**這個測試在正常（未突變）程式碼下可以通過**，因為
> `_call_estimator_or_record_failure` 的 `await db.commit()` 先跑過一次，
> 讓 session 進入乾淨的狀態；但套用突變二（拿掉那個 commit）之後，同一行
> `user.id` 觸發同步 refresh，直接炸 `MissingGreenlet`，而不是乾淨地
> assert 失敗。照抄 `tests/test_sessions.py` 已經寫下的教訓（「先把 id
> 取出來」），把 `user_id = user.id` 移到 `rollback()` 之前，問題消失，
> 突變二之後這條測試改成乾淨地 `assert 0 == 1` 變紅。細節見下面的突變
> 記錄與 `tests/test_ai_analyze.py` 的 `user_id` 那行註解。
>
> ### 三個突變驗證，另外加了兩個「應該仍然綠」的邊界對照組
>
> 除了計畫要求的三個突變，測試裡另外加了兩個對照組
> （`test_the_20th_call_today_is_still_allowed`、
> `test_library_search_only_applies_to_text_not_image`），在**沒有**套用
> 任何突變的正常程式碼下確認相鄰的邊界行為沒有被過度收緊。三個計畫要求
> 的突變全部照計畫的預期紅了：
>
> | 突變 | 結果 |
> |---|---|
> | 拿掉「先搜食物庫」那段（一律呼叫 LLM） | 只有 `test_library_hit_does_not_call_the_llm` 紅，**紅在 `assert fake.calls == 0`**（`assert 1 == 0`），不是紅在回傳值——不是規格 §8.3 警告的假綠燈 |
> | 「失敗也寫 `ai_analyses`」改成只在成功時寫 | 只有 `test_a_failed_llm_call_is_still_recorded_in_ai_analyses` 紅，`assert len(rows) == 1` 變成 `assert 0 == 1` |
> | 額度比較從 `>=` 改成 `>` | 只有 `test_the_21st_call_today_is_blocked` 紅，`assert response.status_code == 429` 變成 `assert 200 == 429` |
>
> 三次突變測完都已改回原樣，`git status` / `git diff` 確認 `app/api/routes/ai.py`
> 跟突變前逐位元組相同，`pytest tests/test_ai_analyze.py -q` 回到 10 passed。

**Files:**
- Create: `app/schemas/ai.py`
- Create: `app/api/routes/ai.py`
- Modify: `app/main.py`
- Test: `tests/test_ai_analyze.py`

### 五條必須成立的行為

1. **食物庫搜得到就不呼叫 LLM** —— 斷言假 estimator 的呼叫次數是 **0**
2. **第 21 次被擋**（`429 AI_DAILY_LIMIT`），而且訊息含「今天用了 N/20」
3. **失敗的呼叫也計入額度** —— LLM 拋錯之後，`ai_analyses` 要有那一列
4. **LLM 回傳垃圾不會 500** —— 回 `502 AI_BAD_RESPONSE`
5. **沒設 API key 回 `503 AI_NOT_CONFIGURED`**
6. **`flagged` 為 True 時仍然正常回 200** —— 規格 §2.2：標記不擋人。
   一致性檢查失敗**不是**錯誤，是一個附註
7. **圖片不會被寫到磁碟** —— 規格 §6

### 第 6 條容易被實作成「擋下來」

驗證失敗看起來很像應該回 422。**不是。** AI 可能是對的而 Atwater 係數是
近似值（酒精、纖維都會讓它偏），硬擋會讓使用者記不了東西。

測試要送一組刻意矛盾的數字（例如 500 大卡但三大營養素只算得出 80），
斷言 **HTTP 200** 且 `consistency.flagged is True`。

### 第 7 條要斷言檔案系統

規格 §6：圖片送去辨識完就丟，不寫進 `photo_dir`、不進資料庫。

**斷言 `settings.photo_dir` 底下的檔案數在呼叫前後沒有變。** 不要只斷言
「回應裡沒有 photo_path」—— 那證明不了檔案沒被寫出去。

### 第 3 條需要照抄 `_reject()` 的形狀

`app/security/sessions.py` 的 `_reject() -> NoReturn` 在拋出例外之前先
`commit()`。**去讀它。**

不照做的後果：LLM 回了垃圾（那次一樣花了錢），而 `ai_analyses` 裡沒有紀錄、
額度也沒扣 —— 於是「LLM 一直失敗」變成一個不花錢的無限迴圈，而它其實
每次都在計費。

> **這一條的測試要驗的是資料庫裡真的有那一列**，不是驗回應碼。
> 而且要注意 `db_session` fixture 用 `join_transaction_mode="create_savepoint"`，
> **`commit()` 在測試裡不會真的提交** —— 這個專案踩過三次
> （計畫一 Task 7 的「commit 不可觀察」）。要斷言之前先
> `await db_session.rollback()`，然後**用 select 讀欄位、不要讀 ORM 實體**
> （rollback 會讓物件過期，之後讀屬性會觸發同步 refresh 而炸 `MissingGreenlet`）。

- [x] **Step 1: 寫 schema**

`app/schemas/ai.py`。Request 是一個 discriminated union（`kind` 決定形狀），
Response 照規格 §4.1 的形狀。

**`nutrition` 要同時給每 100g 與一份的值**，而且**兩者都由後端算**：

```python
class AnalyzedNutrition(BaseModel):
    base_unit: BaseUnit
    serving_grams: Decimal
    # 每 100g/ml —— 直接餵得進 FoodCreateRequest.nutrition
    kcal: Decimal
    protein_g: Decimal
    fat_g: Decimal
    carb_g: Decimal
    # 一份的值 —— 給人看的。**前端不重算**（規格 §4.1）
    serving_kcal: Decimal
    serving_protein_g: Decimal
    serving_fat_g: Decimal
    serving_carb_g: Decimal
```

> **兩組數字必須一致，而那是一個要測的東西**：
> `serving_kcal == kcal × serving_grams / 100`（含四捨五入）。
> 加一條測試釘住它 —— 兩處講同一件事就會漂移，這個專案踩過五次。

- [x] **Step 2: 寫測試**

用假 estimator 注入（`app.dependency_overrides[get_estimator]`）。
**假實作要能數呼叫次數。**

去讀 `tests/conftest.py` 看 `client` fixture 怎麼做 override 的。

**實測：** `tests/test_ai_analyze.py` 的 `FakeEstimator` 分別數
`text_calls` / `image_calls`（`calls` 是兩者的和），注入方式是
`app.dependency_overrides[get_estimator] = lambda: fake`——`client` fixture
的 `finally: app.dependency_overrides.clear()` 會在每個測試結束後把它
一起清掉，不需要額外的清理。

- [x] **Step 3–5: 實作、掛 router、跑測試**

**實測：** `tests/test_ai_analyze.py -q` → 10 passed。全套
`pytest -q` → 551 passed（基準 541 + 這個 task 新增 10 條）。
`ruff check .` → All checks passed。`mypy app` → no issues in 56 source
files（基準 54 + `app/schemas/ai.py` + `app/api/routes/ai.py`）。

- [x] **Step 6: 突變驗證**

> **必須成立（一）：** 把「先搜食物庫」那段拿掉（一律呼叫 LLM），
> 第 1 條測試必須紅，**而且紅在呼叫次數那一行**，不是紅在回傳值。
>
> **實測填回：** 紅了，且只紅一條——`test_library_hit_does_not_call_the_llm`：
> `assert fake.calls == 0` 變成 `assert 1 == 0`（`AssertionError: assert 1 == 0
> where 1 = <FakeEstimator...>.calls`）。**紅在呼叫次數那一行，不是紅在
> 回傳值**——`test_library_search_only_applies_to_text_not_image` 等其餘
> 9 條仍綠。不是規格 §8.3 警告的假綠燈，不需要停下來報告。

> **必須成立（二）：** 把「失敗也寫 `ai_analyses`」改成只在成功時寫，
> 第 3 條測試必須紅。
>
> **實測填回：** 紅了，且只紅一條——`test_a_failed_llm_call_is_still_recorded_in_ai_analyses`：
> `assert len(rows) == 1` 變成 `assert 0 == 1`（`AssertionError: assert 0 == 1
> where 0 = len([])`）——`rollback()` 之後那一列真的不見了，證明拿掉的
> `commit()` 正是「這一列有沒有真的寫進資料庫」的唯一原因。其餘 9 條仍綠。
> （突變驗證過程中另外抓到一個測試自己的 bug，跟這個突變無關，見上面
> 「實測記錄」一節的說明；修好之後才有這條乾淨的紅。）

> **必須成立（三）：** 把額度比較從 `>=` 改成 `>`（差一錯誤），
> 第 2 條測試必須紅。
>
> **實測填回：** 紅了，且只紅一條——`test_the_21st_call_today_is_blocked`：
> `assert response.status_code == 429` 變成 `assert 200 == 429`（第 21 次
> 呼叫在 `>` 之下被放行，回了 200 而不是 429）。其餘 9 條仍綠，包含對照組
> `test_the_20th_call_today_is_still_allowed`（第 20 次本來就該放行，不受
> 這個突變影響）。

- [x] **Step 7: Commit**

---

## Task 6: `create_food` 接受來源標記

**Files:**
- Modify: `app/schemas/food.py`
- Modify: `app/api/routes/foods.py`
- Test: `tests/test_foods_ai_source.py`

### 規格 §5：「有沒有改」是資料

| 路徑 | `source` | `ai_confidence` | `ai_raw_response` |
|---|---|---|---|
| 直接按「確認」 | `'ai'` | AI 給的 | LLM 原始回覆 |
| 「需要修改」後確認 | `'user'` | AI 給的 | **仍然存** |

**這件事不會因為功能正常運作而自動被驗到** —— 兩條路徑都會成功存出一個
食物，回應看起來一模一樣。只有專門斷言 `source` 的測試守得住。

- [ ] **Step 1: 寫失敗的測試**

三條：

1. 不帶那三個欄位時，`source` 是預設的 `'user'`、另外兩個是 `NULL`
   （**既有行為不能壞**）
2. 帶 `source='ai'` 時真的寫進 `food_revisions`
3. 帶 `source='user'` 但**同時帶 `ai_raw_response`** 時，兩者都寫進去
   （那就是「改過才確認」那條路徑）

**斷言要讀資料庫，不是讀回應** —— `FoodResponse` 沒有這三個欄位，
讀回應什麼都驗不到。

- [ ] **Step 2–5: 實作、驗證、突變**

`FoodCreateRequest` 加：

```python
    # P1 就預留好的三個欄位（`food_revisions`），P2 是第一個使用者。
    # 規格 §5：「直接確認」與「改過才確認」要分得出來。
    source: str = "user"
    ai_confidence: Decimal | None = Field(default=None, ge=0, le=1, decimal_places=2)
    ai_raw_response: dict[str, Any] | None = None
```

> **`source` 要不要限制成 `'user' | 'ai' | 'official'`？** 資料庫那一欄
> 目前**沒有** CheckConstraint（去確認）。前端能送任意字串進去就是一個洞。
> **自己判斷要加 Pydantic 驗證、資料庫約束、還是兩個都加**，並在報告裡
> 說明理由。

> **必須成立：** 把 `create_food` 寫入 `source` 那一行改成寫死 `"user"`，
> 至少一條測試紅。
>
> **實測填回：** ——

- [ ] **Step 6: Commit**

---

## 收尾

- [ ] 把每一處「實測填回」都填上
- [ ] 跟預期不同的都寫進計畫
- [ ] **貼出 Task 4 實際用的 prompt**
- [ ] 全套驗證：`pytest -q`、`ruff check .`、`mypy app`、`alembic check`
- [ ] 開 PR

**前端是計畫二**，等這份合併之後再寫 —— 那時會有一個真的能打的端點。
