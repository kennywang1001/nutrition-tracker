# 營養素配餐（今天還能吃什麼）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 算出今天還剩多少熱量與三大營養素，給兩種建議：從自己常吃的食物配（確定性的解題器、免費）與請 AI 配一餐（算一次 AI 額度）；兩種都只把項目帶進記一餐，由使用者確認、選餐別、按「記錄」。

**Architecture:** 後端：`/stats/daily` 的「那一天的實際、目標、運動、額度」抽成 `app/day_budget.py`（兩個功能共用）；剩下的額度與解題器是 `app/planner.py` 的純函式（整數「分」運算、整數分數）；候選與預設份量在 `app/planner_data.py`；`GET /api/planner/library-suggestions`（新的 `routes/planner.py`）。AI：`app/ai/estimator.py` 多配餐的提示詞與解析（輸出 schema 沿用多樣估算），兩家 estimator 多 `suggest_meal`，`POST /api/ai/suggest-meal` 在 `routes/ai.py`；`ai_analyses.kind` 多 `suggest`（migration `0021`）。前端：`/planner` 畫面、飲食頁一張卡片、記一餐用 router state 收「配餐的項目」、`AiMealPanel` 多「讓 AI 配一餐」。

**Tech Stack:** FastAPI · SQLAlchemy 2 async · Alembic · PostgreSQL 16 · Anthropic／Gemini SDK · React 19 · TypeScript strict · TanStack Query v5 · react-router 8 · CSS Modules · Vitest · Playwright · Biome

**依據規格：** `docs/superpowers/specs/2026-10-15-meal-planner-design.md`（以下稱「規格」；D1…D27 指它的 §2）

---

## 執行環境

- 分支 `feat/meal-planner`（已建立，**不要 push**）。`S=C:/Users/user/AppData/Local/Temp/claude/f--wallet/e7b60c93-fbd5-4a61-9c85-74550ff7244b/scratchpad`。
- 後端在 repo 根目錄（Git Bash）：
  - `./.venv/Scripts/python.exe -m pytest -q -W error`（整套約 5 分鐘，timeout 給 10 分鐘；**同一時間只跑一個 pytest**——測試資料庫每次砍掉重建）。需要 dev 的 Postgres：`docker compose up -d`（`localhost:5433`）。**絕對不要跑 `down -v`。**
  - `./.venv/Scripts/python.exe -m ruff check .`、`./.venv/Scripts/python.exe -m mypy app`——**不要接管線**（`| tail` 吃掉退出碼）。**不要跑 `ruff format`**。行寬 100。
  - `alembic check` 指向測試資料庫：`DATABASE_URL="postgresql+asyncpg://wallet:wallet@localhost:5433/wallet_test" ./.venv/Scripts/python.exe -m alembic check`
- 前端在 `frontend/`：`npx vitest run tests/xxx`、`npm run -s test`、`npm run -s typecheck`、`npm run -s lint`（格式 `npx biome check --write <檔案>`）。**三個分開跑**；驗證時一起 grep `FAIL` 與 `Unhandled`（handover §7）。typecheck 在每次 commit 之前單獨跑，跟 `git commit` 用 `&&` 串。
- e2e：`docker compose up -d --build api` → `docker compose exec -T api python -m alembic upgrade head` → `docker compose exec -T api python -m alembic current`（`0021`）→ 在 `frontend/` 跑 `npx playwright test …`。
- **`schema.d.ts` 重新產生**——動到 `app/api/routes` 或 `app/schemas` 的每一個 commit（docstring 也算）：

  ```bash
  S=C:/Users/user/AppData/Local/Temp/claude/f--wallet/e7b60c93-fbd5-4a61-9c85-74550ff7244b/scratchpad
  PYTHONUTF8=1 PYTHONIOENCODING=utf-8 ./.venv/Scripts/python.exe -c "import json; from app.main import app; print(json.dumps(app.openapi(), ensure_ascii=False))" > "$S/openapi.tmp.json"; (cd frontend && npx openapi-typescript "$S/openapi.tmp.json" -o src/api/schema.d.ts)
  rm "$S/openapi.tmp.json"
  ```

  產生之後 `cd frontend && npm run -s typecheck`。
- **突變**：改一行、看指定的測試紅、改回、重跑綠。**改回之前先存原始位元組**（`cp app/x.py "$S/mp-x.py.bak"`；新檔案 `git checkout --` 救不回來），改回之後 `cmp` 比對；`.py` 改回之後 `touch` 並刪掉對應的 `__pycache__/*.pyc`（pyc 用秒比 mtime）。每一批突變之後跑 `git diff`／`git status`。突變小工具一律用 Write 工具寫成檔案（`$S/mp-mutate.py`），跑 pytest 前設 `PYTHONIOENCODING=utf-8`。**有 uncommitted 的想要的改動時，絕對不要對那個檔案 `git checkout`。** vitest 的突變要改成型別過得去的樣子（被 `TypeCheckError` 殺掉的不算，handover「AI 多樣估算」）。
- **Commit**：中文 conventional commit。訊息用 Write 工具寫到 `$S/plan-<task>-msg.txt`（每次不同檔名），最後一行 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`，`git commit -F`。**明確列出要 add 的檔案；絕對不要 stage `lunch.jpg`**（不要 `git add -A`／`.`）。不要 amend。回應（`response_model`）一律在 commit 之前組好（身體資料審查 M6）——這份計畫只有 suggest-meal 會 commit，照 `analyze_meal` 的順序。
- **看不見的字元**：Write／Edit 工具會把「反斜線 u＋四位十六進位」解成真的字元；Bash heredoc 會吃掉一層反斜線。腳本一律用 Write 工具寫成檔案。每個 task commit 前（`$S/plan-scan.py` 已經在 scratchpad：掃 Cc〔Tab、LF 除外〕、Cf、Zl、Zp、BOM，找到就 `exit 1`）：

  ```bash
  ./.venv/Scripts/python.exe -I "$S/plan-scan.py" $(git diff --cached --name-only) && git commit -F "$S/plan-<task>-msg.txt"
  ```

## 開工前必讀

1. 「Expected: FAIL」沒有如預期失敗 → 停下來回報。新模組還不存在時紅的是 import，不是斷言——斷言的咬合力由每個 task 的突變步驟證明（handover §6 規矩 1、8）。
2. 引用的程式碼對不上現況 → 以現況為準並回報，記進「執行中發現的差異」。
3. **「今天」一律 monkeypatch**：`app.api.routes.planner.today_in_timezone`（Task 3）。**`app.api.routes.ai` 的不要 patch**——同一個函式也決定 AI 額度數哪一天，patch 成固定日期，`_seed_analyses` 寫的列（`created_at` 是真的現在）就不算在「今天」裡，額度的測試全部失準。所以 suggest-meal 的測試只用「沒有餐」或「現在吃的一餐」（跨午夜的那一秒可能誤判，寫進已知限制）。planner 測試的使用者時區設 `America/New_York`。
4. `client` 夾具跟測試共用一個 session、外層一個交易（handover §6 第 14 種）：`now()` 整條測試同一個值；`rollback()` 之後 ORM 物件過期——要用的 id 先存成區域變數。
5. **「看不到」的測試先在同一條測試裡看得到一次**（自己的食物當候選、別人的不是）。只斷言「沒有」的測試，路徑打錯也會綠。
6. 前端 `tests/helpers/mock-api.ts` 用 `url.includes(path)` **依序**比對：`/api/ai/suggest-meal` 與 `/api/ai/analyze-meal` 互不包含，但 `/api/foods/7` 會被 `/api/foods` 吃掉——更具體的排前面。畫出飲食頁的測試要準備 `exerciseRoutes()`（既有）。
7. 前端**不算今天**、不做營養素的加減乘除；顯示用 `lib/decimal.ts` 的 `formatMacro`。`quantity` 是後端給的字串，原樣放進記一餐的輸入框。
8. 離線快取的舊資料可能少欄位；`["planner", …]` **不進**離線快取（D25），所以不用相容舊形狀。
9. Playwright 的名稱一律 `exact: true`；登入之後**只用點擊換頁**；換頁後先等頁面獨有的元素；只量有界的一組元素的觸控高度。Playwright 不做型別檢查——加了 spec 之後 `npm run -s typecheck`。
10. 給 LLM 的 Pydantic 類別不寫 docstring（`transform_schema()` 會送給模型）；這份計畫沒有新的 LLM schema 類別（沿用 `LLMMealEstimateSchema`）。

## 寫計畫時實測過的事（沒有整份試跑）

這份計畫**沒有**整份跑過。「Expected: PASS」的條數是照測試清單數的，不是量的；對不上照實回報。

1. **解題器（Task 2 的 `app/planner.py` 全文）**在 scratchpad 原樣跑過（`$S/plan_planner_draft.py`、`plan_harness.py`、`plan_expect.py`）：`ruff check`（repo 的設定）與 `mypy`（repo 的設定）都乾淨；Task 2 測試裡的每一組期望值都是它算出來的；30 個候選的時間 1～17 ms（規格 §4.5）；2 萬組隨機值的 `_scaled` 跟 `app/nutrition.py` 的 `scale()` 完全相同。
2. **`Select.where()` 接在 `.limit()` 後面**：SQLAlchemy 編出來的 SQL 是 `WHERE … GROUP BY … ORDER BY … LIMIT`（條件在 LIMIT 之前）——Task 3 給 `my_recorded_foods_stmt` 加 `require_nutrition` 時可以直接接在既有的 statement 後面。
3. **第一版原型的教訓**（規格 §4.5 最後一段）：沒有 D6（多一樣的代價）與 D11（多樣性）時，前三組是「燕麥 100 g ＋ 板豆腐 25 g ＋ 鮪魚罐頭 125 g」這種；Task 2 的突變會把這兩條各拿掉一次，看指定的測試紅。
4. **寫檔工具會把跳脫的 BOM 寫成真的 BOM**——`$S/plan-scan.py` 第一次寫出來就中了（第 12 行），用腳本換回跳脫寫法才修好。動到任何含跳脫字元的檔案，commit 前掃一次。

## 檔案結構

| 檔案 | Task | 內容 |
|---|---|---|
| `app/day_budget.py`（新）、`app/api/routes/stats.py` | 1 | `DayBudget`、`target_on`、`load_day_budget`；`/stats/daily` 改用它 |
| `tests/test_day_budget.py`（新） | 1 | |
| `app/planner.py`（新）、`tests/test_planner_solver.py`（新） | 2 | `Remaining`、`remaining_for`、`is_full`、`Candidate`、`Choice`、`Combo`、`suggest_combos` |
| `app/api/routes/foods.py` | 3 | `_my_recorded_foods_stmt` → 公開的 `my_recorded_foods_stmt(…, require_nutrition=False)` |
| `app/planner_data.py`（新）、`app/schemas/planner.py`（新）、`app/api/routes/planner.py`（新）、`app/main.py` | 3 | 候選、預設份量、`remaining_of`；回應；端點 |
| `tests/test_planner.py`（新）、`tests/test_planner_privacy.py`（新） | 3 | 端點；不寫 log、好友與社群的模組碰不到 |
| `app/models/ai_analysis.py`、`migrations/versions/0021_add_suggest_analysis_kind.py`（新）、`tests/test_ai_analysis_model.py` | 4 | `AnalysisKind.SUGGEST`、CHECK 三個值 |
| `app/ai/estimator.py`、`app/ai/anthropic_estimator.py`、`app/ai/gemini_estimator.py` | 5 | 提示詞、`suggestion_request`、`parse_raw_meal_suggestion`、`suggest_meal` |
| `tests/test_ai_estimator.py`、`tests/test_ai_provider_errors.py` | 5 | |
| `app/schemas/ai.py`、`app/api/routes/ai.py`、`tests/test_ai_suggest_meal.py`（新） | 6 | `SuggestMealRequest`、`suggest_meal` 端點 |
| `frontend/src/api/schema.d.ts` | 1、3、6 | 每個動到 routes／schemas 的 task 重新產生 |
| `frontend/src/api/{planner.ts（新）,ai.ts,queries.ts,persist.ts}`、`src/lib/planner.ts`（新） | 7 | API 層、交接的型別與解析 |
| `frontend/tests/{planner-api.test.tsx,planner-lib.test.ts}`（新）、`ai-api.test.ts`、`offline.test.tsx` | 7 | |
| `frontend/src/screens/Planner.{tsx,module.css}`（新）、`src/components/PlannerCard.{tsx,module.css}`（新）、`src/screens/Today.tsx`、`src/App.tsx` | 8 | `/planner`、飲食頁卡片、路由 |
| `frontend/tests/{planner.test.tsx,planner-card.test.tsx}`（新）、`today.test.tsx`、`app.test.tsx` | 8 | |
| `frontend/src/App.tsx`（`LogMealRoute`）、`src/screens/LogMeal.{tsx,module.css}` | 9 | 交接、「配餐的項目」 |
| `frontend/tests/log-meal-planner.test.tsx`（新） | 9 | |
| `frontend/src/components/AiMealPanel.{tsx,module.css}` | 10 | 「讓 AI 配一餐」 |
| `frontend/tests/ai-meal-panel.test.tsx`、`log-meal-ai.test.tsx` | 10 | |
| `frontend/e2e/planner.spec.ts`（新） | 11 | 兩條 |
| `docs/handover.md`、`docs/deployment.md`、規格的狀態、這份計畫 | 12 | |

---

## Task 1：後端——`load_day_budget` 抽出來、`/stats/daily` 改用它

**Files:**
- Create: `app/day_budget.py`、`tests/test_day_budget.py`
- Modify: `app/api/routes/stats.py`、`frontend/src/api/schema.d.ts`（只有 docstring 變了才會變；照樣重新產生）

- [ ] **Step 0：基準線。** 跑一次整套後端與前端，記下條數（handover §2：後端 1757；前端 `Test Files 178`、`Tests 2574`）。對不上照實記進「執行中發現的差異」。

- [ ] **Step 1：寫會紅的測試。** `tests/test_day_budget.py`：

```python
"""`load_day_budget`（營養素配餐規格 D1）：某一天的實際、生效的目標、運動、熱量額度。
`/stats/daily` 與營養素配餐共用它；端點的行為由 tests/test_stats_daily.py 守著。"""

from datetime import UTC, date, datetime
from decimal import Decimal

from app.day_budget import load_day_budget, target_on
from app.models.food import FoodRevision
from tests.factories import (
    create_exercise,
    create_food,
    create_intake,
    create_meal,
    create_supplement,
    create_target,
    create_user,
)

DAY = date(2026, 10, 14)
# 紐約 10/14 12:00（EDT）。
NOON = datetime(2026, 10, 14, 16, 0, tzinfo=UTC)


async def _new_yorker(db_session):
    user = await create_user(db_session)
    user.timezone = "America/New_York"
    await db_session.commit()
    return user


async def test_the_budget_adds_the_days_exercise_and_actual_includes_supplements(db_session):
    user = await _new_yorker(db_session)
    await create_target(db_session, user=user, kcal=2000, protein_g=90)
    food = await create_food(db_session, created_by=user, kcal=200, protein_g=10, fat_g=5, carb_g=20)
    revision = await db_session.get(FoodRevision, food.current_revision_id)
    await create_meal(db_session, user=user, eaten_at=NOON, items=[(revision, Decimal("150"))])
    supplement = await create_supplement(db_session, created_by=user, owner=user)
    await create_intake(db_session, user=user, supplement=supplement, taken_at=NOON, kcal=20)
    await create_exercise(db_session, user=user, performed_at=NOON, kcal=343)

    budget = await load_day_budget(
        db_session, user_id=user.id, tz_name="America/New_York", adds_exercise=True, day=DAY
    )

    assert budget.macros.actual.kcal == Decimal("320.00")  # 300 食物 + 20 補劑
    assert budget.target is not None and budget.target.protein_g == Decimal("90.00")
    assert budget.exercise_kcal == Decimal("343.00")
    assert budget.kcal_budget == Decimal("2343.00")


async def test_with_the_setting_off_the_budget_is_the_target(db_session):
    user = await _new_yorker(db_session)
    await create_target(db_session, user=user, kcal=2000)
    await create_exercise(db_session, user=user, performed_at=NOON, kcal=343)

    budget = await load_day_budget(
        db_session, user_id=user.id, tz_name="America/New_York", adds_exercise=False, day=DAY
    )

    assert budget.exercise_kcal == Decimal("343.00")
    assert budget.kcal_budget == Decimal("2000.00")


async def test_without_a_target_there_is_no_budget(db_session):
    user = await _new_yorker(db_session)
    await create_exercise(db_session, user=user, performed_at=NOON, kcal=343)

    budget = await load_day_budget(
        db_session, user_id=user.id, tz_name="America/New_York", adds_exercise=True, day=DAY
    )

    assert budget.target is None
    assert budget.kcal_budget is None


async def test_the_target_is_the_one_in_effect_that_day(db_session):
    """半開區間：effective_to 那一天已經是下一筆。"""
    user = await create_user(db_session)
    await create_target(
        db_session, user=user, kcal=1800,
        effective_from=date(2026, 1, 1), effective_to=DAY,
    )  # fmt: skip
    await create_target(db_session, user=user, kcal=2200, effective_from=DAY)

    on_the_day = await target_on(db_session, user.id, DAY)
    the_day_before = await target_on(db_session, user.id, date(2026, 10, 13))

    assert on_the_day is not None and on_the_day.kcal == Decimal("2200.00")
    assert the_day_before is not None and the_day_before.kcal == Decimal("1800.00")


async def test_another_users_data_is_not_counted(db_session):
    me = await create_user(db_session)
    other = await create_user(db_session)
    await create_target(db_session, user=other, kcal=2000)
    await create_exercise(db_session, user=other, performed_at=NOON, kcal=343)

    budget = await load_day_budget(
        db_session, user_id=me.id, tz_name="Asia/Taipei", adds_exercise=True, day=DAY
    )

    assert budget.target is None
    assert budget.exercise_kcal == Decimal("0.00")
```

（`create_target` 的 `effective_from` 預設是 2026-01-01；`create_intake` 的參數照 `tests/factories.py` 現況——對不上以現況為準。）

Run: `./.venv/Scripts/python.exe -m pytest -q -W error tests/test_day_budget.py` → Expected：FAIL（`ModuleNotFoundError: app.day_budget`）。

- [ ] **Step 2：`app/day_budget.py`。**

```python
"""某一天的「吃了多少、生效的目標、運動、熱量額度」（營養素配餐規格 D1）。

`GET /api/stats/daily` 與營養素配餐（`/api/planner/...`、`/api/ai/suggest-meal`）共用：
「額度」只有這一份定義（運動規格 D15）。查詢固定 4 次：食物、補劑（`daily_macros`）、
目標、運動的 SUM——跟筆數無關（tests/test_stats_daily.py 數著）。

只用呼叫端給的 user_id。健康相關：這個模組不寫 log（tests/test_planner_privacy.py 掃）。
"""

from dataclasses import dataclass
from datetime import date
from decimal import Decimal

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.exercise import kcal_budget
from app.exercise_data import exercise_kcal_on
from app.models.target import UserTarget
from app.stats import DayMacros, daily_macros


@dataclass(frozen=True)
class DayBudget:
    macros: DayMacros
    target: UserTarget | None
    exercise_kcal: Decimal
    # 沒有目標、或目標沒設熱量：None（「沒有目標」不會變成「額度＝運動」，運動 D15）。
    kcal_budget: Decimal | None


async def target_on(db: AsyncSession, user_id: int, day: date) -> UserTarget | None:
    """那一天生效的目標：effective_from <= day < effective_to（NULL＝無窮遠）。
    跟 `GET /api/targets?date=` 同一條規則，兩處不能有一處用 <=。"""
    target: UserTarget | None = await db.scalar(
        select(UserTarget).where(
            UserTarget.user_id == user_id,
            UserTarget.effective_from <= day,
            or_(UserTarget.effective_to.is_(None), UserTarget.effective_to > day),
        )
    )
    return target


async def load_day_budget(
    db: AsyncSession, *, user_id: int, tz_name: str, adds_exercise: bool, day: date
) -> DayBudget:
    macros = await daily_macros(db, user_id=user_id, tz_name=tz_name, day=day)
    target = await target_on(db, user_id, day)
    exercise = await exercise_kcal_on(db, user_id=user_id, tz_name=tz_name, day=day)
    target_kcal = target.kcal if target is not None else None
    return DayBudget(
        macros=macros,
        target=target,
        exercise_kcal=exercise,
        kcal_budget=kcal_budget(target_kcal, exercise, adds_exercise),
    )
```

Run Step 1 的指令 → Expected：PASS（5）。

- [ ] **Step 3：`/stats/daily` 改用它。** `app/api/routes/stats.py` 的 `get_daily_stats`：把「`daily_macros` → 目標查詢 → `exercise_kcal_on` → `kcal_budget`」換成一次 `load_day_budget`，target／ratio 用檔案裡既有的 `_target_and_ratio`（`/stats/range` 已經在用，語意相同）：

```python
    user_id, tz_name = user.id, user.timezone
    adds_exercise = user.exercise_adds_to_budget
    day = date or today_in_timezone(tz_name)

    budget = await load_day_budget(
        db, user_id=user_id, tz_name=tz_name, adds_exercise=adds_exercise, day=day
    )
    actual = budget.macros.actual
    target_response, ratio_response = _target_and_ratio(actual, budget.target)

    return DailyStatsResponse(
        date=day,
        actual=_macros_response(actual),
        target=target_response,
        ratio=ratio_response,
        breakdown=BreakdownResponse(
            food=_macros_response(budget.macros.food),
            supplement=_macros_response(budget.macros.supplement),
        ),
        exercise_kcal=budget.exercise_kcal,
        exercise_adds_to_budget=adds_exercise,
        kcal_budget=budget.kcal_budget,
    )
```

docstring 的最後一段改成「熱量額度…（D15、D16、D17）；那一天的四個數字由 `app/day_budget.py` 的 `load_day_budget` 讀（營養素配餐共用）」，其餘不動。拿掉不再用到的 import（`kcal_budget`、`exercise_kcal_on`、`daily_macros`——`ruff` 會指出來；`UserTarget`、`or_`、`select` `/stats/range` 還在用）。

Run：`./.venv/Scripts/python.exe -m pytest -q -W error tests/test_stats_daily.py tests/test_stats_range.py tests/test_day_budget.py` → Expected：PASS（`test_daily_stats_query_count_does_not_scale_with_item_count` 仍然是 4）。`tests/test_stats_range.py` 不存在就用 `ls tests | grep stats` 找到的那幾個。

- [ ] **Step 4：突變。**
  1. `target_on` 的 `effective_to > day` 改 `>=` → `test_the_target_is_the_one_in_effect_that_day` 紅。
  2. `load_day_budget` 傳 `True` 取代 `adds_exercise` → `test_with_the_setting_off_the_budget_is_the_target` 紅（`test_stats_daily.py` 的設定關那條也紅）。
  3. `target_on` 拿掉 `UserTarget.user_id == user_id` → `test_another_users_data_is_not_counted` 紅。
  4. `get_daily_stats` 的 `ratio` 改成用 `budget.kcal_budget` 當熱量的分母 → `test_stats_daily.py` 有一條紅（運動 D16：ratio 仍是實際／目標）；存活就照實記下來、說明是誰在守。

- [ ] **Step 5：檢查、schema、commit。** 整套 `pytest -q -W error`、`ruff check .`、`mypy app`；照「執行環境」重新產生 `schema.d.ts`（docstring 變了）→ `cd frontend && npm run -s typecheck`。

```bash
git add app/day_budget.py app/api/routes/stats.py tests/test_day_budget.py frontend/src/api/schema.d.ts
```

訊息：`refactor(api): 那一天的實際、目標、運動與熱量額度抽成 load_day_budget（營養素配餐共用）`

---

## Task 2：後端——剩下的額度與解題器（`app/planner.py`，純函式）

**Files:**
- Create: `app/planner.py`、`tests/test_planner_solver.py`

- [ ] **Step 1：寫會紅的測試。** `tests/test_planner_solver.py`。期望值全部是寫計畫時用 Step 2 的程式碼算出來的（「寫計畫時實測過的事」第 1 點）：

```python
"""剩下的額度與「從食物庫配」的解題器（營養素配餐規格 §3、§4）。純函式，不碰資料庫。"""

import random
import time
from decimal import Decimal
from types import SimpleNamespace

import pytest

from app import planner
from app.nutrition import Macros, scale
from app.planner import (
    Candidate,
    Remaining,
    is_full,
    remaining_for,
    suggest_combos,
)


def _m(kcal: str, protein: str = "0", fat: str = "0", carb: str = "0") -> Macros:
    return Macros(Decimal(kcal), Decimal(protein), Decimal(fat), Decimal(carb))


def _c(kcal: str, protein: str, fat: str, carb: str, portion: str | None = None) -> Candidate:
    return Candidate(
        per_100=_m(kcal, protein, fat, carb),
        portion_grams=None if portion is None else Decimal(portion),
    )


def _kcal_only(kcal: str) -> Remaining:
    return Remaining(kcal=Decimal(kcal), protein_g=None, fat_g=None, carb_g=None)


def _summary(combos) -> list[list[tuple[int, str, str]]]:
    """每一組：(第幾個候選, 量, quantity_g)。"""
    return [
        [(c.candidate, str(c.quantity), str(c.quantity_g)) for c in combo.choices]
        for combo in combos
    ]


# 規格 §4.5 的八樣（每 100 g／ml；有份量的是預設份量的 g）。
EIGHT = [
    _c("183", "3.1", "0.3", "41", "200"),  # 0 白飯 1 碗
    _c("210", "20", "13", "3", "150"),  # 1 滷雞腿 1 隻
    _c("140", "12.5", "9.5", "1.5", "55"),  # 2 茶葉蛋 1 顆
    _c("35", "3.6", "1.9", "0.7", "450"),  # 3 無糖豆漿 1 杯
    _c("380", "13", "7", "66"),  # 4 燕麥
    _c("180", "24", "9", "0"),  # 5 鮪魚罐頭
    _c("80", "8", "4.5", "2"),  # 6 板豆腐
    _c("25", "1.5", "0.3", "4"),  # 7 燙青菜
]
DINNER = Remaining(
    kcal=Decimal("650.00"),
    protein_g=Decimal("45.00"),
    fat_g=Decimal("20.00"),
    carb_g=Decimal("70.00"),
)


# ── 剩下的額度（規格 §3） ─────────────────────────────────────────────────────


def test_remaining_subtracts_what_was_eaten_and_never_goes_below_zero():
    remaining = remaining_for(
        kcal_budget=Decimal("2000.00"),
        protein_target=Decimal("90.00"),
        fat_target=Decimal("60.00"),
        carb_target=None,
        actual=_m("1500", "100", "30", "120"),
    )
    assert remaining == Remaining(
        kcal=Decimal("500.00"),
        protein_g=Decimal("0.00"),  # 超過了：夾在 0，仍然「考慮」
        fat_g=Decimal("30.00"),
        carb_g=None,  # 沒設目標：不考慮
    )


def test_kcal_over_the_budget_is_zero():
    remaining = remaining_for(
        kcal_budget=Decimal("1000.00"),
        protein_target=None,
        fat_target=None,
        carb_target=None,
        actual=_m("1200.50"),
    )
    assert remaining is not None and remaining.kcal == Decimal("0.00")


def test_no_kcal_budget_means_nothing_to_plan():
    assert (
        remaining_for(
            kcal_budget=None,
            protein_target=Decimal("90"),
            fat_target=None,
            carb_target=None,
            actual=_m("0"),
        )
        is None
    )


def test_a_macro_target_of_zero_is_not_considered():
    """規格 D2：0 跟沒設一樣（同 /stats/daily 的 ratio）。"""
    remaining = remaining_for(
        kcal_budget=Decimal("2000"),
        protein_target=Decimal("0"),
        fat_target=Decimal("0.00"),
        carb_target=Decimal("250"),
        actual=_m("0"),
    )
    assert remaining is not None
    assert (remaining.protein_g, remaining.fat_g) == (None, None)
    assert remaining.carb_g == Decimal("250.00")


def test_full_is_below_fifty_kcal():
    assert is_full(_kcal_only("49.99"))
    assert not is_full(_kcal_only("50.00"))
    assert suggest_combos(EIGHT, _kcal_only("49.99")) == []


# ── 每一樣的數字跟 scale() 一樣（規格 D10） ─────────────────────────────────


def test_integer_scaling_matches_nutrition_scale():
    rng = random.Random(20261015)
    for _ in range(2000):
        per_100 = Decimal(rng.randint(0, 99_999_999)) / 100
        grams = Decimal(rng.randint(1, 999_999)) / 100
        revision = SimpleNamespace(kcal=per_100, protein_g=per_100, fat_g=per_100, carb_g=per_100)
        expected = scale(revision, grams).kcal
        got = planner._from_cents(planner._scaled(planner._cents(per_100), planner._cents(grams)))
        assert got == expected, (per_100, grams)


# ── 量的步進（規格 D8）與硬限制（D7） ──────────────────────────────────────


def test_a_food_with_a_default_portion_steps_by_half_servings():
    rice = [_c("180", "3", "0.5", "40", "200")]
    one = suggest_combos(rice, _kcal_only("360"))[0].choices[0]
    half = suggest_combos(rice, _kcal_only("180"))[0].choices[0]
    assert (one.quantity, one.quantity_g, one.macros.kcal) == (
        Decimal(1), Decimal("200.00"), Decimal("360.00"),
    )  # fmt: skip
    assert (half.quantity, half.quantity_g) == (Decimal("0.5"), Decimal("100.00"))
    assert str(half.quantity) == "0.5"  # 送進記一餐的字串


def test_a_food_without_a_portion_steps_by_25_up_to_400():
    plain = [_c("100", "0", "0", "0")]
    assert suggest_combos(plain, _kcal_only("275"))[0].choices[0].quantity == Decimal(275)
    assert suggest_combos(plain, _kcal_only("1000"))[0].choices[0].quantity == Decimal(400)


def test_the_kcal_cap_is_105_percent_inclusive():
    # 25 g × 420/100 = 105.00：剛好等於 100 × 1.05，放行；424 → 106.00，擋下。
    assert _summary(suggest_combos([_c("420", "0", "0", "0")], _kcal_only("100"))) == [
        [(0, "25", "25.00")]
    ]
    assert suggest_combos([_c("424", "0", "0", "0")], _kcal_only("100")) == []


def test_every_combo_stays_under_the_cap():
    for combo in suggest_combos(EIGHT, DINNER):
        assert combo.total.kcal <= DINNER.kcal * Decimal("1.05")


# ── 目標函數（D5）：只考慮熱量時、蛋白質已經超標時 ───────────────────────────


def test_with_only_kcal_considered_protein_does_not_matter():
    """兩個都剛好 300 kcal：只看熱量時平手，候選順序決定（高蛋白在前）。"""
    foods = [_c("100", "50", "0", "0"), _c("100", "0", "0", "0")]
    assert _summary(suggest_combos(foods, _kcal_only("300")))[:2] == [
        [(0, "300", "300.00")],
        [(1, "300", "300.00")],
    ]


def test_protein_already_met_pushes_protein_away():
    """蛋白質剩 0（仍然考慮，分母 10 g）：沒有蛋白質的那個贏。"""
    foods = [_c("100", "50", "0", "0"), _c("100", "0", "0", "0")]
    remaining = Remaining(kcal=Decimal("300"), protein_g=Decimal("0"), fat_g=None, carb_g=None)
    assert _summary(suggest_combos(foods, remaining))[0] == [(1, "300", "300.00")]


# ── 規格 §4.5 的八樣：完整輸出（D6、D9、D11 一起） ──────────────────────────


def test_the_eight_foods_dinner():
    combos = suggest_combos(EIGHT, DINNER)
    assert _summary(combos) == [
        [(4, "100", "100.00"), (5, "150", "150.00")],  # 燕麥 ＋ 鮪魚罐頭
        [(4, "100", "100.00"), (6, "350", "350.00")],  # 燕麥 ＋ 板豆腐
        [(0, "1", "200.00"), (5, "175", "175.00")],  # 白飯 1 碗 ＋ 鮪魚罐頭
    ]
    first = combos[0]
    assert first.total == _m("650.00", "49.00", "20.50", "66.00")
    assert first.choices[1].macros == _m("270.00", "36.00", "13.50", "0.00")
    assert combos[2].total == _m("681.00", "48.20", "16.35", "82.00")


def test_combos_share_at_most_one_food_and_a_food_is_in_at_most_two():
    combos = suggest_combos(EIGHT, DINNER)
    sets = [{c.candidate for c in combo.choices} for combo in combos]
    for i, first in enumerate(sets):
        for second in sets[i + 1 :]:
            assert len(first & second) <= 1
    for food in range(len(EIGHT)):
        assert sum(food in s for s in sets) <= 2
    for combo in combos:
        assert len({c.candidate for c in combo.choices}) == len(combo.choices)  # 不重複食物


def test_an_extra_item_has_to_earn_its_place():
    """D6：A 400 g 差 10 kcal（410 的 2.4%），加 B 補滿只少了 0.0006 的分數，不值 0.02。"""
    foods = [_c("100", "0", "0", "0"), _c("40", "0", "0", "0")]
    combos = suggest_combos(foods, _kcal_only("410"))
    assert _summary(combos)[0] == [(0, "400", "400.00")]
    assert _summary(combos)[1] == [(0, "250", "250.00"), (1, "400", "400.00")]


def test_the_e2e_pair():
    """e2e 用的那一組（規格 §4.5、§9.3）：雞胸 ＋ 白飯 1 碗 200 g，剩 700 kcal、蛋白質 50。"""
    foods = [_c("110", "23", "1.5", "0"), _c("180", "3", "0.5", "40", "200")]
    remaining = Remaining(kcal=Decimal("700"), protein_g=Decimal("50"), fat_g=None, carb_g=None)
    combos = suggest_combos(foods, remaining)
    assert _summary(combos) == [
        [(0, "175", "175.00"), (1, "1.5", "300.00")],
        [(0, "250", "250.00")],
        [(1, "2", "400.00")],
    ]
    assert combos[0].total == _m("732.50", "49.25", "4.13", "120.00")


def test_no_candidates_means_no_combos():
    assert suggest_combos([], DINNER) == []


# ── 確定性與時間（D10、規格 §4.5） ─────────────────────────────────────────


def test_the_same_input_gives_the_same_output():
    assert suggest_combos(EIGHT, DINNER) == suggest_combos(list(EIGHT), DINNER)


def test_thirty_gram_based_candidates_finish_well_under_200_ms():
    """最壞情況：30 個都沒有份量（每個 16 格）、剩很多。寫計畫時 17 ms；上限給 200 ms。"""
    rng = random.Random(7)
    foods = [
        _c(str(rng.randint(20, 600)), str(rng.randint(0, 30)), str(rng.randint(0, 50)),
           str(rng.randint(0, 80)))
        for _ in range(30)
    ]  # fmt: skip
    remaining = Remaining(
        kcal=Decimal("2500"), protein_g=Decimal("150"), fat_g=Decimal("80"), carb_g=Decimal("300")
    )
    started = time.perf_counter()
    combos = suggest_combos(foods, remaining)
    elapsed_ms = (time.perf_counter() - started) * 1000
    assert 1 <= len(combos) <= 3
    assert elapsed_ms < 200, elapsed_ms
```

（`ruff` 對 `# fmt: skip` 不管，對行寬會管：超過 100 的行照 ruff 的提示斷行。）

Run: `./.venv/Scripts/python.exe -m pytest -q -W error tests/test_planner_solver.py` → Expected：FAIL（import）。

- [ ] **Step 2：`app/planner.py`。** 全文如下（寫計畫時在 scratchpad 跑過 `ruff`、`mypy` 與 Step 1 的每一個期望值）：

```python
"""今天還能吃什麼：剩下的額度與「從食物庫配」的解題器（營養素配餐規格 §3、§4）。

純函式：不碰資料庫、不碰時間、不寫 log（`tests/test_planner_privacy.py` 掃這個檔案）。
營養素一律換成「分」（×100 的整數）運算，分數也是整數——同樣的輸入永遠是同樣的輸出，
跟平台無關（規格 D10）。
"""

from collections.abc import Sequence
from dataclasses import dataclass
from decimal import ROUND_HALF_UP, Decimal

from app.nutrition import Macros

_CENTS = Decimal("0.01")
_ZERO = Decimal("0.00")

# 剩下的熱量低於這個數字＝今天差不多吃滿了，不給建議（規格 D4）。
FULL_BELOW_KCAL = Decimal(50)

# 量的步進（規格 D8）：有預設份量的食物用「幾份」，沒有的用 g／ml。
SERVING_STEPS: tuple[Decimal, ...] = (Decimal("0.5"), Decimal(1), Decimal("1.5"), Decimal(2))
GRAM_STEPS: tuple[Decimal, ...] = tuple(Decimal(g) for g in range(25, 401, 25))

# 目標函數（規格 D5）：Σ 權重 ×（(合計 − 剩下) / 分母)²。權重 ×100 成整數：
# 熱量 1.0、蛋白質 1.0、脂肪 0.5、碳水 0.5。
_WEIGHTS: tuple[int, int, int, int] = (100, 100, 50, 50)
# 三大營養素剩下的量很少（或 0）時，分母至少 10 g（1000 分）：不然多 1 g 就是無限大的
# 誤差。熱量不用：剩不到 50 kcal 根本不會解題。
_MACRO_FLOOR_CENTS = 1000
# 多一樣食物要多 0.02 的分數才划算（同權重的 ×100；規格 D6）。
_ITEM_PENALTY = 2
# 硬限制（規格 D7）：合計熱量 ≤ 剩下的 × 105 / 100。
_KCAL_CAP_PERCENT = 105

TOP_SINGLES = 12  # 兩樣、三樣只在單樣最好的這幾個食物之間找
SEED_PAIRS = 8  # 三樣：從最好的這幾組兩樣出發，各加一樣
DESCENT_ROUNDS = 2  # 三樣的座標下降最多幾輪
MAX_COMBOS = 3


@dataclass(frozen=True)
class Remaining:
    """今天還能吃多少。三大營養素是 `None`＝沒設目標（或目標是 0），不考慮。"""

    kcal: Decimal
    protein_g: Decimal | None
    fat_g: Decimal | None
    carb_g: Decimal | None


def _left(target: Decimal | None, actual: Decimal) -> Decimal | None:
    # 目標 0 跟沒設一樣不考慮（同 `/stats/daily` 的 ratio：0 → null；規格 D2）。
    if target is None or target == 0:
        return None
    return max(target - actual, _ZERO).quantize(_CENTS)


def remaining_for(
    *,
    kcal_budget: Decimal | None,
    protein_target: Decimal | None,
    fat_target: Decimal | None,
    carb_target: Decimal | None,
    actual: Macros,
) -> Remaining | None:
    """剩下的＝額度（熱量）或目標（三大營養素）− 已經吃的，最少 0（規格 §3）。
    沒有熱量額度（沒有目標、或目標沒設熱量）回 `None`。"""
    if kcal_budget is None:
        return None
    return Remaining(
        kcal=max(kcal_budget - actual.kcal, _ZERO).quantize(_CENTS),
        protein_g=_left(protein_target, actual.protein_g),
        fat_g=_left(fat_target, actual.fat_g),
        carb_g=_left(carb_target, actual.carb_g),
    )


def is_full(remaining: Remaining) -> bool:
    return remaining.kcal < FULL_BELOW_KCAL


@dataclass(frozen=True)
class Candidate:
    """一個可以配的食物：每 100 g／ml 的營養素，與預設份量的重量（沒有是 `None`）。"""

    per_100: Macros
    portion_grams: Decimal | None


@dataclass(frozen=True)
class Choice:
    """組合裡的一樣：第幾個候選、量（有份量是幾份，沒有是 g／ml）、實際 g／ml、營養素。"""

    candidate: int
    quantity: Decimal
    quantity_g: Decimal
    macros: Macros


@dataclass(frozen=True)
class Combo:
    choices: tuple[Choice, ...]
    total: Macros


_Vector = tuple[int, int, int, int]
_NOTHING: _Vector = (0, 0, 0, 0)


@dataclass(frozen=True)
class _Option:
    quantity: Decimal
    quantity_g_cents: int
    vector: _Vector


def _cents(value: Decimal) -> int:
    return int((value * 100).to_integral_value(rounding=ROUND_HALF_UP))


def _from_cents(value: int) -> Decimal:
    return (Decimal(value) / 100).quantize(_CENTS)


def _scaled(per_100_cents: int, quantity_g_cents: int) -> int:
    """每 100 × 量 / 100，四捨五入到分——跟 `app/nutrition.py` 的 `scale()` 一模一樣
    （那邊是 Decimal＋ROUND_HALF_UP，這裡是整數；兩個都是非負數）。"""
    return (2 * per_100_cents * quantity_g_cents + 10000) // 20000


def _macros(vector: _Vector) -> Macros:
    return Macros(
        kcal=_from_cents(vector[0]),
        protein_g=_from_cents(vector[1]),
        fat_g=_from_cents(vector[2]),
        carb_g=_from_cents(vector[3]),
    )


def _add(left: _Vector, right: _Vector) -> _Vector:
    return (left[0] + right[0], left[1] + right[1], left[2] + right[2], left[3] + right[3])


def _options(candidate: Candidate, cap_numerator: int) -> list[_Option]:
    per = (
        _cents(candidate.per_100.kcal),
        _cents(candidate.per_100.protein_g),
        _cents(candidate.per_100.fat_g),
        _cents(candidate.per_100.carb_g),
    )
    if candidate.portion_grams is not None:
        grams = candidate.portion_grams
        steps = [(step, _cents(grams * step)) for step in SERVING_STEPS]
    else:
        steps = [(step, _cents(step)) for step in GRAM_STEPS]
    result = []
    for quantity, quantity_g_cents in steps:
        vector = (
            _scaled(per[0], quantity_g_cents),
            _scaled(per[1], quantity_g_cents),
            _scaled(per[2], quantity_g_cents),
            _scaled(per[3], quantity_g_cents),
        )
        # 一樣就超過上限的量，在任何組合裡都超過：先拿掉。
        if vector[0] * 100 <= cap_numerator:
            result.append(_Option(quantity, quantity_g_cents, vector))
    return result


class _Scorer:
    """Σ wᵢ (eᵢ / Dᵢ)² 乘上 Π Dⱼ² 的整數版本：大小順序完全一樣，不用除法、不用浮點數。"""

    def __init__(self, remaining: Remaining) -> None:
        targets = (remaining.kcal, remaining.protein_g, remaining.fat_g, remaining.carb_g)
        denominators: dict[int, int] = {}
        wanted: dict[int, int] = {}
        for index, value in enumerate(targets):
            if value is None:
                continue
            wanted[index] = _cents(value)
            floor = 0 if index == 0 else _MACRO_FLOOR_CENTS
            denominators[index] = max(wanted[index], floor)
        product = 1
        for denominator in denominators.values():
            product *= denominator * denominator
        self._terms = [
            (index, wanted[index], _WEIGHTS[index] * (product // denominators[index] ** 2))
            for index in denominators
        ]
        self.item_penalty = _ITEM_PENALTY * product

    def __call__(self, total: _Vector) -> int:
        score = 0
        for index, wanted, multiplier in self._terms:
            error = total[index] - wanted
            score += multiplier * error * error
        return score


# 一個食物集合 → (分數, 每個食物用第幾個選項)。食物集合是排好序的候選位置。
_Found = dict[tuple[int, ...], tuple[int, tuple[int, ...]]]


@dataclass(frozen=True)
class _Problem:
    options: list[list[_Option]]
    score: _Scorer
    cap_numerator: int

    def fits(self, total: _Vector) -> bool:
        return total[0] * 100 <= self.cap_numerator

    def total(self, chosen: dict[int, int], skip: int | None = None) -> _Vector:
        result = _NOTHING
        for food, index in chosen.items():
            if food != skip:
                result = _add(result, self.options[food][index].vector)
        return result

    def best_option(self, food: int, others: _Vector) -> tuple[int, int] | None:
        """其他的不動，這個食物最好的量：(分數, 第幾個選項)。都超過上限是 `None`。"""
        found: tuple[int, int] | None = None
        for index, option in enumerate(self.options[food]):
            total = _add(others, option.vector)
            if not self.fits(total):
                continue
            key = (self.score(total), index)
            if found is None or key < found:
                found = key
        return found


def _singles(problem: _Problem) -> _Found:
    found: _Found = {}
    for food in range(len(problem.options)):
        best = problem.best_option(food, _NOTHING)
        if best is not None:
            found[(food,)] = (best[0], (best[1],))
    return found


def _pairs(problem: _Problem, top: list[int]) -> _Found:
    found: _Found = {}
    for position, first in enumerate(top):
        for second in top[position + 1 :]:
            a, b = sorted((first, second))
            best: tuple[int, int, int] | None = None
            for index_a, option_a in enumerate(problem.options[a]):
                for index_b, option_b in enumerate(problem.options[b]):
                    total = _add(option_a.vector, option_b.vector)
                    if not problem.fits(total):
                        continue
                    key = (problem.score(total), index_a, index_b)
                    if best is None or key < best:
                        best = key
            if best is not None:
                found[(a, b)] = (best[0], (best[1], best[2]))
    return found


def _triple(
    problem: _Problem, seed: tuple[int, ...], picks: tuple[int, ...], third: int
) -> tuple[int, tuple[int, ...]] | None:
    """兩樣的組合加第三樣：先挑第三樣最好的量，再輪流重挑每一樣（其他的不動），有進步才換。"""
    chosen = dict(zip(seed, picks, strict=True))
    first = problem.best_option(third, problem.total(chosen))
    if first is None:
        return None
    current, chosen[third] = first
    foods = tuple(sorted(chosen))
    for _ in range(DESCENT_ROUNDS):
        improved = False
        for food in foods:
            candidate = problem.best_option(food, problem.total(chosen, skip=food))
            if candidate is not None and candidate[0] < current:
                current, chosen[food] = candidate
                improved = True
        if not improved:
            break
    return current, tuple(chosen[food] for food in foods)


def _pick(ranked: list[tuple[int, int, tuple[int, ...], tuple[int, ...]]]) -> list[
    tuple[tuple[int, ...], tuple[int, ...]]
]:
    """依序挑：跟已挑的每一組最多共用一樣、同一個食物最多出現在兩組（規格 D11）。"""
    picked: list[tuple[tuple[int, ...], tuple[int, ...]]] = []
    for _value, _size, foods, picks in ranked:
        if any(len(set(foods) & set(other)) > 1 for other, _ in picked):
            continue
        if any(sum(food in other for other, _ in picked) >= 2 for food in foods):
            continue
        picked.append((foods, picks))
        if len(picked) == MAX_COMBOS:
            break
    return picked


def suggest_combos(candidates: Sequence[Candidate], remaining: Remaining) -> list[Combo]:
    """最多 `MAX_COMBOS` 組 1～3 樣、不重複食物的組合，最好的在前（規格 §4.3）。

    ①每個食物各自最好的量；②單樣最好的 `TOP_SINGLES` 個食物兩兩窮舉所有量；③從最好的
    `SEED_PAIRS` 組兩樣出發，各加一個前 `TOP_SINGLES` 的食物、座標下降；④全部依
    「分數＋(樣數 − 1) × 代價」排序，照規格 D11 挑。平手用候選與選項的順序決定。
    """
    if is_full(remaining):
        # 剩不到 50 kcal：不解題（也讓下面的分母一定大於 0）。
        return []
    cap_numerator = _cents(remaining.kcal) * _KCAL_CAP_PERCENT
    score = _Scorer(remaining)
    problem = _Problem(
        options=[_options(candidate, cap_numerator) for candidate in candidates],
        score=score,
        cap_numerator=cap_numerator,
    )

    found = _singles(problem)
    top = sorted((foods[0] for foods in found), key=lambda food: (found[(food,)][0], food))
    top = top[:TOP_SINGLES]
    pairs = _pairs(problem, top)
    found.update(pairs)
    for seed in sorted(pairs, key=lambda foods: (pairs[foods][0], foods))[:SEED_PAIRS]:
        for third in top:
            foods = tuple(sorted((*seed, third)))
            if third in seed or foods in found:
                continue
            result = _triple(problem, seed, pairs[seed][1], third)
            if result is not None:
                found[foods] = result

    ranked = sorted(
        (value + (len(foods) - 1) * score.item_penalty, len(foods), foods, picks)
        for foods, (value, picks) in found.items()
    )
    combos = []
    for foods, picks in _pick(ranked):
        options = [problem.options[food][pick] for food, pick in zip(foods, picks, strict=True)]
        total = _NOTHING
        for option in options:
            total = _add(total, option.vector)
        combos.append(
            Combo(
                choices=tuple(
                    Choice(
                        candidate=food,
                        quantity=option.quantity,
                        quantity_g=_from_cents(option.quantity_g_cents),
                        macros=_macros(option.vector),
                    )
                    for food, option in zip(foods, options, strict=True)
                ),
                total=_macros(total),
            )
        )
    return combos
```

Run Step 1 的指令 → Expected：PASS（20 條）。

- [ ] **Step 3：突變**（每一個都要看到**指定的**測試紅；存活的照實記下來）：
  1. `_WEIGHTS` 的蛋白質 100 → 0 → `test_protein_already_met_pushes_protein_away`、`test_the_eight_foods_dinner` 紅。
  2. `_MACRO_FLOOR_CENTS` 1000 → 0 → `test_protein_already_met…` 紅（`ZeroDivisionError`：分母 0）。
  3. `_ITEM_PENALTY` 2 → 0 → `test_an_extra_item_has_to_earn_its_place` 紅（`test_the_eight_foods_dinner` 也會：第 1 組變成三樣）。
  4. `_pick` 拿掉「最多共用一樣」那兩行 → `test_the_eight_foods_dinner` 紅（第 3 組變成「燕麥＋鮪魚 125 g＋燙青菜」）。
  5. `_pick` 拿掉「最多出現在兩組」那兩行 → 寫下哪一條紅；**兩條都沒紅就照實記下來**（八樣的例子裡第 1 條規則已經擋住了），再補一組能分出來的資料（三個食物各自很好、彼此不共用兩樣），記進「執行中發現的差異」。
  6. `fits` 的 `<=` 改 `<` → `test_the_kcal_cap_is_105_percent_inclusive` 紅；`_options` 的 `<=` 改 `<` → 同一條紅。
  7. `_scaled` 的 `+ 10000` 拿掉（變成捨去）→ `test_integer_scaling_matches_nutrition_scale` 紅。
  8. `_left` 拿掉 `or target == 0` → `test_a_macro_target_of_zero_is_not_considered` 紅；`max(…, _ZERO)` 拿掉 → `test_remaining_subtracts…` 紅。
  9. `is_full` 的 `<` 改 `<=` → `test_full_is_below_fifty_kcal` 紅。
  10. `SERVING_STEPS` 拿掉 `Decimal("0.5")` → `test_a_food_with_a_default_portion…` 紅；`GRAM_STEPS` 的上限 401 → 376 → `…up_to_400` 紅。
  11. `DESCENT_ROUNDS` 2 → 0（三樣只挑第三樣、不再調整）→ 記下有沒有測試紅；沒有就照實記（三樣的品質只在規格 §4.5 的大例子看得出來，不寫成測試）。

  每個突變：存原始位元組 → 改 → 跑 `tests/test_planner_solver.py` → 改回 → `cmp` → `touch`、刪 pyc。

- [ ] **Step 4：檢查、commit。** `pytest -q -W error tests/test_planner_solver.py`、`ruff check .`、`mypy app`（新模組，整套不用跑——沒有任何既有程式碼 import 它）。

```bash
git add app/planner.py tests/test_planner_solver.py
```

訊息：`feat(api): 營養素配餐——剩下的額度與從食物庫配的解題器（整數運算、有界搜尋）`

---

## Task 3：後端——候選與 `GET /api/planner/library-suggestions`

**Files:**
- Create: `app/planner_data.py`、`app/schemas/planner.py`、`app/api/routes/planner.py`、`tests/test_planner.py`、`tests/test_planner_privacy.py`
- Modify: `app/api/routes/foods.py`、`app/main.py`、`frontend/src/api/schema.d.ts`

- [ ] **Step 1：`my_recorded_foods_stmt`。** `app/api/routes/foods.py`：`_my_recorded_foods_stmt` 改名成 `my_recorded_foods_stmt`（兩個呼叫端跟著改），加一個只限關鍵字的參數：

```python
def my_recorded_foods_stmt(
    user: User,
    limit: int,
    order_by: ColumnElement[Any],
    *,
    require_nutrition: bool = False,
) -> Select[tuple[Food, FoodRevision]]:
    """…（既有的說明不動）…

    `require_nutrition`：只要「目前有生效版本」的食物（營養素配餐規格 D12——沒有生效版本的
    食物記不了，不當候選）。條件接在後面也是在 LIMIT 之前（SQL 的 WHERE），所以仍然是前 N 個。
    `frequent`／`recent` 兩個端點不帶（它們回 `nutrition: null`，畫面讓那種食物不能選）。
    """
    stmt = (
        ...既有的 select…limit…
    )
    if require_nutrition:
        stmt = stmt.where(_CurrentRevision.id.is_not(None))
    return stmt
```

`tests/test_foods_frequent.py` 照樣全綠（行為沒變）。

- [ ] **Step 2：回應的 schema。** `app/schemas/planner.py`：

```python
"""`GET /api/planner/library-suggestions` 的回應（營養素配餐規格 D13）。"""

import enum
from datetime import date
from decimal import Decimal

from pydantic import BaseModel

from app.schemas.food import FoodResponse
from app.schemas.stats import MacrosResponse, NullableMacrosResponse


class PlannerStatus(enum.StrEnum):
    OK = "ok"
    # 沒有熱量目標：畫面請使用者先設定（規格 D3）。
    NO_TARGET = "no_target"
    # 剩下的熱量不到 50 kcal（規格 D4）。
    FULL = "full"
    # 自己的餐裡沒有任何有生效版本的食物。
    NO_CANDIDATES = "no_candidates"
    # 有候選，但沒有任何一組不超過上限（每一樣最小的量就太多）。
    NO_FIT = "no_fit"


class RemainingResponse(BaseModel):
    """今天還能吃多少。三大營養素是 null＝沒設目標（或目標是 0），不考慮（規格 D2）。"""

    kcal: Decimal
    protein_g: Decimal | None
    fat_g: Decimal | None
    carb_g: Decimal | None


class PlannedPortionResponse(BaseModel):
    id: int
    label: str
    grams: Decimal


class PlannedItemResponse(BaseModel):
    """組合裡的一樣。`portion` 不是 null 時 `quantity` 是「幾份」（記一餐送 `portion_id`）；
    是 null 時 `quantity` 是 g 或 ml（看 `food.nutrition.base_unit`）。`nutrition` 是這一樣的量的
    四個數字（跟記下去之後 `/stats/daily` 算的一樣，`app/nutrition.py` 的 `scale()`）。"""

    food: FoodResponse
    portion: PlannedPortionResponse | None
    quantity: Decimal
    quantity_g: Decimal
    nutrition: MacrosResponse


class PlannedComboResponse(BaseModel):
    items: list[PlannedItemResponse]
    total: MacrosResponse
    # 合計 / 剩下（兩位小數）。不考慮的那一項、或剩下 0 的那一項是 null。
    fill: NullableMacrosResponse


class LibrarySuggestionsResponse(BaseModel):
    date: date
    status: PlannerStatus
    # 只有 `no_target` 時是 null。
    remaining: RemainingResponse | None
    # 只有 `ok` 時有東西：1 到 3 組，最好的在前。
    combos: list[PlannedComboResponse]
```

- [ ] **Step 3：寫會紅的端點測試。** `tests/test_planner.py`。共用的佈置：

```python
"""`GET /api/planner/library-suggestions`（營養素配餐規格 §4、D12–D14）。

「今天」一律 monkeypatch（`app.api.routes.planner.today_in_timezone`），記下收到的時區；
使用者時區 America/New_York。解題器本身由 tests/test_planner_solver.py 守；這裡守接線：
候選從哪裡來、預設份量怎麼挑、剩下的怎麼算、五種 status、回應的形狀。
"""

from datetime import UTC, date, datetime
from decimal import Decimal

import pytest
from sqlalchemy import event

from app.models.food import FoodRevision
from app.security.tokens import create_access_token
from tests.factories import (
    create_exercise,
    create_food,
    create_meal,
    create_portion,
    create_target,
    create_user,
)

URL = "/api/planner/library-suggestions"
TODAY = date(2026, 10, 14)
NOON = datetime(2026, 10, 14, 16, 0, tzinfo=UTC)  # 紐約 10/14 12:00
LAST_WEEK = datetime(2026, 10, 7, 16, 0, tzinfo=UTC)


def auth(user):
    return {"Authorization": f"Bearer {create_access_token(user.id)}"}


@pytest.fixture
def today(monkeypatch):
    seen: list[str] = []

    def fake(tz_name: str) -> date:
        seen.append(tz_name)
        return TODAY

    monkeypatch.setattr("app.api.routes.planner.today_in_timezone", fake)
    return seen


async def _new_yorker(db_session):
    user = await create_user(db_session)
    user.timezone = "America/New_York"
    await db_session.commit()
    return user


async def _eaten(db_session, user, food, *, at=LAST_WEEK, grams="100"):
    """記一餐讓這個食物變成「吃過」（上週：不佔今天的額度）。"""
    revision = await db_session.get(FoodRevision, food.current_revision_id)
    await create_meal(db_session, user=user, eaten_at=at, items=[(revision, Decimal(grams))])


async def _chicken_and_rice(db_session, user):
    """規格 §4.5 的 e2e 那一組：雞胸（沒有份量）、白飯（預設 1 碗 200 g）。"""
    chicken = await create_food(
        db_session, created_by=user, owner=user, name="雞胸",
        kcal=110, protein_g=23, fat_g=Decimal("1.5"), carb_g=0,
    )  # fmt: skip
    rice = await create_food(
        db_session, created_by=user, owner=user, name="白飯",
        kcal=180, protein_g=3, fat_g=Decimal("0.5"), carb_g=40,
    )  # fmt: skip
    await create_portion(db_session, food=rice, owner=user, label="1 碗", grams=200, is_default=True)
    await _eaten(db_session, user, chicken)
    await _eaten(db_session, user, chicken)  # 雞胸吃兩次：常吃的排第一（候選順序決定平手）
    await _eaten(db_session, user, rice)
    return chicken, rice
```

測試清單（每一條都寫完整；第 1 條的斷言照抄，其他照描述寫）：

1. `test_the_e2e_pair_end_to_end(client, db_session, today)`：`_new_yorker`、`create_target(kcal=700, protein_g=50)`、`_chicken_and_rice` → 200；`today == ["America/New_York"]`；body：

```python
    assert body["date"] == "2026-10-14"
    assert body["status"] == "ok"
    assert body["remaining"] == {
        "kcal": "700.00", "protein_g": "50.00", "fat_g": None, "carb_g": None,
    }  # fmt: skip
    first = body["combos"][0]
    chicken_item, rice_item = first["items"]
    assert chicken_item["food"]["id"] == chicken_id
    assert chicken_item["food"]["nutrition"]["kcal"] == "110.00"
    assert chicken_item["portion"] is None
    assert (chicken_item["quantity"], chicken_item["quantity_g"]) == ("175", "175.00")
    assert chicken_item["nutrition"] == {
        "kcal": "192.50", "protein_g": "40.25", "fat_g": "2.63", "carb_g": "0.00",
    }  # fmt: skip
    assert rice_item["portion"] == {"id": portion_id, "label": "1 碗", "grams": "200.00"}
    assert (rice_item["quantity"], rice_item["quantity_g"]) == ("1.5", "300.00")
    assert first["total"] == {
        "kcal": "732.50", "protein_g": "49.25", "fat_g": "4.13", "carb_g": "120.00",
    }  # fmt: skip
    # 732.50 / 700 = 1.0464… → 1.05；49.25 / 50 = 0.985 → 0.99（HALF_UP）；不考慮的是 null。
    assert first["fill"] == {"kcal": "1.05", "protein_g": "0.99", "fat_g": None, "carb_g": None}
    assert len(body["combos"]) == 3
```

   （id 先存成區域變數：`chicken_id = chicken.id` 等，在呼叫端點之前。）
2. `test_what_was_eaten_today_and_exercise_change_the_remaining`：目標 2000／蛋白質 90；今天（`NOON`）吃雞胸 500 g（550 kcal、115 g）；運動 343（`create_exercise(performed_at=NOON, kcal=343)`）→ `remaining == {"kcal": "1793.00", "protein_g": "0.00", "fat_g": None, "carb_g": None}`；把 `user.exercise_adds_to_budget = False` 再打一次 → `"1450.00"`。
3. `test_no_kcal_target_is_no_target`：沒有目標 → `{"status": "no_target", "remaining": None, "combos": []}`（另一條參數化：目標只有蛋白質、熱量 null → 同樣 `no_target`）。
4. `test_full_below_fifty_kcal`：目標 700、今天吃了 655 kcal → `status == "full"`、`remaining.kcal == "45.00"`、`combos == []`。
5. `test_no_candidates_for_a_new_account`：有目標、沒有任何餐 → `no_candidates`、`remaining` 有值。
6. `test_no_fit_when_every_food_is_too_big`：目標 100、上週吃過一個 600 kcal／100 g 的食物（25 g＝150 > 105）→ `no_fit`。
7. `test_candidates_are_only_my_recorded_foods_with_an_active_revision`：
   - 看得到的：自己記過的私人食物 A → 出現在某一組（先證明「看得到」）。
   - 別人吃過的食物 B（別人的私人食物、別人的餐）→ 不出現在任何一組。
   - 全域食物 C 從來沒記過 → 不出現。
   - 自己記過、但之後 `current_revision_id` 設成 None 的食物 D（`food.current_revision_id = None; await db_session.commit()`；外鍵是 DEFERRABLE）→ 不出現。
   斷言用所有組的 `item["food"]["id"]` 的集合。
8. `test_the_default_portion_prefers_my_own`：一個食物同時有公開的預設份量（`owner=None`）與自己的預設份量（`owner=user`）→ 回應的 `portion.id` 是自己的那個；只有公開的預設 → 用公開的；只有不是預設的份量 → `portion is None`、量是 g。**別人的私人預設份量**（`owner=other, is_default=True`）→ 不會被用到。
9. `test_frequent_foods_come_first_and_the_list_is_capped_at_thirty`：直接測 `app.planner_data.load_candidates`：記 32 個食物（每個一次，`eaten_at` 遞增），其中第 0 個吃 3 次 → 回傳 30 個、第一個是吃 3 次的那個；只吃過一次的裡，**最近吃的**排在常吃的後面（frequent 先、recent 補）。
10. `test_requires_login`：沒帶 token → 401。
11. `test_query_count_is_fixed`：照 `tests/test_stats_daily.py` 的 `before_cursor_execute` 寫法數 SQL：有 3 個候選時是 **7**（額度 4＋常吃 1＋最近 1＋份量 1）；5 個候選時一樣 7。數字對不上照實記錄（例如 auth 也算進去），但兩種候選數要相等。
12. `test_planner_reads_nothing_of_another_user`：另一個使用者的目標、餐、運動都不影響我的 `remaining`（先證明自己的有效：我有目標 → `remaining.kcal == "2000.00"`）。

Run: `./.venv/Scripts/python.exe -m pytest -q -W error tests/test_planner.py` → Expected：FAIL（404：路由還不存在）。

- [ ] **Step 4：`app/planner_data.py`。**

```python
"""營養素配餐讀資料庫的部分：候選食物、它們的預設份量、今天剩下的額度（規格 D1、D8、D12）。

只用呼叫端給的使用者。健康相關：這個模組不寫 log（tests/test_planner_privacy.py 掃）。
"""

from dataclasses import dataclass

from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.routes.foods import my_recorded_foods_stmt
from app.day_budget import DayBudget
from app.models.food import Food, FoodPortion, FoodRevision
from app.models.meal import Meal
from app.models.user import User
from app.nutrition import Macros
from app.planner import Candidate, Remaining, remaining_for

# 規格 D12：常吃前 30 ＋ 最近吃前 30，去重後取 30。
CANDIDATE_LIMIT = 30


@dataclass(frozen=True)
class PlannerFood:
    food: Food
    revision: FoodRevision
    portion: FoodPortion | None

    def candidate(self) -> Candidate:
        return Candidate(
            per_100=Macros(
                kcal=self.revision.kcal,
                protein_g=self.revision.protein_g,
                fat_g=self.revision.fat_g,
                carb_g=self.revision.carb_g,
            ),
            portion_grams=self.portion.grams if self.portion is not None else None,
        )


def remaining_of(budget: DayBudget) -> Remaining | None:
    target = budget.target
    return remaining_for(
        kcal_budget=budget.kcal_budget,
        protein_target=target.protein_g if target is not None else None,
        fat_target=target.fat_g if target is not None else None,
        carb_target=target.carb_g if target is not None else None,
        actual=budget.macros.actual,
    )


async def load_candidates(db: AsyncSession, user: User) -> list[PlannerFood]:
    """常吃的在前、最近吃的補上，去重、最多 `CANDIDATE_LIMIT` 個；只要有生效版本的。
    順序就是解題器平手時的順序（規格 D10）。"""
    frequent = (
        await db.execute(
            my_recorded_foods_stmt(
                user, CANDIDATE_LIMIT, func.count().desc(), require_nutrition=True
            )
        )
    ).all()
    recent = (
        await db.execute(
            my_recorded_foods_stmt(
                user, CANDIDATE_LIMIT, func.max(Meal.eaten_at).desc(), require_nutrition=True
            )
        )
    ).all()
    seen: set[int] = set()
    rows: list[tuple[Food, FoodRevision]] = []
    for food, revision in [*frequent, *recent]:
        if food.id in seen:
            continue
        seen.add(food.id)
        rows.append((food, revision))
        if len(rows) == CANDIDATE_LIMIT:
            break
    if not rows:
        return []
    portions = await _default_portions(db, user.id, [food.id for food, _ in rows])
    return [PlannerFood(food, revision, portions.get(food.id)) for food, revision in rows]


async def _default_portions(
    db: AsyncSession, user_id: int, food_ids: list[int]
) -> dict[int, FoodPortion]:
    """每個食物的預設份量：自己的優先，再來是公開的（同前端 `pickDefaultPortion`；規格 D8）。
    別人的私人份量看不到。一次查詢。"""
    portions = (
        await db.scalars(
            select(FoodPortion)
            .where(
                FoodPortion.food_id.in_(food_ids),
                FoodPortion.is_default.is_(True),
                or_(FoodPortion.owner_id.is_(None), FoodPortion.owner_id == user_id),
            )
            # 自己的（`owner_id IS NULL` 是 False）排前面，再用 id 讓結果固定。
            .order_by(FoodPortion.food_id, FoodPortion.owner_id.is_(None), FoodPortion.id)
        )
    ).all()
    result: dict[int, FoodPortion] = {}
    for portion in portions:
        result.setdefault(portion.food_id, portion)
    return result
```

- [ ] **Step 5：`app/api/routes/planner.py` 與 `app/main.py`。**

```python
"""`GET /api/planner/library-suggestions`：今天還能吃什麼——從常吃的食物配
（營養素配餐規格 §4、D13、D14）。只讀、只看呼叫者自己的資料。"""

from decimal import ROUND_HALF_UP, Decimal

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.day_budget import load_day_budget
from app.days import today_in_timezone
from app.db import get_db
from app.models.user import User
from app.nutrition import Macros
from app.planner import Combo, Remaining, is_full, suggest_combos
from app.planner_data import PlannerFood, load_candidates, remaining_of
from app.schemas.food import FoodResponse, NutritionResponse
from app.schemas.planner import (
    LibrarySuggestionsResponse,
    PlannedComboResponse,
    PlannedItemResponse,
    PlannedPortionResponse,
    PlannerStatus,
    RemainingResponse,
)
from app.schemas.stats import MacrosResponse, NullableMacrosResponse

router = APIRouter(prefix="/planner", tags=["planner"])

_CENTS = Decimal("0.01")


def _remaining_response(remaining: Remaining) -> RemainingResponse:
    return RemainingResponse(
        kcal=remaining.kcal,
        protein_g=remaining.protein_g,
        fat_g=remaining.fat_g,
        carb_g=remaining.carb_g,
    )


def _macros(macros: Macros) -> MacrosResponse:
    return MacrosResponse(
        kcal=macros.kcal, protein_g=macros.protein_g, fat_g=macros.fat_g, carb_g=macros.carb_g
    )


def _fill(total: Decimal, left: Decimal | None) -> Decimal | None:
    # 同 `/stats/daily` 的 `_ratio_field`：不考慮（null）或 0 → null，其餘四捨五入到兩位。
    if left is None or left == 0:
        return None
    return (total / left).quantize(_CENTS, rounding=ROUND_HALF_UP)


def _combo_response(
    combo: Combo, foods: list[PlannerFood], remaining: Remaining
) -> PlannedComboResponse:
    items = []
    for choice in combo.choices:
        planned = foods[choice.candidate]
        portion = planned.portion
        items.append(
            PlannedItemResponse(
                food=FoodResponse(
                    id=planned.food.id,
                    name=planned.food.name,
                    brand=planned.food.brand,
                    is_global=planned.food.owner_id is None,
                    nutrition=NutritionResponse.model_validate(planned.revision),
                ),
                portion=None
                if portion is None
                else PlannedPortionResponse(id=portion.id, label=portion.label, grams=portion.grams),
                quantity=choice.quantity,
                quantity_g=choice.quantity_g,
                nutrition=_macros(choice.macros),
            )
        )
    total = combo.total
    return PlannedComboResponse(
        items=items,
        total=_macros(total),
        fill=NullableMacrosResponse(
            kcal=_fill(total.kcal, remaining.kcal),
            protein_g=_fill(total.protein_g, remaining.protein_g),
            fat_g=_fill(total.fat_g, remaining.fat_g),
            carb_g=_fill(total.carb_g, remaining.carb_g),
        ),
    )


@router.get("/library-suggestions", response_model=LibrarySuggestionsResponse)
async def library_suggestions(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> LibrarySuggestionsResponse:
    """今天還剩多少，以及從常吃、最近吃的食物配出的最多 3 組（1～3 樣）。

    `status`：`no_target`（沒有熱量目標）、`full`（剩不到 50 kcal）、`no_candidates`（還沒有
    記過有營養素的食物）、`no_fit`（每一樣最小的量就超過剩下的 105%）、`ok`。「今天」是
    使用者時區的今天；熱量的剩下用今天的額度（運動設定開時含運動）。不寫任何東西。
    """
    user_id, tz_name = user.id, user.timezone
    adds_exercise = user.exercise_adds_to_budget
    day = today_in_timezone(tz_name)
    budget = await load_day_budget(
        db, user_id=user_id, tz_name=tz_name, adds_exercise=adds_exercise, day=day
    )
    remaining = remaining_of(budget)

    def respond(
        status: PlannerStatus, combos: list[PlannedComboResponse] | None = None
    ) -> LibrarySuggestionsResponse:
        return LibrarySuggestionsResponse(
            date=day,
            status=status,
            remaining=None if remaining is None else _remaining_response(remaining),
            combos=combos or [],
        )

    if remaining is None:
        return respond(PlannerStatus.NO_TARGET)
    if is_full(remaining):
        return respond(PlannerStatus.FULL)
    foods = await load_candidates(db, user)
    if not foods:
        return respond(PlannerStatus.NO_CANDIDATES)
    combos = suggest_combos([food.candidate() for food in foods], remaining)
    if not combos:
        return respond(PlannerStatus.NO_FIT)
    return respond(
        PlannerStatus.OK, [_combo_response(combo, foods, remaining) for combo in combos]
    )
```

`app/main.py`：`from app.api.routes import (…, planner, …)`（照字母順序），`app.include_router(planner.router, prefix="/api")` 放在 `stats.router` 後面。

Run Step 3 的指令 → Expected：PASS（12 條＋參數化）。

- [ ] **Step 6：隱私掃描。** `tests/test_planner_privacy.py`，照 `tests/test_exercise_privacy.py` 的寫法、用 `tests/privacy_helpers.py`：
  1. `app/planner.py`、`app/planner_data.py`、`app/day_budget.py`、`app/api/routes/planner.py` 不 import `logging`、沒有 `logger`／`print(`。
  2. 好友與社群的模組（`SOCIAL_MODULES`，同運動的那一份）不提 `planner`、`day_budget`，沿著 import 也走不到（`app_import_closure`）。
  先看一次它紅：在 `app/planner_data.py` 暫時加 `import logging` → 第 1 條紅 → 拿掉。

- [ ] **Step 7：突變。**
  1. `load_candidates` 的 `require_nutrition=True` 改 `False`（兩處）→ 測試 7 的 D 那一段紅（或 `PlannerFood.candidate()` 讀 `None.kcal` 炸成 500——也算紅，記下是哪一種）。
  2. `my_recorded_foods_stmt` 拿掉 `Meal.user_id == user.id` → 測試 7 的 B 紅。
  3. `_default_portions` 的排序拿掉 `FoodPortion.owner_id.is_(None)` → 測試 8 紅（看資料的 id 順序：公開的那個要先建，才分得出來；計畫的測試要照這個順序建）。
  4. `_default_portions` 拿掉 `or_(…)` 那一行 → 測試 8 的「別人的私人預設份量」紅。
  5. `respond` 的 `remaining` 一律 `None` → 測試 1、4、5 紅。
  6. `_fill` 拿掉 `or left == 0` → 寫一條「蛋白質剩 0 → `fill.protein_g` 是 null」的斷言（併進測試 2：蛋白質已經超標）讓它紅（`DivisionByZero` → 500）。
  7. `library_suggestions` 的 `is_full` 判斷拿掉 → 測試 4 紅？（解題器自己也回 `[]` → 變成 `no_fit`：status 不同，紅。）
  8. `load_candidates` 的去重拿掉 → 測試 9 紅（同一個食物出現兩次）。

- [ ] **Step 8：檢查、schema、commit。** 整套 `pytest -q -W error`、`ruff check .`、`mypy app`；重新產生 `schema.d.ts`；`cd frontend && npm run -s typecheck`。

```bash
git add app/planner_data.py app/schemas/planner.py app/api/routes/planner.py app/api/routes/foods.py \
  app/main.py tests/test_planner.py tests/test_planner_privacy.py frontend/src/api/schema.d.ts
```

訊息：`feat(api): GET /api/planner/library-suggestions——從常吃的食物配今天剩下的額度`
