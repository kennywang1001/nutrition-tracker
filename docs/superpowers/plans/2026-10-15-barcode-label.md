# 掃條碼／營養標示 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 食物多一個條碼：掃到（或手動輸入、從照片讀）就選到自己的或公開的那一筆；找不到時問 Open Food Facts 要預填建議、帶到新增食物；新增食物可以拍營養標示讓 AI 照抄數字（每份換算每 100 在後端做）。

**Architecture:** 後端：`app/barcode.py`（正規化、GS1 檢查碼，純函式）；`foods.barcode`＋兩個唯一索引＋CHECK、`ai_analyses.kind` 多 `label`（migration `0022`）；`routes/foods.py` 多 `GET /foods/by-barcode/{code}`、`PATCH /foods/{id}`、建立時收 `barcode`，`FoodResponse.of()` 統一組回應；`app/nutrition_units.py`（kJ→kcal、每份→每 100）；`app/off.py`（Open Food Facts 用戶端：`httpx`、4 秒、LRU 快取、`get_product_lookup` 可注入）；`app/ai/label.py`（提示詞、平的 schema、`parse_raw_label`），兩家 estimator 多 `read_label`，`POST /api/ai/read-label` 在 `routes/ai.py`。前端：`lib/barcode-detector.ts`（原生 `BarcodeDetector` 或延遲載入的 `barcode-detector` ponyfill，wasm 自己服務）、`lib/use-barcode-scanner.ts`、`components/BarcodeScanner.tsx`（全螢幕掃描層）、`components/BarcodeScanEntry.tsx`（入口＋查詢＋沒命中的卡片），`FoodPicker`／`FoodLibrary` 掛入口，`NewFood`（條碼欄位、OFF 預填、拍營養標示、`returnTo`）、`FoodDetail`（改條碼），`LogMealRoute`／`EditMeal` 收 `pickedFood`。

**Tech Stack:** FastAPI · SQLAlchemy 2 async · Alembic · PostgreSQL 16 · httpx · Anthropic／Gemini SDK · React 19 · TypeScript strict · TanStack Query v5 · react-router 8 · CSS Modules · Vitest · Playwright · Biome · barcode-detector 3.2.2（MIT）＋ zxing-wasm 3.1.3（MIT）

**依據規格：** `docs/superpowers/specs/2026-10-15-barcode-label-design.md`（以下稱「規格」；D1…D31 指它的 §2）

---

## 執行中發現的差異

（執行時填：每個 task 的 commit、跟計畫不一樣的地方、突變的結果。）

## 與規格的差異

（執行完填摘要。）

---

## 執行環境

- 分支 `feat/barcode-label`（已建立，**不要 push**）。`S=C:/Users/user/AppData/Local/Temp/claude/f--wallet/e7b60c93-fbd5-4a61-9c85-74550ff7244b/scratchpad`。
- 後端在 repo 根目錄（Git Bash）：
  - `./.venv/Scripts/python.exe -m pytest -q -W error`（整套約 5 分鐘，timeout 給 10 分鐘；**同一時間只跑一個 pytest**——測試資料庫每次砍掉重建）。需要 dev 的 Postgres：`docker compose up -d db`（`localhost:5433`）。**絕對不要跑 `down -v`。**
  - `./.venv/Scripts/python.exe -m ruff check .`、`./.venv/Scripts/python.exe -m mypy app`——**不要接管線**（`| tail` 吃掉退出碼）。**不要跑 `ruff format`**。行寬 100（中文字算一格，但 ruff 的 E501 量的是字元寬度——寫計畫時有好幾行中文註解超過，換行就好）。
  - `alembic check` 指向測試資料庫：`DATABASE_URL="postgresql+asyncpg://wallet:wallet@localhost:5433/wallet_test" ./.venv/Scripts/python.exe -m alembic check`
- 前端在 `frontend/`：`npx vitest run tests/xxx`、`npm run -s test`、`npm run -s typecheck`、`npm run -s lint`（格式 `npx biome check --write <檔案>`）。**三個分開跑**；驗證時一起 grep `FAIL` 與 `Unhandled`（handover §7）。typecheck 在每次 commit 之前單獨跑，跟 `git commit` 用 `&&` 串。測試預設是手機版面（`src/test/media.ts`）。
- e2e：`docker compose up -d --build api` → `docker compose exec -T api python -m alembic upgrade head` → `docker compose exec -T api python -m alembic current`（`0022`）→ 在 `frontend/` 跑 `npx playwright test …`。
- **`schema.d.ts` 重新產生**——動到 `app/api/routes` 或 `app/schemas` 的每一個 commit（docstring 也算）：

  ```bash
  S=C:/Users/user/AppData/Local/Temp/claude/f--wallet/e7b60c93-fbd5-4a61-9c85-74550ff7244b/scratchpad
  PYTHONUTF8=1 PYTHONIOENCODING=utf-8 ./.venv/Scripts/python.exe -c "import json; from app.main import app; print(json.dumps(app.openapi(), ensure_ascii=False))" > "$S/openapi.tmp.json"; (cd frontend && npx openapi-typescript "$S/openapi.tmp.json" -o src/api/schema.d.ts)
  rm "$S/openapi.tmp.json"
  ```

  產生之後 `cd frontend && npm run -s typecheck`。
- **突變**：改一行、看指定的測試紅、改回、重跑綠。**改之前先存原始位元組**（`cp app/x.py "$S/bc-mp-x.py.bak"`；**新的、還沒追蹤的檔案** `git checkout --` 救不回來，一定要先備份），改回之後 `cmp` 比對；`.py` 改回之後 `touch` 並刪掉對應的 `__pycache__/*.pyc`（pyc 用秒比 mtime）。每一批突變之後跑 `git diff`／`git status`。突變小工具一律用 Write 工具寫成檔案（`$S/bc-mutate-<task>.py`），跑 pytest 前設 `PYTHONIOENCODING=utf-8`。**有 uncommitted 的想要的改動時，絕對不要對那個檔案 `git checkout`。** vitest 的突變要改成型別過得去的樣子（被 `TypeCheckError` 殺掉的不算）。**只改 migration 的突變會讓 conftest 的 `alembic check` 在每一條測試的 setup 就 ERROR**——要看到指定的測試紅，模型與 migration 一起改（handover §7）。
- **Commit**：中文 conventional commit。訊息用 Write 工具寫到 `$S/bc-<task>-msg.txt`（每次不同檔名），最後一行 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`，`git commit -F`。**明確列出要 add 的檔案；絕對不要 stage `lunch.jpg`**（不要 `git add -A`／`.`）。不要 amend。回應（`response_model`）一律在 commit 之前組好（身體資料審查 M6）。
- **看不見的字元**：Write／Edit 工具會把「反斜線 u＋四位十六進位」解成真的字元；Bash heredoc 會吃掉一層反斜線。腳本一律用 Write 工具寫成檔案；測試裡的全形空白、零寬字一律用 `chr()` 組。每個 task commit 前（`$S/bc-scan.py` 已經在 scratchpad：掃 Cc〔Tab、LF 除外〕、Cf、Zl、Zp、CR、BOM，找到就 `exit 1`；寫計畫時自我測試過，對 U+200B 回 1）：

  ```bash
  ./.venv/Scripts/python.exe -I "$S/bc-scan.py" $(git diff --cached --name-only) "$S/bc-<task>-msg.txt" && git commit -F "$S/bc-<task>-msg.txt"
  ```

## 開工前必讀

1. 「Expected: FAIL」沒有如預期失敗 → 停下來回報。新模組還不存在時紅的是 import，不是斷言——斷言的咬合力由每個 task 的突變步驟證明。
2. 引用的程式碼對不上現況 → 以現況為準並回報，記進「執行中發現的差異」。
3. `client` 夾具跟測試共用一個 session、外層一個交易：`rollback()` 之後 ORM 物件過期——要用的 id、headers 先存成區域變數。接住 `IntegrityError` 的地方一定要 `rollback()`（conftest 開頭的邊界 4）；model 層的違規測試用 `async with db_session.begin_nested():`（`tests/test_body_model.py` 的寫法）。
4. **「看不到」的測試先在同一條測試裡看得到一次**（例如：別人的私人食物查不到——先用自己的同一個條碼查到一次）。只斷言「沒有」的測試，路徑打錯也會綠。
5. **測試絕對不打網路**（規格 D14）：Task 4 之後 conftest 有 autouse fixture 把 `app.off._http_get` 換成丟 `AssertionError` 的；要 OFF 的結果就 `app.dependency_overrides[get_product_lookup] = lambda: FakeLookup(...)`（`client` 夾具結束時 `dependency_overrides.clear()` 會一起清掉）。
6. 前端 `tests/helpers/mock-api.ts` 用 `url.includes(path)` **依序**比對：`/api/foods/by-barcode/…` 包含 `/api/foods`、`/api/foods/7` 也會被 `/api/foods` 吃掉——**更具體的排前面**。
7. 前端不驗條碼的檢查碼、不做營養素的換算（後端做）。只去分隔符號、看長度（`lib/barcode.ts`）。
8. **`FoodResponse.barcode` 是必填的 `string | null`，但離線快取裡的舊食物沒有這個 key**：畫面一律用真值判斷（`food.barcode ? … : …`）、受控輸入 `?? ""`（規格 §10.3）。
9. Playwright 的名稱一律 `exact: true`（「食物庫」會撞「從食物庫配」；這次新的「掃條碼」不要跟任何既有名稱互為子字串——寫的時候 `grep -rn "掃條碼" frontend/src` 確認只有自己）；登入之後**只用點擊換頁**；換頁後先等頁面獨有的元素；只量有界的一組元素的觸控高度。Playwright 不做型別檢查——加了 spec 之後 `npm run -s typecheck`。
10. 給 LLM 的 Pydantic 類別**不寫 docstring**（`transform_schema()` 會送給模型），說明寫成 `#` 註解。
11. `aria-disabled` 的慣例：會在焦點正在它身上時停用的按鈕用 `aria-disabled`＋擋在 handler（同「讓 AI 配一餐」）；jest-dom 的 `toBeDisabled()` 不認它、Playwright 的認。觸控目標 44px、輸入框 16px 字（`mobile-form-zoom.spec.ts` 會量）；顏色只用 `index.css` 的設計變數（`tests/css-tokens.test.ts` 會擋）。

## 寫計畫時實測過的事（沒有整份試跑）

這份計畫**沒有**整份跑過。「Expected: PASS」的條數是照測試清單數的，不是量的；對不上照實回報。

1. **`app/barcode.py` 與 `tests/test_barcode.py`（Task 2 全文）**：暫時放進 repo 跑過——34 passed、`ruff`、`mypy` 乾淨，之後刪掉（`git status` 確認乾淨）。過程中發現 `01234565` **兩種檢查碼都對**（所以「0 開頭先試 UPC-E」那條規則真的會決定結果，測試各有一條）；`07654329` 是合格的 EAN-8、不合格的 UPC-E。
2. **`app/nutrition_units.py`、`app/off.py`、`app/ai/label.py`（Task 4、5 全文）**：暫時放進 repo，用 `$S/bc_draft_check.py` 跑過：`kj_to_kcal(1000) = 239.01`、`kj_to_kcal(2151) = 514.10`、35 g／180 kcal → 514.29、規格 §8.3 的四個數字、只有 kJ 的每 100、三種讀不出來（缺每一份量、缺脂肪、換算後超出範圍）都是 `AI_LABEL_UNREADABLE`、OFF 的可樂（只有 kJ 180 → 43.02 kcal、ml、`serving_size: "330 ml"`）、快取命中只打一次。`mypy` 乾淨；`ruff` 只有幾行中文註解太長（計畫裡的版本已經換行）。之後刪掉。
3. **`anthropic.transform_schema()` 對平的營養標示 schema**：`Decimal | None` → `anyOf [number, string, null]`、`Literal["g","ml"]` → `enum`、`str | None` 的 `max_length` 變成 description 裡的提示——跟既有的 `LLMEstimateSchema` 同一種形狀（`$S/bc-schema-probe.py`）。
4. **pydantic-settings 的 bool**：`OFF_ENABLED=""` → `ValidationError`（啟動失敗）；`"false"`、`"0"`、`"no"` → False；`"true"`、`"1"` → True。所以 compose 一定要寫預設值（`${OFF_ENABLED:-true}`），跟 `AI_DAILY_LIMIT` 同一個坑。
5. **掃描的函式庫**（`$S/bc-vite/`：Vite 8.3.0、TypeScript 6.0.3，跟 `frontend/` 同版本）：`barcode-detector@3.2.2`（MIT，依賴 `zxing-wasm@3.1.3` 釘死）＋`zxing-wasm@3.1.3`（MIT）。Task 8 的 `lib/barcode-detector.ts`、`lib/barcode-ponyfill.ts`、`lib/use-barcode-scanner.ts` 全文在那裡 `tsc`（同 `tsconfig.app.json` 的嚴格選項）乾淨、`vite build` 輸出：`barcode-ponyfill-*.js` **43.40 KB（gzip 14.94 KB）**、`zxing_reader-*.wasm` **1,093.28 KB（gzip 463.82 KB）**、入口那一塊 2.45 KB。輸出的 JS 參照的是雜湊過的 `zxing_reader-<hash>.wasm`（套件內建的 jsDelivr 字串還在，但被 `locateFile` 蓋掉）。三個檔案也用 `frontend/` 的 Biome 設定格式化過、`biome check` 乾淨。
6. `httpx` 0.28.1 已經在 `requirements-lock.txt`（anthropic、google-genai 的依賴）；`pyproject.toml` 只在 dev 列了它。

## 檔案結構

| 檔案 | Task | 內容 |
|---|---|---|
| `migrations/versions/0022_add_food_barcode_and_label_kind.py`（新）、`app/models/food.py`、`app/models/ai_analysis.py`、`tests/factories.py` | 1 | `foods.barcode`、CHECK、兩個唯一索引；`AnalysisKind.LABEL` |
| `tests/test_foods_barcode_model.py`（新）、`tests/test_ai_analysis_model.py` | 1 | |
| `app/barcode.py`（新）、`tests/test_barcode.py`（新） | 2 | 正規化、檢查碼、UPC-E 展開 |
| `app/schemas/food.py`、`app/api/routes/foods.py`、`app/api/routes/planner.py` | 3 | `Barcode` 型別、`FoodResponse.barcode`／`.of()`、`FoodCreateRequest.barcode`、`FoodBarcodeUpdate`、`BarcodeLookupResponse`；`by-barcode`、`PATCH`、建立 |
| `tests/test_foods_barcode.py`（新） | 3、4 | |
| `app/nutrition_units.py`（新）、`app/off.py`（新）、`app/config.py`、`app/ratelimit.py`、`pyproject.toml` | 4 | OFF 用戶端、`OFF_ENABLED`、限速、`httpx` |
| `docker-compose.yml`、`docker-compose.override.yml`、`.env.production.example`、`.github/workflows/ci.yml` | 4 | `OFF_ENABLED` |
| `tests/test_off.py`（新）、`tests/test_nutrition_units.py`（新）、`tests/conftest.py`、`tests/test_config.py` | 4 | |
| `app/ai/label.py`（新）、`app/ai/estimator.py`、`app/ai/anthropic_estimator.py`、`app/ai/gemini_estimator.py` | 5 | 提示詞、schema、解析、`read_label` |
| `tests/test_ai_label.py`（新）、`tests/test_ai_provider_errors.py` | 5 | |
| `app/schemas/ai.py`、`app/api/routes/ai.py`、`tests/test_ai_read_label.py`（新） | 6 | `POST /api/ai/read-label` |
| `frontend/src/api/schema.d.ts` | 3、4、6 | 每個動到 routes／schemas 的 task 重新產生 |
| `frontend/src/api/{barcode.ts（新）,ai.ts}`、`src/lib/barcode.ts`（新）、`tests/helpers/foods.ts`（新） | 7 | API 層、輸入整理、測試資料 |
| `frontend/package.json`、`package-lock.json`、`src/lib/{barcode-detector,barcode-ponyfill,use-barcode-scanner}.ts`（新）、`src/components/BarcodeScanner.{tsx,module.css}`（新） | 8 | 偵測器、掃描層 |
| `frontend/src/components/BarcodeScanEntry.{tsx,module.css}`（新）、`FoodPicker.tsx`、`screens/FoodLibrary.tsx`、`src/lib/new-food-handoff.ts`（新）、`src/App.tsx`、`screens/LogMeal.tsx`、`screens/EditMeal.tsx`、`screens/EditMealItems.tsx` | 9 | 入口、命中／沒命中、交接 |
| `frontend/src/screens/NewFood.tsx`、`screens/FoodDetail.tsx` | 10 | 條碼欄位、OFF 預填、拍營養標示、改條碼 |
| `frontend/e2e/barcode.spec.ts`（新） | 11 | 三條 |
| `docs/handover.md`、`docs/deployment.md`、規格的狀態、這份計畫 | 12 | |

---

## Task 1：後端——`foods.barcode` 與 `ai_analyses.kind` 的 `label`（migration `0022`）

**Files:**
- Create: `migrations/versions/0022_add_food_barcode_and_label_kind.py`、`tests/test_foods_barcode_model.py`
- Modify: `app/models/food.py`、`app/models/ai_analysis.py`、`tests/factories.py`、`tests/test_ai_analysis_model.py`

- [ ] **Step 1：寫會紅的測試。** `tests/factories.py` 的 `create_food` 多一個參數 `barcode: str | None = None`，原樣放進 `Food(...)`（工廠不正規化——要測的是資料庫的約束）。

`tests/test_foods_barcode_model.py`：

```python
"""`foods.barcode` 的資料庫約束（掃條碼規格 D1、D4、§10.1）。

ORM 寫入一律走工廠；違規的寫法用 raw SQL 包在 begin_nested 裡（tests/test_body_model.py 的寫法），
接住之後 session 還能用。
"""

import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from app.models.user import UserRole
from tests.factories import create_food, create_user

CODE = "4710088432094"


async def _set_barcode(db_session, food_id: int, barcode: str | None) -> None:
    async with db_session.begin_nested():
        await db_session.execute(
            text("UPDATE foods SET barcode = :b WHERE id = :id"), {"b": barcode, "id": food_id}
        )


async def test_eight_and_thirteen_digits_are_stored(db_session):
    user = await create_user(db_session)
    eight = await create_food(db_session, created_by=user, owner=user, barcode="96385074")
    thirteen = await create_food(db_session, created_by=user, owner=user, barcode=CODE)
    assert (eight.barcode, thirteen.barcode) == ("96385074", CODE)


@pytest.mark.parametrize("bad", ["12345", "036000291452", "47100884320941", "471008843209x", ""])
async def test_the_check_only_allows_eight_or_thirteen_digits(db_session, bad):
    """12 位（UPC-A）也不行：存的一定是標準形式（規格 §3.2）。"""
    user = await create_user(db_session)
    food = await create_food(db_session, created_by=user, owner=user)
    food_id = food.id

    with pytest.raises(IntegrityError) as caught:
        await _set_barcode(db_session, food_id, bad)
    assert "ck_foods_barcode_digits" in str(caught.value.orig)


async def test_one_owner_cannot_use_a_barcode_twice(db_session):
    user = await create_user(db_session)
    await create_food(db_session, created_by=user, owner=user, barcode=CODE)
    second = await create_food(db_session, created_by=user, owner=user)
    second_id = second.id

    with pytest.raises(IntegrityError) as caught:
        await _set_barcode(db_session, second_id, CODE)
    assert "uq_foods_owner_id_barcode" in str(caught.value.orig)


async def test_two_public_foods_cannot_share_a_barcode(db_session):
    admin = await create_user(db_session, role=UserRole.ADMIN)
    await create_food(db_session, created_by=admin, barcode=CODE)
    second = await create_food(db_session, created_by=admin)
    second_id = second.id

    with pytest.raises(IntegrityError) as caught:
        await _set_barcode(db_session, second_id, CODE)
    assert "uq_foods_global_barcode" in str(caught.value.orig)


async def test_private_and_public_and_other_owners_may_share(db_session):
    """規格 §4 的表：私人＋公開、兩個人各自的私人——都可以。"""
    admin = await create_user(db_session, role=UserRole.ADMIN)
    first, second = await create_user(db_session), await create_user(db_session)
    await create_food(db_session, created_by=admin, barcode=CODE)
    await create_food(db_session, created_by=first, owner=first, barcode=CODE)
    await create_food(db_session, created_by=second, owner=second, barcode=CODE)

    count = await db_session.scalar(text("SELECT count(*) FROM foods WHERE barcode = :b"), {"b": CODE})
    assert count == 3


async def test_many_foods_without_a_barcode(db_session):
    """NULL 在唯一索引裡互不相等：既有的食物全部是 NULL。"""
    user = await create_user(db_session)
    admin = await create_user(db_session, role=UserRole.ADMIN)
    for _ in range(2):
        await create_food(db_session, created_by=user, owner=user)
        await create_food(db_session, created_by=admin)
    count = await db_session.scalar(text("SELECT count(*) FROM foods WHERE barcode IS NULL"))
    assert count >= 4
```

`tests/test_ai_analysis_model.py` 加：

```python
async def test_kind_accepts_label(db_session):
    """營養標示（掃條碼規格 D24）：'label' 5 個字，VARCHAR(7) 放得下——只有 CHECK 要換。"""
    user = await create_user(db_session)
    row = _row(user.id, kind=AnalysisKind.LABEL)

    db_session.add(row)
    await db_session.commit()
    await db_session.refresh(row)

    assert row.kind is AnalysisKind.LABEL
```

既有的 `test_kind_rejects_a_value_outside_text_or_image` 的 docstring 改成「只能是 'text'／'image'／'suggest'／'label'」；`test_the_kind_check_lists_every_kind` 不用改（它跑過每一個 `AnalysisKind`）。

Run: `./.venv/Scripts/python.exe -m pytest -q -W error tests/test_foods_barcode_model.py tests/test_ai_analysis_model.py` → Expected：FAIL（`create_food` 收不到 `barcode`／`Food` 沒有這個屬性；`AnalysisKind` 沒有 `LABEL`）。

- [ ] **Step 2：模型。** `app/models/food.py`：`Food.__table_args__` 加（`text` 已經 import）：

```python
        # 條碼（掃條碼規格 D1、D4）。存的一定是 app/barcode.py 的標準形式：8 位或 13 位數字。
        # CHECK 是第二道防線（同 ai_analyses 的 kind_valid）：不假設只有 API 會寫這一欄。NULL 照 CHECK
        # 的規則放行（handover §7）＝沒有條碼。
        CheckConstraint("barcode ~ '^([0-9]{8}|[0-9]{13})$'", name="barcode_digits"),
        # 唯一的範圍跟名稱（uq_foods_owner_id_name_brand）同一個概念，但要兩個索引：
        #   uq_foods_owner_id_barcode  私人食物：同一個人不重複。owner_id 是 NULL 的公開食物在這個
        #                              索引裡彼此不相等（一般的 NULL 語意），所以它管不到公開食物。
        #   uq_foods_global_barcode    公開食物之間不重複（部分索引）。
        # 不用 NULLS NOT DISTINCT：那會讓「沒有條碼」的 NULL 也互撞。
        # 宣告在模型裡（不是只寫在 migration）：模型才是 alembic check 的單一事實來源
        # （FoodRevision 的部分索引踩過，見那邊的註解）。
        Index("uq_foods_owner_id_barcode", "owner_id", "barcode", unique=True),
        Index(
            "uq_foods_global_barcode",
            "barcode",
            unique=True,
            postgresql_where=text("owner_id IS NULL"),
        ),
```

欄位（放在 `brand` 後面）：

```python
    # 商品條碼（掃條碼規格 §3）：8 位（EAN-8）或 13 位（EAN-13；UPC-A／UPC-E 換成這個）。NULL＝沒有。
    # **不進版本**（規格 D5）：條碼不影響任何已記的數字；私人食物擁有者改、公開食物管理員改。
    barcode: Mapped[str | None] = mapped_column(Text)
```

`app/models/ai_analysis.py`：`AnalysisKind` 加

```python
    # 營養標示照片（掃條碼規格 D24）。`input_hash` 是圖片的 SHA-256。'label' 5 個字，欄位（VARCHAR(7)，
    # 最長的仍然是 'suggest'）不用加寬；migration 0022 只換 CHECK。退版的理由同 SUGGEST。
    LABEL = "label"
```

CHECK 改成 `"kind IN ('text', 'image', 'suggest', 'label')"`，上面那段註解的第一行跟著改。

- [ ] **Step 3：migration。** `migrations/versions/0022_add_food_barcode_and_label_kind.py`：

```python
"""add foods.barcode and 'label' to ai_analyses.kind

Revision ID: 0022
Revises: 0021
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0022"
down_revision: str | None = "0021"
branch_labels: Sequence[str] | None = None
depends_on: Sequence[str] | None = None


def upgrade() -> None:
    # 掃條碼規格 §10.1。既有的食物全部是 NULL：加一個可以是空的欄位不重寫表。
    op.add_column("foods", sa.Column("barcode", sa.Text(), nullable=True))
    # 名稱傳短的：命名慣例會套成 ck_foods_barcode_digits（同 0009、0021 的說明）。
    # CHECK 的文字 alembic check 不比——tests/test_foods_barcode_model.py 用真的寫入去撞。
    op.create_check_constraint("barcode_digits", "foods", "barcode ~ '^([0-9]{8}|[0-9]{13})$'")
    op.create_index("uq_foods_owner_id_barcode", "foods", ["owner_id", "barcode"], unique=True)
    op.create_index(
        "uq_foods_global_barcode",
        "foods",
        ["barcode"],
        unique=True,
        postgresql_where=sa.text("owner_id IS NULL"),
    )
    # 'label' 5 個字：0021 已經把欄位加寬到 VARCHAR(7)，這裡只換 CHECK。
    #
    # 退版安全（不進 scripts/deploy.sh 的 ROLLBACK_UNSAFE_REVISIONS）：舊程式的 Food 沒有 barcode
    # （SELECT 只列它知道的欄位、INSERT 不帶 → NULL，CHECK 與兩個索引都放行 NULL）；舊程式從不載入
    # 別人的 ai_analyses.kind（見 app/models/ai_analysis.py 的 SUGGEST）。
    op.drop_constraint("kind_valid", "ai_analyses", type_="check")
    op.create_check_constraint(
        "kind_valid", "ai_analyses", "kind IN ('text', 'image', 'suggest', 'label')"
    )


def downgrade() -> None:
    # 營養標示的列改記成 image：列數留著（今天的額度不變），只是分不出是營養標示。
    op.execute("UPDATE ai_analyses SET kind = 'image' WHERE kind = 'label'")
    op.drop_constraint("kind_valid", "ai_analyses", type_="check")
    op.create_check_constraint(
        "kind_valid", "ai_analyses", "kind IN ('text', 'image', 'suggest')"
    )
    # 條碼的資料會不見。
    op.drop_index("uq_foods_global_barcode", table_name="foods")
    op.drop_index("uq_foods_owner_id_barcode", table_name="foods")
    op.drop_constraint("barcode_digits", "foods", type_="check")
    op.drop_column("foods", "barcode")
```

Run Step 1 的指令 → Expected：PASS（10 條新的＋既有的；conftest 每次跑 `alembic upgrade head`＋`alembic check`——`alembic check` 乾淨就是模型與 migration 對得上）。

- [ ] **Step 4：alembic 來回。** 測試資料庫：`upgrade head` → `check`（乾淨）→ 插一列 `kind='label'` 的 `ai_analyses`、一個帶條碼的食物（raw SQL）→ `downgrade -1`（回 `0021`；`label` 那一列變 `image`、列數不變；`foods` 沒有 `barcode` 欄位）→ `upgrade head` → `check` → `current` 是 `0022`。**dev 資料庫不動**（Task 11 才升）。

- [ ] **Step 5：突變。**（模型與 migration 一起改，見「執行環境」）
  1. 拿掉 `uq_foods_global_barcode`（兩邊）→ 只有 `test_two_public_foods_cannot_share_a_barcode` 紅。
  2. 拿掉 `uq_foods_owner_id_barcode`（兩邊）→ 只有 `test_one_owner_cannot_use_a_barcode_twice` 紅。
  3. `uq_foods_global_barcode` 的 `postgresql_where` 拿掉（兩邊；變成全表的條碼唯一）→ `test_private_and_public_and_other_owners_may_share` 紅。
  4. CHECK 的 `{8}` 改 `{12}`（兩邊）→ `test_eight_and_thirteen_digits_are_stored` 紅、參數 `036000291452` 那一格紅。
  5. migration 的 `kind_valid` 少 `'label'`（模型照舊；CHECK 的文字 `alembic check` 看不到）→ `test_kind_accepts_label` 與 `test_the_kind_check_lists_every_kind` 紅。

- [ ] **Step 6：檢查、commit。** 整套 `pytest -q -W error`、`ruff check .`、`mypy app`。這個 task 沒有動 routes／schemas，不用重新產生 `schema.d.ts`。

```bash
git add migrations/versions/0022_add_food_barcode_and_label_kind.py app/models/food.py \
  app/models/ai_analysis.py tests/factories.py tests/test_foods_barcode_model.py \
  tests/test_ai_analysis_model.py
```

訊息：`feat(api): 食物多條碼欄位（兩個唯一索引、CHECK）、ai_analyses.kind 多 label（migration 0022）`

---

## Task 2：後端——條碼的正規化與檢查碼（`app/barcode.py`）

**Files:**
- Create: `app/barcode.py`、`tests/test_barcode.py`

> 兩個檔案的全文都在寫計畫時跑過（「寫計畫時實測過的事」第 1 點）。照抄。

- [ ] **Step 1：寫會紅的測試。** `tests/test_barcode.py`：

```python
"""`app/barcode.py`：正規化與檢查碼（掃條碼規格 §3）。純函式。"""

import pytest

from app.barcode import (
    InvalidBarcodeError,
    expand_upc_e,
    gtin_check_digit,
    normalize_barcode,
)

# 全形空白（U+3000）。用 chr() 組：原始碼裡不放看不見或像空白的字（handover §7）。
FULL_WIDTH_SPACE = chr(0x3000)


@pytest.mark.parametrize(
    ("body", "digit"),
    [
        ("471008843209", 4),  # 規格 §3.2 算一次的那一個
        ("03600029145", 2),  # UPC-A 036000291452
        ("9638507", 4),  # EAN-8 96385074
        ("04210000526", 4),  # UPC-E 04252614 展開後
        ("000000000000", 0),
    ],
)
def test_the_gs1_check_digit(body, digit):
    assert gtin_check_digit(body) == digit


@pytest.mark.parametrize(
    ("upc_e", "upc_a"),
    [
        ("04252614", "042100005264"),  # 第 6 位 0～2
        ("01234565", "012345000065"),  # 5～9
    ],
)
def test_upc_e_expands_to_upc_a(upc_e, upc_a):
    assert expand_upc_e(upc_e) == upc_a


@pytest.mark.parametrize(
    ("upc_e", "upc_a"),
    [
        ("0ABCDE3C", "0ABC00000DEC"),
        ("0ABCDE4C", "0ABCD00000EC"),
        ("0ABCDE0C", "0AB00000CDEC"),
        ("0ABCDE1C", "0AB10000CDEC"),
        ("0ABCDE2C", "0AB20000CDEC"),
        ("0ABCDE9C", "0ABCDE00009C"),
    ],
)
def test_upc_e_expansion_follows_the_sixth_digit(upc_e, upc_a):
    """用字母標位置：每一種「第 6 位」各一條，看每一位搬到哪裡（規格 §3.3 的表）。"""
    assert expand_upc_e(upc_e) == upc_a


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("4710088432094", "4710088432094"),
        ("4 710088 43209 4", "4710088432094"),
        ("4710088-432094", "4710088432094"),
        (FULL_WIDTH_SPACE + "4710088432094" + FULL_WIDTH_SPACE, "4710088432094"),
        ("036000291452", "0036000291452"),  # UPC-A 補 0
        ("036000-291452", "0036000291452"),
        ("0036000291452", "0036000291452"),  # 同一個商品的 EAN-13 寫法
        ("04252614", "0042100005264"),  # UPC-E → UPC-A → 補 0
        ("042100005264", "0042100005264"),  # 上一列展開後
        ("96385074", "96385074"),  # EAN-8
    ],
)
def test_normalize_returns_the_standard_form(raw, expected):
    assert normalize_barcode(raw) == expected


def test_an_eight_digit_code_starting_with_zero_that_is_not_upc_e_is_ean_8():
    """0 開頭、UPC-E 的檢查碼不對、EAN-8 的對 → EAN-8（第二條路要真的走得到）。"""
    code = "07654329"
    assert gtin_check_digit(code[:-1]) == 9  # 前提：合格的 EAN-8
    upc_a = expand_upc_e(code)  # 076200005439
    assert gtin_check_digit(upc_a[:-1]) != int(upc_a[-1])  # 前提：不是合格的 UPC-E
    assert normalize_barcode(code) == code


def test_an_eight_digit_code_valid_both_ways_is_upc_e():
    """兩種檢查碼都對（寫計畫時找到的 01234565）→ 0 開頭的先當 UPC-E（規格 §3.3）。"""
    assert gtin_check_digit("0123456") == 5
    assert normalize_barcode("01234565") == "0012345000065"


@pytest.mark.parametrize(
    ("raw", "message"),
    [
        ("4710088432096", "檢查碼"),
        ("036000291453", "檢查碼"),
        ("96385075", "檢查碼"),
        ("12345", "8、12 或 13"),
        ("04210000526", "8、12 或 13"),
        ("47100884320941", "8、12 或 13"),
        ("", "只能是數字"),
        ("abc", "只能是數字"),
        ("4710088４32094", "只能是數字"),  # 混了一個全形數字
        ("4710088.432094", "只能是數字"),
    ],
)
def test_invalid_codes_are_rejected_with_a_readable_message(raw, message):
    with pytest.raises(InvalidBarcodeError, match=message):
        normalize_barcode(raw)
```

Run: `./.venv/Scripts/python.exe -m pytest -q -W error tests/test_barcode.py` → Expected：FAIL（`ModuleNotFoundError: app.barcode`）。

- [ ] **Step 2：實作。** `app/barcode.py`：

```python
"""商品條碼的正規化與檢查碼（掃條碼規格 §3）。純函式，不碰資料庫。

存進 `foods.barcode` 的、拿去查的、送給 Open Food Facts 的，一律是 `normalize_barcode()` 的輸出：
8 位（EAN-8）或 13 位（EAN-13；UPC-A 與 UPC-E 都換成這個）。同一個商品掃成 UPC-A 或 EAN-13、
手打 UPC-E 或展開後的 UPC-A，都會是同一個字串——不然查不到自己建過的那一筆。

**檢查碼只在這裡驗**（規格 D3）：前端只去分隔符號、看長度。
"""

import re

# 空白（含全形空白，`\s` 認 Unicode 的空白）與「-」。
_SEPARATORS = re.compile(r"[\s\-]+")
# 只收 ASCII 數字：`str.isdigit()` 也認全形數字與上標，那些不是條碼。
_DIGITS = re.compile(r"[0-9]+")


class InvalidBarcodeError(ValueError):
    """不是 EAN-13／EAN-8／UPC-A／UPC-E，或檢查碼不對。訊息直接給人看（422 的欄位錯誤）。"""


def gtin_check_digit(body: str) -> int:
    """GS1 的 mod-10：不含檢查碼的那幾位，**從右邊數**，第 1、3、5…位 ×3，其餘 ×1；
    檢查碼＝(10 − 總和 mod 10) mod 10。EAN-13、EAN-8、UPC-A 都是這一條。

    `body` 只能是 ASCII 數字（呼叫端驗過）。`"471008843209"` → 4。
    """
    total = 0
    for index, char in enumerate(reversed(body)):
        digit = ord(char) - 48
        total += digit * 3 if index % 2 == 0 else digit
    return (10 - total % 10) % 10


def _has_valid_check_digit(code: str) -> bool:
    return gtin_check_digit(code[:-1]) == ord(code[-1]) - 48


def expand_upc_e(code: str) -> str:
    """8 位的 UPC-E（數字系統＋6 位＋檢查碼）→ 12 位的 UPC-A。不驗檢查碼。

    看第 6 位（`d[5]`）：0～2 → 製造商 `d0 d1 d[5] 0 0`、商品 `0 0 d2 d3 d4`；3 → `d0 d1 d2 0 0`、
    `0 0 0 d3 d4`；4 → `d0 d1 d2 d3 0`、`0 0 0 0 d4`；5～9 → `d0 d1 d2 d3 d4`、`0 0 0 0 d[5]`。
    `"04252614"` → `"042100005264"`。
    """
    system, d, check = code[0], code[1:7], code[7]
    last = d[5]
    if last in "012":
        body = d[0:2] + last + "0000" + d[2:5]
    elif last == "3":
        body = d[0:3] + "00000" + d[3:5]
    elif last == "4":
        body = d[0:4] + "00000" + d[4]
    else:
        body = d[0:5] + "0000" + last
    return system + body + check


def normalize_barcode(raw: str) -> str:
    """去掉空白與「-」、驗檢查碼，回標準形式（規格 §3.2）：

    - 13 位：EAN-13，原樣。
    - 12 位：UPC-A，前面補 0 成 13 位（UPC-A 就是第一位是 0 的 EAN-13）。
    - 8 位、0 開頭：先當 UPC-E（展開成 UPC-A、驗它的檢查碼、補 0 成 13 位）；不合格才當 EAN-8。
    - 其餘 8 位：EAN-8，原樣。

    同樣 8 位永遠得到同樣的結果——掃描器回報 `upc_e` 或 `ean_8`、手動輸入，存的跟查的一定一致。
    不合格丟 `InvalidBarcodeError`。
    """
    code = _SEPARATORS.sub("", raw)
    if not _DIGITS.fullmatch(code):
        raise InvalidBarcodeError("條碼只能是數字")
    if len(code) == 13:
        if _has_valid_check_digit(code):
            return code
    elif len(code) == 12:
        if _has_valid_check_digit(code):
            return "0" + code
    elif len(code) == 8:
        if code[0] == "0":
            upc_a = expand_upc_e(code)
            if _has_valid_check_digit(upc_a):
                return "0" + upc_a
        if _has_valid_check_digit(code):
            return code
    else:
        raise InvalidBarcodeError("條碼要是 8、12 或 13 位數字")
    raise InvalidBarcodeError("條碼的檢查碼不對，請再確認一次")
```

Run Step 1 的指令 → Expected：PASS（35 條；寫計畫時量的是補 `0ABCDE2C` 之前的 34 條）。

- [ ] **Step 3：突變。**
  1. `gtin_check_digit` 的權重對調（`digit * 3 if index % 2 == 1 else digit`）→ `test_the_gs1_check_digit` 大部分紅、正規化的合格碼紅。
  2. 12 位不補 0（`return code`）→ `036000291452` 那幾格紅。
  3. 8 位拿掉 UPC-E 那一段 → `04252614`、`test_an_eight_digit_code_valid_both_ways_is_upc_e` 紅。
  4. UPC-E 那一段沒有「不合格才當 EAN-8」的退路（UPC-E 不合格直接丟錯）→ `test_an_eight_digit_code_starting_with_zero_that_is_not_upc_e_is_ean_8` 紅。
  5. `if last in "012"` 改 `"01"` → `0ABCDE2C` 那一格紅。
  6. `_SEPARATORS` 改成只去 ASCII 空白（`[ \-]+`）→ 全形空白那一格紅。
  7. `_DIGITS` 改成 `\d+` → 混了全形數字那一格紅（`\d` 認 Unicode 數字）。

- [ ] **Step 4：檢查、commit。** `pytest -q -W error tests/test_barcode.py`、`ruff check .`、`mypy app`（整套留給 Task 3）。

```bash
git add app/barcode.py tests/test_barcode.py
```

訊息：`feat(api): 條碼的正規化與 GS1 檢查碼（UPC-A／UPC-E 換成 EAN-13）`

---
