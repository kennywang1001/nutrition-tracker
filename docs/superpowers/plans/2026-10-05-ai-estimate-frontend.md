# AI 估算的前端 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 後端可以在 Anthropic 與 Gemini 之間切換；使用者可以在記一餐與新增食物用 AI 從文字或照片估算一份的營養素，確認或修改後存成自己的食物。

**Architecture:** 後端把兩家實作分成兩個檔案、共用提示詞與解析，`build_estimator()` 依 `AI_PROVIDER` 建實作；路由改成拿一個「建實作的函式」，先查食物庫、真的要呼叫 AI 才建。前端一個 `AiEstimatePanel` 元件（估算、結果卡片、確認／需要修改、存成食物），透過 `FoodPicker` 的新 prop 放進記一餐、直接放進新增食物。

**Tech Stack:** FastAPI · Pydantic Settings · anthropic · google-genai · SQLAlchemy async · React 19 · TypeScript strict · TanStack Query · Vitest + Testing Library · Playwright · Biome

**依據規格：** `docs/superpowers/specs/2026-10-05-ai-estimate-frontend-design.md`

---

## 執行環境

- 分支 `feat/ai-estimate`（規格 commit `721f959`）。
- 後端在 repo 根目錄：`./.venv/Scripts/python.exe -m pytest -q`、`… -m ruff check app tests`、`… -m mypy app`。測試資料庫 `wallet-db-1` 要 healthy（沒開就回報）。
- 前端在 `frontend/`：`npx vitest run tests/xxx`、`npm run -s typecheck`、`npm run -s lint`、`npm run -s test`。Vitest 會把每個測試檔再跑一次型別檢查，數量看起來是兩倍。lint 抱怨格式時用 `npx biome check --write <檔案>`。
- 基準線（master `99a633b`）：後端 636 passed；前端 82 檔 750 passed；e2e 19 passed。
- **`schema.d.ts` 重新產生**（Windows 一定要加 UTF-8 環境變數）：

  ```bash
  S=C:/Users/user/AppData/Local/Temp/claude/f--wallet/e7b60c93-fbd5-4a61-9c85-74550ff7244b/scratchpad
  PYTHONUTF8=1 PYTHONIOENCODING=utf-8 ./.venv/Scripts/python.exe -c "import json; from app.main import app; print(json.dumps(app.openapi(), ensure_ascii=False))" > "$S/openapi.tmp.json"
  (cd frontend && npx openapi-typescript "$S/openapi.tmp.json" -o src/api/schema.d.ts)
  rm "$S/openapi.tmp.json"
  ```

  完成後確認 `schema.d.ts` 是 LF、中文沒有亂碼。
- **檔案編輯用 Write/Edit；LF 換行。不要在 repo 裡或 repo 外的任何地方複製備份檔、留暫存腳本。**
- **突變測試的還原：** 檔案有本任務其他未 commit 的改動時，不要用 `git checkout --`，手動改回並重跑測試確認。
- Commit：`git commit -F <scratchpad 裡的檔案>`，中文全形標點，結尾 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`。不要 stage `lunch.jpg`。
- **不要打真的 AI API。** 測試一律用假實作或 mock。

---

## 開工前必讀：這份計畫的文字沒有權威性

前五份計畫都被抓到錯誤。

1. 「Expected: FAIL」沒有如預期失敗 → **停下來回報**，不要調整測試讓它變紅。
2. 預測紅 N 條、實際不是 N → 照實回報是哪幾條。
3. 要改的檔案不在清單上 → 回報。
4. 引用的程式碼對不上現況 → 以現況為準並回報。
5. 斷言「某件事沒發生」在動作是非同步時會空轉通過（handover §6 第 41 種）——先證明畫面已經是「載入完成」的狀態。
6. Playwright 的 `getByLabel` 預設是**子字串**比對（第 48 種）；testing-library 的 `getByLabelText` 預設是完整比對。
7. 斷言「呼叫了某個函式」不等於「那個函式要達成的效果發生了」（第 50 種）。
8. **先寫測試、跑一次看它紅，再寫實作。** 上一份計畫有一個任務跳過這一步，事後要靠突變補證據。

---

## 開工前已經查證過的事實

| 事實 | 出處 |
|---|---|
| `analyze` 用 `estimator: NutritionEstimator = Depends(get_estimator)`；FastAPI 在進 handler 前解析——**沒設金鑰時連食物庫命中也回 503** | `app/api/routes/ai.py:281-286`、`app/api/deps.py:41-51` |
| 測試用 `app.dependency_overrides[get_estimator] = lambda: fake` 注入假實作（只有 `_inject()` 一處），`tests/conftest.py` 每個測試後 `dependency_overrides.clear()` | `tests/test_ai_analyze.py:76-77`、`tests/conftest.py:166` |
| `ai_analyses.model` 是 NOT NULL，目前寫 `settings.ai_model`（兩處：成功與失敗）；測試的 `_seed_analyses` 也用 `settings.ai_model` | `app/api/routes/ai.py:189,324`、`tests/test_ai_analyze.py:86` |
| `ai_model` 目前預設 `"claude-sonnet-5"`；`test_anthropic_key_defaults_to_none` 斷言這個預設值 | `app/config.py:42`、`tests/test_config.py:64` |
| 空字串金鑰正規化成 None 的 validator 只套在 `anthropic_api_key` | `app/config.py:46-60` |
| `feat/p2-gemini` 分支的 `GeminiEstimator`：`genai.Client(api_key=...)`、`client.aio.models.generate_content(model, contents, config=GenerateContentConfig(system_instruction, max_output_tokens, response_mime_type="application/json", response_schema=<手刻的 Google Schema 字典>))`；**不能直接把 pydantic model 傳給 `response_schema`**（`exclusiveMinimum` 不被接受，分支註解有實測說明） | `git show feat/p2-gemini:app/ai/estimator.py` |
| `.venv` 已經裝了 `google-genai 2.25.0`；鎖定檔的產生方式是 `pip freeze --exclude-editable > requirements-lock.txt`；Dockerfile 與 CI 都用 `pip install -c requirements-lock.txt` | `docs/superpowers/plans/2026-09-02-p1-plan1-skeleton-and-auth.md:220`、`Dockerfile:12`、`.github/workflows/ci.yml:87` |
| `docker-compose.yml` 只傳 `ANTHROPIC_API_KEY: "${ANTHROPIC_API_KEY:-}"` | `docker-compose.yml:44` |
| `_library_hit_response` 回 `analysis_id=None`、沒有食物 id；食物庫比對是**精確（不分大小寫）**，只對 `kind=text` | `app/api/routes/ai.py:62-127` |
| `_assert_quota_available` 數今天的 `ai_analyses` 列數，`>=` 上限就 429 `AI_DAILY_LIMIT` | `app/api/routes/ai.py:130-163` |
| `create_food` 的撞名檢查是「同擁有者、同名、同品牌」，三處拋 `FOOD_EXISTS`：前置查詢、`flush` 的 `IntegrityError`、`commit` 的 `IntegrityError`；`ConflictError` 接受 `details` | `app/api/routes/foods.py:52-132`、`app/errors.py:38-40` |
| `perServingToPer100(value, servingGrams)` 回 `string \| null`；`NUMERIC_FIELDS`（含 `max`）與 `describeFieldErrors` 從 `NewFood.tsx` 匯出 | `frontend/src/lib/decimal.ts:84`、`frontend/src/screens/NewFood.tsx:24-34,58` |
| `shrinkToLongestEdge(file, 1280)`、`MAX_PHOTO_BYTES`、`PhotoTooLargeError`、`describePhotoUploadError` 都已存在 | `frontend/src/lib/resize-image.ts`、`frontend/src/api/photos.ts` |
| `queryKeys.foodSearch(q, scope)` = `["food-search", q, scope]`（獨立命名空間，沒有「全部搜尋」的前綴 key） | `frontend/src/api/queries.ts` |
| `FoodPicker` 回 fragment：搜尋框 div → 搜尋結果 → 常吃／最近吃；搜尋字串是元件內部 state | `frontend/src/components/FoodPicker.tsx` |
| `LogMeal` 的照片是內部 state（`photo`／`setPhoto`／`photoError`），選檔時先擋大小 | `frontend/src/screens/LogMeal.tsx` |
| `usePortionQuantity` 選預設份量時「自己的預設優先」——AI 存出來的食物帶 `default_portion`（私人），會被自動選上 | `frontend/src/lib/portions.ts`、`frontend/src/components/PortionQuantityFields.tsx` |

---

## 與規格的差異（寫計畫時決定）

1. **路由拿的是「建實作的函式」**：新的依賴 `get_estimator_factory()` 回傳 `build_estimator`（一個會在設定不完整時拋 503 的函式）。路由先查食物庫，再呼叫它。測試改成覆寫 `get_estimator_factory`。`get_estimator` 這個名字移除。
2. **`NutritionEstimator` Protocol 多一個 `model: str` 屬性**，`ai_analyses.model` 改記實作自己的 `model`（不是 `settings.ai_model`——它現在可以是 None）。
3. **📷 拍照估算不在搜尋框同一列**，而是在搜尋框正下方、跟「用 AI 估算『…』」同一列（`FoodPicker` 只多一個「在搜尋框下面放東西」的 render prop，不改搜尋框本身的版面）。
4. **照片帶入的時機**：面板在「交回食物」時一起交回當初估算用的照片（`onFoodReady(food, { image })`）。估算失敗或放棄時不帶入。
5. **`AI_PROVIDER` 不分大小寫以外的寫法**：只接受小寫 `anthropic`／`gemini`（打成 `Gemini` 也算打錯字，啟動失敗）。
6. **加一個前端 query key `foodSearchAll = ["food-search"]`**，存成食物之後用它失效所有搜尋結果。

---

## 檔案結構

| 檔案 | 負責什麼 |
|---|---|
| `app/config.py`（改） | `ai_provider`、`gemini_api_key`、`ai_model` 不再有預設；空字串正規化套到四個欄位 |
| `app/ai/estimator.py`（改） | 只留共用：`NutritionEstimator`（多 `model`）、`RawEstimate`、提示詞、`LLMEstimateSchema`、`parse_raw_estimate` |
| `app/ai/anthropic_estimator.py`（新） | `AnthropicEstimator`（從 `estimator.py` 搬來） |
| `app/ai/gemini_estimator.py`（新） | `GeminiEstimator`（從 `feat/p2-gemini` 搬來） |
| `app/api/deps.py`（改） | `build_estimator()`、`EstimatorFactory`、`get_estimator_factory()` |
| `app/api/routes/ai.py`（改） | 先查食物庫再建實作；`food_id`、`remaining_today`；`model` 從實作來 |
| `app/schemas/ai.py`（改） | `AnalyzeResponse.food_id`、`remaining_today` |
| `app/api/routes/foods.py`（改） | `_find_same_named_food`；三處 `FOOD_EXISTS` 附 `food_id` |
| `pyproject.toml`、`requirements-lock.txt`、`docker-compose.yml`、`.env.production.example`（改） | `google-genai`；新的環境變數 |
| `tests/test_config.py`、`tests/test_ai_analyze.py`、`tests/test_foods*.py`（改）、`tests/test_ai_provider.py`（新） | |
| `frontend/src/api/schema.d.ts`（重新產生） | |
| `frontend/src/api/queries.ts`（改） | `foodSearchAll` |
| `frontend/src/api/ai.ts`（新） | `AnalyzeResponse` 型別、`analyzeText`、`analyzeImage`、`fileToBase64` |
| `frontend/src/lib/ai-food.ts`（新） | 純函式：從估算組 `POST /api/foods` 的 body（確認／修改兩種），以及修改表單的驗證 |
| `frontend/src/components/AiEstimatePanel.tsx`＋`.module.css`（新） | 面板 |
| `frontend/src/components/FoodPicker.tsx`（改） | `renderBelowSearch?: (query: string) => ReactNode` |
| `frontend/src/screens/LogMeal.tsx`（改） | 放進面板、選上食物、照片帶入 |
| `frontend/src/screens/NewFood.tsx`（改） | 「用 AI 填」區塊 |
| `frontend/tests/ai-food.test.ts`、`ai-estimate-panel.test.tsx`、`log-meal-ai.test.tsx`、`new-food-ai.test.tsx`（新） | |
| `frontend/e2e/ai-estimate.spec.ts`（新） | |
| `docs/deployment.md`、`docs/handover.md`（改） | |

---

## Task 1：後端——Anthropic 與 Gemini 並存，用 `AI_PROVIDER` 切換

**Files:**
- Modify: `app/config.py`、`app/ai/estimator.py`、`app/api/deps.py`、`app/api/routes/ai.py`、`pyproject.toml`、`requirements-lock.txt`、`docker-compose.yml`、`.env.production.example`
- Create: `app/ai/anthropic_estimator.py`、`app/ai/gemini_estimator.py`、`tests/test_ai_provider.py`
- Test: `tests/test_config.py`、`tests/test_ai_analyze.py`

這個任務**不改路由的行為**（建實作仍然在 handler 一開始）；只改「怎麼建」與「怎麼注入」。順序的改變在 Task 2。

- [ ] **Step 1: 寫失敗的測試**

`tests/test_config.py`：**刪掉** `test_anthropic_key_defaults_to_none`（它斷言 `ai_model == "claude-sonnet-5"`——那個猜的預設值這次拿掉）。檔尾加：

```python
_AI_ENV_VARS = ("AI_PROVIDER", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "AI_MODEL")


def _clear_ai_env(monkeypatch):
    for name in _AI_ENV_VARS:
        monkeypatch.delenv(name, raising=False)


def test_ai_is_off_by_default(monkeypatch):
    """沒設 AI 不該讓 app 起不來——它是選配功能，不是安全性設定
    （跟 jwt_secret 刻意相反）。`_env_file=None`：本機自己的 .env 不能讓
    這條測試多一個變因。"""
    _clear_ai_env(monkeypatch)

    settings = Settings(jwt_secret="x" * 32, _env_file=None)

    assert settings.ai_provider is None
    assert settings.anthropic_api_key is None
    assert settings.gemini_api_key is None
    # 不猜模型名稱：猜錯的名字要到第一次真的呼叫才失敗，而且錯在更難查的地方。
    assert settings.ai_model is None
    assert settings.ai_daily_limit == 20


def test_empty_ai_settings_mean_unset(monkeypatch):
    """docker-compose 用 `${VAR:-}` 傳選配變數，沒設時容器收到的是空字串——
    四個 AI 變數都要把空字串（含空白）當成沒設。"""
    for value in ("", "   "):
        for name in _AI_ENV_VARS:
            monkeypatch.setenv(name, value)

        settings = Settings(jwt_secret="x" * 32, _env_file=None)

        assert settings.ai_provider is None
        assert settings.anthropic_api_key is None
        assert settings.gemini_api_key is None
        assert settings.ai_model is None


def test_real_ai_settings_survive_normalisation(monkeypatch):
    """跟上一條成對：一個永遠回 None 的 validator 也會讓上一條全綠。"""
    _clear_ai_env(monkeypatch)
    monkeypatch.setenv("AI_PROVIDER", "gemini")
    monkeypatch.setenv("GEMINI_API_KEY", "not-a-real-key")
    monkeypatch.setenv("AI_MODEL", "some-model")

    settings = Settings(jwt_secret="x" * 32, _env_file=None)

    assert settings.ai_provider == "gemini"
    assert settings.gemini_api_key == "not-a-real-key"
    assert settings.ai_model == "some-model"


@pytest.mark.parametrize("value", ["openai", "Gemini", "claude"])
def test_unknown_ai_provider_fails_at_startup(monkeypatch, value):
    """打錯字是設定錯誤，要在啟動時大聲說出來——不是安靜地關掉 AI。"""
    _clear_ai_env(monkeypatch)
    monkeypatch.setenv("AI_PROVIDER", value)

    with pytest.raises(ValidationError):
        Settings(jwt_secret="x" * 32, _env_file=None)
```

> 既有的 `test_empty_anthropic_key_is_treated_as_no_key`、`test_a_real_anthropic_key_survives_normalisation` 保留不動。

`tests/test_ai_provider.py`（新）：

```python
"""`build_estimator()`：依 `AI_PROVIDER` 建對應的實作，設定不完整就 503。

建實作不打網路（`AsyncAnthropic(...)`、`genai.Client(...)` 只是建 client），
所以這裡直接斷言型別，不需要假實作。
"""

import pytest

from app.ai.anthropic_estimator import AnthropicEstimator
from app.ai.gemini_estimator import GeminiEstimator
from app.api.deps import build_estimator
from app.config import settings
from app.errors import ServiceUnavailableError


def _configure(monkeypatch, *, provider, anthropic=None, gemini=None, model="some-model"):
    monkeypatch.setattr(settings, "ai_provider", provider)
    monkeypatch.setattr(settings, "anthropic_api_key", anthropic)
    monkeypatch.setattr(settings, "gemini_api_key", gemini)
    monkeypatch.setattr(settings, "ai_model", model)


def test_anthropic_provider_builds_the_anthropic_estimator(monkeypatch):
    _configure(monkeypatch, provider="anthropic", anthropic="sk-ant-not-real")

    estimator = build_estimator()

    assert isinstance(estimator, AnthropicEstimator)
    assert estimator.model == "some-model"


def test_gemini_provider_builds_the_gemini_estimator(monkeypatch):
    _configure(monkeypatch, provider="gemini", gemini="not-real")

    estimator = build_estimator()

    assert isinstance(estimator, GeminiEstimator)
    assert estimator.model == "some-model"


def test_no_provider_means_ai_is_off_even_with_keys(monkeypatch):
    """兩把金鑰都有、沒選供應商：仍然是關閉的——選一家是明確的設定。"""
    _configure(monkeypatch, provider=None, anthropic="a", gemini="b")

    with pytest.raises(ServiceUnavailableError) as excinfo:
        build_estimator()

    assert excinfo.value.code == "AI_NOT_CONFIGURED"


def test_the_other_providers_key_does_not_count(monkeypatch):
    """選了 Gemini、只有 Anthropic 的金鑰：503，訊息說缺的是 GEMINI_API_KEY。"""
    _configure(monkeypatch, provider="gemini", anthropic="sk-ant-not-real")

    with pytest.raises(ServiceUnavailableError) as excinfo:
        build_estimator()

    assert excinfo.value.code == "AI_NOT_CONFIGURED"
    assert "GEMINI_API_KEY" in excinfo.value.message


def test_missing_anthropic_key_is_named(monkeypatch):
    _configure(monkeypatch, provider="anthropic", gemini="not-real")

    with pytest.raises(ServiceUnavailableError) as excinfo:
        build_estimator()

    assert "ANTHROPIC_API_KEY" in excinfo.value.message


def test_missing_model_is_named(monkeypatch):
    _configure(monkeypatch, provider="gemini", gemini="not-real", model=None)

    with pytest.raises(ServiceUnavailableError) as excinfo:
        build_estimator()

    assert "AI_MODEL" in excinfo.value.message
```

`tests/test_ai_analyze.py`：

1. import 改成 `from app.api.deps import get_estimator_factory`（`get_estimator` 移除）。
2. `FakeEstimator` 類別加一個類別屬性（放在 docstring 之後）：

```python
    # NutritionEstimator 的一部分：ai_analyses.model 記的是實作自己的 model。
    model = "fake-model"
```

3. `_inject` 改成：

```python
def _inject(fake: NutritionEstimator) -> None:
    # 路由拿的是「建實作的函式」（先查食物庫，真的要呼叫 AI 才建）。
    app.dependency_overrides[get_estimator_factory] = lambda: lambda: fake
```

4. `_seed_analyses` 的 `model=settings.ai_model` 改成 `model="seed-model"`（`settings.ai_model` 現在預設是 None，而那一欄 NOT NULL）。
5. `test_analyze_without_api_key_returns_503`：`monkeypatch.setattr(settings, "anthropic_api_key", None)` 改成 `monkeypatch.setattr(settings, "ai_provider", None)`；docstring 的 `get_estimator()` 改成 `build_estimator()`、「`settings.anthropic_api_key is None`」改成「沒有選供應商」。
6. 檔尾加：

```python
async def test_analysis_records_the_estimators_model(client, db_session):
    """ai_analyses.model 記的是實際用的那個實作的 model——之後才查得出
    「哪個模型的估算常被改」。不是 settings 裡的值（它可以是 None）。"""
    user = await create_user(db_session)
    _inject(FakeEstimator())

    response = await client.post(
        "/api/ai/analyze",
        headers=auth(user),
        json={"kind": "text", "text": "食物庫裡找不到的一段描述"},
    )

    assert response.status_code == 200
    row = await db_session.scalar(select(AiAnalysis).where(AiAnalysis.user_id == user.id))
    assert row is not None
    assert row.model == "fake-model"
```

- [ ] **Step 2: 跑測試確認失敗**

```
./.venv/Scripts/python.exe -m pytest tests/test_config.py tests/test_ai_provider.py tests/test_ai_analyze.py -q
```

Expected：`test_ai_provider.py` 收集失敗（模組不存在）；`test_ai_analyze.py` 收集失敗（`get_estimator_factory` 不存在）；`test_config.py` 的新測試 FAIL（`ai_provider`、`gemini_api_key` 不存在；`ai_model` 不是 None）。

- [ ] **Step 3: 設定**

`app/config.py`：開頭的 import 加 `from typing import Literal`。把 `anthropic_api_key`、`ai_model` 兩行與其上方的大段註解換成：

```python
    # **AI 是選配功能，刻意跟 jwt_secret 相反：有預設值（＝關閉）。**
    #
    # jwt_secret 沒有預設是 fail closed —— 沒設等於任何人都能偽造 token。
    # AI 不一樣：沒有它只是少一個功能，讓整個 app 因此起不來是錯的取捨。
    # 但「關閉」必須是明講的 —— 端點回 503 AI_NOT_CONFIGURED（見
    # app/api/deps.py 的 build_estimator），不是一個看起來壞掉的樣子。
    #
    # **部署時選一家**（AI 估算前端規格 §3.1）：沒設 ai_provider＝關閉；
    # 設了一個不認得的值（打錯字）→ 這裡的 Literal 讓啟動直接失敗——打錯字
    # 是設定錯誤，要大聲說出來，不是安靜地關掉。
    ai_provider: Literal["anthropic", "gemini"] | None = None
    anthropic_api_key: str | None = None
    gemini_api_key: str | None = None
    # **不給預設值。** 猜一個看起來合理的模型名稱，猜錯時要到第一次真的呼叫
    # 才失敗，而且錯在更難查的地方（feat/p2-gemini 分支的教訓）。
    ai_model: str | None = None
    # 規格 §7：只算真的呼叫 LLM 的次數，失敗的也算（一樣花了錢）。
    ai_daily_limit: int = Field(20, gt=0)
```

把 `@field_validator("anthropic_api_key", mode="before")` 那個 validator 換成：

```python
    @field_validator(
        "ai_provider", "anthropic_api_key", "gemini_api_key", "ai_model", mode="before"
    )
    @classmethod
    def _empty_means_unset(cls, value: object) -> object:
        """空字串（含只有空白）等於沒設。

        `docker-compose` 用 `${VAR:-}` 傳這些選配變數（`:-` 而不是 `:?`），
        所以沒設值時容器裡收到的是**空字串**，不是「沒有這個變數」。

        少了這一步：金鑰是空字串時 `is None` 會是 False，程式會拿一把空字串
        金鑰去建 client——使用者看到的是供應商的認證錯誤，而不是「你沒設定
        AI」；`ai_provider` 是空字串時會撞上 Literal 而讓整個 app 起不來。
        **看起來是開著的比明確關閉更糟。**
        """
        if isinstance(value, str) and value.strip() == "":
            return None
        return value
```

- [ ] **Step 4: 共用部分與兩家實作**

`app/ai/estimator.py` 改成**只留共用的部分**：

1. 模組 docstring 的「## 這個模組不獨立測試 Anthropic 實作本身」段落改成：

```
## 兩家實作各一個檔案

`app/ai/anthropic_estimator.py` 與 `app/ai/gemini_estimator.py`，用哪一家由
`AI_PROVIDER` 決定（`app/api/deps.py` 的 `build_estimator`）。這個檔案只放兩家
共用的：Protocol、`RawEstimate`、提示詞、回覆的形狀與 `parse_raw_estimate()`。

兩家實作都不獨立測試——打真的網路：慢、花錢、不可重現（P2 規格 §8.1）。路由的
測試注入假實作，間接驗證整條路徑接得起來。
```

2. 刪掉 `import base64`、`from typing import Literal, Protocol, cast` 改成 `from typing import Protocol`、刪掉整段 `from anthropic import …` 與 `from anthropic.types import (…)`、刪掉 `UnprocessableEntityError` 的 import（只留 `BadGatewayError`）。
3. `NutritionEstimator` 改成：

```python
class NutritionEstimator(Protocol):
    # 實際用的模型名稱——ai_analyses.model 記的是它（AI 估算前端計畫 Task 1），
    # 之後才問得出「哪個模型的估算常被改」。
    model: str

    async def estimate_text(self, text: str) -> RawEstimate: ...
    async def estimate_image(self, image: bytes, media_type: str) -> RawEstimate: ...
```

4. 刪掉 `_ImageMediaType`。下面幾個名稱**改成公開的**（兩個實作檔案要 import）：`_ALLOWED_IMAGE_MEDIA_TYPES` → `ALLOWED_IMAGE_MEDIA_TYPES`、`_MAX_OUTPUT_TOKENS` → `MAX_OUTPUT_TOKENS`、`_SYSTEM_PROMPT` → `SYSTEM_PROMPT`、`_TEXT_ESTIMATE_INSTRUCTION` → `TEXT_ESTIMATE_INSTRUCTION`、`_IMAGE_ESTIMATE_INSTRUCTION` → `IMAGE_ESTIMATE_INSTRUCTION`、`_LLMEstimateSchema` → `LLMEstimateSchema`（`parse_raw_estimate` 裡的引用一起改）。`ALLOWED_IMAGE_MEDIA_TYPES` 上方的註解改成：「兩家實作打 API 之前的第二道關卡：路由已經用 Pillow 實際解碼判斷過格式（`app/api/routes/ai.py` 的 `_decode_photo`），這裡擋掉理論上不該出現、但也沒有理由假設不會出現的格式。」
5. 刪掉 `_RESPONSE_SCHEMA`、`_OUTPUT_CONFIG`（搬到 Anthropic 實作）、`_extract_text`、`class AnthropicEstimator`（搬走）。

`app/ai/anthropic_estimator.py`（新）：

```python
"""用 Anthropic Claude 估算「一份」的營養素（`AI_PROVIDER=anthropic`）。

不獨立測試——打真的 API 會花錢、不可重現（P2 規格 §8.1）。見
`app/ai/estimator.py` 的說明。
"""

import base64
from typing import Literal, cast

from anthropic import AsyncAnthropic, transform_schema
from anthropic.types import (
    Base64ImageSourceParam,
    ImageBlockParam,
    Message,
    MessageParam,
    OutputConfigParam,
    TextBlock,
    TextBlockParam,
)

from app.ai.estimator import (
    ALLOWED_IMAGE_MEDIA_TYPES,
    IMAGE_ESTIMATE_INSTRUCTION,
    MAX_OUTPUT_TOKENS,
    SYSTEM_PROMPT,
    TEXT_ESTIMATE_INSTRUCTION,
    LLMEstimateSchema,
    RawEstimate,
    parse_raw_estimate,
)
from app.errors import BadGatewayError, UnprocessableEntityError

# Anthropic 的 Base64ImageSourceParam.media_type 是一個 Literal，只接受這四種；
# ALLOWED_IMAGE_MEDIA_TYPES 驗證過之後縮成 Literal 給 mypy。
_ImageMediaType = Literal["image/jpeg", "image/png", "image/gif", "image/webp"]

# 用 anthropic 官方提供的 transform_schema() 從 pydantic model 產生 structured
# output 要的 JSON schema。**這不是唯一的防線**——就算 API 忽略這個提示，
# parse_raw_estimate() 的 pydantic 驗證仍然會擋下任何不合規的回應。
_RESPONSE_SCHEMA: dict[str, object] = transform_schema(LLMEstimateSchema)
_OUTPUT_CONFIG: OutputConfigParam = {
    "format": {"type": "json_schema", "schema": _RESPONSE_SCHEMA}
}


def _extract_text(message: Message) -> str:
    """從回應裡取出第一個文字內容區塊。找不到本身就是一種「垃圾回應」，
    跟 JSON 解析失敗走同一條錯誤路徑。"""
    for block in message.content:
        if isinstance(block, TextBlock):
            return block.text
    raise BadGatewayError("AI_BAD_RESPONSE", "AI 回應沒有文字內容")


class AnthropicEstimator:
    def __init__(self, *, api_key: str, model: str) -> None:
        self._client = AsyncAnthropic(api_key=api_key)
        self.model = model

    async def estimate_text(self, text: str) -> RawEstimate:
        message: MessageParam = {
            "role": "user",
            "content": TEXT_ESTIMATE_INSTRUCTION.format(text=text),
        }
        return await self._estimate(message)

    async def estimate_image(self, image: bytes, media_type: str) -> RawEstimate:
        if media_type not in ALLOWED_IMAGE_MEDIA_TYPES:
            raise UnprocessableEntityError("INVALID_PHOTO", "無法識別的圖片格式")

        source: Base64ImageSourceParam = {
            "type": "base64",
            "media_type": cast(_ImageMediaType, media_type),
            "data": base64.standard_b64encode(image).decode("ascii"),
        }
        image_block: ImageBlockParam = {"type": "image", "source": source}
        text_block: TextBlockParam = {"type": "text", "text": IMAGE_ESTIMATE_INSTRUCTION}
        message: MessageParam = {"role": "user", "content": [image_block, text_block]}
        return await self._estimate(message)

    async def _estimate(self, message: MessageParam) -> RawEstimate:
        response = await self._client.messages.create(
            model=self.model,
            max_tokens=MAX_OUTPUT_TOKENS,
            system=SYSTEM_PROMPT,
            messages=[message],
            output_config=_OUTPUT_CONFIG,
        )
        return parse_raw_estimate(_extract_text(response))
```

`app/ai/gemini_estimator.py`（新）——**從 `git show feat/p2-gemini:app/ai/estimator.py` 搬 `GeminiEstimator`、`_RESPONSE_SCHEMA`（手刻的 Google Schema 字典，連同它上面那段「不能直接把 pydantic model 傳給 response_schema」的完整註解）、`_extract_text`**，改成 import 共用的部分：

```python
"""用 Google Gemini 估算「一份」的營養素（`AI_PROVIDER=gemini`）。

從 `feat/p2-gemini` 分支（P2 計畫一 b）搬來；那條分支把 Anthropic 整個換掉，
這裡改成並存。不獨立測試——見 `app/ai/estimator.py` 的說明。
"""

from google import genai
from google.genai import types

from app.ai.estimator import (
    ALLOWED_IMAGE_MEDIA_TYPES,
    IMAGE_ESTIMATE_INSTRUCTION,
    MAX_OUTPUT_TOKENS,
    SYSTEM_PROMPT,
    TEXT_ESTIMATE_INSTRUCTION,
    RawEstimate,
    parse_raw_estimate,
)
from app.errors import BadGatewayError, UnprocessableEntityError

# （這裡貼分支上 `_RESPONSE_SCHEMA` 上方的完整註解——說明 pydantic 的
#  exclusiveMinimum 不被 Google 的 types.Schema 接受，所以手刻；真正的範圍
#  驗證仍然只由 parse_raw_estimate() 做——一字不改地搬過來。）
_RESPONSE_SCHEMA: dict[str, object] = {
    "type": "OBJECT",
    "properties": {
        "name": {"type": "STRING"},
        "brand": {"type": "STRING", "nullable": True},
        "serving_grams": {"type": "NUMBER"},
        "serving_kcal": {"type": "NUMBER"},
        "serving_protein_g": {"type": "NUMBER"},
        "serving_fat_g": {"type": "NUMBER"},
        "serving_carb_g": {"type": "NUMBER"},
        "confidence": {"type": "NUMBER"},
    },
    "required": [
        "name",
        "brand",
        "serving_grams",
        "serving_kcal",
        "serving_protein_g",
        "serving_fat_g",
        "serving_carb_g",
        "confidence",
    ],
}


def _extract_text(response: types.GenerateContentResponse) -> str:
    """`GenerateContentResponse.text` 是 `str | None`——`None` 或空字串本身
    就是一種「垃圾回應」，跟 JSON 解析失敗走同一條錯誤路徑。"""
    text = response.text
    if not text:
        raise BadGatewayError("AI_BAD_RESPONSE", "AI 回應沒有文字內容")
    return text


class GeminiEstimator:
    def __init__(self, *, api_key: str, model: str) -> None:
        # 非同步走 `client.aio`——`genai.Client` 是同一個物件底下切出同步／
        # 非同步兩組介面，不需要另外 import 一個 Async 版本。
        self._client = genai.Client(api_key=api_key)
        self.model = model

    async def estimate_text(self, text: str) -> RawEstimate:
        return await self._estimate(TEXT_ESTIMATE_INSTRUCTION.format(text=text))

    async def estimate_image(self, image: bytes, media_type: str) -> RawEstimate:
        if media_type not in ALLOWED_IMAGE_MEDIA_TYPES:
            raise UnprocessableEntityError("INVALID_PHOTO", "無法識別的圖片格式")

        # `types.Part.from_bytes()` 直接吃原始 bytes，SDK 自己處理編碼。
        image_part = types.Part.from_bytes(data=image, mime_type=media_type)
        # 明確標註型別：不然 mypy 會把 [Part, str] 推成 list[object]，跟
        # generate_content() 期待的聯集型別對不上（list 是不變的）。
        contents: list[types.PartUnionDict] = [image_part, IMAGE_ESTIMATE_INSTRUCTION]
        return await self._estimate(contents)

    async def _estimate(self, contents: types.ContentListUnionDict) -> RawEstimate:
        config = types.GenerateContentConfig(
            system_instruction=SYSTEM_PROMPT,
            max_output_tokens=MAX_OUTPUT_TOKENS,
            response_mime_type="application/json",
            response_schema=_RESPONSE_SCHEMA,
        )
        response = await self._client.aio.models.generate_content(
            model=self.model,
            contents=contents,
            config=config,
        )
        return parse_raw_estimate(_extract_text(response))
```

> 上面 `_RESPONSE_SCHEMA` 的那段括號註解**是指示，不是要寫進檔案的文字**——把分支上那段完整註解貼過來取代它。分支上的程式碼若跟這裡不一樣（例如 SDK 的型別名稱），**以分支為準並回報**——分支是實際裝了 SDK、跑過 mypy 的版本。

- [ ] **Step 5: `build_estimator` 與依賴**

`app/api/deps.py`：import 改成

```python
from collections.abc import Callable

from app.ai.anthropic_estimator import AnthropicEstimator
from app.ai.estimator import NutritionEstimator
from app.ai.gemini_estimator import GeminiEstimator
```

（`from collections.abc import Callable` 放在 import 區塊最上面的標準函式庫那一段。）把 `get_estimator` 整個換成：

```python
def build_estimator() -> NutritionEstimator:
    """依 `AI_PROVIDER` 建對應的實作；設定不完整就 503——關閉必須是明講的，
    不是一個看起來壞掉的樣子（跟 `jwt_secret` 刻意相反：見 app/config.py）。

    **訊息說出缺的是哪一個**：部署的人看到「AI 分析未設定：缺 GEMINI_API_KEY」
    就知道要補什麼，不用去讀程式碼。

    每次呼叫都建一個新的實作（等同新的 client）——沒有需要跨請求共用的
    狀態，跟 `get_current_user` 每次重查一次使用者是同一種簡單優先的取捨。
    """
    provider = settings.ai_provider
    if provider is None:
        raise ServiceUnavailableError("AI_NOT_CONFIGURED", "AI 分析未設定")
    if settings.ai_model is None:
        raise ServiceUnavailableError("AI_NOT_CONFIGURED", "AI 分析未設定：缺 AI_MODEL")
    if provider == "anthropic":
        if settings.anthropic_api_key is None:
            raise ServiceUnavailableError(
                "AI_NOT_CONFIGURED", "AI 分析未設定：缺 ANTHROPIC_API_KEY"
            )
        return AnthropicEstimator(api_key=settings.anthropic_api_key, model=settings.ai_model)
    if settings.gemini_api_key is None:
        raise ServiceUnavailableError("AI_NOT_CONFIGURED", "AI 分析未設定：缺 GEMINI_API_KEY")
    return GeminiEstimator(api_key=settings.gemini_api_key, model=settings.ai_model)


EstimatorFactory = Callable[[], NutritionEstimator]


async def get_estimator_factory() -> EstimatorFactory:
    """路由拿的是「建實作的函式」，不是實作本身。

    FastAPI 在進 handler 之前就解析依賴——如果依賴本身就是實作，AI 沒設定時
    連「食物庫命中、根本不用呼叫 AI」的請求也會 503。拿函式的話，路由可以
    決定什麼時候才真的需要它（AI 估算前端規格 §3.3）。

    測試用 `app.dependency_overrides[get_estimator_factory]` 換成回傳假實作的函式。
    """
    return build_estimator
```

- [ ] **Step 6: 路由用新的依賴（行為不變）**

`app/api/routes/ai.py`：

1. `from app.api.deps import get_current_user, get_estimator` 改成 `from app.api.deps import EstimatorFactory, get_current_user, get_estimator_factory`；`from app.ai.estimator import NutritionEstimator, RawEstimate` 改成 `from app.ai.estimator import RawEstimate`（如果 `NutritionEstimator` 不再用到）。
2. `_call_estimator_or_record_failure` 多一個關鍵字參數 `model: str`，失敗那一列的 `model=settings.ai_model` 改成 `model=model`。
3. `analyze` 的參數 `estimator: NutritionEstimator = Depends(get_estimator)` 改成 `make_estimator: EstimatorFactory = Depends(get_estimator_factory)`，函式本體**第一行**加 `estimator = make_estimator()`（Task 2 會把它往下移）。兩處 `_call_estimator_or_record_failure(...)` 呼叫都加 `model=estimator.model,`；成功那一列的 `model=settings.ai_model` 改成 `model=estimator.model`。

- [ ] **Step 7: 相依套件與部署設定**

`pyproject.toml` 的 dependencies 在 `"anthropic>=0.40",` 下面加一行 `"google-genai>=2.25",`。

鎖定檔：

```
./.venv/Scripts/python.exe -m pip install -e ".[dev]"
./.venv/Scripts/python.exe -m pip freeze --exclude-editable > requirements-lock.txt
git diff requirements-lock.txt
./.venv/Scripts/python.exe -m pip install --dry-run -c requirements-lock.txt -e ".[dev]"
```

Expected：`git diff` **只多出** `google-genai` 與它的相依（對照 `git diff master...feat/p2-gemini -- requirements-lock.txt` 的「+」行：`charset-normalizer`、`cryptography`、`distro`、`google-auth`、`google-genai`、`pyasn1`、`pyasn1_modules`、`requests`、`tenacity`、`urllib3`，`websockets` 的版本可能變），**`anthropic` 與它的相依（`docstring_parser`、`jiter`、`httpx2` 等）都還在**。出現其他差異（例如 `.venv` 裡多裝了跟專案無關的東西）→ **回報，不要 commit 那些行**。`--dry-run` 要能解析成功。確認鎖定檔是 LF。

`docker-compose.yml`：把 `ANTHROPIC_API_KEY: "${ANTHROPIC_API_KEY:-}"` 那一行換成

```yaml
      AI_PROVIDER: "${AI_PROVIDER:-}"
      AI_MODEL: "${AI_MODEL:-}"
      ANTHROPIC_API_KEY: "${ANTHROPIC_API_KEY:-}"
      GEMINI_API_KEY: "${GEMINI_API_KEY:-}"
```

上方註解裡的「來自 Anthropic 的認證錯誤」改成「來自供應商的認證錯誤」，並加一句「四個都是選配，空字串由 `app/config.py` 的 `_empty_means_unset` 正規化成沒設」。

`.env.production.example`：把 `ANTHROPIC_API_KEY=` 那一段（含上方兩行註解）換成：

```
# 選配：AI 估算。AI_PROVIDER 不填＝AI 功能整個關閉（端點回 503
# AI_NOT_CONFIGURED），其他功能不受影響。
#
# AI_PROVIDER 只接受 anthropic 或 gemini（小寫）；填了別的值，api 容器會
# 啟動失敗——打錯字要大聲說出來。選了哪一家，就要填那一家的金鑰。
#
# AI_MODEL 沒有預設值：從供應商的文件確認目前可用的模型名稱後再填
# （Anthropic：https://docs.anthropic.com/en/docs/about-claude/models、
# Gemini：https://ai.google.dev/gemini-api/docs/models）。
AI_PROVIDER=
AI_MODEL=
ANTHROPIC_API_KEY=
GEMINI_API_KEY=
```

- [ ] **Step 8: 跑測試確認通過**

```
./.venv/Scripts/python.exe -m pytest tests/test_config.py tests/test_ai_provider.py tests/test_ai_analyze.py tests/test_ai_estimator.py -q
```

- [ ] **Step 9: 突變測試**（每個都手動改回並重跑）

1. `_empty_means_unset` 的欄位清單拿掉 `"gemini_api_key"` → Expected：`test_empty_ai_settings_mean_unset` FAIL。
2. `build_estimator` 的 Gemini 分支改成檢查 `settings.anthropic_api_key` → Expected：`test_the_other_providers_key_does_not_count` FAIL。
3. 成功那一列的 `model=estimator.model` 改回 `model=settings.ai_model` → Expected：`test_analysis_records_the_estimators_model` FAIL（或 NOT NULL 的錯誤——照實回報是哪一種）。

- [ ] **Step 10: 全部後端測試、ruff、mypy**

```
./.venv/Scripts/python.exe -m pytest -q
./.venv/Scripts/python.exe -m ruff check app tests
./.venv/Scripts/python.exe -m mypy app
```

Expected：全部綠；pytest 數量 = 636 − 1（刪掉的 config 測試）+ 新增的條數（config 4＋參數化展開、provider 6、analyze 1）。照實回報數字。

- [ ] **Step 11: Commit**

```
feat(ai): Anthropic 與 Gemini 並存，用 AI_PROVIDER 選一家

兩家實作各一個檔案，共用提示詞與回覆解析；build_estimator() 依設定建實作，
缺金鑰或缺 AI_MODEL 時 503 並說出缺哪一個；AI_PROVIDER 打錯字啟動失敗。
路由改拿「建實作的函式」（get_estimator_factory），下一步才能先查食物庫。
ai_analyses.model 記實作自己的 model。Gemini 實作從 feat/p2-gemini 搬來。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

```bash
git add app/config.py app/ai/estimator.py app/ai/anthropic_estimator.py app/ai/gemini_estimator.py app/api/deps.py app/api/routes/ai.py pyproject.toml requirements-lock.txt docker-compose.yml .env.production.example tests/test_config.py tests/test_ai_provider.py tests/test_ai_analyze.py
```

---

## Task 2：後端——先查食物庫、`food_id`、`remaining_today`、撞名附 `food_id`

**Files:**
- Modify: `app/api/routes/ai.py`、`app/schemas/ai.py`、`app/api/routes/foods.py`
- Test: `tests/test_ai_analyze.py`、`tests/test_foods_create.py`
- Regenerate: `frontend/src/api/schema.d.ts`

- [ ] **Step 1: 寫失敗的測試**

`tests/test_ai_analyze.py` 的 imports 補上 `func`（`from sqlalchemy import func, select`）。檔尾加：

```python
async def test_library_hit_reports_the_food_id(client, db_session):
    """命中食物庫時回那個食物的 id——前端直接選它，不再建一個同名的
    （然後被 409 FOOD_EXISTS 擋下）。"""
    user = await create_user(db_session)
    food = await create_food(db_session, created_by=user, owner=user, name="牛肉麵")
    _inject(FakeEstimator())

    response = await client.post(
        "/api/ai/analyze", headers=auth(user), json={"kind": "text", "text": "牛肉麵"}
    )

    assert response.json()["food_id"] == food.id


async def test_an_ai_estimate_has_no_food_id(client, db_session):
    user = await create_user(db_session)
    _inject(FakeEstimator())

    response = await client.post(
        "/api/ai/analyze",
        headers=auth(user),
        json={"kind": "text", "text": "食物庫裡找不到的一段描述"},
    )

    assert response.json()["food_id"] is None


async def test_library_hit_works_without_ai_configured(client, db_session, monkeypatch):
    """AI 沒設定時，文字命中食物庫照樣能用（AI 估算前端規格 §3.3）。

    刻意不 override——用真正的 build_estimator()，它在沒選供應商時拋 503。"""
    monkeypatch.setattr(settings, "ai_provider", None)
    user = await create_user(db_session)
    await create_food(db_session, created_by=user, owner=user, name="牛肉麵")

    response = await client.post(
        "/api/ai/analyze", headers=auth(user), json={"kind": "text", "text": "牛肉麵"}
    )

    assert response.status_code == 200
    assert response.json()["name"] == "牛肉麵"


async def test_library_hit_does_not_even_build_an_estimator(client, db_session):
    """比「結果對」更強的斷言（P2 規格 §8.3 同一個道理）：命中食物庫時
    連建實作的函式都沒被呼叫。"""
    user = await create_user(db_session)
    await create_food(db_session, created_by=user, owner=user, name="牛肉麵")
    built = {"n": 0}

    def factory():
        built["n"] += 1
        return FakeEstimator()

    app.dependency_overrides[get_estimator_factory] = lambda: factory

    await client.post(
        "/api/ai/analyze", headers=auth(user), json={"kind": "text", "text": "牛肉麵"}
    )

    assert built["n"] == 0


async def test_not_configured_wins_over_quota(client, db_session, monkeypatch):
    """AI 沒設定、額度又剛好用完：要說「未設定」，不是「今天用完了」——
    後者會讓人以為明天就好了。"""
    monkeypatch.setattr(settings, "ai_provider", None)
    user = await create_user(db_session)
    await _seed_analyses(db_session, user, settings.ai_daily_limit)

    response = await client.post(
        "/api/ai/analyze",
        headers=auth(user),
        json={"kind": "text", "text": "食物庫裡找不到的一段描述"},
    )

    assert response.status_code == 503
    assert response.json()["error"]["code"] == "AI_NOT_CONFIGURED"


async def test_remaining_today_counts_this_call(client, db_session):
    user = await create_user(db_session)
    await _seed_analyses(db_session, user, 3)
    _inject(FakeEstimator())

    response = await client.post(
        "/api/ai/analyze",
        headers=auth(user),
        json={"kind": "text", "text": "食物庫裡找不到的一段描述"},
    )

    assert response.json()["remaining_today"] == settings.ai_daily_limit - 4


async def test_the_last_allowed_call_reports_zero_remaining(client, db_session):
    user = await create_user(db_session)
    await _seed_analyses(db_session, user, settings.ai_daily_limit - 1)
    _inject(FakeEstimator())

    response = await client.post(
        "/api/ai/analyze",
        headers=auth(user),
        json={"kind": "text", "text": "食物庫裡找不到的一段描述"},
    )

    assert response.status_code == 200
    assert response.json()["remaining_today"] == 0


async def test_a_failed_call_also_uses_up_the_quota(client, db_session):
    """失敗的呼叫也花了錢（規格 §7），所以下一次的 remaining 也少算它。"""
    user = await create_user(db_session)
    _inject(FakeEstimator(error=BadGatewayError("AI_BAD_RESPONSE", "垃圾")))
    failed = await client.post(
        "/api/ai/analyze",
        headers=auth(user),
        json={"kind": "text", "text": "食物庫裡找不到的一段描述"},
    )
    assert failed.status_code == 502

    _inject(FakeEstimator())
    response = await client.post(
        "/api/ai/analyze",
        headers=auth(user),
        json={"kind": "text", "text": "食物庫裡找不到的另一段描述"},
    )

    assert response.json()["remaining_today"] == settings.ai_daily_limit - 2


async def test_library_hit_does_not_use_up_the_quota(client, db_session):
    user = await create_user(db_session)
    await _seed_analyses(db_session, user, 5)
    await create_food(db_session, created_by=user, owner=user, name="牛肉麵")
    _inject(FakeEstimator())

    response = await client.post(
        "/api/ai/analyze", headers=auth(user), json={"kind": "text", "text": "牛肉麵"}
    )

    assert response.json()["remaining_today"] == settings.ai_daily_limit - 5
    rows = await db_session.scalar(
        select(func.count()).select_from(AiAnalysis).where(AiAnalysis.user_id == user.id)
    )
    assert rows == 5
```

`tests/test_foods_create.py`：

1. 「同一個人建同名食物 → 409」那條（第 120 行附近，`create_food(..., name="滷肉飯")` 那條）：把 `await create_food(...)` 的回傳值存成 `existing = await create_food(...)`，在 `assert response.json()["error"]["code"] == "FOOD_EXISTS"` 之後加：

```python
    # 附上撞到的那一筆，前端才能提供「用現有的」（AI 估算前端規格 §3.4）。
    assert response.json()["error"]["details"]["food_id"] == existing.id
```

2. `test_a_concurrent_duplicate_name_returns_409_not_500`：同樣把 `create_food(...)` 存成 `existing`，在 `FOOD_EXISTS` 那行斷言之後加：

```python
    # 併發那條路（IntegrityError）也要附上——rollback 之後重查一次那一筆。
    assert response.json()["error"]["details"]["food_id"] == existing.id
```

- [ ] **Step 2: 跑測試確認失敗**

```
./.venv/Scripts/python.exe -m pytest tests/test_ai_analyze.py tests/test_foods_create.py -q
```

Expected FAIL：`…reports_the_food_id`、`…has_no_food_id`（KeyError）、`…works_without_ai_configured`（503）、`…does_not_even_build_an_estimator`（1）、`…counts_this_call`、`…zero_remaining`、`…uses_up_the_quota`、`…does_not_use_up_the_quota`（KeyError）、兩條 `FOOD_EXISTS` 的 `details`（KeyError）。`test_not_configured_wins_over_quota` **現在會 PASS**（建實作在最前面）——它守的是 Step 3 的順序。照實回報。

- [ ] **Step 3: 實作**

`app/schemas/ai.py` 的 `AnalyzeResponse`，`analysis_id` 之後加：

```python
    # 命中食物庫時是那個食物的 id——前端直接選它，不再建一個同名的（然後被
    # 409 FOOD_EXISTS 擋下）。真的呼叫了 AI 時是 None（AI 估算前端規格 §3.2）。
    food_id: int | None
```

`consistency` 之後加：

```python
    # 今天還能呼叫幾次（AI_DAILY_LIMIT − 今天 ai_analyses 的列數，最小 0）。
    # 命中食物庫不扣次數。
    remaining_today: int
```

`app/api/routes/ai.py`：

1. 把 `_assert_quota_available` 拆成兩個函式：

```python
async def _count_used_today(db: AsyncSession, user: User) -> int:
    """今天呼叫了幾次 AI——直接數 `ai_analyses`（規格 §7.2），不另設計數器。

    「今天」用 `day_bounds(today_in_timezone(user.timezone), user.timezone)`
    ——跟 `stats/daily`、`meals`、`supplements/today` 同一個「今天」。
    """
    start, end = day_bounds(today_in_timezone(user.timezone), user.timezone)
    return (
        await db.scalar(
            select(func.count())
            .select_from(AiAnalysis)
            .where(
                AiAnalysis.user_id == user.id,
                AiAnalysis.created_at >= start,
                AiAnalysis.created_at < end,
            )
        )
        or 0
    )


def _remaining(used_today: int) -> int:
    return max(0, settings.ai_daily_limit - used_today)


async def _assert_quota_available(db: AsyncSession, user: User) -> int:
    """額度用完就 429；沒用完回傳今天已經用了幾次。

    **比較必須是 `>=`，不是 `>`。** 上限 20 代表最多存在 20 列，第 21 次
    呼叫發生時 `used_today` 已經是 20，`20 >= 20` 才會擋下來（計畫 Task 5
    突變驗證（三））。
    """
    used_today = await _count_used_today(db, user)
    if used_today >= settings.ai_daily_limit:
        _, end = day_bounds(today_in_timezone(user.timezone), user.timezone)
        retry_after_seconds = max(1.0, (end - datetime.now(UTC)).total_seconds())
        raise TooManyRequestsError(
            "AI_DAILY_LIMIT",
            f"今天用了 {used_today}/{settings.ai_daily_limit} 次，請明天再試",
            retry_after_seconds,
        )
    return used_today
```

2. `_library_hit_response(food, revision)` 多一個參數 `remaining_today: int`，回應裡加 `food_id=food.id,`、`remaining_today=remaining_today,`。
3. `analyze` 的本體改成這個順序（只列出改動的部分）：

```python
    if isinstance(payload, AnalyzeTextRequest):
        hit = await _find_in_food_library(db, user, payload.text)
        if hit is not None:
            food, revision = hit
            used_today = await _count_used_today(db, user)
            return _library_hit_response(
                food, revision, remaining_today=_remaining(used_today)
            )

    # 到這裡才真的需要 AI：沒設定就 503（AI 估算前端規格 §3.3）。**要在檢查
    # 額度之前**——沒設定又剛好額度用完時，該說的是「未設定」，不是「今天
    # 用完了」（後者會讓人以為明天就好了）。
    estimator = make_estimator()
    used_today = await _assert_quota_available(db, user)
```

（刪掉 Task 1 放在函式第一行的 `estimator = make_estimator()`，以及原本的 `await _assert_quota_available(db, user)`。）回傳 `AnalyzeResponse(...)` 時加 `food_id=None,`、`remaining_today=_remaining(used_today + 1),`（這一次已經寫進 `ai_analyses`）。模組 docstring 的流程說明 ② 前面加一行「（命中食物庫之後才建 AI 實作——AI 沒設定時，命中食物庫照樣能用）」。

`app/api/routes/foods.py`：

1. 在 `create_food` 之前加：

```python
async def _find_same_named_food(
    db: AsyncSession, *, owner_id: int | None, name: str, brand: str | None
) -> Food | None:
    """撞名檢查的範圍：同一個擁有者、同名、同品牌（`uq_foods_owner_id_name_brand`）。
    所以找到的一定是**你自己的**食物（或建全域食物時撞到的全域食物）——
    把它的 id 附在 409 裡不會洩漏別人的私人食物。"""
    return await db.scalar(
        select(Food).where(
            Food.owner_id.is_not_distinct_from(owner_id),
            Food.name == name,
            Food.brand.is_not_distinct_from(brand),
        )
    )


def _food_exists(existing: Food | None) -> ConflictError:
    """409 FOOD_EXISTS，附上撞到的那一筆的 id（AI 估算前端規格 §3.4）——
    前端才能提供「用現有的」。找不到（理論上不會）就不附。"""
    details = {"food_id": existing.id} if existing is not None else None
    return ConflictError("FOOD_EXISTS", "你已經建過同名的食物了", details)
```

2. 前置查詢改成 `existing = await _find_same_named_food(db, owner_id=owner_id, name=payload.name, brand=payload.brand)`，`raise ConflictError("FOOD_EXISTS", …)` 改成 `raise _food_exists(existing)`。
3. `flush` 與 `commit` 兩處 `except IntegrityError` 裡，`await db.rollback()` 之後改成：

```python
        # 併發下另一個請求剛建好那一筆：rollback 之後重查一次，附上它的 id。
        existing = await _find_same_named_food(
            db, owner_id=owner_id, name=payload.name, brand=payload.brand
        )
        raise _food_exists(existing) from exc
```

（`existing` 這個名字在函式前面已經用過；變數重用沒問題，或改名 `raced`——擇一，保持 mypy 綠。）

- [ ] **Step 4: 跑測試確認通過**

```
./.venv/Scripts/python.exe -m pytest tests/test_ai_analyze.py tests/test_foods_create.py -q
```

- [ ] **Step 5: 突變測試**（每個都手動改回並重跑）

1. 把 `estimator = make_estimator()` 移回 `analyze` 的第一行 → Expected：`…works_without_ai_configured`、`…does_not_even_build_an_estimator` FAIL。
2. 把 `estimator = make_estimator()` 移到 `_assert_quota_available` **之後** → Expected：`test_not_configured_wins_over_quota` FAIL（429）。
3. `_remaining(used_today + 1)` 改成 `_remaining(used_today)` → Expected：`…counts_this_call`、`…zero_remaining` FAIL。
4. `flush` 那個 `except` 裡的 `_food_exists(existing)` 改成 `_food_exists(None)` → Expected：`test_a_concurrent_duplicate_name_returns_409_not_500` FAIL。

- [ ] **Step 6: 全部後端測試、ruff、mypy**

- [ ] **Step 7: 重新產生 `schema.d.ts`**（指令見「執行環境」），然後在 `frontend/`：

```
npm run -s typecheck
npm run -s test
```

Expected：`schema.d.ts` 的 `AnalyzeResponse` 多了 `food_id: number | null`、`remaining_today: number`；前端全綠（還沒有程式碼用 `AnalyzeResponse`）。

- [ ] **Step 8: Commit**

```
feat(ai): 先查食物庫再建實作；回應帶 food_id 與 remaining_today；撞名附 food_id

AI 沒設定時，文字命中食物庫照樣能用；沒設定又剛好額度用完時說「未設定」。
命中食物庫回那個食物的 id，前端不會再建一個同名的；remaining_today 是今天
還能呼叫幾次（命中食物庫不扣）。POST /api/foods 撞名時，三條路都附上撞到的
那一筆的 id。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

```bash
git add app/api/routes/ai.py app/schemas/ai.py app/api/routes/foods.py tests/test_ai_analyze.py tests/test_foods_create.py frontend/src/api/schema.d.ts
```

---

## Task 3：前端——估算的 API、組 body 的純函式、`describeFieldErrors` 搬家

**Files:**
- Create: `frontend/src/api/ai.ts`、`frontend/src/lib/ai-food.ts`、`frontend/tests/ai-food.test.ts`、`frontend/tests/ai-api.test.ts`
- Modify: `frontend/src/api/queries.ts`、`frontend/src/api/errors.ts`、`frontend/src/screens/NewFood.tsx`、`frontend/src/screens/FoodDetail.tsx`、`frontend/src/components/AddPortionForm.tsx`、`frontend/src/screens/Supplements.tsx`
- Test: `frontend/tests/queries.test.tsx`（加）

> **`describeFieldErrors` 搬到 `api/errors.ts`**：面板（`components/`）要用它，而 `NewFood` 會 import 面板——留在 `NewFood.tsx` 會變成循環 import。

- [ ] **Step 1: 寫失敗的測試**

`frontend/tests/queries.test.tsx` 檔尾加：

```tsx
describe("食物搜尋的 query key", () => {
	it("foodSearchAll 是每一組搜尋結果的前綴——存了新食物要一次失效全部", () => {
		const prefix = queryKeys.foodSearchAll;
		expect(queryKeys.foodSearch("牛肉麵", "all").slice(0, prefix.length)).toEqual([
			...prefix,
		]);
	});
});
```

`frontend/tests/ai-food.test.ts`（新）：

```ts
import { describe, expect, it } from "vitest";
import type { AnalyzeResponse } from "../src/api/ai";
import {
	confirmedFoodRequest,
	draftFromEstimate,
	editedFoodRequest,
} from "../src/lib/ai-food";

const ESTIMATE: AnalyzeResponse = {
	analysis_id: 12,
	food_id: null,
	name: "牛肉麵",
	brand: null,
	nutrition: {
		base_unit: "g",
		serving_grams: "550.00",
		kcal: "112.73",
		protein_g: "5.82",
		fat_g: "3.27",
		carb_g: "14.55",
		serving_kcal: "620.00",
		serving_protein_g: "32.00",
		serving_fat_g: "18.00",
		serving_carb_g: "80.00",
	},
	confidence: "0.37",
	consistency: { atwater_kcal: "610.00", deviation: "10.00", flagged: false },
	remaining_today: 19,
};

describe("confirmedFoodRequest：直接確認", () => {
	it("用後端算好的每 100 值、建「一份」預設份量、標記成 AI", () => {
		expect(confirmedFoodRequest(ESTIMATE)).toEqual({
			name: "牛肉麵",
			brand: null,
			nutrition: {
				base_unit: "g",
				kcal: "112.73",
				protein_g: "5.82",
				fat_g: "3.27",
				carb_g: "14.55",
			},
			default_portion: { label: "一份", grams: "550.00" },
			source: "ai",
			ai_confidence: "0.37",
			ai_raw_response: ESTIMATE,
		});
	});
});

describe("draftFromEstimate：修改表單的初始值", () => {
	it("一份的值，去掉多餘的零", () => {
		expect(draftFromEstimate(ESTIMATE)).toEqual({
			name: "牛肉麵",
			servingGrams: "550",
			kcal: "620",
			protein_g: "32",
			fat_g: "18",
			carb_g: "80",
		});
	});
});

describe("editedFoodRequest：改過才確認", () => {
	it("每份換算成每 100、份量用改過的重量、標記成使用者，AI 原本的仍然附上", () => {
		const result = editedFoodRequest(ESTIMATE, {
			...draftFromEstimate(ESTIMATE),
			kcal: "550",
		});

		expect(result).toEqual({
			ok: true,
			body: {
				name: "牛肉麵",
				brand: null,
				nutrition: {
					base_unit: "g",
					kcal: "100.00",
					protein_g: "5.82",
					fat_g: "3.27",
					carb_g: "14.55",
				},
				default_portion: { label: "一份", grams: "550" },
				source: "user",
				ai_confidence: "0.37",
				ai_raw_response: ESTIMATE,
			},
		});
	});

	it("名稱空白：擋下", () => {
		expect(
			editedFoodRequest(ESTIMATE, { ...draftFromEstimate(ESTIMATE), name: "  " }),
		).toEqual({ ok: false, error: "請輸入名稱" });
	});

	it("一份重量不是正數：擋下", () => {
		expect(
			editedFoodRequest(ESTIMATE, {
				...draftFromEstimate(ESTIMATE),
				servingGrams: "0",
			}),
		).toEqual({ ok: false, error: "一份的重量要大於 0" });
	});

	it("一份重量超過 10000：擋下", () => {
		expect(
			editedFoodRequest(ESTIMATE, {
				...draftFromEstimate(ESTIMATE),
				servingGrams: "10001",
			}),
		).toEqual({ ok: false, error: "一份的重量不能超過 10000" });
	});

	it("營養素空白：說是哪一個", () => {
		expect(
			editedFoodRequest(ESTIMATE, { ...draftFromEstimate(ESTIMATE), fat_g: "" }),
		).toEqual({ ok: false, error: "請輸入一份的脂肪" });
	});

	it("營養素不是數字：說是哪一個", () => {
		expect(
			editedFoodRequest(ESTIMATE, {
				...draftFromEstimate(ESTIMATE),
				protein_g: "abc",
			}),
		).toEqual({ ok: false, error: "一份的蛋白質必須是 0 以上的數字" });
	});

	it("換算後超過上限：提示重量可能少打一位數", () => {
		// 一份 5 g、熱量 600 → 每 100 是 12000，超過 10000。
		expect(
			editedFoodRequest(ESTIMATE, {
				...draftFromEstimate(ESTIMATE),
				servingGrams: "5",
				kcal: "600",
			}),
		).toEqual({ ok: false, error: "換算後超過上限，請確認一份的重量" });
	});
});
```

`frontend/tests/ai-api.test.ts`（新）：

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { analyzeImage, analyzeText } from "../src/api/ai";
import { MAX_PHOTO_BYTES, PhotoTooLargeError } from "../src/api/photos";
import { resetRefreshStateForTests } from "../src/auth/refresh";
import { clearTokens, setTokens } from "../src/auth/store";
import { json, mockApi } from "./helpers/mock-api";

// 照片會先經過 shrinkToLongestEdge（canvas，jsdom 沒有）——原樣回傳。
vi.mock("../src/lib/resize-image", () => ({
	shrinkToLongestEdge: vi.fn((file: File) => Promise.resolve(file)),
}));

beforeEach(() => {
	localStorage.clear();
	clearTokens();
	resetRefreshStateForTests();
	vi.restoreAllMocks();
	setTokens({ access_token: "a", refresh_token: "r" });
});

function sentBody(fetchMock: ReturnType<typeof mockApi>): unknown {
	const call = fetchMock.mock.calls[0];
	return JSON.parse(String(call?.[1]?.body));
}

describe("AI 估算的 API", () => {
	it("文字：送 kind=text", async () => {
		const fetchMock = mockApi([
			{ method: "POST", path: "/api/ai/analyze", handler: () => json({ name: "x" }) },
		]);

		await analyzeText("一碗牛肉麵");

		expect(sentBody(fetchMock)).toEqual({ kind: "text", text: "一碗牛肉麵" });
	});

	it("照片：送 kind=image 與 base64（不含 data: 前綴）", async () => {
		const fetchMock = mockApi([
			{ method: "POST", path: "/api/ai/analyze", handler: () => json({ name: "x" }) },
		]);
		const file = new File(["fake-jpeg"], "lunch.jpg", { type: "image/jpeg" });

		await analyzeImage(file);

		expect(sentBody(fetchMock)).toEqual({
			kind: "image",
			image_base64: btoa("fake-jpeg"),
		});
	});

	it("照片太大：送出前就擋，不打網路", async () => {
		const fetchMock = mockApi([]);
		const file = new File(["x"], "big.jpg", { type: "image/jpeg" });
		Object.defineProperty(file, "size", { value: MAX_PHOTO_BYTES + 1 });

		await expect(analyzeImage(file)).rejects.toBeInstanceOf(PhotoTooLargeError);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
```

- [ ] **Step 2: 跑測試確認失敗**

```
cd frontend
npx vitest run tests/queries.test.tsx tests/ai-food.test.ts tests/ai-api.test.ts
```

Expected：`queries.test.tsx` 新的一條 FAIL（`foodSearchAll` 不存在）；另外兩個檔案整個 FAIL（模組不存在）。

- [ ] **Step 3: 實作**

`frontend/src/api/queries.ts`，`foodSearch` 之後加：

```ts
	/** 「所有搜尋結果」這個前綴，給 `invalidateQueries` 用。存了新食物
	 *  （AI 估算確認、新增食物）之後，任何一組已經快取的搜尋結果都可能該
	 *  多一筆——一次失效全部，不是猜哪幾組。 */
	foodSearchAll: ["food-search"] as const,
```

`frontend/src/api/errors.ts`：把 `describeFieldErrors`（連同它的註解）從 `NewFood.tsx` **搬**到檔尾，註解裡「匯出給 `FoodDetail.tsx`（Task 5）重用」改成「`NewFood`、`FoodDetail`、`AddPortionForm`、`Supplements`、`AiEstimatePanel` 共用」。`NewFood.tsx` 刪掉原本的定義、改成 `import { ApiError, describeFieldErrors } from "../api/errors";`；`FoodDetail.tsx`、`AddPortionForm.tsx`、`Supplements.tsx` 的 import 改成從 `../api/errors`（`FoodDetail` 的 `NUMERIC_FIELDS`、`NumericField` 等其他名稱仍然從 `./NewFood` import）。

`frontend/src/api/ai.ts`（新）：

```ts
import { shrinkToLongestEdge } from "../lib/resize-image";
import { apiFetch } from "./client";
import { MAX_PHOTO_BYTES, PhotoTooLargeError } from "./photos";
import type { components } from "./schema";

export type AnalyzeResponse = components["schemas"]["AnalyzeResponse"];

async function analyze(body: unknown): Promise<AnalyzeResponse> {
	const result = await apiFetch<AnalyzeResponse>("/api/ai/analyze", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	if (result === null) {
		// 後端成功時一律回 200 + AnalyzeResponse；null 代表 apiFetch 的假設被破壞。
		throw new Error("AI 估算沒有回傳結果");
	}
	return result;
}

/** 文字估算。後端會先查食物庫（精確比對名稱），命中就不呼叫 AI、不扣次數。 */
export function analyzeText(text: string): Promise<AnalyzeResponse> {
	return analyze({ kind: "text", text });
}

/** 照片估算。**前處理跟上傳餐點照片同一套**（`uploadMealPhoto`）：先擋大小
 *  （原始檔案的位元組數，不必為註定被拒的檔案花 CPU 縮圖），再把長邊縮到
 *  1280，最後轉 base64。照片只拿來估算，後端不存（P2 規格 §6）。 */
export async function analyzeImage(file: File): Promise<AnalyzeResponse> {
	if (file.size > MAX_PHOTO_BYTES) {
		throw new PhotoTooLargeError();
	}
	const resized = await shrinkToLongestEdge(file, 1280);
	return analyze({ kind: "image", image_base64: await fileToBase64(resized) });
}

/** `readAsDataURL` 給的是 `data:image/jpeg;base64,....`——後端只要逗號後面那段。 */
export function fileToBase64(file: Blob): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => {
			const dataUrl = String(reader.result);
			resolve(dataUrl.slice(dataUrl.indexOf(",") + 1));
		};
		reader.onerror = () => reject(reader.error ?? new Error("讀取照片失敗"));
		reader.readAsDataURL(file);
	});
}
```

`frontend/src/lib/ai-food.ts`（新）：

```ts
import type { AnalyzeResponse } from "../api/ai";
import type { components } from "../api/schema";
import { formatMacro, isPlainPositiveDecimal, perServingToPer100 } from "./decimal";

type FoodCreateRequest = components["schemas"]["FoodCreateRequest"];

/** AI 估出來的食物會帶一個預設份量，就叫「一份」——記一餐選上它時，
 *  份量自動是「一份 × 1」。 */
export const AI_PORTION_LABEL = "一份";

/** 一份重量的後端上限（`DefaultPortionInput.grams` 的 `le=10000`）。 */
const MAX_SERVING_GRAMS = 10000;

/** 修改表單的四個營養素。上限是**換算成每 100 之後**的上限——跟
 *  `NewFood` 的 `NUMERIC_FIELDS` 同一組（後端 `NutritionInput`）。 */
const NUTRIENTS = [
	{ field: "kcal", label: "一份的熱量", max: 10000 },
	{ field: "protein_g", label: "一份的蛋白質", max: 1000 },
	{ field: "fat_g", label: "一份的脂肪", max: 1000 },
	{ field: "carb_g", label: "一份的碳水化合物", max: 1000 },
] as const;

type Nutrient = (typeof NUTRIENTS)[number]["field"];

/** 修改表單的值：都是「一份」的，不是每 100（使用者看到的卡片就是一份）。 */
export type EstimateDraft = {
	name: string;
	servingGrams: string;
} & Record<Nutrient, string>;

/** 修改表單的初始值：卡片上那組一份的數字（`formatMacro` 去掉多餘的零）。 */
export function draftFromEstimate(estimate: AnalyzeResponse): EstimateDraft {
	const n = estimate.nutrition;
	return {
		name: estimate.name,
		servingGrams: formatMacro(n.serving_grams),
		kcal: formatMacro(n.serving_kcal),
		protein_g: formatMacro(n.serving_protein_g),
		fat_g: formatMacro(n.serving_fat_g),
		carb_g: formatMacro(n.serving_carb_g),
	};
}

/** 「確認」：直接用後端算好的每 100 值（P2 規格 §4.1：換算在後端做一次，
 *  前端不重算）。`ai_raw_response` 存整個估算回應——P2 規格 §5：之後才
 *  問得出「AI 常常錯很多嗎」。 */
export function confirmedFoodRequest(estimate: AnalyzeResponse): FoodCreateRequest {
	const n = estimate.nutrition;
	return {
		name: estimate.name,
		brand: estimate.brand,
		nutrition: {
			base_unit: n.base_unit,
			kcal: n.kcal,
			protein_g: n.protein_g,
			fat_g: n.fat_g,
			carb_g: n.carb_g,
		},
		default_portion: { label: AI_PORTION_LABEL, grams: n.serving_grams },
		source: "ai",
		ai_confidence: estimate.confidence,
		ai_raw_response: estimate,
	};
}

export type EditedResult =
	| { ok: true; body: FoodCreateRequest }
	| { ok: false; error: string };

/** 「需要修改」之後存：使用者改的是一份的值，換算成每 100 用
 *  `perServingToPer100`（新增食物「每一份」模式同一個函式）。
 *
 *  **`source: "user"`，但 `ai_confidence` 與 `ai_raw_response` 照樣送 AI 原本的**
 *  （P2 規格 §5）——改過之後仍然留著 AI 說了什麼。 */
export function editedFoodRequest(
	estimate: AnalyzeResponse,
	draft: EstimateDraft,
): EditedResult {
	const name = draft.name.trim();
	if (name === "") return { ok: false, error: "請輸入名稱" };

	const grams = draft.servingGrams.trim();
	if (!isPlainPositiveDecimal(grams)) {
		return { ok: false, error: "一份的重量要大於 0" };
	}
	if (Number(grams) > MAX_SERVING_GRAMS) {
		return { ok: false, error: `一份的重量不能超過 ${MAX_SERVING_GRAMS}` };
	}

	const per100: Partial<Record<Nutrient, string>> = {};
	for (const { field, label, max } of NUTRIENTS) {
		const raw = draft[field].trim();
		if (raw === "") return { ok: false, error: `請輸入${label}` };
		const converted = perServingToPer100(raw, grams);
		if (converted === null) {
			return { ok: false, error: `${label}必須是 0 以上的數字` };
		}
		// 換算後超過上限，通常代表一份的重量少打一位數。
		if (Number(converted) > max) {
			return { ok: false, error: "換算後超過上限，請確認一份的重量" };
		}
		per100[field] = converted;
	}

	return {
		ok: true,
		body: {
			name,
			brand: estimate.brand,
			nutrition: {
				base_unit: estimate.nutrition.base_unit,
				kcal: per100.kcal as string,
				protein_g: per100.protein_g as string,
				fat_g: per100.fat_g as string,
				carb_g: per100.carb_g as string,
			},
			default_portion: { label: AI_PORTION_LABEL, grams },
			source: "user",
			ai_confidence: estimate.confidence,
			ai_raw_response: estimate,
		},
	};
}
```

> `per100.kcal as string`：迴圈走完四個欄位一定都有值；如果 Biome／TypeScript 有更乾淨的寫法（例如先組好一個完整的物件），可以換，但不要改變行為。`ai_raw_response: estimate` 的型別若跟 `FoodCreateRequest["ai_raw_response"]`（`{ [key: string]: unknown } | null`）對不上，用 `estimate as unknown as Record<string, unknown>` 並加一行註解說明——回報你怎麼處理的。

- [ ] **Step 4: 跑測試確認通過**

```
npx vitest run tests/queries.test.tsx tests/ai-food.test.ts tests/ai-api.test.ts tests/new-food.test.tsx tests/food-detail.test.tsx tests/supplements.test.tsx
```

- [ ] **Step 5: 突變測試**

`editedFoodRequest` 的 `source: "user"` 改成 `"ai"` → Expected：「每份換算成每 100…」FAIL。改回。

- [ ] **Step 6: 全部前端檢查**（typecheck、lint、test）

- [ ] **Step 7: Commit**

```
feat(ai): 前端的估算 API 與「存成食物」的 body

analyzeText／analyzeImage（照片先擋大小、縮到 1280、轉 base64）；確認與
改過才確認兩種 body——前者用後端算好的每 100，後者把一份換算成每 100，
兩者都附上 AI 原本的估算。describeFieldErrors 搬到 api/errors.ts。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

```bash
git add frontend/src/api/ai.ts frontend/src/lib/ai-food.ts frontend/src/api/queries.ts frontend/src/api/errors.ts frontend/src/screens/NewFood.tsx frontend/src/screens/FoodDetail.tsx frontend/src/components/AddPortionForm.tsx frontend/src/screens/Supplements.tsx frontend/tests/ai-food.test.ts frontend/tests/ai-api.test.ts frontend/tests/queries.test.tsx
```

---

## Task 4：前端——`AiEstimatePanel`

**Files:**
- Create: `frontend/src/components/AiEstimatePanel.tsx`、`AiEstimatePanel.module.css`、`frontend/tests/ai-estimate-panel.test.tsx`

- [ ] **Step 1: 寫失敗的測試**

`frontend/tests/ai-estimate-panel.test.tsx`（新）：

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AnalyzeResponse } from "../src/api/ai";
import { MAX_PHOTO_BYTES } from "../src/api/photos";
import { queryKeys } from "../src/api/queries";
import { resetRefreshStateForTests } from "../src/auth/refresh";
import { clearTokens, setTokens } from "../src/auth/store";
import { AiEstimatePanel } from "../src/components/AiEstimatePanel";
import { json, type Route, mockApi } from "./helpers/mock-api";

vi.mock("../src/lib/resize-image", () => ({
	shrinkToLongestEdge: vi.fn((file: File) => Promise.resolve(file)),
}));

const ESTIMATE: AnalyzeResponse = {
	analysis_id: 12,
	food_id: null,
	name: "牛肉麵",
	brand: null,
	nutrition: {
		base_unit: "g",
		serving_grams: "550.00",
		kcal: "112.73",
		protein_g: "5.82",
		fat_g: "3.27",
		carb_g: "14.55",
		serving_kcal: "620.00",
		serving_protein_g: "32.00",
		serving_fat_g: "18.00",
		serving_carb_g: "80.00",
	},
	// 一個不會跟畫面上其他數字撞的值——用來證明它沒有被顯示。
	confidence: "0.37",
	consistency: { atwater_kcal: "610.00", deviation: "10.00", flagged: false },
	remaining_today: 19,
};

const CREATED = {
	id: 30,
	name: "牛肉麵",
	brand: null,
	is_global: false,
	nutrition: {
		base_unit: "g",
		kcal: "112.73",
		protein_g: "5.82",
		fat_g: "3.27",
		carb_g: "14.55",
	},
};

const EXISTING = { ...CREATED, id: 7, name: "滷肉飯" };

function apiError(status: number, code: string, message: string, details = {}) {
	return () => json({ error: { code, message, details } }, status);
}

/** `extra` 排在前面：mockApi 依序用 url.includes 比對。 */
function routes(
	analyzeResult: () => Response = () => json(ESTIMATE),
	extra: Route[] = [],
): Route[] {
	return [
		...extra,
		{ method: "POST", path: "/api/ai/analyze", handler: analyzeResult },
		{ method: "GET", path: "/api/foods/7", handler: () => json(EXISTING) },
		{ method: "POST", path: "/api/foods", handler: () => json(CREATED, 201) },
	];
}

function renderPanel(text = "一碗牛肉麵") {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const onFoodReady = vi.fn();
	render(
		<QueryClientProvider client={client}>
			<AiEstimatePanel text={text} onFoodReady={onFoodReady} />
		</QueryClientProvider>,
	);
	return { client, onFoodReady };
}

function bodyOf(
	fetchMock: ReturnType<typeof mockApi>,
	method: string,
	path: string,
): unknown {
	const call = fetchMock.mock.calls.find(
		([input, init]) =>
			(init?.method ?? "GET").toUpperCase() === method &&
			String(input).includes(path),
	);
	return call === undefined ? undefined : JSON.parse(String(call[1]?.body));
}

function posted(fetchMock: ReturnType<typeof mockApi>, path: string): number {
	return fetchMock.mock.calls.filter(
		([input, init]) =>
			(init?.method ?? "GET").toUpperCase() === "POST" &&
			String(input).endsWith(path),
	).length;
}

async function estimateByText() {
	await userEvent.click(
		screen.getByRole("button", { name: "用 AI 估算「一碗牛肉麵」" }),
	);
	return screen.findByRole("region", { name: "AI 估算結果" });
}

beforeEach(() => {
	localStorage.clear();
	clearTokens();
	resetRefreshStateForTests();
	vi.restoreAllMocks();
	setTokens({ access_token: "a", refresh_token: "r" });
});

describe("AI 估算面板：估算", () => {
	it("文字估算：顯示一份的數字、一致性、今天還能用幾次", async () => {
		const fetchMock = mockApi(routes());
		renderPanel();

		const card = await estimateByText();

		expect(bodyOf(fetchMock, "POST", "/api/ai/analyze")).toEqual({
			kind: "text",
			text: "一碗牛肉麵",
		});
		expect(within(card).getByRole("heading", { name: "牛肉麵" })).toBeInTheDocument();
		expect(within(card).getByText("一份 550 g · 620 kcal")).toBeInTheDocument();
		expect(within(card).getByText("蛋白質 32 g　脂肪 18 g　碳水 80 g")).toBeInTheDocument();
		expect(within(card).getByText("✓ 熱量與三大營養素對得起來")).toBeInTheDocument();
		expect(within(card).getByText("今天還能用 19 次")).toBeInTheDocument();
	});

	it("不顯示 AI 自己報的信心值（P2 規格 §4.1）", async () => {
		mockApi(routes());
		renderPanel();

		const card = await estimateByText();

		expect(card).not.toHaveTextContent("0.37");
		expect(card).not.toHaveTextContent("37%");
		expect(card).not.toHaveTextContent("信心");
	});

	it("一致性對不起來：提醒看一眼", async () => {
		mockApi(
			routes(() =>
				json({
					...ESTIMATE,
					consistency: { atwater_kcal: "300.00", deviation: "320.00", flagged: true },
				}),
			),
		);
		renderPanel();

		const card = await estimateByText();

		expect(
			within(card).getByText("⚠ 熱量跟三大營養素對不太起來，建議看一眼"),
		).toBeInTheDocument();
	});

	it("沒有文字時只有拍照估算", () => {
		mockApi(routes());
		renderPanel("   ");

		expect(screen.queryByRole("button", { name: /用 AI 估算/ })).not.toBeInTheDocument();
		expect(screen.getByLabelText("拍照估算")).toBeInTheDocument();
	});

	it("照片估算：送 kind=image；確認後交回的是那張照片", async () => {
		const fetchMock = mockApi(routes());
		const { onFoodReady } = renderPanel();
		const photo = new File(["fake-jpeg"], "noodle.jpg", { type: "image/jpeg" });

		await userEvent.upload(screen.getByLabelText("拍照估算"), photo);
		const card = await screen.findByRole("region", { name: "AI 估算結果" });

		expect(bodyOf(fetchMock, "POST", "/api/ai/analyze")).toEqual({
			kind: "image",
			image_base64: btoa("fake-jpeg"),
		});
		await userEvent.click(within(card).getByRole("button", { name: "確認" }));
		await waitFor(() =>
			expect(onFoodReady).toHaveBeenCalledWith(CREATED, { image: photo }),
		);
	});

	it("照片太大：選的當下就擋，不打網路", async () => {
		const fetchMock = mockApi(routes());
		renderPanel();
		const photo = new File(["x"], "big.jpg", { type: "image/jpeg" });
		Object.defineProperty(photo, "size", { value: MAX_PHOTO_BYTES + 1 });

		await userEvent.upload(screen.getByLabelText("拍照估算"), photo);

		expect(await screen.findByRole("alert")).toHaveTextContent("照片超過");
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe("AI 估算面板：確認與修改", () => {
	it("確認：存成食物（AI 標記、一份預設份量），交回那個食物，失效搜尋", async () => {
		const fetchMock = mockApi(routes());
		const { client, onFoodReady } = renderPanel();
		const invalidate = vi.spyOn(client, "invalidateQueries");

		const card = await estimateByText();
		await userEvent.click(within(card).getByRole("button", { name: "確認" }));

		await waitFor(() =>
			expect(onFoodReady).toHaveBeenCalledWith(CREATED, { image: null }),
		);
		expect(bodyOf(fetchMock, "POST", "/api/foods")).toMatchObject({
			source: "ai",
			default_portion: { label: "一份", grams: "550.00" },
			nutrition: { kcal: "112.73" },
		});
		expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.foodSearchAll });
		// 交回之後面板回到起點，不會一直掛著上一次的結果。
		expect(screen.queryByRole("region", { name: "AI 估算結果" })).not.toBeInTheDocument();
	});

	it("需要修改：改過再存，標記成使用者、換算成每 100", async () => {
		const fetchMock = mockApi(routes());
		const { onFoodReady } = renderPanel();

		const card = await estimateByText();
		await userEvent.click(within(card).getByRole("button", { name: "需要修改" }));
		const form = screen.getByRole("form", { name: "修改 AI 估算" });
		const kcal = within(form).getByLabelText("一份的熱量（kcal）");
		expect(kcal).toHaveValue("620");
		await userEvent.clear(kcal);
		await userEvent.type(kcal, "550");
		await userEvent.click(within(form).getByRole("button", { name: "存成食物" }));

		await waitFor(() => expect(onFoodReady).toHaveBeenCalled());
		expect(bodyOf(fetchMock, "POST", "/api/foods")).toMatchObject({
			source: "user",
			ai_confidence: "0.37",
			nutrition: { kcal: "100.00" },
		});
	});

	it("修改的內容不合法：擋下，不送", async () => {
		const fetchMock = mockApi(routes());
		renderPanel();

		const card = await estimateByText();
		await userEvent.click(within(card).getByRole("button", { name: "需要修改" }));
		const form = screen.getByRole("form", { name: "修改 AI 估算" });
		await userEvent.clear(within(form).getByLabelText("食物名稱"));
		await userEvent.click(within(form).getByRole("button", { name: "存成食物" }));

		expect(within(form).getByRole("alert")).toHaveTextContent("請輸入名稱");
		expect(posted(fetchMock, "/api/foods")).toBe(0);
	});

	it("放棄修改：回到結果卡片", async () => {
		mockApi(routes());
		renderPanel();

		const card = await estimateByText();
		await userEvent.click(within(card).getByRole("button", { name: "需要修改" }));
		await userEvent.click(screen.getByRole("button", { name: "放棄修改" }));

		expect(screen.getByRole("region", { name: "AI 估算結果" })).toBeInTheDocument();
		expect(screen.queryByRole("form", { name: "修改 AI 估算" })).not.toBeInTheDocument();
	});
});

describe("AI 估算面板：食物庫已經有", () => {
	it("命中食物庫：「用這個」交回那一筆，不建新食物", async () => {
		const fetchMock = mockApi(
			routes(() => json({ ...ESTIMATE, food_id: 7, name: "滷肉飯", analysis_id: null })),
		);
		const { onFoodReady } = renderPanel();

		await userEvent.click(
			screen.getByRole("button", { name: "用 AI 估算「一碗牛肉麵」" }),
		);
		const hit = await screen.findByRole("region", { name: "食物庫裡的食物" });
		expect(hit).toHaveTextContent("食物庫裡已經有「滷肉飯」");
		await userEvent.click(within(hit).getByRole("button", { name: "用這個" }));

		await waitFor(() =>
			expect(onFoodReady).toHaveBeenCalledWith(EXISTING, { image: null }),
		);
		expect(posted(fetchMock, "/api/foods")).toBe(0);
	});

	it("存的時候撞名：「用現有的」交回撞到的那一筆", async () => {
		mockApi(
			routes(undefined, [
				{
					method: "POST",
					path: "/api/foods",
					handler: apiError(409, "FOOD_EXISTS", "你已經建過同名的食物了", {
						food_id: 7,
					}),
				},
			]),
		);
		const { onFoodReady } = renderPanel();

		const card = await estimateByText();
		await userEvent.click(within(card).getByRole("button", { name: "確認" }));
		expect(await within(card).findByText("你已經有「牛肉麵」了")).toBeInTheDocument();
		await userEvent.click(within(card).getByRole("button", { name: "用現有的" }));

		await waitFor(() =>
			expect(onFoodReady).toHaveBeenCalledWith(EXISTING, { image: null }),
		);
	});

	it("撞名時「改名」打開修改模式", async () => {
		mockApi(
			routes(undefined, [
				{
					method: "POST",
					path: "/api/foods",
					handler: apiError(409, "FOOD_EXISTS", "你已經建過同名的食物了", {
						food_id: 7,
					}),
				},
			]),
		);
		renderPanel();

		const card = await estimateByText();
		await userEvent.click(within(card).getByRole("button", { name: "確認" }));
		await userEvent.click(await within(card).findByRole("button", { name: "改名" }));

		expect(screen.getByRole("form", { name: "修改 AI 估算" })).toBeInTheDocument();
	});
});

describe("AI 估算面板：錯誤", () => {
	it("今天的次數用完：顯示後端的訊息", async () => {
		mockApi(routes(apiError(429, "AI_DAILY_LIMIT", "今天用了 20/20 次，請明天再試")));
		renderPanel();

		await userEvent.click(
			screen.getByRole("button", { name: "用 AI 估算「一碗牛肉麵」" }),
		);

		expect(await screen.findByRole("alert")).toHaveTextContent(
			"今天用了 20/20 次，請明天再試",
		);
	});

	it("AI 沒設定：說未設定，估算按鈕停用", async () => {
		mockApi(routes(apiError(503, "AI_NOT_CONFIGURED", "AI 分析未設定")));
		renderPanel();

		const button = screen.getByRole("button", { name: "用 AI 估算「一碗牛肉麵」" });
		await userEvent.click(button);

		expect(await screen.findByRole("alert")).toHaveTextContent("AI 分析未設定");
		expect(button).toBeDisabled();
		expect(screen.getByLabelText("拍照估算")).toBeDisabled();
	});

	it("AI 回了看不懂的東西：可以再試一次", async () => {
		mockApi(routes(apiError(502, "AI_BAD_RESPONSE", "AI 回傳的內容不是有效的 JSON")));
		renderPanel();

		await userEvent.click(
			screen.getByRole("button", { name: "用 AI 估算「一碗牛肉麵」" }),
		);

		expect(await screen.findByRole("alert")).toHaveTextContent(
			"AI 這次的回答看不懂，可以再試一次",
		);
		expect(
			screen.getByRole("button", { name: "用 AI 估算「一碗牛肉麵」" }),
		).toBeEnabled();
	});
});
```

> 「沒有文字時只有拍照估算」用 `"   "`：面板自己 trim。`getByRole("region", { name })` 需要 `<section aria-label>`——section 有名字才是 region。

- [ ] **Step 2: 跑測試確認失敗**

```
npx vitest run tests/ai-estimate-panel.test.tsx
```

Expected：整個檔案 FAIL（模組不存在）。

- [ ] **Step 3: 實作**

`frontend/src/components/AiEstimatePanel.module.css`（新）：

```css
.panel {
	display: flex;
	flex-direction: column;
	gap: var(--space-2);
}

.entry {
	display: flex;
	flex-wrap: wrap;
	gap: var(--space-2);
}

.aiButton,
.photoButton {
	display: inline-flex;
	align-items: center;
	gap: var(--space-2);
	min-height: 44px;
	padding: 0 var(--space-3);
	border: 1px dashed var(--color-accent);
	border-radius: var(--radius-button);
	background: var(--color-surface);
	color: var(--color-action);
	font-weight: 600;
}

.aiButton:disabled,
.photoButton:has(+ .fileInput:disabled) {
	opacity: 0.4;
}

/* 同 LogMeal：視覺上藏起來但仍可用鍵盤對焦，外框畫在前一個兄弟 label 上。 */
.fileInput {
	position: absolute;
	width: 1px;
	height: 1px;
	opacity: 0;
}

.photoButton:has(+ .fileInput:focus-visible) {
	outline: 2px solid var(--color-action);
	outline-offset: 2px;
}

.card {
	display: flex;
	flex-direction: column;
	gap: var(--space-1);
	padding: var(--space-3) var(--space-4);
	border: 2px solid var(--color-accent);
	border-radius: var(--radius-card);
	background: var(--color-surface);
}

.card h3 {
	margin: 0;
	font-size: 16px;
}

.card p {
	margin: 0;
}

.muted {
	font-size: 12px;
	color: var(--color-text-muted);
}

.warning {
	font-size: 12px;
	color: var(--color-danger);
}

.actions {
	display: flex;
	flex-wrap: wrap;
	gap: var(--space-2);
	margin-top: var(--space-2);
}

.actions button {
	flex: 1;
	min-height: 44px;
	border-radius: var(--radius-button);
	font-weight: 700;
}

.primary {
	border: none;
	background: var(--color-action);
	color: var(--color-on-action);
}

.secondary {
	border: 1px solid var(--color-action);
	background: transparent;
	color: var(--color-action);
}

.primary:disabled,
.secondary:disabled {
	opacity: 0.4;
}

.form {
	display: flex;
	flex-direction: column;
	gap: var(--space-2);
}

/* 字級不在這裡設——index.css 的全域規則保證 input ≥ 16px。 */
.form input {
	padding: var(--space-2) var(--space-3);
	border: 1px solid var(--color-border);
	border-radius: var(--radius-button);
	background: var(--color-bg);
	color: var(--color-text);
}
```

`frontend/src/components/AiEstimatePanel.tsx`（新）：

```tsx
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Camera } from "lucide-react";
import { type ChangeEvent, type FormEvent, useId, useState } from "react";
import { type AnalyzeResponse, analyzeImage, analyzeText } from "../api/ai";
import { apiFetch } from "../api/client";
import { ApiError, describeFieldErrors } from "../api/errors";
import type { Food } from "../api/foods";
import { describePhotoUploadError, PhotoTooLargeError } from "../api/photos";
import { queryKeys } from "../api/queries";
import type { components } from "../api/schema";
import { formatMacro } from "../lib/decimal";
import {
	confirmedFoodRequest,
	draftFromEstimate,
	type EstimateDraft,
	editedFoodRequest,
} from "../lib/ai-food";
import styles from "./AiEstimatePanel.module.css";

type FoodCreateRequest = components["schemas"]["FoodCreateRequest"];

type AnalyzeInput = { kind: "text"; text: string } | { kind: "image"; file: File };

type Props = {
	/** 文字估算要用的字（記一餐是搜尋框的字，新增食物是「描述這個食物」）。
	 *  trim 之後是空字串時只顯示拍照估算。 */
	text: string;
	/** 交回一個可以用的食物。`image` 是估算用的照片（文字估算是 null）——
	 *  記一餐用它當這一餐的照片（AI 估算前端規格 §5.1）。 */
	onFoodReady: (food: Food, source: { image: File | null }) => void;
	/** 文字估算按鈕的字。 */
	textButtonLabel?: (text: string) => string;
};

function defaultTextButtonLabel(text: string): string {
	return `用 AI 估算「${text}」`;
}

function describeAnalyzeError(error: unknown): string {
	if (error instanceof PhotoTooLargeError) return error.message;
	if (error instanceof ApiError) {
		switch (error.code) {
			case "AI_DAILY_LIMIT":
				// 後端的訊息含「今天用了 N/20」。
				return error.message;
			case "AI_NOT_CONFIGURED":
				return "AI 分析未設定";
			case "AI_BAD_RESPONSE":
				return "AI 這次的回答看不懂，可以再試一次";
			case "PHOTO_TOO_LARGE":
			case "INVALID_PHOTO":
				return describePhotoUploadError(error);
		}
	}
	return "AI 估算失敗，請再試一次";
}

function describeSaveError(error: unknown): string {
	if (error instanceof ApiError && error.code === "VALIDATION_ERROR") {
		return describeFieldErrors(error).join("；");
	}
	return "存成食物失敗，請再試一次";
}

/** 從文字或照片估算一份的營養素，確認或修改後存成自己的食物，交回給所在
 *  的畫面（AI 估算前端規格 §4）。記一餐與新增食物共用。
 *
 *  **不顯示 `confidence`**：那是模型自己說的，不是量出來的（P2 規格 §4.1）。
 *  畫面上的可靠度訊號是 `consistency`——算得出來的那個。 */
export function AiEstimatePanel({
	text,
	onFoodReady,
	textButtonLabel = defaultTextButtonLabel,
}: Props) {
	const queryClient = useQueryClient();
	const photoInputId = useId();
	const trimmed = text.trim();

	const [estimate, setEstimate] = useState<AnalyzeResponse | null>(null);
	// 估算用的照片——確認之後跟食物一起交回。
	const [image, setImage] = useState<File | null>(null);
	// null＝看結果卡片；有值＝修改模式。
	const [draft, setDraft] = useState<EstimateDraft | null>(null);
	const [formError, setFormError] = useState<string | null>(null);
	// 存的時候撞名（409 FOOD_EXISTS 附的 food_id）。
	const [existingFoodId, setExistingFoodId] = useState<number | null>(null);
	// 這一次畫面上已經知道 AI 沒設定：估算按鈕停用，不讓人一直按。
	const [aiUnavailable, setAiUnavailable] = useState(false);

	function clearResult() {
		setEstimate(null);
		setImage(null);
		setDraft(null);
		setFormError(null);
		setExistingFoodId(null);
	}

	const analyze = useMutation({
		mutationFn: (input: AnalyzeInput) =>
			input.kind === "text" ? analyzeText(input.text) : analyzeImage(input.file),
		onMutate: () => clearResult(),
		onSuccess: (result, input) => {
			setEstimate(result);
			setImage(input.kind === "image" ? input.file : null);
		},
		onError: (error) => {
			if (error instanceof ApiError && error.code === "AI_NOT_CONFIGURED") {
				setAiUnavailable(true);
			}
		},
	});

	function finish(food: Food) {
		const used = image;
		clearResult();
		analyze.reset();
		onFoodReady(food, { image: used });
	}

	const save = useMutation({
		mutationFn: (body: FoodCreateRequest) =>
			apiFetch<Food>("/api/foods", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			}),
		onSuccess: (food) => {
			// 新食物要出現在食物庫與之後的搜尋裡。
			queryClient.invalidateQueries({ queryKey: queryKeys.foodSearchAll });
			if (food) finish(food);
		},
		onError: (error) => {
			if (error instanceof ApiError && error.code === "FOOD_EXISTS") {
				const id = error.details.food_id;
				if (typeof id === "number") setExistingFoodId(id);
			}
		},
	});

	const pickExisting = useMutation({
		mutationFn: (foodId: number) => apiFetch<Food>(`/api/foods/${foodId}`),
		onSuccess: (food) => {
			if (food) finish(food);
		},
	});

	const busy = analyze.isPending || save.isPending || pickExisting.isPending;

	function handlePhoto(event: ChangeEvent<HTMLInputElement>) {
		const file = event.target.files?.[0];
		// 清掉 input 的值：同一張再選一次，change 才會再觸發。
		event.target.value = "";
		if (file === undefined) return;
		analyze.mutate({ kind: "image", file });
	}

	function startEditing(current: AnalyzeResponse) {
		setDraft(draftFromEstimate(current));
		setFormError(null);
		setExistingFoodId(null);
		save.reset();
	}

	function submitDraft(event: FormEvent, current: AnalyzeResponse) {
		event.preventDefault();
		if (draft === null) return;
		const result = editedFoodRequest(current, draft);
		if (!result.ok) {
			setFormError(result.error);
			return;
		}
		setFormError(null);
		save.mutate(result.body);
	}

	const unit = estimate?.nutrition.base_unit ?? "g";
	const saveFailed =
		save.isError && !(save.error instanceof ApiError && save.error.code === "FOOD_EXISTS");

	return (
		<div className={styles.panel}>
			<div className={styles.entry}>
				{trimmed !== "" && (
					<button
						type="button"
						className={styles.aiButton}
						disabled={busy || aiUnavailable}
						onClick={() => analyze.mutate({ kind: "text", text: trimmed })}
					>
						{textButtonLabel(trimmed)}
					</button>
				)}
				<label htmlFor={photoInputId} className={styles.photoButton}>
					<Camera aria-hidden="true" size={18} />
					拍照估算
				</label>
				<input
					id={photoInputId}
					type="file"
					accept="image/*"
					className={styles.fileInput}
					disabled={busy || aiUnavailable}
					onChange={handlePhoto}
				/>
			</div>

			{analyze.isPending && <p role="status">AI 估算中…</p>}
			{analyze.isError && <p role="alert">{describeAnalyzeError(analyze.error)}</p>}

			{estimate !== null && estimate.food_id !== null && (
				<section aria-label="食物庫裡的食物" className={styles.card}>
					<p>食物庫裡已經有「{estimate.name}」</p>
					<p className={styles.muted}>
						{`每 100 ${unit}：${formatMacro(estimate.nutrition.kcal)} kcal`}
					</p>
					<div className={styles.actions}>
						<button
							type="button"
							className={styles.primary}
							disabled={busy}
							onClick={() => {
								if (estimate.food_id !== null) pickExisting.mutate(estimate.food_id);
							}}
						>
							用這個
						</button>
					</div>
					{pickExisting.isError && <p role="alert">讀取食物失敗，請再試一次</p>}
				</section>
			)}

			{estimate !== null && estimate.food_id === null && draft === null && (
				<section aria-label="AI 估算結果" className={styles.card}>
					<h3>{estimate.name}</h3>
					{estimate.brand !== null && <p className={styles.muted}>{estimate.brand}</p>}
					<p>
						{`一份 ${formatMacro(estimate.nutrition.serving_grams)} ${unit} · ${formatMacro(estimate.nutrition.serving_kcal)} kcal`}
					</p>
					<p className={styles.muted}>
						{`蛋白質 ${formatMacro(estimate.nutrition.serving_protein_g)} g　脂肪 ${formatMacro(estimate.nutrition.serving_fat_g)} g　碳水 ${formatMacro(estimate.nutrition.serving_carb_g)} g`}
					</p>
					{estimate.consistency.flagged ? (
						<p className={styles.warning}>⚠ 熱量跟三大營養素對不太起來，建議看一眼</p>
					) : (
						<p className={styles.muted}>✓ 熱量與三大營養素對得起來</p>
					)}
					<p className={styles.muted}>{`今天還能用 ${estimate.remaining_today} 次`}</p>

					{existingFoodId !== null ? (
						<>
							<p role="alert">你已經有「{estimate.name}」了</p>
							<div className={styles.actions}>
								<button
									type="button"
									className={styles.primary}
									disabled={busy}
									onClick={() => pickExisting.mutate(existingFoodId)}
								>
									用現有的
								</button>
								<button
									type="button"
									className={styles.secondary}
									disabled={busy}
									onClick={() => startEditing(estimate)}
								>
									改名
								</button>
							</div>
						</>
					) : (
						<div className={styles.actions}>
							<button
								type="button"
								className={styles.primary}
								disabled={busy}
								onClick={() => save.mutate(confirmedFoodRequest(estimate))}
							>
								{save.isPending ? "存成食物中…" : "確認"}
							</button>
							<button
								type="button"
								className={styles.secondary}
								disabled={busy}
								onClick={() => startEditing(estimate)}
							>
								需要修改
							</button>
						</div>
					)}
					{saveFailed && <p role="alert">{describeSaveError(save.error)}</p>}
					{pickExisting.isError && <p role="alert">讀取食物失敗，請再試一次</p>}
				</section>
			)}

			{estimate !== null && estimate.food_id === null && draft !== null && (
				<form
					aria-label="修改 AI 估算"
					className={`${styles.card} ${styles.form}`}
					onSubmit={(event) => submitDraft(event, estimate)}
				>
					<label htmlFor="ai-name">食物名稱</label>
					<input
						id="ai-name"
						type="text"
						maxLength={100}
						value={draft.name}
						onChange={(event) => setDraft({ ...draft, name: event.target.value })}
					/>
					<label htmlFor="ai-serving-grams">{`一份的重量（${unit}）`}</label>
					<input
						id="ai-serving-grams"
						type="text"
						inputMode="decimal"
						value={draft.servingGrams}
						onChange={(event) =>
							setDraft({ ...draft, servingGrams: event.target.value })
						}
					/>
					<label htmlFor="ai-kcal">一份的熱量（kcal）</label>
					<input
						id="ai-kcal"
						type="text"
						inputMode="decimal"
						value={draft.kcal}
						onChange={(event) => setDraft({ ...draft, kcal: event.target.value })}
					/>
					<label htmlFor="ai-protein">一份的蛋白質（g）</label>
					<input
						id="ai-protein"
						type="text"
						inputMode="decimal"
						value={draft.protein_g}
						onChange={(event) =>
							setDraft({ ...draft, protein_g: event.target.value })
						}
					/>
					<label htmlFor="ai-fat">一份的脂肪（g）</label>
					<input
						id="ai-fat"
						type="text"
						inputMode="decimal"
						value={draft.fat_g}
						onChange={(event) => setDraft({ ...draft, fat_g: event.target.value })}
					/>
					<label htmlFor="ai-carb">一份的碳水化合物（g）</label>
					<input
						id="ai-carb"
						type="text"
						inputMode="decimal"
						value={draft.carb_g}
						onChange={(event) => setDraft({ ...draft, carb_g: event.target.value })}
					/>
					{formError !== null && <p role="alert">{formError}</p>}
					{existingFoodId !== null && <p role="alert">你已經有同名的食物了，換個名稱</p>}
					{saveFailed && <p role="alert">{describeSaveError(save.error)}</p>}
					<div className={styles.actions}>
						<button type="submit" className={styles.primary} disabled={busy}>
							{save.isPending ? "存成食物中…" : "存成食物"}
						</button>
						<button
							type="button"
							className={styles.secondary}
							disabled={busy}
							onClick={() => {
								setDraft(null);
								setFormError(null);
								save.reset();
							}}
						>
							放棄修改
						</button>
					</div>
				</form>
			)}
		</div>
	);
}
```

> 修改模式下撞名時，`save.onError` 會把 `existingFoodId` 設起來——修改表單只說「換個名稱」，不提供「用現有的」（使用者已經在改了）。
>
> 欄位標籤刻意都帶「一份的」或「食物名稱」：新增食物畫面上同時有 `NewFood` 自己的「名稱」「熱量（每份 kcal）」——testing-library 是完整比對、不會撞，但 Playwright 是子字串比對（handover §6 第 48 種）。

- [ ] **Step 4: 跑測試確認通過**

```
npx vitest run tests/ai-estimate-panel.test.tsx tests/css-tokens.test.ts
```

- [ ] **Step 5: 突變測試**（在 scratchpad 的副本做，或就地改完手動改回）

1. 結果卡片加一行 `<p>{estimate.confidence}</p>` → Expected：「不顯示 AI 自己報的信心值」FAIL。
2. `finish` 裡拿掉 `clearResult()` → Expected：「確認：存成食物…」FAIL（卡片還在）。
3. `save.onSuccess` 拿掉 `invalidateQueries` → Expected：同一條 FAIL。
4. `onError` 拿掉 `setAiUnavailable(true)` → Expected：「AI 沒設定：說未設定，估算按鈕停用」FAIL。

- [ ] **Step 6: 全部前端檢查**（typecheck、lint、test）

- [ ] **Step 7: Commit**

```
feat(ai): 估算面板——文字或照片估算、確認或修改、存成食物

結果卡片顯示一份的數字、一致性檢查、今天還能用幾次；不顯示 AI 自陳的
信心值。命中食物庫或存的時候撞名，都可以直接用現有的那一筆。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

```bash
git add frontend/src/components/AiEstimatePanel.tsx frontend/src/components/AiEstimatePanel.module.css frontend/tests/ai-estimate-panel.test.tsx
```

---

## Task 5：前端——接進記一餐（含照片帶入）

**Files:**
- Modify: `frontend/src/components/FoodPicker.tsx`、`frontend/src/screens/LogMeal.tsx`
- Create: `frontend/tests/log-meal-ai.test.tsx`

- [ ] **Step 1: 寫失敗的測試**

`frontend/tests/log-meal-ai.test.tsx`（新）：

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetRefreshStateForTests } from "../src/auth/refresh";
import { clearTokens, setTokens } from "../src/auth/store";
import { LogMeal } from "../src/screens/LogMeal";
import { json, mockApi } from "./helpers/mock-api";

vi.mock("../src/lib/resize-image", () => ({
	shrinkToLongestEdge: vi.fn((file: File) => Promise.resolve(file)),
}));

function wrap(children: ReactNode) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const ESTIMATE = {
	analysis_id: 12,
	food_id: null,
	name: "牛肉麵",
	brand: null,
	nutrition: {
		base_unit: "g",
		serving_grams: "550.00",
		kcal: "112.73",
		protein_g: "5.82",
		fat_g: "3.27",
		carb_g: "14.55",
		serving_kcal: "620.00",
		serving_protein_g: "32.00",
		serving_fat_g: "18.00",
		serving_carb_g: "80.00",
	},
	confidence: "0.37",
	consistency: { atwater_kcal: "610.00", deviation: "10.00", flagged: false },
	remaining_today: 19,
};

const CREATED = {
	id: 30,
	name: "牛肉麵",
	brand: null,
	is_global: false,
	nutrition: {
		base_unit: "g",
		kcal: "112.73",
		protein_g: "5.82",
		fat_g: "3.27",
		carb_g: "14.55",
	},
};

// AI 存出來的食物帶一個自己的預設份量「一份」（AI 估算前端規格 §4.1）。
const ONE_SERVING = {
	id: 300,
	label: "一份",
	grams: "550.00",
	is_default: true,
	is_global: false,
};

/** 路徑順序：mockApi 依序用 url.includes 比對——具體的排前面。 */
function mockLogMeal() {
	return mockApi([
		{ path: "/api/foods/frequent", handler: () => json([]) },
		{ path: "/api/foods/recent", handler: () => json([]) },
		{ path: "/api/foods/30/portions", handler: () => json([ONE_SERVING]) },
		{ method: "GET", path: "/api/foods?q=", handler: () => json([]) },
		{ method: "POST", path: "/api/ai/analyze", handler: () => json(ESTIMATE) },
		{ method: "POST", path: "/api/foods", handler: () => json(CREATED, 201) },
		{ method: "POST", path: "/api/meals/99/photo", handler: () => json({ id: 99 }) },
		{ method: "POST", path: "/api/meals", handler: () => json({ id: 99 }, 201) },
	]);
}

function mealBody(fetchMock: ReturnType<typeof mockApi>): unknown {
	const call = fetchMock.mock.calls.find(
		([input, init]) =>
			(init?.method ?? "GET").toUpperCase() === "POST" &&
			String(input).endsWith("/api/meals"),
	);
	return call === undefined ? undefined : JSON.parse(String(call[1]?.body));
}

function uploadedPhotoName(fetchMock: ReturnType<typeof mockApi>): string | null {
	const call = fetchMock.mock.calls.find(([input]) =>
		String(input).includes("/api/meals/99/photo"),
	);
	if (call === undefined) return null;
	const file = (call[1]?.body as FormData).get("file");
	return file instanceof File ? file.name : null;
}

/** 等到卡片消失才算完成：卡片消失＝面板已經把食物（與照片）交回給記一餐。
 *  只等「已選擇：牛肉麵」不夠——第二次估算時那行字早就在畫面上了，
 *  會在交回之前就往下走（handover §6 第 41 種）。 */
async function confirmEstimate() {
	const card = await screen.findByRole("region", { name: "AI 估算結果" });
	await userEvent.click(within(card).getByRole("button", { name: "確認" }));
	await waitFor(() =>
		expect(
			screen.queryByRole("region", { name: "AI 估算結果" }),
		).not.toBeInTheDocument(),
	);
	expect(screen.getByText("已選擇：牛肉麵")).toBeInTheDocument();
}

beforeEach(() => {
	localStorage.clear();
	clearTokens();
	resetRefreshStateForTests();
	vi.restoreAllMocks();
	setTokens({ access_token: "a", refresh_token: "r" });
});

describe("記一餐：AI 估算", () => {
	it("搜尋框有字就能用 AI 估算；確認後選上那個食物，份量是「一份 × 1」", async () => {
		const fetchMock = mockLogMeal();
		render(wrap(<LogMeal onSaved={vi.fn()} />));

		await userEvent.type(screen.getByLabelText("搜尋食物"), "牛肉麵");
		await userEvent.click(screen.getByRole("button", { name: "用 AI 估算「牛肉麵」" }));
		await confirmEstimate();

		await waitFor(() => expect(screen.getByLabelText("份量選項")).toHaveValue("300"));
		expect(screen.getByLabelText("份量")).toHaveValue("1");
		await userEvent.click(screen.getByRole("button", { name: "記錄" }));

		await waitFor(() =>
			expect(mealBody(fetchMock)).toMatchObject({
				items: [{ food_id: 30, quantity: "1", portion_id: 300 }],
			}),
		);
	});

	it("拍照估算：那張照片自動當這一餐的照片", async () => {
		const fetchMock = mockLogMeal();
		render(wrap(<LogMeal onSaved={vi.fn()} />));
		const photo = new File(["fake-jpeg"], "noodle.jpg", { type: "image/jpeg" });

		await userEvent.upload(screen.getByLabelText("拍照估算"), photo);
		await confirmEstimate();
		// 預覽是 effect 裡建的 object URL——等它出現。
		expect(await screen.findByAltText("選好的照片")).toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: "記錄" }));

		await waitFor(() => expect(uploadedPhotoName(fetchMock)).toBe("noodle.jpg"));
	});

	it("已經選了別張照片：拍照估算的照片不覆蓋它", async () => {
		const fetchMock = mockLogMeal();
		render(wrap(<LogMeal onSaved={vi.fn()} />));
		const chosen = new File(["a"], "chosen.jpg", { type: "image/jpeg" });
		const forEstimate = new File(["b"], "noodle.jpg", { type: "image/jpeg" });

		// 「照片（選填）」在選了食物之後的表單裡：先用文字估算選上食物、
		// 選一張照片，再用另一張照片估算一次。
		await userEvent.type(screen.getByLabelText("搜尋食物"), "牛肉麵");
		await userEvent.click(screen.getByRole("button", { name: "用 AI 估算「牛肉麵」" }));
		await confirmEstimate();
		await userEvent.upload(screen.getByLabelText("照片（選填）"), chosen);
		await userEvent.upload(screen.getByLabelText("拍照估算"), forEstimate);
		await confirmEstimate();
		await userEvent.click(screen.getByRole("button", { name: "記錄" }));

		await waitFor(() => expect(uploadedPhotoName(fetchMock)).toBe("chosen.jpg"));
	});
});
```

> 第三條測試的流程要先確認：「照片（選填）」只在選了食物之後的表單裡（`LogMeal.tsx` 的 `selectedFood !== null && <form>`）。如果現況不是這樣，照現況調整步驟、**不改斷言**，並回報。

- [ ] **Step 2: 跑測試確認失敗**

```
npx vitest run tests/log-meal-ai.test.tsx
```

Expected：三條都 FAIL（找不到「用 AI 估算」按鈕或「拍照估算」）。

- [ ] **Step 3: 實作**

`frontend/src/components/FoodPicker.tsx`：

1. `import { useState } from "react";` 改成 `import { type ReactNode, useState } from "react";`。
2. `Props` 加：

```tsx
	/** 選填：放在搜尋框正下方的東西，拿到目前的搜尋字（trim 過）。記一餐用它
	 *  放 AI 估算面板（AI 估算前端規格 §5.1）；編輯這一餐的「加一項」不給。 */
	renderBelowSearch?: (query: string) => ReactNode;
```

3. 函式簽章改成 `export function FoodPicker({ onSelect, renderBelowSearch }: Props)`；JSX 在搜尋框那個 `</div>` 之後加 `{renderBelowSearch?.(searchInput.trim())}`。

> 用 `searchInput`（不是 debounce 之後的值）：按鈕上的字跟著打字即時更新，估算本身是按了才送。

`frontend/src/screens/LogMeal.tsx`：import `AiEstimatePanel`（`../components/AiEstimatePanel`）；`<FoodPicker onSelect={setSelectedFood} />` 換成：

```tsx
			<FoodPicker
				onSelect={setSelectedFood}
				renderBelowSearch={(query) => (
					<AiEstimatePanel
						text={query}
						onFoodReady={(food, { image }) => {
							setSelectedFood(food);
							// 拍照估算的照片當這一餐的照片——但已經選了別張就不覆蓋
							// （AI 估算前端規格 §5.1）。放進去的是原始檔案：記一餐上傳時
							// 自己會縮（uploadMealPhoto）。大小已經在面板擋過。
							if (image !== null && photo === null) {
								setPhoto(image);
								setPhotoError(null);
							}
						}}
					/>
				)}
			/>
```

- [ ] **Step 4: 跑測試確認通過**

```
npx vitest run tests/log-meal-ai.test.tsx tests/log-meal.test.tsx tests/food-picker.test.tsx tests/edit-meal.test.tsx
git diff master -- frontend/tests/log-meal.test.tsx
```

Expected：全部 PASS；`git diff` 沒有輸出（既有的記一餐測試一條都沒改）。

- [ ] **Step 5: 突變測試**

1. 拿掉 `&& photo === null` → Expected：「已經選了別張照片…不覆蓋」FAIL。
2. `FoodPicker` 拿掉 `renderBelowSearch` 那一行 → Expected：三條全 FAIL。

- [ ] **Step 6: 全部前端檢查**（typecheck、lint、test）

- [ ] **Step 7: Commit**

```
feat(ai): 記一餐可以用 AI 估算，拍照估算的照片當這一餐的照片

搜尋框下面多了「用 AI 估算『…』」與「拍照估算」；確認後直接選上那個食物，
份量是剛建的「一份 × 1」。已經選了別張照片時不覆蓋。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

```bash
git add frontend/src/components/FoodPicker.tsx frontend/src/screens/LogMeal.tsx frontend/tests/log-meal-ai.test.tsx
```

---

## Task 6：前端——接進新增食物

**Files:**
- Modify: `frontend/src/screens/NewFood.tsx`
- Create: `frontend/tests/new-food-ai.test.tsx`

- [ ] **Step 1: 寫失敗的測試**

`frontend/tests/new-food-ai.test.tsx`（新）：

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { MemoryRouter, Route, Routes, useParams } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetRefreshStateForTests } from "../src/auth/refresh";
import { clearTokens, setTokens } from "../src/auth/store";
import { NewFood } from "../src/screens/NewFood";
import { json, mockApi } from "./helpers/mock-api";

vi.mock("../src/lib/resize-image", () => ({
	shrinkToLongestEdge: vi.fn((file: File) => Promise.resolve(file)),
}));

/** 用真的 react-router 比對確認「導到正確的 id」（同 new-food.test.tsx）。 */
function FakeFoodDetail() {
	const { id } = useParams();
	return <p>food-detail:{id}</p>;
}

function wrap(children: ReactNode) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return (
		<QueryClientProvider client={client}>
			<MemoryRouter initialEntries={["/foods/new"]}>
				<Routes>
					<Route path="/foods/new" element={children} />
					<Route path="/foods/:id" element={<FakeFoodDetail />} />
				</Routes>
			</MemoryRouter>
		</QueryClientProvider>
	);
}

const ESTIMATE = {
	analysis_id: 12,
	food_id: null,
	name: "牛肉麵",
	brand: null,
	nutrition: {
		base_unit: "g",
		serving_grams: "550.00",
		kcal: "112.73",
		protein_g: "5.82",
		fat_g: "3.27",
		carb_g: "14.55",
		serving_kcal: "620.00",
		serving_protein_g: "32.00",
		serving_fat_g: "18.00",
		serving_carb_g: "80.00",
	},
	confidence: "0.37",
	consistency: { atwater_kcal: "610.00", deviation: "10.00", flagged: false },
	remaining_today: 19,
};

beforeEach(() => {
	localStorage.clear();
	clearTokens();
	resetRefreshStateForTests();
	vi.restoreAllMocks();
	setTokens({ access_token: "a", refresh_token: "r" });
});

describe("新增食物：用 AI 填", () => {
	it("描述 → 估算 → 確認：存好之後導到那個食物的詳情頁", async () => {
		const fetchMock = mockApi([
			{ method: "POST", path: "/api/ai/analyze", handler: () => json(ESTIMATE) },
			{
				method: "POST",
				path: "/api/foods",
				handler: () => json({ ...ESTIMATE, id: 30, is_global: false }, 201),
			},
		]);
		render(wrap(<NewFood />));

		await userEvent.type(screen.getByLabelText("描述這個食物"), "一碗牛肉麵");
		await userEvent.click(screen.getByRole("button", { name: "估算" }));
		const card = await screen.findByRole("region", { name: "AI 估算結果" });
		await userEvent.click(within(card).getByRole("button", { name: "確認" }));

		expect(await screen.findByText("food-detail:30")).toBeInTheDocument();
		const analyzeCall = fetchMock.mock.calls.find(([input]) =>
			String(input).includes("/api/ai/analyze"),
		);
		expect(JSON.parse(String(analyzeCall?.[1]?.body))).toEqual({
			kind: "text",
			text: "一碗牛肉麵",
		});
	});

	it("沒有描述時只有拍照估算；手動填表單的路照舊", () => {
		mockApi([]);
		render(wrap(<NewFood />));

		expect(screen.queryByRole("button", { name: "估算" })).not.toBeInTheDocument();
		expect(screen.getByLabelText("拍照估算")).toBeInTheDocument();
		expect(screen.getByLabelText("名稱")).toBeInTheDocument();
	});
});
```

> 回應的食物 body 用 `{ ...ESTIMATE, id: 30, is_global: false }` 只是為了少寫一份 fixture——面板只用 `id`。如果型別檢查不讓它過（測試檔的 `json()` 吃 `unknown`，應該會過），改成一個獨立的 `CREATED` 物件。

- [ ] **Step 2: 跑測試確認失敗**

```
npx vitest run tests/new-food-ai.test.tsx
```

Expected：兩條 FAIL（找不到「描述這個食物」／「拍照估算」）。

- [ ] **Step 3: 實作**

`frontend/src/screens/NewFood.tsx`：import `AiEstimatePanel`（`../components/AiEstimatePanel`）；state 區加 `const [aiText, setAiText] = useState("");`；`<h1>新增食物</h1>` 之後、`<form onSubmit={handleSubmit}>` 之前加：

```tsx
			{/* 用 AI 填（AI 估算前端規格 §5.2）：跟記一餐同一個面板。存好之後跟
			    手動建立成功一樣導到詳情頁。放在表單外面——面板自己的修改模式
			    也是一個 <form>，巢狀 form 不合法。 */}
			<section aria-labelledby="new-food-ai">
				<h2 id="new-food-ai">用 AI 填</h2>
				<label htmlFor="ai-describe">描述這個食物</label>
				<input
					id="ai-describe"
					type="text"
					value={aiText}
					onChange={(event) => setAiText(event.target.value)}
				/>
				<AiEstimatePanel
					text={aiText}
					textButtonLabel={() => "估算"}
					onFoodReady={(food) => navigate(`/foods/${food.id}`)}
				/>
			</section>
```

- [ ] **Step 4: 跑測試確認通過**

```
npx vitest run tests/new-food-ai.test.tsx tests/new-food.test.tsx
git diff master -- frontend/tests/new-food.test.tsx
```

Expected：全部 PASS；`new-food.test.tsx` 沒有改（`git diff` 只會看到 Task 3 以前的改動——如果 Task 3 沒碰它，就是沒有輸出）。

- [ ] **Step 5: 突變測試**

`onFoodReady` 改成 `() => {}` → Expected：第一條 FAIL。改回。

- [ ] **Step 6: 全部前端檢查**（typecheck、lint、test）

- [ ] **Step 7: Commit**

```
feat(ai): 新增食物可以用 AI 填

表單上方一個「用 AI 填」區塊，跟記一餐同一個估算面板；存好之後導到那個
食物的詳情頁。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

```bash
git add frontend/src/screens/NewFood.tsx frontend/tests/new-food-ai.test.tsx
```

---

## Task 7：e2e

**Files:** Create `frontend/e2e/ai-estimate.spec.ts`

- [ ] **Step 1: 確認本機環境**

e2e 打的是本機 docker 的 api。

1. **本機的 api 不能設定 AI**（第二條測試要看到「AI 分析未設定」，而且 e2e 不該花錢）：

```
cd F:/wallet
grep -n "AI_PROVIDER\|ANTHROPIC_API_KEY\|GEMINI_API_KEY" .env 2>/dev/null
```

有設值（不是空的）→ **停下來回報**，不要自己改使用者的 `.env`。

2. 重建 api（多了 `google-genai`、新的環境變數）：

```
docker compose up -d --build api
docker compose exec api alembic upgrade head
```

Docker 沒開或指令失敗 → 回報。

- [ ] **Step 2: 寫 e2e**

`frontend/e2e/ai-estimate.spec.ts`：

```ts
import { expect, type Page, test } from "@playwright/test";
import { ADMIN } from "./accounts.ts";

async function login(page: Page) {
	await page.goto("/");
	await page.getByLabel("Email").fill(ADMIN.email);
	await page.getByLabel("密碼").fill(ADMIN.password);
	await page.getByRole("button", { name: "登入" }).click();
	await expect(page.getByRole("heading", { name: "總覽" })).toBeVisible();
}

async function openLogMeal(page: Page) {
	await page.getByRole("button", { name: "新增紀錄" }).click();
	await page.getByRole("link", { name: "記一餐" }).click();
	await expect(page.getByRole("heading", { name: "記一餐" })).toBeVisible();
}

// CI 沒有 AI 金鑰，而且 e2e 不該花錢——只走不需要呼叫 AI 的路
// （AI 估算前端規格 §6.2）。真的呼叫 AI 的路由元件測試與後端測試守著。

test("AI 估算命中食物庫：「用這個」→ 記錄 → 飲食頁看到那個食物", async ({
	page,
}) => {
	await login(page);
	const foodName = `E2E AI ${Date.now()}`;

	// 先建一個唯一名稱的食物（食物庫的比對是精確比對名稱）。
	await page.getByRole("link", { name: "飲食" }).click();
	await page.getByRole("link", { name: "食物庫" }).click();
	await page.getByRole("link", { name: "新增食物" }).click();
	await page.getByLabel("名稱", { exact: true }).fill(foodName);
	await page.getByLabel("熱量（每 100 單位 kcal）").fill("100");
	await page.getByLabel("蛋白質（g）", { exact: true }).fill("10");
	await page.getByLabel("脂肪（g）", { exact: true }).fill("5");
	await page.getByLabel("碳水化合物（g）", { exact: true }).fill("5");
	await page.getByRole("button", { name: "建立食物" }).click();
	await expect(page.getByRole("heading", { name: foodName })).toBeVisible();

	await openLogMeal(page);
	await page.getByLabel("搜尋食物").fill(foodName);
	await page.getByRole("button", { name: `用 AI 估算「${foodName}」` }).click();
	const hit = page.getByRole("region", { name: "食物庫裡的食物" });
	await expect(hit).toContainText(`食物庫裡已經有「${foodName}」`);
	await hit.getByRole("button", { name: "用這個" }).click();

	await expect(page.getByText(`已選擇：${foodName}`)).toBeVisible();
	await page.getByLabel("份量", { exact: true }).fill("100");
	await page.getByRole("button", { name: "記錄" }).click();
	await expect(page.getByRole("heading", { name: "總覽" })).toBeVisible();

	await page.getByRole("link", { name: "飲食" }).click();
	// 餐點卡片是 <li>，裡面每個食物又是一個 <li>——取最後一個（內層那一項）。
	await expect(
		page.getByRole("listitem").filter({ hasText: foodName }).last(),
	).toContainText("100 g");
});

test("AI 沒設定：估算一個食物庫沒有的東西，說「AI 分析未設定」", async ({
	page,
}) => {
	await login(page);
	await openLogMeal(page);
	const text = `E2E 食物庫沒有這個 ${Date.now()}`;

	await page.getByLabel("搜尋食物").fill(text);
	await page.getByRole("button", { name: `用 AI 估算「${text}」` }).click();

	await expect(page.getByRole("alert")).toContainText("AI 分析未設定");
});
```

> 新增食物的欄位標籤以 `e2e/portions.spec.ts` 現況為準。**新增食物畫面現在多了 AI 面板**：面板的修改模式沒打開時沒有任何「名稱」「熱量」相關的欄位，但「描述這個食物」是新的欄位——如果哪個 `getByLabel` 因為子字串比對撞到它，加 `exact: true` 並回報。
> 「蛋白質（g）」等加了 `exact: true`：每 100 模式下新增食物的標籤是「蛋白質（g）」，而「一份的蛋白質（g）」只在 AI 面板的修改模式出現——這裡不會打開，但 exact 讓它不靠運氣。

- [ ] **Step 3: 跑 e2e**

```
cd frontend
npx playwright test e2e/ai-estimate.spec.ts
npx playwright test
```

Expected：新的兩條 PASS；全部 e2e = 19 + 2 = 21 passed。**特別注意既有的 e2e**（`foods.spec.ts`、`admin.spec.ts`、`mobile-form-zoom.spec.ts`、`portions.spec.ts`、`daily-loop.spec.ts`、`trend.spec.ts` 都會經過新增食物或記一餐）——有紅的照實回報是哪一條、為什麼。

- [ ] **Step 4: 突變測試**

把 `app/api/routes/ai.py` 的 `estimator = make_estimator()` 移回 `analyze` 第一行、重建 api（`docker compose up -d --build api`）、重跑第一條 → Expected：FAIL（命中食物庫也 503，看不到「食物庫裡已經有」）。改回、確認 `git diff app/` 是空的、重建 api、重跑確認綠。

- [ ] **Step 5: Commit**

```
test(e2e): AI 估算命中食物庫可以直接用；沒設定時說未設定

CI 沒有金鑰、e2e 也不該花錢，所以只走不呼叫 AI 的兩條路。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

```bash
git add frontend/e2e/ai-estimate.spec.ts
```

---

## Task 8：部署手冊與交接文件

**Files:** Modify `docs/deployment.md`、`docs/handover.md`

- [ ] **Step 1: 部署手冊**

`docs/deployment.md` 「4. 產生密鑰並填設定」裡關於 `ANTHROPIC_API_KEY` 的那兩段（從「`.env.production.example` 還有一個選配的 `ANTHROPIC_API_KEY`」到「這一步目前不在這份 task 的範圍內。」那個引用區塊結束）換成：

```markdown
`.env.production.example` 還有四個選配的 AI 變數（AI 營養素估算）。
**全部留白也沒關係**：`AI_PROVIDER` 沒填，AI 功能就整個關閉（估算端點回
`503 AI_NOT_CONFIGURED`，畫面上說「AI 分析未設定」），其他功能完全不受影響。
「沒有 AI」不是安全性問題，只是少一個功能——不該讓整個 app 因此起不來。

要打開 AI：

| 變數 | 填什麼 |
|---|---|
| `AI_PROVIDER` | `anthropic` 或 `gemini`（小寫）。**填了別的值，api 容器會啟動失敗**——打錯字要大聲說出來 |
| `AI_MODEL` | 那一家的模型名稱。**沒有預設值**：從供應商的文件確認目前可用的名稱再填（Anthropic：https://docs.anthropic.com/en/docs/about-claude/models、Gemini：https://ai.google.dev/gemini-api/docs/models） |
| `ANTHROPIC_API_KEY` | 選 `anthropic` 時必填 |
| `GEMINI_API_KEY` | 選 `gemini` 時必填 |

選了一家卻沒填它的金鑰或 `AI_MODEL`：端點回 503，訊息會說缺哪一個
（例如「AI 分析未設定：缺 GEMINI_API_KEY」）。四個變數都由
`docker-compose.yml` 用 `${VAR:-}` 傳進 api 容器（空字串＝沒設）。

**換供應商**：改 `AI_PROVIDER` 與 `AI_MODEL`（以及那一家的金鑰），然後
`up -d`（不是 `restart`，見「二、更新」）。每日上限（預設 20 次）兩家共用、
照樣算。

**打開之後怎麼確認**：在記一餐打一個食物庫沒有的東西，按「用 AI 估算」——
看到結果卡片就是通的；看到「AI 分析未設定」就照訊息補設定；看到「AI 這次的
回答看不懂」通常是 `AI_MODEL` 填錯（供應商回了錯誤），看 api 容器的 log。
```

「二、更新」那一節的 `git pull` 指令區塊之後加一段：

```markdown
> **2026-10 這一版（AI 估算的前端）多了一個 Python 套件（`google-genai`）**，
> 上面的 `--build` 會裝進去；沒有 migration。要打開 AI，先照「4. 產生密鑰並
> 填設定」在 `.env.production` 填好 AI 變數再 `up -d --build`。
```

- [ ] **Step 2: 交接文件**

`docs/handover.md`：

1. §2 階段進度表的 `| P2 AI 分析 | 拍照 → 辨識 → 估算 → **驗證** → 落庫 | ⬜ |` 改成 `| P2 AI 分析 | 拍照 → 辨識 → 估算 → **驗證** → 落庫。後端（Anthropic 與 Gemini 擇一，`AI_PROVIDER`）與前端（記一餐、新增食物的估算面板；規格 `docs/superpowers/specs/2026-10-05-ai-estimate-frontend-design.md`）都已實作 | ✅ 已實作於 `feat/ai-estimate` |`。
2. §8.2 加一條：

```markdown
- **AI 估算的已知限制**：一次一樣食物（P2 規格 §9）；「編輯這一餐」的加一項
  沒有 AI（`FoodPicker` 的 `renderBelowSearch` 沒給，要加只是多傳一個 prop）；
  估算用的照片不存（記一餐的拍照估算會把那張照片當這一餐的照片，那是另一件事）；
  `ai_raw_response` 存的是前端送來的估算回應（不是後端自己留的 LLM 原文）——
  它是你自己的資料，偽造它只會騙到你自己。
```

3. 這次實作過程中新發現的「綠燈說謊」寫進 §6（沒有就不寫；有的話標題的數字跟著改）。

- [ ] **Step 3: Commit**

```
docs: 部署手冊與交接文件——AI 估算的前端

部署手冊寫明四個 AI 變數、怎麼換供應商、怎麼確認打開了；交接文件的
階段進度把 P2 標成已實作。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

```bash
git add docs/deployment.md docs/handover.md
```

---

## 收尾

- [ ] 全部測試：後端 `pytest`、`ruff`、`mypy`；前端 `typecheck`、`lint`、`test`；e2e。
- [ ] `git status` 乾淨（`lunch.jpg` 除外）。

---

## 自我檢查（寫計畫時做的）

**規格涵蓋：**

| 規格 | 任務 |
|---|---|
| §3.1 兩家並存、`AI_PROVIDER`、缺什麼說什麼、打錯字啟動失敗、不猜模型名稱、空字串正規化、`google-genai` | Task 1 |
| §3.2 `food_id`、`remaining_today` | Task 2 |
| §3.3 先查食物庫再建實作 | Task 2（Task 1 先把依賴改成「建實作的函式」） |
| §3.4 `FOOD_EXISTS` 附 `food_id`（含 `IntegrityError` 那條） | Task 2 |
| §3.5 後端測試 | Task 1、2 |
| §3.6 `schema.d.ts` | Task 2 Step 7 |
| §4.1 面板流程（輸入、估算中、結果卡片、確認、需要修改） | Task 3（body）、Task 4（面板） |
| §4.2 命中食物庫、撞名 | Task 4 |
| §4.3 錯誤 | Task 4 |
| §4.4 失效搜尋、估算不快取 | Task 3（`foodSearchAll`）、Task 4 |
| §5.1 記一餐（含照片帶入、不覆蓋） | Task 5 |
| §5.2 新增食物 | Task 6 |
| §6.1、§6.2 測試 | Task 3–7 |
| §7 部署 | Task 1 Step 7（compose、example）、Task 8（手冊） |

**名稱一致：** `get_estimator_factory`／`build_estimator`／`EstimatorFactory`（Task 1 定義、Task 2 使用）；`NutritionEstimator.model`（Task 1）；`_count_used_today`／`_remaining`／`_assert_quota_available` 回傳 int（Task 2）；`_find_same_named_food`／`_food_exists`（Task 2）；`AnalyzeResponse`、`analyzeText`、`analyzeImage`、`fileToBase64`（Task 3 定義，Task 4 使用）；`confirmedFoodRequest`、`draftFromEstimate`、`editedFoodRequest`、`EstimateDraft`（Task 3 定義，Task 4 使用）；`queryKeys.foodSearchAll`（Task 3 定義，Task 4 使用）；`describeFieldErrors` 從 `api/errors`（Task 3 搬，Task 4 使用）；`AiEstimatePanel` 的 props `text`／`onFoodReady(food, { image })`／`textButtonLabel`（Task 4 定義，Task 5、6 使用）；`FoodPicker` 的 `renderBelowSearch`（Task 5）。
