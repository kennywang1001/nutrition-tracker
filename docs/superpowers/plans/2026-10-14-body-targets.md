# 身體資料與目標（含體重紀錄）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 使用者填身體資料、每天記體重，就能在 `/me/targets` 看到用公式算出的建議目標並一鍵套用；體重變了 1 公斤以上時「每日目標」卡片提示重算。體重有自己的頁面（`/weight`：圖表與清單）。

**Architecture:** 兩張新表（`user_profiles` 1:1、`weight_entries` 主鍵 `(user_id, date)`，migration `0019`）。公式是 `app/body_targets.py` 的純函式（Decimal、HALF_UP），讀資料的小函式在 `app/body_data.py`。端點在兩個新的路由模組：`routes/body.py`（`/api/me/body-profile`、`/api/me/target-suggestion`、`…/apply`）與 `routes/weights.py`（`/api/weights…`）。套用由後端在一個交易裡重算、比對畫面上看到的四個數字、用從 `set_target_from_today` 抽出來的 `write_target_from_today` 寫目標、記下套用時的體重；手動存目標清掉那個體重。前端的 query 都在 `["body", …]` 底下（進離線快取）；圖表是純渲染的 SVG（同 `TrendChart` 的慣例），數字運算只在 `lib/decimal.ts`。

**Tech Stack:** FastAPI · SQLAlchemy 2 async · Alembic · PostgreSQL 16 · React 19 · TypeScript strict · TanStack Query v5 · react-router · CSS Modules · Vitest · Playwright · Biome

**依據規格：** `docs/superpowers/specs/2026-10-14-body-targets-design.md`（以下稱「規格」；D1…D27 指它的 §2）

---

## 執行環境

- 分支 `feat/body-targets`（已建立，**不要 push**）。
- 後端在 repo 根目錄（Git Bash）：
  - `./.venv/Scripts/python.exe -m pytest -q -W error`（整套約 4 分鐘，timeout 給 10 分鐘；**同一時間只跑一個 pytest**——測試資料庫每次砍掉重建）。需要 dev 的 Postgres：`docker compose up -d`（專案 `wallet`，`localhost:5433`）。**絕對不要跑 `down -v`。**
  - `./.venv/Scripts/python.exe -m ruff check .`、`./.venv/Scripts/python.exe -m mypy app`。**不要跑 `ruff format`**（handover §7）。
  - `alembic check` 指向測試資料庫（handover §9）：
    `DATABASE_URL="postgresql+asyncpg://wallet:wallet@localhost:5433/wallet_test" ./.venv/Scripts/python.exe -m alembic check`
- 前端在 `frontend/`：`npx vitest run tests/xxx`、`npm run -s test`、`npm run -s typecheck`、`npm run -s lint`（格式用 `npx biome check --write <檔案>`）。驗證時一起 grep `FAIL` 與 `Unhandled`。**typecheck 在每次 commit 之前單獨跑一次，跟 `git commit` 用 `&&` 串，不要用 `;`。**
- e2e：先 `docker compose up -d --build api`，**再** `docker compose exec -T api python -m alembic upgrade head`（重建不會替 dev 跑 migration，handover §7），`docker compose exec -T api python -m alembic current` 確認是 `0019`；然後在 `frontend/` 跑 `npx playwright test …`。
- 基準線（handover §2，2026-10-10）：後端 **1450**；前端 `Test Files 154`、`Tests 2128`（vitest 印出來的數字）；e2e **50**；端點 **87**；資料表 19。開工前自己再量一次，對不上照實記下來。
- **`schema.d.ts` 重新產生**——動到 `app/api/routes` 或 `app/schemas` 的每一個 commit（docstring 也算）：

  ```bash
  S=C:/Users/user/AppData/Local/Temp/claude/f--wallet/e7b60c93-fbd5-4a61-9c85-74550ff7244b/scratchpad
  PYTHONUTF8=1 PYTHONIOENCODING=utf-8 ./.venv/Scripts/python.exe -c "import json; from app.main import app; print(json.dumps(app.openapi(), ensure_ascii=False))" > "$S/openapi.tmp.json"; (cd frontend && npx openapi-typescript "$S/openapi.tmp.json" -o src/api/schema.d.ts)
  rm "$S/openapi.tmp.json"
  ```

  產生之後跑 `cd frontend && npm run -s typecheck`。
- **突變**：改一行、看到指定的測試紅、改回、重跑看到綠。`.py` 改回之後 `touch` 那個檔案，並刪掉對應的 `__pycache__/*.pyc`（handover §7：pyc 用秒比 mtime）。**還沒 commit 的新檔案 `git checkout --` 救不回來**：突變前先 `cp app/x.py "$S/body-x.py.bak"`，改回之後 `diff` 確認。**每一批突變做完跑 `git diff`／`git status`**，確認沒有突變留在檔案裡（這件事發生過兩次）。突變可能變成無限迴圈：pytest 加 `--timeout` 不可用時，用 `timeout 300 ./.venv/Scripts/python.exe -m pytest …`。
- **Commit**：中文 conventional commit。訊息用 Write 工具寫到 `$S/body-<task>-msg.txt`（每次用不同的檔名），最後一行 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`，`git commit -F`。**明確列出要 add 的檔案；絕對不要 stage `lunch.jpg`**（不要 `git add -A`／`git add .`）。不要 amend。
- **看不見的字元**：Write／Edit 工具會把「反斜線 u＋四位十六進位」解成真的字元；Bash heredoc 會吃掉一層反斜線（handover §7）。腳本一律用 Write 工具寫成檔案再跑。每個 task commit 前跑一次（掃 Cc〔Tab、LF 除外〕、Cf、Zl、Zp、CR、BOM）：

  ```bash
  git diff --cached --name-only | ./.venv/Scripts/python.exe -c "import sys,unicodedata as u; [print(p.strip(), i+1, hex(ord(c))) for p in sys.stdin for i,l in enumerate(open(p.strip(),encoding='utf-8',newline='')) for c in l if (u.category(c) in ('Cc','Cf','Zl','Zp') and c not in '\t\n') or ord(c)==0xfeff]"
  ```

  Expected：沒有輸出。

## 開工前必讀

1. 「Expected: FAIL」沒有如預期失敗 → 停下來回報。新模組還不存在時紅的是 import，不是斷言——斷言有沒有咬合力由每個 task 的突變步驟證明（handover §6 規矩 1、8）。
2. 引用的程式碼對不上現況 → 以現況為準並回報。
3. **「今天」一律 monkeypatch，而且記下收到的時區**（handover §6 第 2、22 種）：`app.api.routes.body.today_in_timezone`、`app.api.routes.weights.today_in_timezone`、既有的 `app.api.routes.targets.today_in_timezone`。測試使用者的時區設成**不是預設的** `Asia/Taipei`（例如 `America/New_York`），否則「傳錯時區」測不出來。
4. `client` 夾具跟測試共用一個 session、外層一個交易（handover §6 第 14 種）：`now()` 在整條測試裡是同一個值，**`updated_at` 有沒有變在端點測試裡看不到**——不要寫那種斷言。並行的 upsert 用獨立的 session（Task 4）。
5. 共用 session 裡 `rollback()` 之後 ORM 物件會過期（`MissingGreenlet`）：id、日期先存成區域變數。要測「資料庫擋下來」用 `async with db_session.begin_nested():` 包住 raw SQL，**並斷言錯誤訊息裡是哪一個約束的名字**（第 13 種：別的約束先擋下來也會是 `IntegrityError`）。
6. 端點在 `await db.commit()` 之後不碰 ORM 物件（handover §7）：開頭就把 `user.id`、`user.timezone` 存成區域變數。
7. **「看不到」的測試先在同一條測試裡看得到一次**（A 自己讀得到、B 讀不到）。只斷言 404 的測試，路徑打錯也會綠。
8. 前端的 `tests/helpers/mock-api.ts` 用 `url.includes(path)` **依序**比對：`/api/me` 的路由會吃掉 `/api/me/body-profile`、`/api/me/target-suggestion`。**新的 `/api/me/...` 路由一律排在 `/api/me` 前面**；既有測試裡會畫出新卡片的（`me.test.tsx`、`targets.test.tsx`、`app.test.tsx`……）在路由清單**最前面**加上 Task 6 的 `bodyRoutes()`。沒準備的路徑會 `throw`（query 變成 error，不會讓測試直接紅）——斷言「沒有發出某個請求」要看 `spy.mock.calls`。
9. 前端**不算今天**：預設日期、圖表的右端都用 `GET /api/weights` 回的 `today`；日期加減只用 `lib/civil-date.ts`（UTC，掃描測試守著）；數字運算只在 `lib/decimal.ts`（`tests/decimal-containment.test.ts`）。
10. Playwright 的名稱一律 `exact: true`；登入之後**只用點擊換頁**，不要 `page.goto`；等頁面獨有的元素再動作。
11. 離線快取裡的舊資料可能少了新欄位（`undefined`，不是 `null`）：畫面判斷用真值或 `?? null`（handover §7）。

## 寫計畫時實測過的事（沒有整份試跑）

這份計畫**沒有**整份跑過。「Expected: PASS」的條數是照測試清單數的，不是量的；對不上照實回報。只有下面兩件不確定的事做了小實驗：

1. **建議的回應用聯集時不能加 discriminator。** `Annotated[Ready | Missing, Field(discriminator="ready")]`：OpenAPI 的 `discriminator.mapping` 鍵是 `"True"`／`"False"`，openapi-typescript 7.13 因此產生 `ready: "True"`（字串）。不加 discriminator：OpenAPI 是 `anyOf`，產生 `ready: true`／`ready: false`，前端可以 `if (s.ready)` 收窄。FastAPI 的 `response_model=SuggestionReady | SuggestionMissing` 序列化正常。
2. **公式的數字**：規格 §3 的五組（A–E）用跟 Task 2 同一套 `Decimal`／`ROUND_HALF_UP` 運算的腳本算過；7700 / 7 剛好是 1100，所以調整量是整數（275、550）。

## 與規格的差異

（執行中發現的寫在這裡。）

## 執行中發現的差異

### Task 1–5（後端，2026-10-14）

**數字：** 後端整套 **1592** 條（開工前 1450，新增 142：五個新測試檔 133 條、`test_export.py` +6、
`test_targets_today.py` +3）；端點 **95**；`alembic` 在測試資料庫 upgrade → check → downgrade -1（`0018`）→
upgrade（`0019`）→ check 都乾淨。dev 資料庫沒有碰（Task 10 的 e2e 前再 `upgrade head`）。

**Task 1**
1. 模型沒用 `created_at, updated_at = _timestamps()`，直接照 `app/models/social.py` 每個欄位各寫一次（行為一樣）。
2. **只改 migration 的突變（拿掉 `rate_valid`、拿掉 `CASCADE`、改主鍵）在 conftest 的 `alembic check` 就先炸了**：
   18 條全部是 setup ERROR，不是指定的那一條紅。要看到指定的測試紅，模型與 migration 要**一起改**
   （`rate_valid` → 只有 `[rate-…]` 紅；`CASCADE` → 只有 cascade 那條紅）。只改 CHECK 的文字
   （`height_cm > 100 AND …`、`weight_kg BETWEEN 25 AND 351`）不會漂移，照計畫只有那一條紅。
   模型拿掉 `rate_valid` → `alembic check` 報 `remove_constraint`（照計畫）。

**Task 2**
3. 五組（A–E）與 floor-raw、F 兩組用獨立的 Decimal 腳本重算過，全部對得上。
4. 多一條 `test_a_raw_value_exactly_at_the_floor_does_not_count_as_floored`（女、39 歲、160 cm、35.6 kg、久坐、維持：
   BMR 1000、TDEE 剛好 1200）：`raw < floor` 改成 `<=` 的突變原本存活。共 22 條（計畫 21）。

**Task 3**
5. 條數：`test_body_profile.py` 36、`test_target_suggestion.py` 13（計畫約 30／10）——多了幾格邊界
   （目標體重三位小數、速度 `"1"`、速度 null、出生年 null 不檢查、`+0.99` 不提示、年齡跟著「端點拿到的今天」）。
6. Step 4 的紅不是 404：`seen_timezones` 夾具 monkeypatch `app.api.routes.body.today_in_timezone`，模組不存在時是夾具的
   import 錯誤；只有 401 那幾條是 404。
7. `app/body_data.py` 的兩個讀取函式 mypy 報 `no-any-return`（`db.scalar` 是 Any）：照 `routes/targets.py` 先放進有註解的
   變數。**Task 3 的 commit 帶著這兩個 mypy 錯誤**（檢查時把 mypy 接了 `| tail -1`，退出碼被吃掉），下一個 commit 修掉。
   教訓：mypy／ruff 不要接管線。
8. 突變 3（`set_` 拿掉 `updated_at`）照預期存活。另外多做：PUT 也清掉套用體重 → `test_put_does_not_touch_the_applied_weight` 紅；
   `load_profile` 不看 user_id → 跨使用者那條紅。

**Task 4**
9. 800 天的邊界：2026-10-14 往回 799 天是 **2024-08-06**（`from=2024-08-06` 是 800 天、`2024-08-05` 是 801 天）；
   多一條 `test_the_800_day_fixture_dates_are_right` 守著手算的日期（第一次就算錯了一天）。`test_weights.py` 27 條。
10. **規格 §8.1 的「並行第一次存身體資料」計畫的 Task 3 沒列**：加在 `test_weights_concurrency.py`
    （`test_two_first_time_profile_saves_at_once_both_succeed`）——第一條連線 INSERT 不 commit，第二條直接呼叫真的
    `save_body_profile`，卡在主鍵上；第一條 commit 之後第二條走 DO UPDATE。突變成「先查有沒有、沒有就 INSERT／有就 UPDATE」
    只有這條紅。
11. `test_export.py`：體重也加進 `EXPORT_PATHS` 與 `_some_of_each`（每個 index 一天一筆）——「session 撐到最後一塊」
    「送的時候沒有交易」「送的時候連線在池子裡」三條也跑體重；限速那條改名 `test_the_exports_share_one_budget_per_user`、
    輪流打四個；「只有自己的」那條也看體重。
12. 突變 4（先查再寫）除了並行那條，`test_put_creates_then_corrects_the_same_day` 也紅——但只是因為突變版回的是請求的
    `"80.4"` 不是資料庫的 `"80.40"`；語意上的錯只有並行那條抓得到（照計畫）。`>` 改 `>=` 的游標是無限迴圈，120 秒逾時。

**Task 5**
13. Step 1 的重構先**不**放 `clear_applied_weight`（純重構，既有 61 條綠），等 D16 的測試紅了才加回去。
    `_to_response` 有 6 處呼叫（不是 3 處）。
14. D16 的測試 parametrize 兩條寫入的路（今天才開始的原地改、更早開始的關閉＋開新）；另加
    `test_a_clash_keeps_the_applied_weight`（409 時清掉的動作也 rollback）。
15. 掃描的第一條實際掃到 **21** 個模型（計畫寫 22）；`>= 20` 仍成立。四個掃描突變（`FriendMeal` 加 `weight_kg`、
    `NotificationMeal` 加 `body_profile_id`、`friends.py` 註解寫 `WeightEntry`、`weights.py` 加 `import logging`）各自只紅
    對應的那一條。
16. 突變 7（原地改那支 `flush` 換成 `commit`）照預期存活。

**環境**
17. 突變小工具印 pytest 輸出時遇到 cp950 編不了的字元會整個停下（檔案有還原）：跑之前設 `PYTHONIOENCODING=utf-8`。

---

## 檔案結構

| 檔案 | Task | 內容 |
|---|---|---|
| `app/models/body.py`（新）、`app/models/__init__.py` | 1 | `UserProfile`、`WeightEntry`、`Sex`、`ActivityLevel`、`Goal` |
| `migrations/versions/0019_create_body_tables.py`（新） | 1 | 兩張表 |
| `tests/factories.py`、`tests/test_body_model.py`（新） | 1 | `create_profile`、`create_weight`；約束與 cascade |
| `app/body_targets.py`（新）、`tests/test_body_targets.py`（新） | 2 | 公式（純函式） |
| `app/body_data.py`（新） | 3、5 | `load_profile`、`latest_weight`、`inputs_from`、`clear_applied_weight` |
| `app/schemas/body.py`（新） | 3–5 | 身體資料、建議、套用、體重的形狀 |
| `app/api/routes/body.py`（新）、`app/main.py` | 3、5 | 身體資料、建議、套用 |
| `tests/test_body_profile.py`、`tests/test_target_suggestion.py`（新） | 3、5 | |
| `app/api/routes/weights.py`（新）、`app/export.py`、`app/api/routes/export.py` | 4 | 體重的三個端點、`weights.csv` |
| `tests/test_weights.py`、`tests/test_weights_concurrency.py`（新）、`tests/test_export.py` | 4 | |
| `app/api/routes/targets.py` | 5 | 抽出 `write_target_from_today`；手動存目標清掉套用體重 |
| `tests/test_body_privacy.py`（新）、`tests/test_targets_today.py` | 5 | 掃描；清掉套用體重 |
| `frontend/src/api/schema.d.ts` | 3–5 | 每個後端 task 重新產生 |
| `frontend/src/api/{body.ts（新）,queries.ts}`、`src/lib/{body.ts（新）,weights.ts（新）,decimal.ts,civil-date.ts}` | 6 | API 層、標籤、移動平均、數字與日期 |
| `frontend/tests/helpers/body-routes.ts`（新）、`tests/weights-lib.test.ts`、`tests/body-api.test.tsx`（新）、`decimal.test.ts`、`civil-date.test.ts` | 6 | |
| `frontend/src/screens/BodyProfile.tsx`、`components/BodyProfileCard.tsx`（新）、`Me.tsx`、`App.tsx`、`lib/layout.ts` | 7 | `/me/body` |
| `frontend/src/components/{WeightCard,WeightForm,WeightChart}.tsx`、`screens/Weight.tsx`、`components/Segmented.module.css`（新）、`screens/Trend.{tsx,module.css}`、`index.css` | 8 | 體重 |
| `frontend/src/components/TargetSuggestion.tsx`（新）、`TargetsCard.tsx`、`screens/Targets.tsx`、`api/export.ts` | 9 | 建議、提示、匯出 |
| `frontend/e2e/body-targets.spec.ts`（新） | 10 | |
| `docs/handover.md`、`docs/deployment.md`、規格的狀態 | 11 | |

---

## Task 1：後端——migration `0019` 與模型

**Files:**
- Create: `app/models/body.py`、`migrations/versions/0019_create_body_tables.py`、`tests/test_body_model.py`
- Modify: `app/models/__init__.py`、`tests/factories.py`

- [ ] **Step 1：模型。** `app/models/body.py`：

```python
"""身體資料與體重（身體資料規格 §4）。健康資料：只有身體資料的模組讀寫這兩張表——
好友與社群的模組連這幾個名字都不准出現（`tests/test_body_privacy.py` 掃的是文字）。"""

import datetime as dt
import enum
from decimal import Decimal

from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    Date,
    DateTime,
    Enum,
    ForeignKey,
    Numeric,
    SmallInteger,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class Sex(enum.StrEnum):
    MALE = "male"
    FEMALE = "female"


class ActivityLevel(enum.StrEnum):
    SEDENTARY = "sedentary"
    LIGHT = "light"
    MODERATE = "moderate"
    ACTIVE = "active"
    VERY_ACTIVE = "very_active"


class Goal(enum.StrEnum):
    LOSE = "lose"
    MAINTAIN = "maintain"
    GAIN = "gain"


def _enum(cls: type[enum.StrEnum], name: str, length: int) -> Enum:
    # handover §7：create_constraint=True 會讓 alembic check 永久漂移；False 的另一半是
    # __table_args__ 裡手寫的 CHECK——只寫一半＝沒有約束。
    return Enum(
        cls,
        name=name,
        native_enum=False,
        create_constraint=False,
        length=length,
        values_callable=lambda e: [m.value for m in e],
    )


def _timestamps() -> tuple[Mapped[dt.datetime], Mapped[dt.datetime]]:
    return (
        mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now()),
        mapped_column(
            DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
        ),
    )


class UserProfile(Base):
    """一人一列（D1），每個欄位都可以是 null（還沒填）。

    CHECK 對 NULL 放行（handover §7）——這裡要的正是「null 或範圍內」，所以不用寫
    `x IS NULL OR …`。出生年的真正範圍跟「今天」有關，CHECK 只擋衛生範圍（D4）。"""

    __tablename__ = "user_profiles"
    __table_args__ = (
        CheckConstraint("sex IN ('male', 'female')", name="sex_valid"),
        CheckConstraint("birth_year BETWEEN 1900 AND 2100", name="birth_year_sane"),
        CheckConstraint("height_cm BETWEEN 100 AND 250", name="height_range"),
        CheckConstraint(
            "activity_level IN ('sedentary', 'light', 'moderate', 'active', 'very_active')",
            name="activity_level_valid",
        ),
        CheckConstraint("goal IN ('lose', 'maintain', 'gain')", name="goal_valid"),
        CheckConstraint("rate_kg_per_week IN (0.25, 0.50)", name="rate_valid"),
        CheckConstraint("target_weight_kg BETWEEN 25 AND 350", name="target_weight_range"),
        CheckConstraint(
            "targets_applied_weight_kg BETWEEN 25 AND 350", name="applied_weight_range"
        ),
    )

    user_id: Mapped[int] = mapped_column(
        BigInteger,
        ForeignKey("users.id", ondelete="CASCADE"),
        primary_key=True,
        autoincrement=False,
    )
    sex: Mapped[Sex | None] = mapped_column(_enum(Sex, "body_sex", 8))
    birth_year: Mapped[int | None] = mapped_column(SmallInteger)
    height_cm: Mapped[Decimal | None] = mapped_column(Numeric(4, 1))
    activity_level: Mapped[ActivityLevel | None] = mapped_column(
        _enum(ActivityLevel, "activity_level", 16)
    )
    goal: Mapped[Goal | None] = mapped_column(_enum(Goal, "body_goal", 8))
    rate_kg_per_week: Mapped[Decimal | None] = mapped_column(Numeric(3, 2))
    target_weight_kg: Mapped[Decimal | None] = mapped_column(Numeric(5, 2))
    # 套用建議時的體重（D15）；手動存目標時清成 null（D16）。只有後端寫，API 不收。
    targets_applied_weight_kg: Mapped[Decimal | None] = mapped_column(Numeric(5, 2))
    created_at: Mapped[dt.datetime]
    updated_at: Mapped[dt.datetime]
    created_at, updated_at = _timestamps()


class WeightEntry(Base):
    """一人一天一筆（D12）：主鍵就是 (user_id, date)，同時是「某段日期」與「最新一筆」的索引。

    `date` 是使用者時區的日曆日（記的時候選的那一天），不是時間點。`updated_at` 的
    `onupdate` 只在 ORM 的 UPDATE 生效——upsert 要自己在 `set_` 裡寫（`routes/weights.py`）。"""

    __tablename__ = "weight_entries"
    __table_args__ = (CheckConstraint("weight_kg BETWEEN 25 AND 350", name="weight_range"),)

    user_id: Mapped[int] = mapped_column(
        BigInteger,
        ForeignKey("users.id", ondelete="CASCADE"),
        primary_key=True,
        autoincrement=False,
    )
    date: Mapped[dt.date] = mapped_column(Date, primary_key=True)
    weight_kg: Mapped[Decimal] = mapped_column(Numeric(5, 2), nullable=False)
    created_at: Mapped[dt.datetime]
    updated_at: Mapped[dt.datetime]
    created_at, updated_at = _timestamps()
```

> `created_at, updated_at = _timestamps()` 這種寫法如果 SQLAlchemy 的宣告式映射不認（先宣告註解、再在同一個類別裡解構賦值），
> 就照 `app/models/social.py` 的寫法每個欄位各寫一次 `mapped_column(...)`，刪掉 `_timestamps`——行為一樣，回報一行。

`app/models/__init__.py`：加 `from app.models.body import ActivityLevel, Goal, Sex, UserProfile, WeightEntry`，五個名字照字母順序放進 `__all__`。

- [ ] **Step 2：migration。** `migrations/versions/0019_create_body_tables.py`（格式照 `0018`）：

```python
"""create body tables

Revision ID: 0019
Revises: 0018
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0019"
down_revision: str | None = "0018"
branch_labels: Sequence[str] | None = None
depends_on: Sequence[str] | None = None


def _timestamps() -> list[sa.Column]:
    return [
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
    ]


def _enum(name: str, *values: str, length: int) -> sa.Enum:
    return sa.Enum(*values, name=name, native_enum=False, create_constraint=False, length=length)


def _user_fk(table: str) -> sa.ForeignKeyConstraint:
    return sa.ForeignKeyConstraint(
        ["user_id"], ["users.id"], name=f"fk_{table}_user_id_users", ondelete="CASCADE"
    )


def upgrade() -> None:
    # 只有新表：舊版程式不讀不寫它們，所以這一版可以退版，
    # 不用進 deploy.sh 的 ROLLBACK_UNSAFE_REVISIONS。
    op.create_table(
        "user_profiles",
        sa.Column("user_id", sa.BigInteger, nullable=False),
        sa.Column("sex", _enum("body_sex", "male", "female", length=8), nullable=True),
        sa.Column("birth_year", sa.SmallInteger, nullable=True),
        sa.Column("height_cm", sa.Numeric(4, 1), nullable=True),
        sa.Column(
            "activity_level",
            _enum(
                "activity_level",
                "sedentary",
                "light",
                "moderate",
                "active",
                "very_active",
                length=16,
            ),
            nullable=True,
        ),
        sa.Column("goal", _enum("body_goal", "lose", "maintain", "gain", length=8), nullable=True),
        sa.Column("rate_kg_per_week", sa.Numeric(3, 2), nullable=True),
        sa.Column("target_weight_kg", sa.Numeric(5, 2), nullable=True),
        sa.Column("targets_applied_weight_kg", sa.Numeric(5, 2), nullable=True),
        *_timestamps(),
        sa.PrimaryKeyConstraint("user_id", name="pk_user_profiles"),
        _user_fk("user_profiles"),
        # name= 是命名慣例的輸入（同 0013、0018）：最後是 ck_user_profiles_<name>。
        sa.CheckConstraint("sex IN ('male', 'female')", name="sex_valid"),
        sa.CheckConstraint("birth_year BETWEEN 1900 AND 2100", name="birth_year_sane"),
        sa.CheckConstraint("height_cm BETWEEN 100 AND 250", name="height_range"),
        sa.CheckConstraint(
            "activity_level IN ('sedentary', 'light', 'moderate', 'active', 'very_active')",
            name="activity_level_valid",
        ),
        sa.CheckConstraint("goal IN ('lose', 'maintain', 'gain')", name="goal_valid"),
        sa.CheckConstraint("rate_kg_per_week IN (0.25, 0.50)", name="rate_valid"),
        sa.CheckConstraint("target_weight_kg BETWEEN 25 AND 350", name="target_weight_range"),
        sa.CheckConstraint(
            "targets_applied_weight_kg BETWEEN 25 AND 350", name="applied_weight_range"
        ),
    )
    op.create_table(
        "weight_entries",
        sa.Column("user_id", sa.BigInteger, nullable=False),
        sa.Column("date", sa.Date, nullable=False),
        sa.Column("weight_kg", sa.Numeric(5, 2), nullable=False),
        *_timestamps(),
        sa.PrimaryKeyConstraint("user_id", "date", name="pk_weight_entries"),
        _user_fk("weight_entries"),
        sa.CheckConstraint("weight_kg BETWEEN 25 AND 350", name="weight_range"),
    )


def downgrade() -> None:
    op.drop_table("weight_entries")
    op.drop_table("user_profiles")
```

- [ ] **Step 3：factories。** `tests/factories.py` 加（import `Sex`、`ActivityLevel`、`Goal`、`UserProfile`、`WeightEntry`）：

```python
async def create_profile(
    db_session: AsyncSession,
    *,
    user: User,
    sex: Sex | None = Sex.MALE,
    birth_year: int | None = 1990,
    height_cm: Decimal | int | str | None = 175,
    activity_level: ActivityLevel | None = ActivityLevel.MODERATE,
    goal: Goal | None = Goal.LOSE,
    rate_kg_per_week: Decimal | str | None = "0.5",
    target_weight_kg: Decimal | int | str | None = None,
    targets_applied_weight_kg: Decimal | int | str | None = None,
) -> UserProfile:
    """預設是規格 §3.2 那一位（男、1990、175 cm、中度、減重每週 0.5）——配上 80 kg 的體重
    與 2026-10-14 的「今天」就是 2110 kcal。"""

    def dec(value: Decimal | int | str | None) -> Decimal | None:
        return None if value is None else Decimal(str(value))

    profile = UserProfile(
        user_id=user.id,
        sex=sex,
        birth_year=birth_year,
        height_cm=dec(height_cm),
        activity_level=activity_level,
        goal=goal,
        rate_kg_per_week=dec(rate_kg_per_week),
        target_weight_kg=dec(target_weight_kg),
        targets_applied_weight_kg=dec(targets_applied_weight_kg),
    )
    db_session.add(profile)
    await db_session.commit()
    return profile


async def create_weight(
    db_session: AsyncSession, *, user: User, day: date, weight_kg: Decimal | int | str = 80
) -> WeightEntry:
    entry = WeightEntry(user_id=user.id, date=day, weight_kg=Decimal(str(weight_kg)))
    db_session.add(entry)
    await db_session.commit()
    return entry
```

- [ ] **Step 4：約束的測試。** `tests/test_body_model.py`：

```python
"""兩張表的約束與 cascade（身體資料規格 §4）。每一條「擋下來」都斷言是**哪一個**約束
（handover §6 第 13 種：別的約束先擋也是 IntegrityError）。"""

from datetime import date

import pytest
from sqlalchemy import delete, func, select, text
from sqlalchemy.exc import IntegrityError

from app.models.body import UserProfile, WeightEntry
from app.models.user import User
from tests.factories import create_profile, create_user, create_weight

PROFILE_INSERT = (
    "INSERT INTO user_profiles (user_id, sex, birth_year, height_cm, activity_level, goal,"
    " rate_kg_per_week, target_weight_kg, targets_applied_weight_kg)"
    " VALUES (:user_id, :sex, :birth_year, :height_cm, :activity_level, :goal,"
    " :rate, :target, :applied)"
)
VALID = {
    "sex": "female",
    "birth_year": 1990,
    "height_cm": 160,
    "activity_level": "light",
    "goal": "gain",
    "rate": 0.25,
    "target": 60,
    "applied": 55,
}


async def _insert_profile(db_session, user_id: int, **overrides) -> None:
    async with db_session.begin_nested():
        await db_session.execute(text(PROFILE_INSERT), {**VALID, "user_id": user_id, **overrides})


async def test_a_valid_profile_and_an_all_null_profile_both_insert(db_session):
    first, second = await create_user(db_session), await create_user(db_session)
    first_id, second_id = first.id, second.id

    await _insert_profile(db_session, first_id)
    await _insert_profile(
        db_session,
        second_id,
        sex=None,
        birth_year=None,
        height_cm=None,
        activity_level=None,
        goal=None,
        rate=None,
        target=None,
        applied=None,
    )

    count = await db_session.scalar(
        select(func.count()).select_from(UserProfile).where(
            UserProfile.user_id.in_([first_id, second_id])
        )
    )
    assert count == 2


@pytest.mark.parametrize(
    ("field", "value", "constraint"),
    [
        ("sex", "other", "ck_user_profiles_sex_valid"),
        ("birth_year", 1899, "ck_user_profiles_birth_year_sane"),
        ("height_cm", 99.9, "ck_user_profiles_height_range"),
        ("height_cm", 250.1, "ck_user_profiles_height_range"),
        ("activity_level", "extreme", "ck_user_profiles_activity_level_valid"),
        ("goal", "bulk", "ck_user_profiles_goal_valid"),
        ("rate", 0.3, "ck_user_profiles_rate_valid"),
        ("target", 24.99, "ck_user_profiles_target_weight_range"),
        ("applied", 350.01, "ck_user_profiles_applied_weight_range"),
    ],
)
async def test_each_profile_check_rejects_its_own_bad_value(db_session, field, value, constraint):
    """只改一個欄位，其他都是 VALID——擋下來的一定是那個欄位的約束。"""
    user = await create_user(db_session)
    user_id = user.id

    with pytest.raises(IntegrityError) as caught:
        await _insert_profile(db_session, user_id, **{field: value})

    assert constraint in str(caught.value.orig)


@pytest.mark.parametrize(
    ("field", "value"), [("height_cm", 100), ("height_cm", 250), ("target", 25), ("target", 350)]
)
async def test_the_range_edges_are_inclusive(db_session, field, value):
    user = await create_user(db_session)
    user_id = user.id

    await _insert_profile(db_session, user_id, **{field: value})


async def test_one_weight_per_user_per_day(db_session):
    user = await create_user(db_session)
    user_id = user.id
    await create_weight(db_session, user=user, day=date(2026, 10, 1), weight_kg=70)

    with pytest.raises(IntegrityError) as caught:
        async with db_session.begin_nested():
            await db_session.execute(
                text("INSERT INTO weight_entries (user_id, date, weight_kg) VALUES (:u, :d, 71)"),
                {"u": user_id, "d": date(2026, 10, 1)},
            )

    assert "pk_weight_entries" in str(caught.value.orig)


@pytest.mark.parametrize("weight", [24.99, 350.01])
async def test_a_weight_out_of_range_is_rejected(db_session, weight):
    user = await create_user(db_session)
    user_id = user.id

    with pytest.raises(IntegrityError) as caught:
        async with db_session.begin_nested():
            await db_session.execute(
                text("INSERT INTO weight_entries (user_id, date, weight_kg) VALUES (:u, :d, :w)"),
                {"u": user_id, "d": date(2026, 10, 1), "w": weight},
            )

    assert "ck_weight_entries_weight_range" in str(caught.value.orig)


async def test_deleting_a_user_takes_the_profile_and_the_weights(db_session):
    user = await create_user(db_session)
    other = await create_user(db_session)
    await create_profile(db_session, user=user)
    await create_profile(db_session, user=other)
    await create_weight(db_session, user=user, day=date(2026, 10, 1))
    await create_weight(db_session, user=other, day=date(2026, 10, 1))
    user_id, other_id = user.id, other.id

    await db_session.execute(delete(User).where(User.id == user_id))
    await db_session.commit()

    profiles = (await db_session.scalars(select(UserProfile.user_id))).all()
    weights = (await db_session.scalars(select(WeightEntry.user_id))).all()
    assert user_id not in profiles and user_id not in weights
    # 別人的還在：cascade 沒有多刪。
    assert other_id in profiles and other_id in weights
```

- [ ] **Step 5：跑。**

```bash
./.venv/Scripts/python.exe -m pytest -q -W error tests/test_body_model.py
```

Expected：PASS（18 條）。接著 `alembic check`（執行環境那一行）——Expected：`No new upgrade operations detected.`。再驗退版：

```bash
export DATABASE_URL="postgresql+asyncpg://wallet:wallet@localhost:5433/wallet_test"
./.venv/Scripts/python.exe -m alembic downgrade -1 && ./.venv/Scripts/python.exe -m alembic current
./.venv/Scripts/python.exe -m alembic upgrade head && ./.venv/Scripts/python.exe -m alembic current
unset DATABASE_URL
```

Expected：`0018`，然後 `0019 (head)`。

- [ ] **Step 6：突變。** 各改一處、看指定測試紅、改回（模型與 migration 是**同一份約束的兩處**：測試資料庫由 migration 建，所以突變要改 migration）：
  1. migration 的 `height_range` 改成 `height_cm > 100 AND height_cm < 250` → `test_the_range_edges_are_inclusive` 紅。
  2. migration 拿掉 `rate_valid` → `test_each_profile_check_rejects_its_own_bad_value[rate-…]` 紅。
  3. migration 的 `_user_fk` 拿掉 `ondelete="CASCADE"` → `test_deleting_a_user_takes_the_profile_and_the_weights` 紅（`users` 刪不掉，FK 擋下來）。
  4. 模型拿掉 `rate_valid`（migration 不動）→ `alembic check` 報漂移（`remove_constraint`）。

  改回、`touch`、刪 pyc，`git diff` 確認乾淨，重跑 Step 5 全綠。

- [ ] **Step 7：檢查與 commit。**

```bash
./.venv/Scripts/python.exe -m ruff check . && ./.venv/Scripts/python.exe -m mypy app
git add app/models/body.py app/models/__init__.py migrations/versions/0019_create_body_tables.py tests/factories.py tests/test_body_model.py
```

訊息（`$S/body-t1-msg.txt`）：`feat(body): 身體資料與體重的兩張表（migration 0019）`，內文一兩行說明主鍵與手寫 CHECK。

---

## Task 2：後端——建議目標的公式（純函式）

**Files:**
- Create: `app/body_targets.py`、`tests/test_body_targets.py`

- [ ] **Step 1：先寫測試。** `tests/test_body_targets.py`（數字是規格 §3 的五組，腳本算過）：

```python
"""建議目標的公式（身體資料規格 §3）。全部是手算得出來的數字；年齡用固定的今天。"""

from datetime import date
from decimal import Decimal

import pytest

from app.body_targets import BodyInputs, Suggestion, round_half_up, suggest
from app.models.body import ActivityLevel, Goal, Sex

TODAY = date(2026, 10, 14)
D = Decimal


def inputs(**overrides) -> BodyInputs:
    base = {
        "sex": Sex.MALE,
        "birth_year": 1990,
        "height_cm": D(175),
        "activity_level": ActivityLevel.MODERATE,
        "goal": Goal.LOSE,
        "rate_kg_per_week": D("0.5"),
        "weight_kg": D(80),
    }
    return BodyInputs(**{**base, **overrides})


def macros(result: Suggestion | list) -> tuple:
    assert isinstance(result, Suggestion)
    return (result.kcal, result.protein_g, result.fat_g, result.carb_g)


def test_case_a_the_worked_example():
    result = suggest(inputs(), TODAY)

    assert isinstance(result, Suggestion)
    assert (result.bmr, result.tdee, result.adjustment_kcal) == (D(1719), D(2664), D(-550))
    assert result.floor_applied is False
    assert result.floor_kcal == D(1500)
    assert macros(result) == (D(2110), D(144), D(59), D(251))


def test_case_b_the_floor_applies():
    result = suggest(
        inputs(
            sex=Sex.FEMALE,
            birth_year=1960,
            height_cm=D(155),
            weight_kg=D(50),
            activity_level=ActivityLevel.SEDENTARY,
        ),
        TODAY,
    )

    assert isinstance(result, Suggestion)
    assert (result.bmr, result.tdee) == (D(978), D(1173))
    assert result.floor_applied is True
    assert result.floor_kcal == D(1200)
    assert macros(result) == (D(1200), D(90), D(33), D(136))


def test_case_c_gain_adds():
    result = suggest(
        inputs(
            birth_year=2000,
            height_cm=D(180),
            weight_kg=D(70),
            activity_level=ActivityLevel.ACTIVE,
            goal=Goal.GAIN,
            rate_kg_per_week=D("0.25"),
        ),
        TODAY,
    )

    assert isinstance(result, Suggestion)
    assert (result.bmr, result.tdee, result.adjustment_kcal) == (D(1700), D(2933), D(275))
    assert macros(result) == (D(3210), D(140), D(89), D(462))


def test_case_d_maintain_ignores_the_rate():
    """速度是 0.5，但目標是維持：調整是 0。"""
    result = suggest(
        inputs(
            sex=Sex.FEMALE,
            birth_year=1985,
            height_cm=D(165),
            weight_kg=D(60),
            activity_level=ActivityLevel.LIGHT,
            goal=Goal.MAINTAIN,
            rate_kg_per_week=D("0.5"),
        ),
        TODAY,
    )

    assert isinstance(result, Suggestion)
    assert (result.bmr, result.tdee, result.adjustment_kcal) == (D(1265), D(1740), D(0))
    assert macros(result) == (D(1740), D(96), D(48), D(231))


def test_case_e_carbs_are_clamped_at_zero():
    result = suggest(
        inputs(
            sex=Sex.FEMALE,
            birth_year=1926,
            height_cm=D(100),
            weight_kg=D(150),
            activity_level=ActivityLevel.SEDENTARY,
        ),
        TODAY,
    )

    assert isinstance(result, Suggestion)
    assert result.floor_applied is False
    assert macros(result) == (D(1210), D(270), D(34), D(0))


def test_the_floor_is_judged_on_the_raw_value_not_the_rounded_one():
    """原始 1499.2：四捨五入到 10 是 1500、不低於下限；但原始值低於下限——下限有套用（D8）。
    男、40 歲、170 cm、61.1 kg、久坐、減 0.25：BMR 611 + 1062.5 − 200 + 5 = 1478.5；
    TDEE 1774.2；原始 1499.2。"""
    result = suggest(
        inputs(
            birth_year=1986,
            height_cm=D(170),
            weight_kg=D("61.1"),
            activity_level=ActivityLevel.SEDENTARY,
            rate_kg_per_week=D("0.25"),
        ),
        TODAY,
    )

    assert isinstance(result, Suggestion)
    assert result.floor_applied is True
    assert result.kcal == D(1500)


def test_case_f_carbs_use_the_rounded_protein():
    """蛋白質有小數（1.8 × 68.4 = 123.12）：碳水要用四捨五入後的 123 算，四個數字才自洽。
    男、30 歲、172.5 cm、非常高、減 0.25 → 原始 2797.5375 → 2800；
    (2800 − 492 − 702) / 4 = 401.5 → 402（用 123.12 算是 401.38 → 401）。"""
    result = suggest(
        inputs(
            birth_year=1996,
            height_cm=D("172.5"),
            weight_kg=D("68.4"),
            activity_level=ActivityLevel.VERY_ACTIVE,
            rate_kg_per_week=D("0.25"),
        ),
        TODAY,
    )

    assert macros(result) == (D(2800), D(123), D(78), D(402))


def test_age_comes_from_the_year_of_today_that_was_passed_in():
    """同一份資料，今天換成隔年：年齡多一歲，BMR 少 5。"""
    this_year = suggest(inputs(), TODAY)
    next_year = suggest(inputs(), date(2027, 1, 1))

    assert isinstance(this_year, Suggestion) and isinstance(next_year, Suggestion)
    assert this_year.bmr - next_year.bmr == D(5)


@pytest.mark.parametrize(
    ("value", "step", "expected"),
    [
        (D("2105"), D(10), D(2110)),  # 銀行家捨入會給 2100
        (D("400.5"), D(1), D(401)),  # 銀行家捨入會給 400
        (D("58.49"), D(1), D(58)),
        (D("-550"), D(1), D(-550)),
    ],
)
def test_round_half_up(value, step, expected):
    assert round_half_up(value, step) == expected


ALL_MISSING = [
    "sex",
    "birth_year",
    "height_cm",
    "activity_level",
    "goal",
    "rate_kg_per_week",
    "weight",
]


def test_everything_missing_is_listed_in_order():
    empty = BodyInputs(None, None, None, None, None, None, None)

    # 目標沒填時速度也算缺：不知道要不要速度，就先要。
    assert suggest(empty, TODAY) == ALL_MISSING


@pytest.mark.parametrize(
    ("field", "name"),
    [
        ("sex", "sex"),
        ("birth_year", "birth_year"),
        ("height_cm", "height_cm"),
        ("activity_level", "activity_level"),
        ("goal", "goal"),
        ("rate_kg_per_week", "rate_kg_per_week"),
        ("weight_kg", "weight"),
    ],
)
def test_each_single_missing_input_is_named(field, name):
    assert suggest(inputs(**{field: None}), TODAY) == [name]


def test_maintain_does_not_need_a_rate():
    result = suggest(inputs(goal=Goal.MAINTAIN, rate_kg_per_week=None), TODAY)

    assert isinstance(result, Suggestion)
    assert result.adjustment_kcal == D(0)
```

- [ ] **Step 2：跑，看它紅。** `./.venv/Scripts/python.exe -m pytest -q -W error tests/test_body_targets.py` → Expected：FAIL（`ModuleNotFoundError: app.body_targets`）。

- [ ] **Step 3：實作。** `app/body_targets.py`：

```python
"""建議目標的公式（身體資料規格 §3）。純函式：不碰資料庫，「今天」由呼叫端給。

**全程 Decimal、ROUND_HALF_UP。** 浮點的 1.55 × 1718.75 不是 2664.0625；Python 內建的
`round()` 是銀行家捨入（2105 → 2100、400.5 → 400），跟手算、跟使用者的直覺都不一樣。

公式（Mifflin-St Jeor）：
    男 BMR = 10·kg + 6.25·cm − 5·歲 + 5；女 BMR = 10·kg + 6.25·cm − 5·歲 − 161
    TDEE = BMR × 活動係數；熱量 = TDEE ∓ 每週速度 × 7700 / 7
    下限：女 1200、男 1500（看**原始值**，D8）；否則四捨五入到 10
    蛋白質 = g/kg × 目前體重；脂肪 = 熱量 25% / 9；碳水 = 剩下的 / 4，不小於 0
"""

from dataclasses import dataclass
from datetime import date
from decimal import ROUND_HALF_UP, Decimal
from typing import Literal

from app.models.body import ActivityLevel, Goal, Sex

ACTIVITY_FACTORS: dict[ActivityLevel, Decimal] = {
    ActivityLevel.SEDENTARY: Decimal("1.2"),
    ActivityLevel.LIGHT: Decimal("1.375"),
    ActivityLevel.MODERATE: Decimal("1.55"),
    ActivityLevel.ACTIVE: Decimal("1.725"),
    ActivityLevel.VERY_ACTIVE: Decimal("1.9"),
}
PROTEIN_PER_KG: dict[Goal, Decimal] = {
    Goal.LOSE: Decimal("1.8"),
    Goal.MAINTAIN: Decimal("1.6"),
    Goal.GAIN: Decimal("2.0"),
}
KCAL_FLOOR: dict[Sex, Decimal] = {Sex.FEMALE: Decimal(1200), Sex.MALE: Decimal(1500)}
KCAL_PER_KG_BODY_WEIGHT = Decimal(7700)
FAT_SHARE = Decimal("0.25")
# 最新體重跟套用時差這麼多（含）就提示重算（D17）。
RESUGGEST_THRESHOLD_KG = Decimal(1)

MissingInput = Literal[
    "sex", "birth_year", "height_cm", "activity_level", "goal", "rate_kg_per_week", "weight"
]


@dataclass(frozen=True)
class BodyInputs:
    sex: Sex | None
    birth_year: int | None
    height_cm: Decimal | None
    activity_level: ActivityLevel | None
    goal: Goal | None
    rate_kg_per_week: Decimal | None
    weight_kg: Decimal | None


@dataclass(frozen=True)
class Suggestion:
    kcal: Decimal
    protein_g: Decimal
    fat_g: Decimal
    carb_g: Decimal
    bmr: Decimal
    tdee: Decimal
    adjustment_kcal: Decimal
    floor_applied: bool
    floor_kcal: Decimal


def round_half_up(value: Decimal, step: Decimal = Decimal(1)) -> Decimal:
    """四捨五入到 `step` 的倍數（`step=10`：2105 → 2110）。"""
    return (value / step).quantize(Decimal(1), rounding=ROUND_HALF_UP) * step


def missing_inputs(inputs: BodyInputs) -> list[MissingInput]:
    """缺什麼（D11 的固定順序）。速度只有減重、增重要；目標還沒填時也算缺。"""
    missing: list[MissingInput] = []
    if inputs.sex is None:
        missing.append("sex")
    if inputs.birth_year is None:
        missing.append("birth_year")
    if inputs.height_cm is None:
        missing.append("height_cm")
    if inputs.activity_level is None:
        missing.append("activity_level")
    if inputs.goal is None:
        missing.append("goal")
    if inputs.goal is not Goal.MAINTAIN and inputs.rate_kg_per_week is None:
        missing.append("rate_kg_per_week")
    if inputs.weight_kg is None:
        missing.append("weight")
    return missing


def suggest(inputs: BodyInputs, today: date) -> Suggestion | list[MissingInput]:
    """完整就回建議，不完整就回缺什麼（D11）。"""
    sex, birth_year, height = inputs.sex, inputs.birth_year, inputs.height_cm
    activity, goal, weight = inputs.activity_level, inputs.goal, inputs.weight_kg
    rate = Decimal(0) if goal is Goal.MAINTAIN else inputs.rate_kg_per_week
    if (
        sex is None
        or birth_year is None
        or height is None
        or activity is None
        or goal is None
        or rate is None
        or weight is None
    ):
        # 跟 missing_inputs 是同一組條件；兩邊漂移由「每一種單獨缺」的測試抓。
        return missing_inputs(inputs)

    age = today.year - birth_year  # D7：只有出生年
    bmr = (
        Decimal(10) * weight
        + Decimal("6.25") * height
        - Decimal(5) * age
        + (Decimal(5) if sex is Sex.MALE else Decimal(-161))
    )
    tdee = bmr * ACTIVITY_FACTORS[activity]
    step = rate * KCAL_PER_KG_BODY_WEIGHT / Decimal(7)
    adjustment = {Goal.LOSE: -step, Goal.MAINTAIN: Decimal(0), Goal.GAIN: step}[goal]
    raw = tdee + adjustment

    floor = KCAL_FLOOR[sex]
    floor_applied = raw < floor  # D8：看原始值
    kcal = floor if floor_applied else round_half_up(raw, Decimal(10))

    protein = round_half_up(PROTEIN_PER_KG[goal] * weight)
    fat = round_half_up(kcal * FAT_SHARE / Decimal(9))
    # 用已經四捨五入的蛋白質與脂肪：四個數字加起來對得上熱量（誤差在四捨五入內）。
    carb = max(Decimal(0), round_half_up((kcal - protein * 4 - fat * 9) / Decimal(4)))

    return Suggestion(
        kcal=kcal,
        protein_g=protein,
        fat_g=fat,
        carb_g=carb,
        bmr=round_half_up(bmr),
        tdee=round_half_up(tdee),
        adjustment_kcal=round_half_up(adjustment),
        floor_applied=floor_applied,
        floor_kcal=floor,
    )
```

- [ ] **Step 4：跑。** 同 Step 2 → Expected：PASS（21 條）。

- [ ] **Step 5：突變**（各一處、看指定測試紅、改回；`app/body_targets.py` 是新檔案，先 `cp` 一份備份）：
  1. 女的 `-161` 改成 `-151` → case B、D、E 紅。
  2. `ROUND_HALF_UP` 改成 `ROUND_HALF_EVEN` → `test_round_half_up[2105…]`、`[400.5…]` 紅。
  3. `floor_applied = raw < floor` 改成 `round_half_up(raw, Decimal(10)) < floor` → `test_the_floor_is_judged_on_the_raw_value…` 紅（1499.2 四捨五入是 1500，突變版說「沒套用」）。
  4. `max(Decimal(0), …)` 拿掉 → case E 紅。
  5. `rate = Decimal(0) if goal is Goal.MAINTAIN else …` 改成永遠用 `inputs.rate_kg_per_week` → `test_maintain_does_not_need_a_rate` 紅（維持、速度 null 也被當成缺）。（case D 存活：維持的調整在 dict 裡本來就是 0——這是預期的。）
  6. `missing_inputs` 裡 `weight` 那一段拿掉 → `test_each_single_missing_input_is_named[weight_kg-weight]` 紅（`suggest` 回 `[]`）。
  7. 碳水的算式改用沒四捨五入的蛋白質（`PROTEIN_PER_KG[goal] * weight`）→ `test_case_f_carbs_use_the_rounded_protein` 紅（A–E 的蛋白質都是整數，全部存活——這就是 F 存在的理由）。

  `diff` 備份確認改回，`git status` 乾淨（除了新檔案）。

- [ ] **Step 6：commit。** `ruff check .`、`mypy app` 通過後：

```bash
git add app/body_targets.py tests/test_body_targets.py
```

訊息（`$S/body-t2-msg.txt`）：`feat(body): 建議目標的公式——Mifflin-St Jeor、下限、三大營養素（純函式）`。

---

## Task 3：後端——身體資料端點與 `GET /api/me/target-suggestion`

**Files:**
- Create: `app/schemas/body.py`、`app/body_data.py`、`app/api/routes/body.py`、`tests/test_body_profile.py`、`tests/test_target_suggestion.py`
- Modify: `app/main.py`、`frontend/src/api/schema.d.ts`

- [ ] **Step 1：schema。** `app/schemas/body.py`（這個 task 先寫身體資料與建議；體重與套用的形狀在 Task 4、5 加進同一個檔案）：

```python
"""身體資料、建議目標、體重的請求與回應（身體資料規格 §5）。健康資料：這些形狀只出現在
身體資料的端點，好友與社群的回應不准引用（`tests/test_body_privacy.py`）。"""

from datetime import date
from decimal import Decimal
from typing import Literal

from pydantic import BaseModel, Field, field_validator

from app.body_targets import MissingInput
from app.models.body import ActivityLevel, Goal, Sex

RATES = (Decimal("0.25"), Decimal("0.5"))


class BodyProfileRequest(BaseModel):
    """`PUT /api/me/body-profile`：**七個鍵都必填、值可以 null**（D5，同 `TargetTodayRequest`）。

    出生年這裡只擋衛生範圍（同資料庫的 CHECK）；「今年 − 100 到今年 − 13」要知道使用者的
    今天，在端點擋（D4）。"""

    sex: Sex | None
    birth_year: int | None = Field(ge=1900, le=2100)
    height_cm: Decimal | None = Field(ge=100, le=250, max_digits=4, decimal_places=1)
    activity_level: ActivityLevel | None
    goal: Goal | None
    rate_kg_per_week: Decimal | None = Field(max_digits=3, decimal_places=2)
    target_weight_kg: Decimal | None = Field(ge=25, le=350, max_digits=5, decimal_places=2)

    @field_validator("rate_kg_per_week")
    @classmethod
    def _rate_is_one_of_two(cls, value: Decimal | None) -> Decimal | None:
        if value is not None and value not in RATES:
            raise ValueError("速度只能是每週 0.25 或 0.5 公斤")
        return value


class BodyProfileResponse(BaseModel):
    """沒有那一列＝七個都是 null（不是 404）。**不含** `targets_applied_weight_kg`（內部用）。"""

    sex: Sex | None
    birth_year: int | None
    height_cm: Decimal | None
    activity_level: ActivityLevel | None
    goal: Goal | None
    rate_kg_per_week: Decimal | None
    target_weight_kg: Decimal | None


class SuggestionReady(BaseModel):
    """建議目標（D10：跟 `SuggestionMissing` 是普通聯集，不加 discriminator——加了
    openapi-typescript 會產生 `ready: "True"`）。"""

    ready: Literal[True]
    kcal: Decimal
    protein_g: Decimal
    fat_g: Decimal
    carb_g: Decimal
    bmr: Decimal
    tdee: Decimal
    adjustment_kcal: Decimal
    floor_applied: bool
    floor_kcal: Decimal
    weight_kg: Decimal
    based_on_date: date
    applied_weight_kg: Decimal | None
    weight_change_kg: Decimal | None
    resuggest: bool


class SuggestionMissing(BaseModel):
    ready: Literal[False]
    missing: list[MissingInput]
```

> 必填但可為 null 的寫法：`sex: Sex | None`（沒有預設值）在 Pydantic v2 是必填；有 `Field(...)` 而沒有 `default=` 的也是（同 `TargetTodayRequest`）。

- [ ] **Step 2：讀資料的小函式。** `app/body_data.py`：

```python
"""身體資料端點共用的讀寫（身體資料規格 §5）。只用呼叫端給的 user_id——沒有「讀別人的」這條路。"""

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.body_targets import BodyInputs
from app.models.body import UserProfile, WeightEntry


async def load_profile(db: AsyncSession, user_id: int) -> UserProfile | None:
    return await db.scalar(select(UserProfile).where(UserProfile.user_id == user_id))


async def latest_weight(db: AsyncSession, user_id: int) -> WeightEntry | None:
    """**日期**最新的一筆（不是最後寫的那一筆：補記上週的不會變成「目前體重」）。"""
    return await db.scalar(
        select(WeightEntry)
        .where(WeightEntry.user_id == user_id)
        .order_by(WeightEntry.date.desc())
        .limit(1)
    )


def inputs_from(profile: UserProfile | None, latest: WeightEntry | None) -> BodyInputs:
    return BodyInputs(
        sex=profile.sex if profile else None,
        birth_year=profile.birth_year if profile else None,
        height_cm=profile.height_cm if profile else None,
        activity_level=profile.activity_level if profile else None,
        goal=profile.goal if profile else None,
        rate_kg_per_week=profile.rate_kg_per_week if profile else None,
        weight_kg=latest.weight_kg if latest else None,
    )


async def clear_applied_weight(db: AsyncSession, user_id: int) -> None:
    """手動存目標時呼叫（D16）。不 commit：跟目標在同一個交易。沒有那一列就什麼都不做。"""
    await db.execute(
        update(UserProfile)
        .where(UserProfile.user_id == user_id)
        .values(targets_applied_weight_kg=None)
    )
```

- [ ] **Step 3：先寫測試。** `tests/test_body_profile.py`（`auth()` 同 `test_targets_today.py`；`today` 夾具 monkeypatch `app.api.routes.body.today_in_timezone`，固定 `date(2026, 10, 14)` 並記下時區）。`FULL` 是一組完整的請求：

```python
FULL = {
    "sex": "female",
    "birth_year": 1990,
    "height_cm": "162.5",
    "activity_level": "light",
    "goal": "lose",
    "rate_kg_per_week": "0.25",
    "target_weight_kg": "55",
}
```

測試清單（每條一兩個斷言；寫法照既有的端點測試）：

1. `test_an_empty_profile_is_all_nulls_not_404`：沒有列 → 200、七個鍵都是 `None`、**沒有** `targets_applied_weight_kg` 這個鍵。
2. `test_put_saves_the_whole_profile_and_get_reads_it_back`：PUT `FULL` → 200，回應等於 `FULL`（數字比 `Decimal`）；再 GET 一樣；資料庫裡只有一列。
3. `test_a_second_put_replaces_every_field`：先 PUT `FULL`，再 PUT 一組全部不同（含 `target_weight_kg: None`）→ 資料庫那一列是第二組（`target_weight_kg` 是 null），`created_at` 不變。
4. `test_put_does_not_touch_the_applied_weight`：`create_profile(..., targets_applied_weight_kg=80)` 之後 PUT `FULL` → 資料庫裡仍然是 80（`set_` 只放七個欄位）。
5. `test_every_key_is_required`（parametrize 七個鍵）：拿掉一個 → 422。
6. `test_out_of_range_values_are_422`（parametrize）：`height_cm` 99.9／250.1／`"170.25"`（兩位小數）、`target_weight_kg` 24.99／350.01、`rate_kg_per_week` `"0.3"`、`sex` `"other"`、`activity_level` `"extreme"`、`goal` `"bulk"` → 422；邊界 100、250、25、350、`"0.50"` → 200。
7. `test_birth_year_is_judged_by_the_users_today`（parametrize `(1926, 200)`、`(1925, 422)`、`(2013, 200)`、`(2014, 422)`）：使用者時區設 `America/New_York`；422 的 `error.code` 是 `BIRTH_YEAR_OUT_OF_RANGE`、訊息含「1926」與「2013」；`seen_timezones == ["America/New_York"]`。
8. `test_maintain_keeps_whatever_rate_was_sent`：`goal: "maintain"`、`rate_kg_per_week: "0.5"` → 存 0.5（D3：不清掉，切回減重還在）。
9. `test_someone_elses_profile_is_untouched`：A PUT `FULL`；B GET 是全 null；B PUT 另一組之後 A 的那一列沒變（**先**證明 A 讀得到自己的）。
10. `test_it_needs_a_login`：GET、PUT 不帶 token → 401。

`tests/test_target_suggestion.py`（這個 task 只寫 GET；`today` 同上 monkeypatch `app.api.routes.body.today_in_timezone`，固定 2026-10-14）：

1. `test_the_worked_example`：`create_profile(user=…)`（預設值）＋ `create_weight(day=2026-10-10, weight_kg=80)` → 回應等於

   ```python
   {
       "ready": True, "kcal": "2110", "protein_g": "144", "fat_g": "59", "carb_g": "251",
       "bmr": "1719", "tdee": "2664", "adjustment_kcal": "-550", "floor_applied": False,
       "floor_kcal": "1500", "weight_kg": "80.00", "based_on_date": "2026-10-10",
       "applied_weight_kg": None, "weight_change_kg": None, "resuggest": False,
   }
   ```

   （數字欄位用 `Decimal(body[k]) == Decimal(v)` 比，不比字串的小數位數。）
2. `test_the_latest_weight_is_by_date_not_by_insertion`：先建 10/10 的 80，再建 10/01 的 90 → `weight_kg` 是 80、`based_on_date` 是 10/10。
3. `test_nothing_set_lists_everything_missing`：沒有列、沒有體重 → `{"ready": False, "missing": [七個]}`（順序同 Task 2）。
4. `test_a_profile_without_a_weight_is_missing_only_the_weight`。
5. `test_resuggest_threshold`（parametrize `(applied, latest, change, resuggest)`：`("80", "79.01", "-0.99", False)`、`("80", "79", "-1.00", True)`、`("80", "81", "1.00", True)`、`(None, "81", None, False)`）。
6. `test_someone_elses_weight_does_not_count`：A 有完整的資料與體重（先證明 A 是 ready）；B 有完整的資料、沒有體重 → B 是 `missing: ["weight"]`。
7. `test_it_uses_the_users_timezone`：時區 `America/New_York` → 夾具記到它。

- [ ] **Step 4：跑，看它紅。** `pytest -q -W error tests/test_body_profile.py tests/test_target_suggestion.py` → Expected：FAIL（404：路由還不存在）。

- [ ] **Step 5：路由。** `app/api/routes/body.py`：

```python
"""身體資料與建議目標（身體資料規格 §5.1、§5.2）。只讀寫自己的：路徑上沒有使用者 id。

健康資料：這個模組不寫 log（`tests/test_body_privacy.py` 掃這個檔案，連註解都不能出現那幾個字）。"""

from decimal import Decimal

from fastapi import APIRouter, Depends
from sqlalchemy import func
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.body_data import inputs_from, latest_weight, load_profile
from app.body_targets import RESUGGEST_THRESHOLD_KG, suggest
from app.days import today_in_timezone
from app.db import get_db
from app.errors import UnprocessableEntityError
from app.models.body import UserProfile
from app.models.user import User
from app.schemas.body import (
    BodyProfileRequest,
    BodyProfileResponse,
    SuggestionMissing,
    SuggestionReady,
)

router = APIRouter(tags=["body"])

# D4：出生年在「使用者的今年 − 100」到「今年 − 13」。
MAX_AGE = 100
MIN_AGE = 13
PROFILE_FIELDS = (
    "sex",
    "birth_year",
    "height_cm",
    "activity_level",
    "goal",
    "rate_kg_per_week",
    "target_weight_kg",
)


def _profile_response(profile: UserProfile | None) -> BodyProfileResponse:
    if profile is None:
        return BodyProfileResponse(**dict.fromkeys(PROFILE_FIELDS))
    return BodyProfileResponse(**{field: getattr(profile, field) for field in PROFILE_FIELDS})


@router.get("/me/body-profile", response_model=BodyProfileResponse)
async def read_body_profile(
    user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
) -> BodyProfileResponse:
    """自己的身體資料。還沒填過＝七個都是 null（200，不是 404）。"""
    return _profile_response(await load_profile(db, user.id))


@router.put("/me/body-profile", response_model=BodyProfileResponse)
async def save_body_profile(
    payload: BodyProfileRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> BodyProfileResponse:
    """整組取代自己的身體資料（D5）。`INSERT … ON CONFLICT DO UPDATE`：兩台裝置同時第一次存
    不會撞主鍵變 500。套用時的體重不在這裡改（`set_` 只有七個欄位）。"""
    user_id = user.id
    today = today_in_timezone(user.timezone)
    if payload.birth_year is not None:
        earliest, latest = today.year - MAX_AGE, today.year - MIN_AGE
        if not earliest <= payload.birth_year <= latest:
            raise UnprocessableEntityError(
                "BIRTH_YEAR_OUT_OF_RANGE", f"出生年要在 {earliest} 到 {latest} 之間"
            )

    values = payload.model_dump()
    statement = (
        pg_insert(UserProfile)
        .values(user_id=user_id, **values)
        .on_conflict_do_update(
            index_elements=[UserProfile.user_id],
            # ON CONFLICT 不走 ORM 的 onupdate：updated_at 自己寫。
            set_={**values, "updated_at": func.now()},
        )
        .returning(*(getattr(UserProfile, field) for field in PROFILE_FIELDS))
    )
    row = (await db.execute(statement)).one()
    await db.commit()
    return BodyProfileResponse(**row._asdict())


@router.get("/me/target-suggestion", response_model=SuggestionReady | SuggestionMissing)
async def read_target_suggestion(
    user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
) -> SuggestionReady | SuggestionMissing:
    """依身體資料與**日期最新**的體重算建議目標（規格 §3）；缺什麼就回缺什麼（D11）。

    `resuggest`：最新體重跟套用建議時的體重差 ≥ 1 公斤（D17）。從沒套用過、或之後手動改過
    目標（D16）時 `applied_weight_kg` 是 null，不提示。"""
    user_id = user.id
    today = today_in_timezone(user.timezone)
    profile = await load_profile(db, user_id)
    latest = await latest_weight(db, user_id)
    result = suggest(inputs_from(profile, latest), today)
    if isinstance(result, list):
        return SuggestionMissing(ready=False, missing=result)
    assert latest is not None  # suggest 只有在有體重時才回建議

    applied = profile.targets_applied_weight_kg if profile is not None else None
    change: Decimal | None = None if applied is None else latest.weight_kg - applied
    return SuggestionReady(
        ready=True,
        kcal=result.kcal,
        protein_g=result.protein_g,
        fat_g=result.fat_g,
        carb_g=result.carb_g,
        bmr=result.bmr,
        tdee=result.tdee,
        adjustment_kcal=result.adjustment_kcal,
        floor_applied=result.floor_applied,
        floor_kcal=result.floor_kcal,
        weight_kg=latest.weight_kg,
        based_on_date=latest.date,
        applied_weight_kg=applied,
        weight_change_kg=change,
        resuggest=change is not None and abs(change) >= RESUGGEST_THRESHOLD_KG,
    )
```

`app/main.py`：`from app.api.routes import body`（照字母順序加進既有的 import 清單），`app.include_router(body.router, prefix="/api")` 放在 `me.router` 那一行後面。

> `.returning(...)` 回來的 `sex`、`activity_level`、`goal` 是 enum 成員（欄位型別是 `Enum`）。如果 asyncpg 回的是字串而 Pydantic 照樣收（StrEnum），不用處理。

- [ ] **Step 6：跑。** 同 Step 4 → Expected：PASS（`test_body_profile.py` 約 30 條含 parametrize、`test_target_suggestion.py` 10 條）。

- [ ] **Step 7：突變**（`routes/body.py`、`body_data.py` 是新檔案，先備份）：
  1. `save_body_profile` 拿掉出生年的檢查 → 第 7 條的 `1925`、`2014` 紅。
  2. `MIN_AGE` 的比較寫成 `<`（`earliest <= birth_year < latest`）→ `2013` 那一格紅。
  3. `set_` 改成 `{**values}`（拿掉 `updated_at`）→ **存活**（`now()` 在共用交易裡不變，開工前必讀第 4 點）。記下來，不補測試。
  4. `on_conflict_do_update` 整段拿掉 → 第 3 條紅（第二次 PUT 撞主鍵：500 或 IntegrityError）。
  5. `latest_weight` 的 `.desc()` 拿掉 → `test_the_latest_weight_is_by_date_not_by_insertion` 紅。
  6. `abs(change) >= …` 改成 `change >= …` → `resuggest` 的 `-1.00` 那一格紅。
  7. `today_in_timezone(user.timezone)` 改成 `today_in_timezone("Asia/Taipei")` → 時區那兩條紅。

  改回、`touch`、刪 pyc，`diff` 備份、`git diff` 乾淨。

- [ ] **Step 8：重新產生 `schema.d.ts`**（執行環境那一段），`cd frontend && npm run -s typecheck` → 綠。

- [ ] **Step 9：檢查與 commit。** `ruff check .`、`mypy app` 通過：

```bash
git add app/schemas/body.py app/body_data.py app/api/routes/body.py app/main.py tests/test_body_profile.py tests/test_target_suggestion.py frontend/src/api/schema.d.ts
```

訊息（`$S/body-t3-msg.txt`）：`feat(body): 身體資料的讀寫與建議目標（GET /api/me/body-profile、PUT、/api/me/target-suggestion）`。

---

## Task 4：後端——體重的三個端點與 `weights.csv`

**Files:**
- Create: `app/api/routes/weights.py`、`tests/test_weights.py`、`tests/test_weights_concurrency.py`
- Modify: `app/schemas/body.py`、`app/main.py`、`app/export.py`、`app/api/routes/export.py`、`tests/test_export.py`、`frontend/src/api/schema.d.ts`

- [ ] **Step 1：schema。** `app/schemas/body.py` 加：

```python
class WeightRequest(BaseModel):
    weight_kg: Decimal = Field(ge=25, le=350, max_digits=5, decimal_places=2)


class WeightEntryResponse(BaseModel):
    date: date
    weight_kg: Decimal


class WeightListResponse(BaseModel):
    """`today` 是使用者時區的今天（D14）：前端拿它當表單的預設日期與圖表的右端，不自己算。"""

    today: date
    entries: list[WeightEntryResponse]
```

> `WeightEntryResponse` 的欄位叫 `date`、型別也是 `date`：Pydantic 的類別本體裡 `date: date` 會讓之後的註解看到欄位而不是型別。這個類別只有這一個 `date` 註解，而且在 `weight_kg` 前面——沒有問題；**不要在它後面再加用到 `date` 型別的欄位**。

- [ ] **Step 2：先寫測試。** `tests/test_weights.py`。夾具 `today` monkeypatch `app.api.routes.weights.today_in_timezone`：固定 `TODAY = date(2026, 10, 14)`、記下時區。使用者時區設 `America/New_York`。

1. `test_put_creates_then_corrects_the_same_day`：PUT `/api/weights/2026-10-14` `{"weight_kg": "80.4"}` → 200 `{"date": "2026-10-14", "weight_kg": "80.40"}`；再 PUT `"79.9"` → 200；資料庫裡那一天只有一列、值是 79.90、`created_at` 跟第一次一樣。
2. `test_the_date_boundaries_follow_the_users_today`（parametrize：`TODAY` → 200、`TODAY + 1 天` → 422 `WEIGHT_DATE_IN_FUTURE`、`TODAY − 730 天` → 200、`TODAY − 731 天` → 422 `WEIGHT_DATE_TOO_OLD`）；`seen_timezones` 都是 `America/New_York`。
3. `test_bad_weights_are_422`（parametrize `"24.99"`、`"350.01"`、`"80.123"`、`"abc"`、缺 `weight_kg`）；`"25"`、`"350"` → 200。
4. `test_a_date_that_is_not_a_date_is_422`：`/api/weights/2026-13-01`、`/api/weights/yesterday`。
5. `test_list_defaults_to_the_last_800_days_oldest_first`：建 `TODAY`、`TODAY − 799`、`TODAY − 800`、`TODAY − 3` 四筆 → `GET /api/weights` 回 `today == "2026-10-14"`、entries 是 `TODAY − 799`、`TODAY − 3`、`TODAY` 三筆（由舊到新，800 天前那筆不在）。
6. `test_list_with_a_range`：`?from=2026-10-01&to=2026-10-10` 只回範圍內（兩端都含）；只給 `from` → `to` 是今天；只給 `to` → `from` 是 `to − 799`。
7. `test_list_range_errors`：`from > to` → 422 `INVALID_RANGE`；801 天 → 422 `RANGE_TOO_LONG`；800 天 → 200。
8. `test_delete`：刪一筆 → 204、再 GET 沒有它；再刪一次 → 404 `WEIGHT_NOT_FOUND`。
9. `test_someone_elses_weights`：A 記一筆（**先**證明 A 的 GET 有它）；B 的 GET 是空的；B 刪同一天 → 404，A 的那筆還在；B PUT 同一天 → 200 但 A 的值沒變。
10. `test_it_needs_a_login`：三個端點不帶 token → 401。

- [ ] **Step 3：並行的 upsert。** `tests/test_weights_concurrency.py`：照抄 `tests/test_invites_concurrency.py` 的 `independent_sessions` 夾具與 `_wait_until_someone_else_is_lock_waiting`（或從那裡 import——那兩個是模組層級的名字），直接呼叫 `routes/weights.py` 的 `upsert_weight`（Step 5）：

```python
async def test_two_concurrent_upserts_of_the_same_day_both_succeed(independent_sessions):
    """兩個同時到的 PUT（兩台裝置）：第二個卡在第一個的列鎖上，第一個 commit 之後走
    DO UPDATE——兩個都成功、只有一列、值是後到的。換成「先查再 INSERT」的寫法，第二個會
    撞主鍵（handover §6 第 14 種：共用 session 的端點測試看不到這件事）。"""
    user = User(
        email=f"weight-race-{uuid.uuid4().hex}@example.com",
        password_hash="not-a-real-hash",
        display_name="race",
    )
    async with independent_sessions() as setup:
        setup.add(user)
        await setup.commit()
    day = date(2026, 10, 14)
    try:
        async with independent_sessions() as first, independent_sessions() as second:
            await upsert_weight(first, user.id, day, Decimal("80"))
            first_pid = await first.scalar(select(func.pg_backend_pid()))
            racing = asyncio.create_task(upsert_weight(second, user.id, day, Decimal("81")))
            async with asyncio.timeout(5.0):
                await _wait_until_someone_else_is_lock_waiting(first_pid)
            await first.commit()
            await racing
            await second.commit()
        async with independent_sessions() as check:
            rows = (
                await check.execute(
                    select(WeightEntry.weight_kg).where(WeightEntry.user_id == user.id)
                )
            ).scalars().all()
        assert rows == [Decimal("81.00")]
    finally:
        async with independent_sessions() as cleanup:
            await cleanup.execute(delete(User).where(User.id == user.id))
            await cleanup.commit()
```

> `_wait_until_someone_else_is_lock_waiting` 的簽名以那個檔案的現況為準；它等的是 `pg_stat_activity` 裡別的連線在等鎖。

- [ ] **Step 4：跑，看它紅。** → Expected：FAIL（路由、`upsert_weight` 不存在）。

- [ ] **Step 5：路由。** `app/api/routes/weights.py`：

```python
"""體重紀錄（身體資料規格 §5.3）。一人一天一筆，日期是使用者時區的日曆日；只讀寫自己的。

健康資料：這個模組不寫 log（`tests/test_body_privacy.py` 掃這個檔案，連註解都不能出現那幾個字）。"""

from datetime import date, timedelta
from decimal import Decimal

from fastapi import APIRouter, Depends, Query, Response, status
from sqlalchemy import delete, func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.days import today_in_timezone
from app.db import get_db
from app.errors import NotFoundError, UnprocessableEntityError
from app.models.body import WeightEntry
from app.models.user import User
from app.schemas.body import WeightEntryResponse, WeightListResponse, WeightRequest

router = APIRouter(prefix="/weights", tags=["weights"])

# D13：可以補記兩年內的日子。D14：清單一次最多 800 天（比兩年多一點，剛記的都在裡面）。
MAX_BACKFILL_DAYS = 730
MAX_LIST_DAYS = 800


async def upsert_weight(
    db: AsyncSession, user_id: int, day: date, weight_kg: Decimal
) -> WeightEntryResponse:
    """新增或更正那一天（D13）。不 commit。`ON CONFLICT DO UPDATE` 由資料庫決定誰先誰後：
    同一天兩個同時到的請求，後到的等先到的 commit 再更新，兩個都成功（並行測試守著）。"""
    statement = (
        pg_insert(WeightEntry)
        .values(user_id=user_id, date=day, weight_kg=weight_kg)
        .on_conflict_do_update(
            index_elements=[WeightEntry.user_id, WeightEntry.date],
            set_={"weight_kg": weight_kg, "updated_at": func.now()},
        )
        .returning(WeightEntry.date, WeightEntry.weight_kg)
    )
    row = (await db.execute(statement)).one()
    return WeightEntryResponse(date=row.date, weight_kg=row.weight_kg)


@router.put("/{day}", response_model=WeightEntryResponse)
async def put_weight(
    day: date,
    payload: WeightRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> WeightEntryResponse:
    """記（或更正）某一天的體重。日期不能是使用者的明天以後，也不能早於兩年前。"""
    user_id = user.id
    today = today_in_timezone(user.timezone)
    if day > today:
        raise UnprocessableEntityError("WEIGHT_DATE_IN_FUTURE", "不能記未來的體重")
    if day < today - timedelta(days=MAX_BACKFILL_DAYS):
        raise UnprocessableEntityError("WEIGHT_DATE_TOO_OLD", "只能補記兩年內的體重")
    saved = await upsert_weight(db, user_id, day, payload.weight_kg)
    await db.commit()
    return saved


@router.delete("/{day}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_weight(
    day: date,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> Response:
    deleted = await db.scalar(
        delete(WeightEntry)
        .where(WeightEntry.user_id == user.id, WeightEntry.date == day)
        .returning(WeightEntry.date)
    )
    if deleted is None:
        raise NotFoundError("WEIGHT_NOT_FOUND", "那一天沒有體重紀錄")
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("", response_model=WeightListResponse)
async def list_weights(
    date_from: date | None = Query(default=None, alias="from"),
    date_to: date | None = Query(default=None, alias="to"),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> WeightListResponse:
    """一段日期的體重，由舊到新，兩端都含（D14）。`to` 省略＝使用者的今天；`from` 省略＝
    `to` 往回 799 天（共 800 天）。"""
    user_id = user.id
    today = today_in_timezone(user.timezone)
    end = date_to if date_to is not None else today
    start = date_from if date_from is not None else end - timedelta(days=MAX_LIST_DAYS - 1)
    if end < start:
        raise UnprocessableEntityError("INVALID_RANGE", "結束日期不能早於開始日期")
    span = (end - start).days + 1
    if span > MAX_LIST_DAYS:
        raise UnprocessableEntityError(
            "RANGE_TOO_LONG", f"期間最多 {MAX_LIST_DAYS} 天，這次是 {span} 天"
        )
    rows = (
        await db.execute(
            select(WeightEntry.date, WeightEntry.weight_kg)
            .where(
                WeightEntry.user_id == user_id,
                WeightEntry.date >= start,
                WeightEntry.date <= end,
            )
            .order_by(WeightEntry.date)
        )
    ).all()
    return WeightListResponse(
        today=today,
        entries=[WeightEntryResponse(date=row.date, weight_kg=row.weight_kg) for row in rows],
    )
```

`app/main.py`：import `weights`，`app.include_router(weights.router, prefix="/api")`。

- [ ] **Step 6：`weights.csv`。** `app/export.py`：

```python
WEIGHT_COLUMNS = ("日期", "體重(kg)")


async def weight_csv(db: AsyncSession, *, user_id: int) -> AsyncIterator[bytes]:
    """體重：一天一列，由舊到新。日期就是記的時候選的那一天（日曆日），不用換時區。
    主鍵是 (user_id, date)，所以游標只要日期。"""
    yield encode_header(WEIGHT_COLUMNS)
    after: date | None = None
    while True:
        query = (
            select(WeightEntry.date, WeightEntry.weight_kg)
            .where(WeightEntry.user_id == user_id)
            .order_by(WeightEntry.date)
            .limit(EXPORT_CHUNK_ROWS)
        )
        if after is not None:
            query = query.where(WeightEntry.date > after)
        rows = (await db.execute(query)).all()
        if not rows:
            return
        yield encode_rows([(row.date.isoformat(), row.weight_kg) for row in rows])
        after = rows[-1].date
```

（`from datetime import date, datetime`、`from app.models.body import WeightEntry`。）`app/api/routes/export.py` 照 `export_supplements` 加：

```python
@router.get("/weights.csv", response_class=StreamingResponse, responses=_CSV_RESPONSES)
async def export_weights(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> StreamingResponse:
    """自己全部的體重：一天一列，由舊到新。"""
    return await _csv_response(db, weight_csv(db, user_id=user.id), name="weights", user=user)
```

> 先確認既有的三個匯出端點掛的依賴（`export_slot`、限速）——照它們的寫法掛，四個共用同一個額度（規格 D18）。`>` 改成 `>=` 會變成無限迴圈（handover §7）：突變時加 `timeout`。

`tests/test_export.py`：`WEIGHTS = "/api/export/weights.csv"`、`WEIGHT_HEADER = ["日期", "體重(kg)"]`；兩個既有的 parametrize（檔名與標題、要登入）各加一組；新增：

```python
async def test_weights_come_oldest_first_one_row_per_day(client, db_session, monkeypatch):
    """跨兩塊（chunk 調成 2）：三天、順序、值，而且沒有別人的。"""
    monkeypatch.setattr("app.export.EXPORT_CHUNK_ROWS", 2)
    user = await create_user(db_session)
    other = await create_user(db_session)
    for day, kg in [(date(2026, 10, 3), "70.5"), (date(2026, 10, 1), "71"), (date(2026, 10, 2), "70.8")]:
        await create_weight(db_session, user=user, day=day, weight_kg=kg)
    await create_weight(db_session, user=other, day=date(2026, 10, 1), weight_kg="99")

    response = await client.get(WEIGHTS, headers=auth(user.id))

    rows = list(csv.reader(io.StringIO(response.content.decode("utf-8-sig"))))
    assert rows == [
        WEIGHT_HEADER,
        ["2026-10-01", "71.00"],
        ["2026-10-02", "70.80"],
        ["2026-10-03", "70.50"],
    ]
```

（`EXPORT_CHUNK_ROWS` 的 monkeypatch 寫法以 `test_export.py` 現況為準；`auth()` 也是。）

- [ ] **Step 7：跑。** `pytest -q -W error tests/test_weights.py tests/test_weights_concurrency.py tests/test_export.py` → Expected：PASS。

- [ ] **Step 8：突變**（新檔案先備份；`weight_csv` 的突變用 `timeout 300`）：
  1. `if day > today` 改成 `>=` → 第 2 條的 `TODAY` 紅。
  2. `MAX_BACKFILL_DAYS` 的比較改成 `<=` → `TODAY − 730` 紅。
  3. `upsert_weight` 換成「`db.add(WeightEntry(...))` + flush」→ 第 1 條紅（第二次 PUT 撞主鍵）、並行那條紅。
  4. 只換並行那一種寫法：先 `select` 有沒有，沒有就 `insert … ON CONFLICT DO NOTHING`、有就 `update` → **端點測試全綠、只有並行那條紅**（這就是它存在的理由）。
  5. `list_weights` 的 `end - timedelta(days=MAX_LIST_DAYS - 1)` 改成 `MAX_LIST_DAYS` → 第 5 條紅（800 天前那筆跑進來）。
  6. `delete_weight` 的 `WeightEntry.user_id == user.id` 拿掉 → 第 9 條紅。
  7. `weight_csv` 的 `.where(WeightEntry.user_id == user_id)` 拿掉 → 匯出那條紅（多一列 99）。

  改回、`touch`、刪 pyc、`diff` 備份、`git diff` 乾淨。

- [ ] **Step 9：重新產生 `schema.d.ts`**、`npm run -s typecheck` 綠。

- [ ] **Step 10：commit。** `ruff check .`、`mypy app`：

```bash
git add app/schemas/body.py app/api/routes/weights.py app/main.py app/export.py app/api/routes/export.py tests/test_weights.py tests/test_weights_concurrency.py tests/test_export.py frontend/src/api/schema.d.ts
```

訊息（`$S/body-t4-msg.txt`）：`feat(body): 體重紀錄的三個端點與 weights.csv 匯出`。

---

## Task 5：後端——套用建議、手動存目標清掉套用體重、隱私掃描

**Files:**
- Create: `tests/test_body_privacy.py`
- Modify: `app/api/routes/targets.py`、`app/api/routes/body.py`、`app/schemas/body.py`、`tests/test_target_suggestion.py`、`tests/test_targets_today.py`、`frontend/src/api/schema.d.ts`

- [ ] **Step 1：抽出寫入函式（純重構，先跑既有測試）。** `app/api/routes/targets.py`：把 `set_target_from_today` 的本體搬進一個**不 commit** 的函式，留在這個模組裡（既有測試 monkeypatch 的是 `app.api.routes.targets.today_in_timezone` 與 `…._new_period_end`，搬到別的模組它們就失效了）：

```python
@dataclass(frozen=True)
class TargetValues:
    kcal: Decimal | None
    protein_g: Decimal | None
    fat_g: Decimal | None
    carb_g: Decimal | None


async def write_target_from_today(
    db: AsyncSession, user_id: int, today: date, values: TargetValues
) -> UserTarget:
    """從 `today` 起目標是這四個值（帳號設定規格 §3.1 的三種狀態）。**不 commit**：呼叫端在
    同一個交易裡還有別的要寫（手動存目標要清掉套用體重、套用建議要記下體重）。

    撞上 EXCLUDE → 整筆 rollback（連呼叫端在這之前寫的）、`409 TARGET_CONFLICT`。"""
    current = await db.scalar(
        select(UserTarget).where(
            UserTarget.user_id == user_id,
            UserTarget.effective_from <= today,
            or_(UserTarget.effective_to.is_(None), UserTarget.effective_to > today),
        )
    )
    if current is not None and current.effective_from == today:
        current.kcal, current.protein_g = values.kcal, values.protein_g
        current.fat_g, current.carb_g = values.fat_g, values.carb_g
        await db.flush()
        return current

    new_effective_to = await _new_period_end(db, user_id, today, current)
    label = current.label if current is not None else None
    if current is not None:
        current.effective_to = today
        await db.flush()  # 1. 先關舊的——順序不能換，見 update_target

    new_target = UserTarget(
        user_id=user_id,
        kcal=values.kcal,
        protein_g=values.protein_g,
        fat_g=values.fat_g,
        carb_g=values.carb_g,
        label=label,
        effective_from=today,
        effective_to=new_effective_to,
    )
    db.add(new_target)
    try:
        await db.flush()  # 2. 再開新的
    except IntegrityError as exc:
        await db.rollback()
        raise ConflictError(
            "TARGET_CONFLICT", "目標剛被另一台裝置改過，請重新整理再試"
        ) from exc
    return new_target
```

`set_target_from_today` 變成（docstring 保留原本的三種狀態說明，多一句 D16）：

```python
    user_id = user.id
    today = today_in_timezone(user.timezone)
    target = await write_target_from_today(
        db, user_id, today, TargetValues(**payload.model_dump())
    )
    # 身體資料規格 D16：手動設的目標不是「建議」，之後體重變了不提示重算。
    await clear_applied_weight(db, user_id)
    await db.commit()
    await db.refresh(target)
    return _to_response(target)
```

（`from dataclasses import dataclass`、`from decimal import Decimal`、`from app.body_data import clear_applied_weight`。）

跑既有的：`pytest -q -W error tests/test_targets_today.py tests/test_targets.py` → Expected：PASS（重構不改行為）。

- [ ] **Step 2：先寫測試。** `tests/test_targets_today.py` 加一條：

```python
async def test_saving_by_hand_forgets_the_applied_weight(client, db_session, seen_timezones):
    """身體資料規格 D16：手打的目標不是建議，之後不提示重算。別人的不受影響。"""
    user, other = await create_user(db_session), await create_user(db_session)
    await create_profile(db_session, user=user, targets_applied_weight_kg=80)
    await create_profile(db_session, user=other, targets_applied_weight_kg=70)
    user_id, other_id = user.id, other.id

    response = await client.put("/api/targets/today", headers=auth(user_id), json=BODY)

    assert response.status_code == 200
    applied = dict(
        (await db_session.execute(
            select(UserProfile.user_id, UserProfile.targets_applied_weight_kg).where(
                UserProfile.user_id.in_([user_id, other_id])
            )
        )).tuples().all()
    )
    assert applied == {user_id: None, other_id: Decimal("70.00")}
```

`app/schemas/body.py` 加套用的請求：

```python
class ApplySuggestionRequest(BaseModel):
    """畫面上看到的四個數字（D15）。**不會被存**——存的是後端重算的；這四個只用來確認
    「看到的就是要存的」，不一樣就 409。"""

    kcal: Decimal = Field(ge=0, max_digits=8, decimal_places=2)
    protein_g: Decimal = Field(ge=0, max_digits=8, decimal_places=2)
    fat_g: Decimal = Field(ge=0, max_digits=8, decimal_places=2)
    carb_g: Decimal = Field(ge=0, max_digits=8, decimal_places=2)
```

`tests/test_target_suggestion.py` 加（`APPLY = "/api/me/target-suggestion/apply"`；`SHOWN = {"kcal": "2110", "protein_g": "144", "fat_g": "59", "carb_g": "251"}`，配預設的 `create_profile` 與 80 kg；**套用要另外 monkeypatch `app.api.routes.targets.today_in_timezone`？不用**——套用把 body 模組算的 `today` 傳進 `write_target_from_today`，那個函式不自己算今天。用 Task 3 的 `today` 夾具就好）：

1. `test_apply_saves_the_suggestion_from_today_and_remembers_the_weight`：200；回應是 `TargetResponse`（`effective_from == "2026-10-14"`、四個數字）；資料庫的 `user_targets` 今天起是那四個值；`targets_applied_weight_kg == 80`；之後 GET 建議是 `applied_weight_kg: "80.00"`、`resuggest: False`。
2. `test_apply_closes_the_previous_target`：`create_target(effective_from=2026-10-01, kcal=1800)` → 套用之後舊的那筆 `effective_to == 2026-10-14`、值沒變（沿用帳號設定的規則，只驗一次接得上）。
3. `test_numbers_that_differ_from_the_suggestion_are_409_and_write_nothing`（parametrize 四個欄位各差 1）：`409 SUGGESTION_CHANGED`；`user_targets` 沒有列、`targets_applied_weight_kg` 仍是 null。
4. `test_trailing_zeros_are_the_same_number`：`{"kcal": "2110.00", …}` → 200（比的是 `Decimal`，不是字串）。
5. `test_an_incomplete_profile_is_422_with_what_is_missing`：沒有體重 → `422 PROFILE_INCOMPLETE`、`details.missing == ["weight"]`、什麼都沒寫。
6. `test_a_zero_carb_suggestion_is_saved_as_unset`：規格 §3.3 的 E（女、1926、100 cm、150 kg、久坐、減 0.5）送 `{"kcal": "1210", "protein_g": "270", "fat_g": "34", "carb_g": "0"}` → 200、`carb_g is None`（D9）。
7. `test_a_target_clash_is_409_and_the_weight_is_not_remembered`：monkeypatch `app.api.routes.targets._new_period_end` 回 None 並先建一筆未來的目標（照 `test_targets_today.py` 的 `test_a_clash_is_409_and_writes_nothing`）→ `409 TARGET_CONFLICT`、`targets_applied_weight_kg` 仍是 null。
8. `test_after_the_weight_moves_a_kilo_the_suggestion_says_so`：套用（80）→ 記 2026-10-14 的 78.5（直接 `create_weight`）→ GET 建議：`weight_change_kg == -1.5`、`resuggest is True`。
9. `test_apply_needs_a_login`。

`tests/test_body_privacy.py`（新）：

```python
"""身體資料是健康資料（身體資料規格 §7）：不進任何好友或社群的回應、只有身體資料的模組
碰得到那兩張表、那幾個模組不寫 log。掃的是型別與原始碼——端點測試只看得到「這一次的回應
沒有」，看不到「某天有人把它加進白名單」。"""

import re
from pathlib import Path

from pydantic import BaseModel

import app.schemas.friend as friend_schemas
import app.schemas.social as social_schemas

APP = Path(__file__).resolve().parent.parent / "app"
HEALTH_WORDS = ("weight", "height", "birth", "sex", "activity", "goal", "profile")


def _models_reachable_from(module) -> set[type[BaseModel]]:
    """模組裡每個 BaseModel，連同欄位型別裡巢狀的（list[X]、X | None）。"""
    seen: set[type[BaseModel]] = set()
    stack = [
        value
        for value in vars(module).values()
        if isinstance(value, type) and issubclass(value, BaseModel) and value is not BaseModel
    ]
    while stack:
        model = stack.pop()
        if model in seen:
            continue
        seen.add(model)
        for field in model.model_fields.values():
            for inner in _types_in(field.annotation):
                if isinstance(inner, type) and issubclass(inner, BaseModel):
                    stack.append(inner)
    return seen


def _types_in(annotation) -> list:
    args = getattr(annotation, "__args__", None)
    if not args:
        return [annotation]
    return [inner for arg in args for inner in _types_in(arg)]


def test_no_friend_or_social_response_has_a_health_field():
    models = _models_reachable_from(friend_schemas) | _models_reachable_from(social_schemas)
    assert len(models) >= 20  # 掃到東西了：寫計畫時兩個模組頂層就有 22 個模型（含 import 進來的）
    offenders = sorted(
        f"{model.__name__}.{name}"
        for model in models
        for name in model.model_fields
        if any(word in name.lower() for word in HEALTH_WORDS)
    )
    assert offenders == []


BODY_MODULES = {
    APP / "models" / "body.py",
    APP / "models" / "__init__.py",
    APP / "body_targets.py",
    APP / "body_data.py",
    APP / "schemas" / "body.py",
    APP / "api" / "routes" / "body.py",
    APP / "api" / "routes" / "weights.py",
    APP / "export.py",
}


def test_only_the_body_modules_touch_the_health_tables():
    """`routes/targets.py` 只准呼叫 `clear_applied_weight`，不准自己碰那張表。"""
    words = re.compile(r"\bUserProfile\b|\bWeightEntry\b|\buser_profiles\b|\bweight_entries\b")
    offenders = sorted(
        str(path.relative_to(APP))
        for path in APP.rglob("*.py")
        if path not in BODY_MODULES and words.search(path.read_text(encoding="utf-8"))
    )
    assert offenders == []


def test_the_body_modules_do_not_log():
    """`export.py` 例外：它不在這個集合裡要掃的範圍（它本來就沒有 logger；如果之後有，
    也只會記匯出的事件）。"""
    log_words = re.compile(r"\blogging\b|\blogger\b|\bprint\(")
    offenders = sorted(
        str(path.relative_to(APP))
        for path in BODY_MODULES - {APP / "export.py", APP / "models" / "__init__.py"}
        if log_words.search(path.read_text(encoding="utf-8"))
    )
    assert offenders == []
```

> 第一條的 `>= 20` 是防空轉（handover §6 第 5 種）：模組路徑打錯時，掃描對空集合永遠是綠的。寫計畫時量過：兩個模組頂層的 BaseModel 共 22 個，欄位名沒有一個含那七個字（`comment` 的 `body` 不算）。

- [ ] **Step 3：跑，看它紅。** `pytest -q -W error tests/test_target_suggestion.py tests/test_targets_today.py tests/test_body_privacy.py` → Expected：套用的幾條 FAIL（404）、`test_saving_by_hand_forgets_the_applied_weight` FAIL；掃描三條 PASS（現在就該是綠的——它們守的是以後）。

- [ ] **Step 4：套用的端點。** `app/api/routes/body.py` 加：

```python
@router.post("/me/target-suggestion/apply", response_model=TargetResponse)
async def apply_target_suggestion(
    payload: ApplySuggestionRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> TargetResponse:
    """把建議存成今天起的目標（D15）。一個交易：重算 → 跟畫面上看到的比 → 寫目標 →
    記下這次用的體重。

    存的是**重算的**數字，不是請求裡的；請求的四個數字只用來確認使用者按下去的時候看到的
    就是會存的——另一個分頁剛記了體重、或畫面是離線快取裡的舊建議，就 409，什麼都不寫。"""
    user_id = user.id
    today = today_in_timezone(user.timezone)
    profile = await load_profile(db, user_id)
    latest = await latest_weight(db, user_id)
    result = suggest(inputs_from(profile, latest), today)
    if isinstance(result, list):
        raise UnprocessableEntityError(
            "PROFILE_INCOMPLETE", "身體資料或體重還沒填完", {"missing": result}
        )
    assert latest is not None
    shown = (payload.kcal, payload.protein_g, payload.fat_g, payload.carb_g)
    if shown != (result.kcal, result.protein_g, result.fat_g, result.carb_g):
        raise ConflictError("SUGGESTION_CHANGED", "建議目標剛剛變了，請看過新的數字再套用")

    weight_used = latest.weight_kg
    target = await write_target_from_today(
        db,
        user_id,
        today,
        TargetValues(
            kcal=result.kcal,
            protein_g=result.protein_g,
            fat_g=result.fat_g,
            # D9：碳水被擠到 0 時存「未設定」——0 的目標算不出比例。
            carb_g=None if result.carb_g == 0 else result.carb_g,
        ),
    )
    await db.execute(
        update(UserProfile)
        .where(UserProfile.user_id == user_id)
        .values(targets_applied_weight_kg=weight_used)
    )
    await db.commit()
    await db.refresh(target)
    return target_response(target)
```

`routes/targets.py` 的 `_to_response` 改名 `target_response`（公開，三處呼叫跟著改）；`body.py` import `TargetValues`、`target_response`、`write_target_from_today`（前例：`supplement_intakes.py` 從 `supplement_plans` import），以及 `ConflictError`、`update`、`ApplySuggestionRequest`、`TargetResponse`。

- [ ] **Step 5：跑。** 同 Step 3 → Expected：PASS。再跑 `tests/test_targets.py`（`_to_response` 改名）。

- [ ] **Step 6：突變**：
  1. `set_target_from_today` 拿掉 `clear_applied_weight` → `test_saving_by_hand_forgets_the_applied_weight` 紅。
  2. `clear_applied_weight` 的 `.where(...)` 拿掉 → 同一條紅（別人的 70 被清掉）。
  3. 套用的 `shown != …` 整段拿掉 → 第 3 條紅。
  4. 比對改成比字串（`str(payload.kcal) != str(result.kcal)`）→ 第 4 條紅。
  5. `carb_g=None if … else …` 改成 `carb_g=result.carb_g` → 第 6 條紅。
  6. `update(UserProfile)…` 移到 `write_target_from_today` **之前**、而且在它前面加一個 `await db.commit()` → 第 7 條紅（409 了，體重卻記住了）。
  7. `write_target_from_today` 的原地改那一支把 `await db.flush()` 換成 `await db.commit()` → **存活**（共用 session 的 commit 只到 savepoint）。記下來；這個函式的 docstring 寫「不 commit」，審查時看。
  8. 掃描：在 `app/schemas/friend.py` 的 `FriendMeal` 暫時加 `weight_kg: Decimal | None = None` → 第一條掃描紅；在 `app/api/routes/friends.py` 暫時加一行註解 `# WeightEntry` → 第二條紅；在 `routes/weights.py` 加 `import logging` → 第三條紅。

  改回、`touch`、刪 pyc、`git diff` 確認 `friend.py`、`friends.py` 沒有留下任何改動。

- [ ] **Step 7：重新產生 `schema.d.ts`**、`npm run -s typecheck` 綠。**跑整套後端**（約 4 分鐘）→ 全綠，記下條數。

- [ ] **Step 8：commit。**

```bash
git add app/api/routes/targets.py app/api/routes/body.py app/schemas/body.py tests/test_target_suggestion.py tests/test_targets_today.py tests/test_body_privacy.py frontend/src/api/schema.d.ts
```

訊息（`$S/body-t5-msg.txt`）：`feat(body): 套用建議目標（同一個交易記下體重）；手動存目標清掉套用體重；健康資料的掃描測試`。

---

## Task 6：前端——API 層、query 鍵、數字與日期工具

**Files:**
- Create: `frontend/src/api/body.ts`、`frontend/src/lib/body.ts`、`frontend/src/lib/weights.ts`、`frontend/tests/helpers/body-routes.ts`、`frontend/tests/weights-lib.test.ts`、`frontend/tests/body-api.test.tsx`
- Modify: `frontend/src/api/queries.ts`、`frontend/src/lib/decimal.ts`、`frontend/src/lib/civil-date.ts`、`frontend/tests/decimal.test.ts`、`frontend/tests/civil-date.test.ts`

- [ ] **Step 1：先寫測試。**

`tests/decimal.test.ts` 加：

```ts
describe("differenceOf", () => {
	it("字串進字串出，正負號都留著", () => {
		expect(differenceOf("78.50", "80.00")).toBe("-1.5");
		expect(differenceOf("80.1", "80")).toBe("0.1");
		expect(differenceOf("80", "80.00")).toBe("0");
	});
});

describe("paddedExtent", () => {
	it("最小值往下、最大值往上各留 pad，再取整", () => {
		expect(paddedExtent(["72.4", "70.2", "71"], "1")).toEqual({ lo: "69", hi: "74" });
	});
	it("全部一樣也有範圍", () => {
		expect(paddedExtent(["70"], "1")).toEqual({ lo: "69", hi: "71" });
	});
	it("空陣列是 null", () => {
		expect(paddedExtent([], "1")).toBeNull();
	});
});

describe("positionIn", () => {
	it("lo 是 0、hi 是 1、中間照比例", () => {
		expect(positionIn("69", "69", "74")).toBe(0);
		expect(positionIn("74", "69", "74")).toBe(1);
		expect(positionIn("71.5", "69", "74")).toBe(0.5);
	});
	it("範圍是 0 時回 0.5，不除以零", () => {
		expect(positionIn("70", "70", "70")).toBe(0.5);
	});
});

describe("checkRangeInput", () => {
	const weight = { min: "25", max: "350", places: 2 } as const;
	it.each([
		["", "empty"],
		["abc", "not-decimal"],
		["1e2", "not-decimal"],
		["-70", "not-decimal"],
		["70.123", "too-precise"],
		["24.99", "out-of-range"],
		["350.01", "out-of-range"],
		["25", null],
		[" 350 ", null],
		["72.4", null],
	] as const)("%j → %j", (raw, problem) => {
		expect(checkRangeInput(raw, weight)).toBe(problem);
	});
	it("places 0 只收整數", () => {
		expect(checkRangeInput("1990.5", { min: "1900", max: "2100", places: 0 })).toBe("too-precise");
		expect(checkRangeInput("1990", { min: "1900", max: "2100", places: 0 })).toBeNull();
	});
});
```

`tests/civil-date.test.ts` 加：

```ts
describe("daysBetween", () => {
	it.each([
		["2026-10-14", "2026-10-14", 0],
		["2026-10-01", "2026-10-14", 13],
		["2026-10-14", "2026-10-01", -13],
		["2026-12-31", "2027-01-01", 1],
		["2028-02-28", "2028-03-01", 2], // 閏年
		["2026-03-28", "2026-03-30", 2], // 跨日光節約（UTC 沒有）
	] as const)("%s → %s = %d", (from, to, days) => {
		expect(daysBetween(from, to)).toBe(days);
	});
});
```

`tests/weights-lib.test.ts`（新）：

```ts
import { describe, expect, it } from "vitest";
import { entriesInSpan, movingAverage, recentAverage, weekChange } from "../src/lib/weights";

const e = (date: string, weight_kg: string) => ({ date, weight_kg });

describe("movingAverage（7 個日曆天，不是 7 筆）", () => {
	it("每一筆是 [這天 − 6, 這天] 之間所有紀錄的平均", () => {
		const entries = [e("2026-10-01", "80"), e("2026-10-03", "79"), e("2026-10-07", "78"), e("2026-10-08", "77")];
		expect(movingAverage(entries)).toEqual([
			e("2026-10-01", "80"),
			e("2026-10-03", "79.5"),
			e("2026-10-07", "79"), // 10/01–10/07：80、79、78
			e("2026-10-08", "78"), // 10/02–10/08：79、78、77（10/01 掉出去了）
		]);
	});
	it("沒記的日子不當 0", () => {
		expect(movingAverage([e("2026-10-01", "80"), e("2026-10-20", "70")])).toEqual([
			e("2026-10-01", "80"),
			e("2026-10-20", "70"),
		]);
	});
});

describe("weekChange", () => {
	it("最新一筆跟「日期 ≤ 最新 − 7 天」的最新一筆比", () => {
		const entries = [e("2026-10-01", "81"), e("2026-10-06", "80.5"), e("2026-10-07", "80"), e("2026-10-14", "79")];
		expect(weekChange(entries)).toEqual({ latest: e("2026-10-14", "79"), since: e("2026-10-07", "80"), change: "-1" });
	});
	it("七天以前沒有紀錄就是 null；沒有紀錄也是 null", () => {
		expect(weekChange([e("2026-10-10", "80"), e("2026-10-14", "79")])).toBeNull();
		expect(weekChange([])).toBeNull();
	});
});

describe("entriesInSpan", () => {
	const all = [e("2026-07-01", "82"), e("2026-09-20", "81"), e("2026-10-14", "79")];
	it("30 天是 [今天 − 29, 今天]", () => {
		expect(entriesInSpan(all, "2026-10-14", 30)).toEqual({ start: "2026-09-15", entries: all.slice(1) });
	});
	it("全部從第一筆開始；沒有紀錄時從今天開始", () => {
		expect(entriesInSpan(all, "2026-10-14", "all")).toEqual({ start: "2026-07-01", entries: all });
		expect(entriesInSpan([], "2026-10-14", "all")).toEqual({ start: "2026-10-14", entries: [] });
	});
});

describe("recentAverage", () => {
	it("[今天 − 6, 今天] 的平均；沒有就是 null", () => {
		expect(recentAverage([e("2026-10-07", "80"), e("2026-10-08", "79"), e("2026-10-14", "78")], "2026-10-14")).toBe("78.5");
		expect(recentAverage([e("2026-10-01", "80")], "2026-10-14")).toBeNull();
	});
});
```

`tests/body-api.test.tsx`（新）：`saveWeight` 送 `PUT /api/weights/2026-10-14`、body `{"weight_kg":"72.4"}`；`deleteWeight` 送 `DELETE`；`applySuggestion` 送 `POST /api/me/target-suggestion/apply` 帶四個數字；`useTargetSuggestion` 在 `ready: false` 時回傳的物件有 `missing`（型別收窄靠 `if (data.ready)`——這條是給 typecheck 看的）。用 `mockApi` 的 spy 看 `method`、`url`、`body`。

- [ ] **Step 2：跑，看它紅。** `npx vitest run tests/decimal.test.ts tests/civil-date.test.ts tests/weights-lib.test.ts tests/body-api.test.tsx` → Expected：FAIL（函式不存在）。

- [ ] **Step 3：`lib/decimal.ts`** 加（**decimal.js 只准在這個檔案**）：

```ts
/** a − b（體重的變化）。字串進字串出，`toString()` 會去掉尾數的 0（"-1.50" → "-1.5"）。 */
export function differenceOf(a: Numeric, b: Numeric): Numeric {
	return new Decimal(a).minus(b).toString();
}

/** 圖表的 y 軸範圍：最小值減 `pad` 往下取整、最大值加 `pad` 往上取整。空陣列回 `null`。
 *  所有值一樣時上下仍各有 `pad`，範圍不會是 0。 */
export function paddedExtent(
	values: readonly Numeric[],
	pad: Numeric,
): { lo: Numeric; hi: Numeric } | null {
	if (values.length === 0) return null;
	const decimals = values.map((value) => new Decimal(value));
	return {
		lo: Decimal.min(...decimals).minus(pad).floor().toString(),
		hi: Decimal.max(...decimals).plus(pad).ceil().toString(),
	};
}

/** `value` 在 [lo, hi] 裡的位置：lo → 0、hi → 1（給 SVG 座標用，所以回 number）。
 *  範圍是 0 時回 0.5——不除以零，畫在正中間。 */
export function positionIn(value: Numeric, lo: Numeric, hi: Numeric): number {
	const span = new Decimal(hi).minus(lo);
	if (span.isZero()) return 0.5;
	return new Decimal(value).minus(lo).dividedBy(span).toNumber();
}

export type RangeInputProblem = "empty" | "not-decimal" | "too-precise" | "out-of-range";

/** 有範圍、有小數位數限制的一格（體重、身高、出生年；身體資料規格 §5）。`null`＝沒問題。
 *  寫法限制同 `checkTargetInput`（不收 `1e3`、`+5`、`-1`）；空白是 `"empty"`，要不要接受
 *  由呼叫端決定（身體資料的欄位可以留空，體重不行）。不丟例外。 */
export function checkRangeInput(
	value: string,
	rule: { min: Numeric; max: Numeric; places: number },
): RangeInputProblem | null {
	const v = value.trim();
	if (v === "") return "empty";
	if (!PLAIN_DECIMAL.test(v)) return "not-decimal";
	const dot = v.indexOf(".");
	const places = dot === -1 ? 0 : v.length - dot - 1;
	if (places > rule.places) return "too-precise";
	const number = new Decimal(v);
	if (number.lessThan(rule.min) || number.greaterThan(rule.max)) return "out-of-range";
	return null;
}
```

> `"4."` 的小數位數是 0（`length - dot - 1`），`places: 0` 時算合法——後端收 `4.`？Pydantic 的 `Decimal` 收 `"1990."`，但 `birth_year` 是 `int`，`"1990."` 會 422。出生年的輸入另外要求「只有數字」：`BodyProfile` 用 `/^\d{4}$/` 先比（Task 7）。

- [ ] **Step 4：`lib/civil-date.ts`** 加（不准用本地時間的 accessor；同 `shiftDays` 用 `slice` 取三段）：

```ts
const DAY_MS = 86_400_000;

function utcMidnight(isoDate: string): number {
	if (!ISO_DATE.test(isoDate)) {
		throw new Error(`只接受 YYYY-MM-DD，收到：${JSON.stringify(isoDate)}`);
	}
	return Date.UTC(
		Number(isoDate.slice(0, 4)),
		Number(isoDate.slice(5, 7)) - 1,
		Number(isoDate.slice(8, 10)),
	);
}

/** `to` 比 `from` 晚幾天（可以是負的）。兩個都是 UTC 午夜，相減一定是整天數。 */
export function daysBetween(from: string, to: string): number {
	return Math.round((utcMidnight(to) - utcMidnight(from)) / DAY_MS);
}
```

- [ ] **Step 5：`lib/weights.ts`**（新）：

```ts
import { shiftDays } from "./civil-date";
import { averageOf, differenceOf, type Numeric } from "./decimal";

/** 一筆體重（`WeightEntryResponse` 的形狀；這裡不 import schema，讓純函式好測）。 */
export type WeightPoint = { date: string; weight_kg: Numeric };

export const MOVING_AVERAGE_DAYS = 7;

/** 日期字串（YYYY-MM-DD）可以直接比大小：字典序就是時間序。 */
function within(entry: WeightPoint, start: string, end: string): boolean {
	return entry.date >= start && entry.date <= end;
}

/** 7 天移動平均（身體資料規格 §6.4）：**7 個日曆天，不是 7 筆**——每一筆的值是日期在
 *  [這天 − 6, 這天] 之間所有紀錄的平均。沒記的日子不補、不當 0；只有自己一筆就是自己。
 *  `entries` 由舊到新（後端的順序）。最多 800 筆，O(n²) 也只是幾十萬次比較。 */
export function movingAverage(entries: readonly WeightPoint[]): WeightPoint[] {
	return entries.map((entry) => {
		const start = shiftDays(entry.date, -(MOVING_AVERAGE_DAYS - 1));
		const window = entries.filter((other) => within(other, start, entry.date));
		// 至少有自己，averageOf 不會是 null。
		return { date: entry.date, weight_kg: averageOf(window.map((w) => w.weight_kg)) ?? entry.weight_kg };
	});
}

/** 「跟 7 天前比」：最新一筆，跟日期 ≤ 最新 − 7 天的最新一筆比。沒有那一筆就是 null
 *  （不拿 6 天前的湊）。 */
export function weekChange(
	entries: readonly WeightPoint[],
): { latest: WeightPoint; since: WeightPoint; change: Numeric } | null {
	const latest = entries.at(-1);
	if (latest === undefined) return null;
	const cutoff = shiftDays(latest.date, -7);
	const since = entries.filter((entry) => entry.date <= cutoff).at(-1);
	if (since === undefined) return null;
	return { latest, since, change: differenceOf(latest.weight_kg, since.weight_kg) };
}

export type WeightSpan = 30 | 90 | "all";

/** 圖表要畫的那一段與它的起點。30／90 天是 [今天 − (天數 − 1), 今天]；「全部」從第一筆開始
 *  （沒有紀錄就從今天）。`today` 是後端給的（`GET /api/weights` 的 `today`）。 */
export function entriesInSpan(
	entries: readonly WeightPoint[],
	today: string,
	span: WeightSpan,
): { start: string; entries: WeightPoint[] } {
	if (span === "all") return { start: entries[0]?.date ?? today, entries: [...entries] };
	const start = shiftDays(today, -(span - 1));
	return { start, entries: entries.filter((entry) => within(entry, start, today)) };
}

/** 「最近 7 天平均」：[今天 − 6, 今天] 的紀錄的平均；沒有就是 null。 */
export function recentAverage(entries: readonly WeightPoint[], today: string): Numeric | null {
	const start = shiftDays(today, -(MOVING_AVERAGE_DAYS - 1));
	return averageOf(entries.filter((entry) => within(entry, start, today)).map((w) => w.weight_kg));
}
```

- [ ] **Step 6：`lib/body.ts`**（新，標籤只有這一份）：

```ts
import type { components } from "../api/schema";

type Sex = components["schemas"]["Sex"];
type ActivityLevel = components["schemas"]["ActivityLevel"];
type Goal = components["schemas"]["Goal"];
type Missing = components["schemas"]["SuggestionMissing"]["missing"][number];

export const SEX_OPTIONS: readonly { value: Sex; label: string }[] = [
	{ value: "male", label: "男" },
	{ value: "female", label: "女" },
];

/** 五級活動量（身體資料規格 決定 1 的表）：係數在後端（`app/body_targets.py`），這裡只有字。 */
export const ACTIVITY_OPTIONS: readonly { value: ActivityLevel; label: string; hint: string }[] = [
	{ value: "sedentary", label: "久坐", hint: "幾乎不運動" },
	{ value: "light", label: "輕度", hint: "每週運動 1–3 天" },
	{ value: "moderate", label: "中度", hint: "每週運動 3–5 天" },
	{ value: "active", label: "高度", hint: "每週運動 6–7 天" },
	{ value: "very_active", label: "非常高", hint: "體力工作或一天兩練" },
];

export const GOAL_OPTIONS: readonly { value: Goal; label: string }[] = [
	{ value: "lose", label: "減重" },
	{ value: "maintain", label: "維持" },
	{ value: "gain", label: "增重" },
];

/** 速度的值是後端 `Decimal` 正規化之前的寫法；比對前用 `formatMacro` 把 "0.50" 變成 "0.5"。 */
export const RATE_OPTIONS = [
	{ value: "0.25", label: "每週 0.25 公斤" },
	{ value: "0.5", label: "每週 0.5 公斤" },
] as const;

export const MISSING_LABELS: Record<Missing, string> = {
	sex: "性別",
	birth_year: "出生年",
	height_cm: "身高",
	activity_level: "活動量",
	goal: "目標",
	rate_kg_per_week: "速度",
	weight: "體重",
};

/** 規格 D26 的原文。 */
export const SUGGESTION_DISCLAIMER =
	"依公式估算，僅供參考，不是醫療建議；懷孕、哺乳、慢性病或未滿 18 歲請諮詢專業人員。";
```

> `components["schemas"]["Sex"]` 等名字以重新產生的 `schema.d.ts` 為準（FastAPI 用 enum 的類別名當 schema 名）；對不上就照實際的改。

- [ ] **Step 7：query 鍵與 API 層。** `api/queries.ts` 加（放在 `me` 附近，註解說明命名空間）：

```ts
	/** 身體資料、建議、體重（身體資料規格 §6.1）：全部在 `"body"` 底下——記一筆體重、改身體資料
	 *  都可能改變建議，失效 `bodyAll` 一次打到三個。**進離線快取**（D19：自己的資料，離線看得到
	 *  自己的體重是功能），所以不加進 `persist.ts` 的 `NOT_PERSISTED`。 */
	bodyProfile: ["body", "profile"] as const,
	targetSuggestion: ["body", "suggestion"] as const,
	weights: ["body", "weights"] as const,
	bodyAll: ["body"] as const,
```

`api/body.ts`（新）：

```ts
import { type QueryClient, useQuery } from "@tanstack/react-query";
import { apiFetch } from "./client";
import { queryKeys } from "./queries";
import type { components } from "./schema";

export type BodyProfile = components["schemas"]["BodyProfileResponse"];
export type BodyProfileInput = components["schemas"]["BodyProfileRequest"];
export type SuggestionReady = components["schemas"]["SuggestionReady"];
export type TargetSuggestion = SuggestionReady | components["schemas"]["SuggestionMissing"];
export type WeightList = components["schemas"]["WeightListResponse"];
export type WeightEntry = components["schemas"]["WeightEntryResponse"];
type Target = components["schemas"]["TargetResponse"];

function required<T>(value: T | null, what: string): T {
	if (value === null) throw new Error(`${what}的回應沒有 body`);
	return value;
}

const fetchProfile = async () =>
	required(await apiFetch<BodyProfile>("/api/me/body-profile"), "身體資料");

export function useBodyProfile() {
	return useQuery({ queryKey: queryKeys.bodyProfile, queryFn: fetchProfile });
}

/** 掛載時一定重抓——給 `/me/body` 的表單預填用（D27，同 `useFreshDailyStats` 的兩條規矩：
 *  `isFetchedAfterMount && isSuccess` 才算、離線快取還原完才掛）。 */
export function useFreshBodyProfile() {
	return useQuery({
		queryKey: queryKeys.bodyProfile,
		queryFn: fetchProfile,
		refetchOnMount: "always",
	});
}

export async function saveBodyProfile(body: BodyProfileInput): Promise<BodyProfile> {
	return required(
		await apiFetch<BodyProfile>("/api/me/body-profile", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		}),
		"身體資料",
	);
}

export function useTargetSuggestion() {
	return useQuery({
		queryKey: queryKeys.targetSuggestion,
		queryFn: async () =>
			required(await apiFetch<TargetSuggestion>("/api/me/target-suggestion"), "建議目標"),
	});
}

/** 送畫面上看到的四個數字（D15）：後端重算，不一樣就 409 `SUGGESTION_CHANGED`。 */
export async function applySuggestion(
	shown: Pick<SuggestionReady, "kcal" | "protein_g" | "fat_g" | "carb_g">,
): Promise<Target> {
	return required(
		await apiFetch<Target>("/api/me/target-suggestion/apply", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(shown),
		}),
		"套用建議目標",
	);
}

/** 最近 800 天（後端的預設）。回應裡的 `today` 是使用者的今天——表單與圖表都用它。 */
export function useWeights() {
	return useQuery({
		queryKey: queryKeys.weights,
		queryFn: async () => required(await apiFetch<WeightList>("/api/weights"), "體重"),
	});
}

export async function saveWeight(date: string, weightKg: string): Promise<WeightEntry> {
	return required(
		await apiFetch<WeightEntry>(`/api/weights/${date}`, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ weight_kg: weightKg }),
		}),
		"體重",
	);
}

export async function deleteWeight(date: string): Promise<void> {
	await apiFetch<null>(`/api/weights/${date}`, { method: "DELETE" });
}

/** 體重或身體資料變了：體重清單、建議（含重算提示）一起重抓。 */
export function invalidateBody(client: QueryClient): Promise<void> {
	return client.invalidateQueries({ queryKey: queryKeys.bodyAll });
}
```

> `apiFetch` 的簽名（第二個參數、204 回 `null`）以 `api/client.ts` 現況為準；`api/targets.ts` 是照抄的對象。

- [ ] **Step 8：測試用的路由。** `tests/helpers/body-routes.ts`（新）：

```ts
import { json, type Route } from "./mock-api";

export const EMPTY_PROFILE = {
	sex: null, birth_year: null, height_cm: null, activity_level: null,
	goal: null, rate_kg_per_week: null, target_weight_kg: null,
};
export const NOT_READY = { ready: false, missing: ["sex", "birth_year", "height_cm", "activity_level", "goal", "rate_kg_per_week", "weight"] };
export const NO_WEIGHTS = { today: "2019-07-04", entries: [] };

/** 會畫出「我的」的新卡片或建議區塊的測試，**放在路由清單最前面**：`/api/me` 的路由用
 *  `url.includes` 比對，會吃掉 `/api/me/body-profile` 與 `/api/me/target-suggestion`。 */
export function bodyRoutes(
	overrides: { profile?: unknown; suggestion?: unknown; weights?: unknown } = {},
): Route[] {
	return [
		{ method: "GET", path: "/api/me/target-suggestion", handler: () => json(overrides.suggestion ?? NOT_READY) },
		{ method: "GET", path: "/api/me/body-profile", handler: () => json(overrides.profile ?? EMPTY_PROFILE) },
		{ method: "GET", path: "/api/weights", handler: () => json(overrides.weights ?? NO_WEIGHTS) },
	];
}
```

（`Route` 如果沒有 export，就在 `mock-api.ts` 補 `export`。）

- [ ] **Step 9：跑。** 同 Step 2 → Expected：PASS。再跑 `npx vitest run tests/decimal-containment.test.ts tests/civil-date.test.ts`（掃描：decimal.js 只在 `lib/decimal.ts`、civil-date 沒有本地 accessor）→ PASS。

- [ ] **Step 10：突變**：
  1. `movingAverage` 的 `-(MOVING_AVERAGE_DAYS - 1)` 改成 `-MOVING_AVERAGE_DAYS` → 第一條紅（10/08 那筆把 10/01 算進來）。
  2. `weekChange` 的 `<= cutoff` 改成 `< cutoff` → 第一條紅（10/07 剛好 7 天前）。
  3. `paddedExtent` 的 `.floor()` 拿掉 → `lo: "69.2"`，紅。
  4. `positionIn` 拿掉 `isZero` 那一行 → 「範圍是 0」那條紅（NaN）。
  5. `daysBetween` 的 `Math.round` 改成 `Math.floor` → **存活**（UTC 午夜相減永遠整除）。記下來，不補。

- [ ] **Step 11：檢查與 commit。** `npm run -s lint`、`npm run -s test`（grep `FAIL`／`Unhandled`）；然後單獨跑 typecheck 並串 commit：

```bash
cd frontend && npm run -s typecheck && cd .. && git add frontend/src/api/body.ts frontend/src/api/queries.ts frontend/src/lib/body.ts frontend/src/lib/weights.ts frontend/src/lib/decimal.ts frontend/src/lib/civil-date.ts frontend/tests/helpers/body-routes.ts frontend/tests/helpers/mock-api.ts frontend/tests/weights-lib.test.ts frontend/tests/body-api.test.tsx frontend/tests/decimal.test.ts frontend/tests/civil-date.test.ts && git commit -F "$S/body-t6-msg.txt"
```

訊息：`feat(frontend): 身體資料與體重的 API 層、移動平均與圖表用的數字工具`。

---

## Task 7：前端——`/me/body` 與「身體資料」卡片

**Files:**
- Create: `frontend/src/screens/BodyProfile.tsx`、`frontend/src/components/BodyProfileCard.tsx`、`frontend/src/components/BodyProfileCard.module.css`、`frontend/tests/body-profile.test.tsx`
- Modify: `frontend/src/screens/Me.tsx`、`frontend/src/App.tsx`、`frontend/src/lib/layout.ts`、`frontend/tests/layout.test.ts`、`frontend/tests/me.test.tsx`（及其他畫出「我的」的測試）

- [ ] **Step 1：先寫測試。** `tests/body-profile.test.tsx`（`QueryClient` 由測試建立、`staleTime: 60_000`，照 `tests/targets.test.tsx` 的 `renderScreen`；「整頁重新載入」那條照抄它的兩個 `QueryClient` 經 localStorage 交接的寫法）：

1. 「預填的是掛載之後抓回來的」：快取先 `setQueryData(bodyProfile, 舊的)`，API 回新的（身高 175）→ 表單的「身高（cm）」是 `175`，從沒出現過舊值（`findByLabelText` 之後 `toHaveValue`）。
2. 「整頁重新載入：還原期間不預填」：照 `targets.test.tsx` 那條——localStorage 裡是舊的、API 掛著不回 → 畫面是「載入中…」，沒有表單；放行之後是新的。
3. 「讀不到就不給表單」：API 500 → `role="alert"`「無法載入身體資料」，沒有「儲存」。
4. 「送出整組七個鍵」：改身高、選「維持」→ 按「儲存」→ PUT 的 body 是七個鍵，`rate_kg_per_week` 是原本的值（維持時速度欄位藏起來但值不清掉，D3）、空白的目標體重送 `null`；成功後導到 `/me`、`bodyAll` 被失效（`queryClient.getQueryState(queryKeys.targetSuggestion)?.isInvalidated`）。
5. 「速度只在減重、增重時出現」：選「維持」→ 沒有「速度」這組單選；選「增重」→ 有。
6. 「前端擋範圍」：身高 `99`、體重 `24.9`、出生年 `199` → 三則錯誤、沒有送出（`spy` 裡沒有 PUT）。
7. 「後端的 422 顯示訊息」：PUT 回 `422 BIRTH_YEAR_OUT_OF_RANGE`「出生年要在 1926 到 2013 之間」→ 畫面上有那句話。
8. 「可及性」：性別、目標、速度各是一個 `group`（`fieldset`，`getByRole("group", { name: "性別" })`）；活動量是 `combobox`，選項的名稱是「中度（每週運動 3–5 天）」。

`tests/me.test.tsx` 加：「身體資料卡片」——沒填：「還沒有填」＋連結「修改身體資料」（`href="/me/body"`）；填了：`男・1990 年生・175 cm・中度活動・減重每週 0.5 公斤・目標 72 公斤`（沒設的段落略過）。**既有的每一個 `mockApi([...])` 在最前面加 `...bodyRoutes()`**（開工前必讀第 8 點）；`targets.test.tsx`、`app.test.tsx` 等會畫出「我的」或 `/me/targets` 的也一樣——先跑一次整套，看哪些檔案因為新卡片紅或印 `Unhandled`，就在那些檔案加。

`tests/layout.test.ts` 加：`contentWidthFor("/me/body") === "form"`、`contentWidthFor("/weight") === "narrow"`。

- [ ] **Step 2：跑，看它紅。** `npx vitest run tests/body-profile.test.tsx tests/me.test.tsx tests/layout.test.ts` → FAIL。

- [ ] **Step 3：`/me/body`。** `screens/BodyProfile.tsx` 的骨架照 `screens/Targets.tsx`（`BodyProfile` → 還原完才掛 `BodyProfileLoader` → 第一份新鮮的資料記下來 → `BodyProfileForm`）。表單的值全部是字串（輸入框）或選項：

```ts
type Values = {
	sex: Sex | null;
	birthYear: string;
	heightCm: string;
	activityLevel: ActivityLevel | null;
	goal: Goal | null;
	rate: "0.25" | "0.5" | null;
	targetWeightKg: string;
};

function initialValues(profile: BodyProfile): Values {
	const rate = profile.rate_kg_per_week === null ? null : formatMacro(profile.rate_kg_per_week);
	return {
		sex: profile.sex,
		birthYear: profile.birth_year === null ? "" : String(profile.birth_year),
		heightCm: profile.height_cm === null ? "" : formatMacro(profile.height_cm),
		activityLevel: profile.activity_level,
		goal: profile.goal,
		rate: rate === "0.25" || rate === "0.5" ? rate : null,
		targetWeightKg: profile.target_weight_kg === null ? "" : formatMacro(profile.target_weight_kg),
	};
}

const HEIGHT = { min: "100", max: "250", places: 1 } as const;
const WEIGHT = { min: "25", max: "350", places: 2 } as const;

/** 空白＝不設定（null）；有字就要合規則。回傳要送的 body，或一串錯誤。 */
function toRequest(values: Values): { body: BodyProfileInput } | { errors: string[] } {
	const errors: string[] = [];
	const birth = values.birthYear.trim();
	if (birth !== "" && !/^\d{4}$/.test(birth)) errors.push("出生年要是四位數的西元年");
	const height = checkRangeInput(values.heightCm, HEIGHT);
	if (height !== null && height !== "empty") errors.push("身高要在 100 到 250 公分之間，最多一位小數");
	const target = checkRangeInput(values.targetWeightKg, WEIGHT);
	if (target !== null && target !== "empty") errors.push("目標體重要在 25 到 350 公斤之間，最多兩位小數");
	if (errors.length > 0) return { errors };
	return {
		body: {
			sex: values.sex,
			birth_year: birth === "" ? null : Number(birth),
			height_cm: values.heightCm.trim() === "" ? null : values.heightCm.trim(),
			activity_level: values.activityLevel,
			goal: values.goal,
			// 維持時藏起來但照送原本的值（D3）：切回減重時還在。
			rate_kg_per_week: values.rate,
			target_weight_kg: values.targetWeightKg.trim() === "" ? null : values.targetWeightKg.trim(),
		},
	};
}
```

（`Number(birth)` 在 `/^\d{4}$/` 之後是安全的；這不是 Decimal 運算。）

畫面（`ui.screen`，h1「身體資料」；每一組都是 `.screen` 的通用樣式，不另寫 CSS）：

- `<fieldset><legend>性別</legend>` 兩個 `<label><input type="radio" name="sex" …/>男</label>`。
- 「出生年」`<input inputMode="numeric" autoComplete="bday-year">`；「身高（cm）」、「目標體重（kg，選填）」`inputMode="decimal"`。
- 「活動量」`<select>`：第一個選項 `<option value="">請選擇</option>`，其餘 `ACTIVITY_OPTIONS` 的 `${label}（${hint}）`。
- `<fieldset><legend>目標</legend>` 三個單選；`goal` 是 `lose`／`gain` 時才畫 `<fieldset><legend>速度</legend>` 兩個單選。
- 說明一行：「這些資料只用來算建議目標，好友看不到。」
- 錯誤 `<ul role="alert">`；「儲存」是 submit，送出中 `disabled`（跟 `/me/targets` 一樣是表單的送出鈕，焦點留在原處沒關係——成功就導頁）。
- 送出：`useMutation({ mutationFn: saveBodyProfile, onSuccess: () => invalidateBody(queryClient) })`；`save.mutate(body, { onSuccess: () => navigate("/me"), onError })`——422 用 `describeFieldErrors`（`BIRTH_YEAR_OUT_OF_RANGE` 沒有 `errors` 陣列，會退回 `error.message`），其他「儲存失敗，請再試一次」。

- [ ] **Step 4：卡片。** `components/BodyProfileCard.tsx`：`<Card testId="body-profile-card">`（e2e 用）；`useBodyProfile()`；標題 `h2`「身體資料」（`ui.sectionTitle`）；載入中／讀不到同 `TargetsCard` 的寫法；摘要：

```ts
function summary(profile: BodyProfile): string | null {
	const parts = [
		SEX_OPTIONS.find((o) => o.value === profile.sex)?.label,
		profile.birth_year === null ? undefined : `${profile.birth_year} 年生`,
		profile.height_cm === null ? undefined : `${formatMacro(profile.height_cm)} cm`,
		ACTIVITY_OPTIONS.find((o) => o.value === profile.activity_level)?.label.concat("活動"),
		goalText(profile),
		profile.target_weight_kg === null ? undefined : `目標 ${formatMacro(profile.target_weight_kg)} 公斤`,
	].filter((part): part is string => part !== undefined);
	return parts.length === 0 ? null : parts.join("・");
}
```

`goalText`：維持 →「維持體重」；減重／增重有速度 →「減重每週 0.5 公斤」；沒有速度 →「減重」。`null` 時顯示「還沒有填」。連結「修改」，`aria-label="修改身體資料"`，到 `/me/body`。CSS 只用 `index.css` 的變數（同 `TargetsCard.module.css`，可以直接複製它的 `.title`／`.text`／`.link`）。

- [ ] **Step 5：接上。** `Me.tsx`：`<TargetsCard />` 後面加 `<BodyProfileCard />`（D21；體重卡片 Task 8 再加），註解寫順序的理由。`App.tsx`：`<Route path="/me/body" element={<BodyProfile />} />`（放在 `/me/targets` 旁邊）。`lib/layout.ts`：`FORM` 加 `"/me/body"`，註解的 `/me/targets`、`/me/password` 那句一起改成三個。

- [ ] **Step 6：跑。** 同 Step 2 → PASS；整套 `npm run -s test` → 綠（grep `FAIL`／`Unhandled`）。

- [ ] **Step 7：突變**：
  1. `BodyProfile` 拿掉 `useIsRestoring` 那一層（直接掛 loader）→ 第 2 條紅。
  2. loader 的 `isFetchedAfterMount &&` 拿掉 → 第 1 條紅。
  3. `rate_kg_per_week: values.rate` 改成 `values.goal === "maintain" ? null : values.rate` → 第 4 條紅。
  4. 卡片的 `.filter(...)` 改成不濾 `undefined` → 摘要多出 `undefined`，卡片那條紅。

- [ ] **Step 8：commit。** `npm run -s lint`；typecheck 單獨跑、`&&` 串 commit：

```bash
cd frontend && npm run -s typecheck && cd .. && git add frontend/src/screens/BodyProfile.tsx frontend/src/components/BodyProfileCard.tsx frontend/src/components/BodyProfileCard.module.css frontend/src/screens/Me.tsx frontend/src/App.tsx frontend/src/lib/layout.ts frontend/tests/body-profile.test.tsx frontend/tests/me.test.tsx frontend/tests/layout.test.ts && git commit -F "$S/body-t7-msg.txt"
```

（Step 1 裡另外改到的測試檔一併列出來 add。）訊息：`feat(frontend): 身體資料的表單（/me/body）與「我的」的身體資料卡片`。

---

## Task 8：前端——體重卡片、`/weight` 與圖表

**Files:**
- Create: `frontend/src/components/{WeightCard,WeightForm,WeightChart}.tsx`、`WeightCard.module.css`、`frontend/src/components/Segmented.module.css`、`frontend/src/screens/Weight.tsx`、`Weight.module.css`、`frontend/tests/{weight-chart,weight}.test.tsx`
- Modify: `frontend/src/screens/Trend.tsx`、`Trend.module.css`、`frontend/src/index.css`、`frontend/src/screens/Me.tsx`、`frontend/src/App.tsx`、`frontend/tests/me.test.tsx`

- [ ] **Step 1：分段切換搬家（純搬，先跑趨勢的測試）。** 把 `Trend.module.css` 的 `.metrics`、`.legend`、`.metric`、`.metricInput` 四條原樣搬到新的 `components/Segmented.module.css`，改名 `.group`、`.legend`、`.option`、`.input`（檔頭註解照搬）；`Trend.tsx` 改 `import segmented from "../components/Segmented.module.css"`，兩組切換的四個 className 換過去；`Trend.module.css` 只剩 `.summary`、`.stale`。`npx vitest run tests/trend.test.tsx` → PASS。（畫面不變；e2e 的 `touch-targets` 量得到這些標籤。）

- [ ] **Step 2：先寫測試。**

`tests/weight-chart.test.tsx`（純渲染，給固定的 props）：

```tsx
const entries = [
	{ date: "2026-10-01", weight_kg: "80" },
	{ date: "2026-10-08", weight_kg: "78" },
	{ date: "2026-10-14", weight_kg: "79" },
];

function chart(props: Partial<Parameters<typeof WeightChart>[0]> = {}) {
	return render(
		<WeightChart
			entries={entries}
			average={movingAverage(entries)}
			start="2026-10-01"
			end="2026-10-14"
			targetKg={null}
			{...props}
		/>,
	);
}
```

1. 「每筆一個點，可以按角色找到」：`getAllByRole("img")` 三個，名稱「10/1，80 公斤」……（`formatCivilDate` 的格式以現況為準）。
2. 「x 照日期、y 照體重」：y 軸是 `paddedExtent(["80","78","79"], "1")` = 77–81；第一點 `cx` 是左邊界（`PAD_X`）、最後一點是右邊界（`VIEW_WIDTH − PAD_X`）、10/08 的 `cx` 在 7/13 的位置（`toBeCloseTo`）；`cy`：80 → `VIEW_HEIGHT × (1 − 3/4)`、78 → `VIEW_HEIGHT × (1 − 1/4)`。常數從元件 export。
3. 「平均線」：`getByTestId("weight-average")` 的 `points` 有三組座標，第三組的 y 是 78.5 的位置——10/14 的視窗是 10/08–10/14（78、79），**不是**最後一筆的 79。
4. 「目標線」：`targetKg="72"` → `weight-target` 存在、y 在 72 的位置，而且 y 軸範圍把 72 包進去（71–81）；`null` → 沒有。
5. 「只有一筆」（`start === end`）：不除以零，點畫在左邊界 `PAD_X`（除數是 `Math.max(天數, 1)`）。
6. 「圖的名稱」：`getByRole("group", { name: "體重" })`。

`tests/weight.test.tsx`（`/weight`，`MemoryRouter`、`bodyRoutes({ weights: { today: "2026-10-14", entries: [...] } })`）：

1. 「預設 30 天」：有 2026-07-01 與 2026-10-10 兩筆 → 圖上只有 10/10 一點；選「全部」→ 兩點；選「90 天」→ 一點（7/01 在 90 天外：90 天是 7/17 起）。三個選項是 `radio`，在名稱「期間」的 `group` 裡。
2. 「清單由新到舊、修改」：按「修改 10/10」→ 那一列變成輸入框（名稱「10/10 的體重（公斤）」）＋「儲存」＋「取消」；改成 `78.2` 存 → `PUT /api/weights/2026-10-10` body `{"weight_kg":"78.2"}`、`bodyAll` 失效。
3. 「刪除要確認」：按「刪除 10/10」→ `alertdialog`「刪除 10/10 的體重？」、焦點在「取消」；按「刪除」→ `DELETE /api/weights/2026-10-10`；按「取消」→ 焦點回到「刪除 10/10」（`useConfirmFocus`）。
4. 「沒有紀錄」：「還沒有體重紀錄」，記錄的表單在。
5. 「最近 7 天平均」與「目標 72 公斤」（`bodyRoutes({ profile: { …EMPTY_PROFILE, target_weight_kg: "72.00" } })`）出現在圖下面。

`tests/me.test.tsx` 加「體重卡片」：

1. 有 10/07 的 80 與 10/14 的 79 →「79 公斤・10/14」與「比 7 天前 −1 公斤」。
2. 「記錄體重」→ 展開表單：體重輸入框（`inputMode="decimal"`）、日期 `type="date"` 預設 `2026-10-14`、`max="2026-10-14"`、`min="2024-10-14"`（`shiftDays(today, -730)`）；填 `78.5` 按「儲存」→ `PUT /api/weights/2026-10-14`、表單收起、焦點回到「記錄體重」。
3. 「體重不合規則不送」：`24` → 錯誤「體重要在 25 到 350 公斤之間，最多兩位小數」，沒有 PUT。
4. 「看全部」連到 `/weight`。

- [ ] **Step 3：跑，看它紅。**

- [ ] **Step 4：圖表。** `components/WeightChart.tsx`（純渲染；檔頭說明照 `TrendChart` 的三點：幾何算成屬性、`role="img"` 不能拿、不量容器）：

```tsx
import { daysBetween, formatCivilDate } from "../lib/civil-date";
import { formatMacro, paddedExtent, positionIn, type Numeric } from "../lib/decimal";
import type { WeightPoint } from "../lib/weights";

export const VIEW_WIDTH = 280;
export const VIEW_HEIGHT = 160;
/** 左右各留一點，第一點與最後一點的圓不會被 viewBox 切掉一半。 */
export const PAD_X = 6;
const AXIS_PAD_KG = "1";

type Props = {
	entries: readonly WeightPoint[];
	average: readonly WeightPoint[];
	start: string;
	end: string;
	targetKg: Numeric | null;
};

export function WeightChart({ entries, average, start, end, targetKg }: Props) {
	const values = entries.map((entry) => entry.weight_kg);
	const extent = paddedExtent(targetKg === null ? values : [...values, targetKg], AXIS_PAD_KG);
	if (extent === null) return null;
	const days = Math.max(daysBetween(start, end), 1);
	const x = (date: string) => PAD_X + (daysBetween(start, date) / days) * (VIEW_WIDTH - 2 * PAD_X);
	const y = (value: Numeric) => VIEW_HEIGHT * (1 - positionIn(value, extent.lo, extent.hi));
	const shownDates = new Set(entries.map((entry) => entry.date));
	const line = average
		.filter((point) => shownDates.has(point.date))
		.map((point) => `${x(point.date)},${y(point.weight_kg)}`)
		.join(" ");

	return (
		// biome-ignore lint/a11y/useSemanticElements: 同 TrendChart：它建議的 <fieldset> 對一張 SVG 圖沒有意義
		<svg viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`} className="trend-chart" role="group" aria-label="體重" data-testid="weight-chart">
			{/* biome-ignore lint/a11y/noAriaHiddenOnFocusable: SVG <text> 不能聚焦（同 TrendChart）；刻度是裝飾 */}
			<text x={0} y={10} className="weight-axis" aria-hidden="true">{extent.hi}</text>
			{/* biome-ignore lint/a11y/noAriaHiddenOnFocusable: 同上 */}
			<text x={0} y={VIEW_HEIGHT - 2} className="weight-axis" aria-hidden="true">{extent.lo}</text>
			{targetKg !== null && (
				<line data-testid="weight-target" className="trend-target" x1={0} x2={VIEW_WIDTH} y1={y(targetKg)} y2={y(targetKg)} />
			)}
			{line !== "" && (
				<polyline data-testid="weight-average" className="weight-average" points={line} aria-hidden="true" />
			)}
			{entries.map((entry) => (
				// biome-ignore lint/a11y/noInteractiveElementToNoninteractiveRole: circle 不是互動元素（同 TrendChart 的 rect）；拿掉 role 點會對螢幕閱讀器消失
				<circle
					key={entry.date}
					data-testid={`weight-point-${entry.date}`}
					role="img"
					aria-label={`${formatCivilDate(entry.date)}，${formatMacro(entry.weight_kg)} 公斤`}
					cx={x(entry.date)}
					cy={y(entry.weight_kg)}
					r={3}
					className="weight-point"
				/>
			))}
		</svg>
	);
}
```

> biome 的忽略註解在 JSX children 位置要用 `{/* … */}`（handover §7）；`map` 回傳的 JSX 前面那一行是運算式位置，`//` 合法。實際需要哪幾條忽略以 `npm run -s lint` 為準，**不要為了 lint 拿掉 `role`**。

`index.css` 在 `.trend-date` 後面加（只用變數）：

```css
/* 體重圖（身體資料規格 §6.4）：點、7 天移動平均、刻度。目標線沿用 .trend-target。 */
.weight-point {
	fill: var(--color-accent);
}

.weight-average {
	fill: none;
	stroke: var(--color-action);
	stroke-width: 2;
}

.weight-axis {
	fill: var(--color-text-muted);
	font-size: 10px;
}
```

- [ ] **Step 5：表單。** `components/WeightForm.tsx`：props `{ today: string; onDone: () => void; cancelRef? }`。標籤「體重（公斤）」（`inputMode="decimal"`、`autoComplete="off"`）、標籤「日期」（`type="date"`、`min={shiftDays(today, -730)}`、`max={today}`、預設 `today`）、「儲存」「取消」。送出前 `checkRangeInput(weight, { min: "25", max: "350", places: 2 })`；`useMutation({ mutationFn: ({ date, weight }) => saveWeight(date, weight), onSuccess: () => invalidateBody(queryClient) })`、`mutate(vars, { onSuccess: onDone })`。日期在範圍外（使用者手打）交給後端的 422 訊息（`WEIGHT_DATE_IN_FUTURE`／`TOO_OLD`，`caught.message`）。「儲存」送出中 `aria-disabled`（焦點在它身上，D：會變成不能按的按鈕用 `aria-disabled`），用 ref 擋重複送出（同 `ExportCard`）。

- [ ] **Step 6：卡片。** `components/WeightCard.tsx`：`<Card testId="weight-card">`（e2e 用）；`useWeights()`；標題「體重」；有紀錄：`<p>{formatMacro(latest.weight_kg)} 公斤・{formatCivilDate(latest.date)}</p>`，`weekChange` 不是 null 時 `<p>比 7 天前 {signed(change)} 公斤</p>`（`signed`：開頭不是 `-` 而且不是 `0` 就加 `+`；負號顯示成 `−`？**不換**，照 `formatMacro` 的 `-`，跟重算提示一致）；沒有紀錄：「還沒有體重紀錄」。按鈕「記錄體重」（`ui.secondary`）切換 `WeightForm`（打開時按鈕卸載、表單收起時焦點回到按鈕——`useConfirmFocus` 的同一個模式，或一個 `ref` + effect）。連結「看全部」到 `/weight`。`Me.tsx`：`<BodyProfileCard />` 後面加 `<WeightCard />`。

- [ ] **Step 7：`/weight`。** `screens/Weight.tsx`（`ui.screen`，h1「體重」）：

```tsx
const SPANS = [
	{ value: 30, label: "30 天" },
	{ value: 90, label: "90 天" },
	{ value: "all", label: "全部" },
] as const satisfies readonly { value: WeightSpan; label: string }[];
```

- `useWeights()`、`useBodyProfile()`（目標體重；讀不到就當沒有）。載入中／讀不到：「載入中…」／`role="alert"`「無法載入體重」。
- 期間切換：`<fieldset className={segmented.group}><legend className={segmented.legend}>期間</legend>…`（同趨勢頁）。
- `const average = movingAverage(all)`（**用全部算，再只畫範圍內的**——範圍開頭那幾天的平均要用到範圍外的紀錄）；`entriesInSpan(all, today, span)` 給 `entries` 與 `start`；`<WeightChart … end={today} />`。
- 圖下面 `<p>`：`recentAverage(all, today)` 不是 null 時「最近 7 天平均 X 公斤」；有目標體重時「目標 X 公斤」。
- `<WeightForm today={today} … />`（標題「記錄體重」）。
- 清單 `<ul>` 由新到舊（`[...all].reverse()`）：每列 `WeightRow`——顯示模式：「10/10　78.2 公斤」＋「修改」（`aria-label="修改 10/10"`）＋「刪除」（`aria-label="刪除 10/10"`）；修改模式：輸入框（`aria-label="10/10 的體重（公斤）"`）＋儲存＋取消；確認模式：照 `Expenses.tsx` 的 `ExpenseRow`（`role="alertdialog"`、`useConfirmFocus`、`aria-labelledby` 指到「刪除 10/10 的體重？」）。刪除用 `useMutation` + `invalidateBody`。
- `App.tsx`：`<Route path="/weight" element={<Weight />} />`。寬度是預設的 `narrow`，`layout.ts` 不用改（Task 7 的測試已經守著）。
- `Weight.module.css`：清單列的排版（名稱在左、按鈕在右、按鈕 ≥ 44px），只用變數。

- [ ] **Step 8：跑。** `npx vitest run tests/weight-chart.test.tsx tests/weight.test.tsx tests/me.test.tsx tests/trend.test.tsx` → PASS；整套 → 綠。

- [ ] **Step 9：突變**：
  1. `WeightChart` 的 `x` 拿掉 `daysBetween`、改成照索引平均分配（`index / (n − 1)`）→ 第 2 條的 10/08 紅（7/13 ≠ 1/2）。
  2. `y` 拿掉 `1 −` → 第 2 條的 `cy` 紅（重的畫在下面）。
  3. `extent` 不把 `targetKg` 包進去 → 第 4 條紅。
  4. `Weight.tsx` 的平均改成 `movingAverage(entriesInSpan(...).entries)` → **存活**（測試資料的範圍開頭沒有前一週的紀錄）。補一條：30 天的範圍從 9/15 起、9/12 有一筆 80、9/16 有一筆 78 → 平均線第一點是 79，不是 78。再跑突變確認紅。
  5. 卡片的 `weekChange` 換成「跟前一筆比」→ 卡片那條紅（前一筆不是 7 天前）。
  6. 刪除不經確認直接送 → 第 3 條紅。
  7. 把 `role="img"` 從 `<circle>` 拿掉 → 圖表第 1 條紅。

- [ ] **Step 10：commit。** `npm run -s lint`；typecheck 單獨跑、`&&` 串 commit；`git add` 列出這個 task 的每一個檔案（`Trend.tsx`、`Trend.module.css`、`Segmented.module.css`、`index.css`、新的元件、畫面、測試、`Me.tsx`、`App.tsx`）。訊息（`$S/body-t8-msg.txt`）：`feat(frontend): 體重卡片、/weight 的圖表（7 天移動平均、目標線）與清單`。

---

## Task 9：前端——建議目標區塊、每日目標卡片的提示、匯出多一顆

**Files:**
- Create: `frontend/src/components/TargetSuggestion.tsx`、`TargetSuggestion.module.css`、`frontend/tests/target-suggestion.test.tsx`
- Modify: `frontend/src/screens/Targets.tsx`、`frontend/src/components/TargetsCard.tsx`、`TargetsCard.module.css`、`frontend/src/api/export.ts`、`frontend/tests/{targets,me,export-card}.test.tsx`

- [ ] **Step 1：先寫測試。** `tests/target-suggestion.test.tsx`（`READY` 是 Task 3 那一組 2110／144／59／251、`bmr: "1719"`、`tdee: "2664"`、`adjustment_kcal: "-550"`、`weight_kg: "80.00"`、`based_on_date: "2026-10-10"`）：

1. 「四個數字與說明」：「熱量 2110 kcal」「蛋白質 144 g」「脂肪 59 g」「碳水 251 g」；說明「基礎代謝 1719 kcal，乘上活動量是每日消耗 2664 kcal；減重每週 0.5 公斤 −550 kcal」——**調整的文字來自 `adjustment_kcal` 的正負與 `useBodyProfile` 的速度**；`adjustment_kcal: "0"` 時寫「維持體重，不加不減」；「依 10/10 的體重 80 公斤」；免責聲明全文（`SUGGESTION_DISCLAIMER`）。
2. 「下限」：`floor_applied: true`、`floor_kcal: "1200"` → 多一行「已調到最低建議熱量 1200 kcal」；`false` → 沒有。
3. 「套用」：按「套用建議目標」→ `POST …/apply` 的 body 是四個數字（字串原樣）→ 導到 `/me`；`dailyStats`、`rangeStatsAll`、`bodyAll` 都被失效。
4. 「409 建議變了」：回 `409 SUGGESTION_CHANGED` → `role="alert"`「建議目標剛剛變了，請看過新的數字再套用」、建議被失效（重抓）、沒有導頁；按鈕在送出中是 `aria-disabled="true"`、焦點還在它身上。
5. 「其他 409」：`TARGET_CONFLICT` → 顯示後端的訊息。
6. 「缺資料」：`{ready: false, missing: ["sex", "goal", "weight"]}` → 「還差：性別、目標、體重」；連結「填寫身體資料」（`/me/body`）與「記錄體重」（`/weight`）；只缺 `weight` → 只有「記錄體重」；沒有「套用建議目標」。免責聲明在兩種狀態都在。
7. 「讀不到」：500 → 「無法載入建議目標」；手動表單照常（在 `targets.test.tsx` 驗）。

`tests/targets.test.tsx`：每個 `mockApi([...])` 最前面加 `...bodyRoutes()`；加一條「建議在手動表單上面、手動表單有標題『自己設定』」（DOM 順序：`compareDocumentPosition`）。

`tests/me.test.tsx` 加「每日目標卡片的重算提示」：`bodyRoutes({ suggestion: { ...READY, applied_weight_kg: "80.00", weight_change_kg: "-1.50", resuggest: true } })` → 卡片裡「體重變了 -1.5 公斤，要重算建議目標嗎？」與連結「重算建議目標」（`/me/targets`）；`resuggest: false` → 沒有；`ready: false` → 沒有。

`tests/export-card.test.tsx`：把「三顆」改成「四顆」、名稱多一個「體重」、`GET /api/export/weights.csv`（既有測試裡寫死三顆的地方都改）。

- [ ] **Step 2：跑，看它紅。**

- [ ] **Step 3：`components/TargetSuggestion.tsx`**：

```tsx
export function TargetSuggestion() {
	const suggestion = useTargetSuggestion();
	const titleId = useId();
	return (
		<section aria-labelledby={titleId} data-testid="suggestion">
			<h2 id={titleId}>建議目標</h2>
			{suggestion.isPending ? (
				<p>載入中…</p>
			) : suggestion.data == null ? (
				<p>無法載入建議目標</p>
			) : suggestion.data.ready ? (
				<Ready suggestion={suggestion.data} />
			) : (
				<Missing missing={suggestion.data.missing} />
			)}
			<p className={styles.disclaimer}>{SUGGESTION_DISCLAIMER}</p>
		</section>
	);
}

function Ready({ suggestion }: { suggestion: SuggestionReady }) {
	const queryClient = useQueryClient();
	const navigate = useNavigate();
	const profile = useBodyProfile().data;
	const [error, setError] = useState<string | null>(null);
	const apply = useMutation({
		mutationFn: applySuggestion,
		// 放在 hook 層：導頁之後照樣跑（同 /me/targets 的手動儲存）。
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: queryKeys.dailyStats });
			void queryClient.invalidateQueries({ queryKey: queryKeys.rangeStatsAll });
			void invalidateBody(queryClient);
		},
	});

	function handleApply() {
		if (apply.isPending) return;
		setError(null);
		const { kcal, protein_g, fat_g, carb_g } = suggestion;
		apply.mutate(
			{ kcal, protein_g, fat_g, carb_g },
			{
				onSuccess: () => navigate("/me"),
				onError: (caught: unknown) => {
					if (caught instanceof ApiError && caught.code === "SUGGESTION_CHANGED") {
						void queryClient.invalidateQueries({ queryKey: queryKeys.targetSuggestion });
						setError("建議目標剛剛變了，請看過新的數字再套用");
					} else if (caught instanceof ApiError && caught.status === 409) {
						setError(caught.message);
					} else {
						setError("套用失敗，請再試一次");
					}
				},
			},
		);
	}
	// …四個數字（`TARGET_FIELDS` 的標籤與單位＋`formatMacro`，`data-testid="suggestion-kcal"` 放在熱量的數字上給 e2e）、
	// 說明（`adjustmentText(suggestion, profile)`）、下限的那一行、「依 M/D 的體重 N 公斤」、
	// <button type="button" className={ui.secondary 以外的主要按鈕樣式} aria-disabled={apply.isPending} onClick={handleApply}>套用建議目標</button>、
	// error 的 <p role="alert">。
}
```

`adjustmentText`：`adjustment_kcal` 是 `"0"`（用 `differenceOf(x, "0") === "0"` 或直接比 `formatMacro(x) === "0"`）→「維持體重，不加不減」；負 →「減重每週 {formatMacro(rate)} 公斤 {formatMacro(adjustment)} kcal」；正 →「增重每週 … +{…} kcal」。速度讀不到（`profile` 還沒回來）就省略「每週 … 公斤」那段，只寫「減重 −550 kcal」。

`Missing`：`還差：${missing.map((m) => MISSING_LABELS[m]).join("、")}`；`missing` 裡有 `weight` 以外的 → 連結「填寫身體資料」；有 `weight` → 連結「記錄體重」到 `/weight`。

> 「套用」是一顆會在焦點上變成不能按的按鈕：用 `aria-disabled`、不用原生 `disabled`（開工前的規則；`ExportCard` 的說明）。它不是 submit，`.screen button` 的通用樣式是次要按鈕；要主要按鈕的外觀就在 `TargetSuggestion.module.css` 寫一個 class（只用 `index.css` 的變數，照 `ui.module.css` 的 `button[type="submit"]` 那條抄顏色）。

- [ ] **Step 4：接上。**
  - `screens/Targets.tsx`：還原完之後畫 `<TargetSuggestion />`，接著 `<h2>自己設定</h2>` 與原本的 `<TargetsLoader />`（D23）。`Targets` 的 docstring 加一句：建議區塊讀的是一般的快取（不用「掛載後才算」）——套用由後端重算、不一樣就 409，舊的快取最多換來一次 409。
  - `components/TargetsCard.tsx`：`useTargetSuggestion()`；`data?.ready && data.resuggest && data.weight_change_kg !== null` 時在「修改」連結前面加
    `<p className={styles.prompt}>體重變了 {formatMacro(change)} 公斤，要重算建議目標嗎？</p>` 與 `<Link to="/me/targets">重算建議目標</Link>`。`TargetsCard.module.css` 加 `.prompt`（`--color-accent-soft` 底、`--radius-card`、`--space-2` 內距）。
  - `api/export.ts`：`EXPORT_KINDS` 加 `{ kind: "weights", label: "體重" }`，檔頭的「三種」改「四種」；`ExportCard.tsx` 的註解裡的「三顆」跟著改。

- [ ] **Step 5：跑。** 這幾個測試檔 → PASS；整套 → 綠。

- [ ] **Step 6：突變**：
  1. 套用送出的 `kcal` 改成 `String(Number(kcal) + 1)` → 第 3 條紅。（改成 `formatMacro(kcal)` 對 `"2110"` 沒差，會存活——不是有效的突變點。）
  2. `SUGGESTION_CHANGED` 分支拿掉 `invalidateQueries` → 第 4 條紅。
  3. `onSuccess: () => navigate("/me")` 搬進 `useMutation` 的 `onSuccess` → **測試存活**（handover §7：元件卸載之後仍會跑——測試裡不會卸載）。記下來，維持寫在 `mutate` 的 callback。
  4. 卡片的條件拿掉 `data.resuggest &&` → 「`resuggest: false` 沒有提示」紅。
  5. `Missing` 的「記錄體重」連結條件反過來 → 第 6 條紅。

- [ ] **Step 7：commit。** lint、typecheck（單獨、`&&`）；`git add` 列出每個檔案。訊息（`$S/body-t9-msg.txt`）：`feat(frontend): 建議目標區塊（套用、缺什麼、免責聲明）、每日目標卡片的重算提示、匯出體重`。

---

## Task 10：e2e

**Files:**
- Create: `frontend/e2e/body-targets.spec.ts`

- [ ] **Step 1：準備 dev。**

```bash
docker compose up -d --build api
docker compose exec -T api python -m alembic upgrade head
docker compose exec -T api python -m alembic current
```

Expected：`0019 (head)`。

- [ ] **Step 2：spec。** `e2e/body-targets.spec.ts`（固定手機尺寸；一條測試一個新帳號；登入之後只點擊）：

```ts
import { expect, type Page, test } from "@playwright/test";
import { loginAs, newAccount } from "./new-account.ts";
import { expectTouchTargets } from "./touch-targets.ts";

test.use({ viewport: { width: 390, height: 844 } });

async function openMe(page: Page) {
	await page.getByRole("link", { name: "我的", exact: true }).click();
	await expect(page.getByRole("heading", { name: "我的", exact: true })).toBeVisible();
}

async function recordWeightOnMe(page: Page, kg: string) {
	const card = page.getByTestId("weight-card");
	await card.getByRole("button", { name: "記錄體重", exact: true }).click();
	await card.getByLabel("體重（公斤）", { exact: true }).fill(kg);
	await card.getByRole("button", { name: "儲存", exact: true }).click();
	await expect(card.getByRole("button", { name: "記錄體重", exact: true })).toBeVisible();
}

/** iOS 在 < 16px 的欄位上會自動放大（handover「mobile-form-zoom」）。 */
async function expectInputsAtLeast16px(page: Page, where: string) {
	const controls = page.locator("main input, main select");
	const count = await controls.count();
	expect(count, `${where}：要有輸入框`).toBeGreaterThan(0);
	for (let i = 0; i < count; i++) {
		const px = await controls.nth(i).evaluate((node) => Number.parseFloat(getComputedStyle(node).fontSize));
		expect(px, `${where} 第 ${i} 個欄位`).toBeGreaterThanOrEqual(16);
	}
}

test("填身體資料、記體重、套用建議、總覽的分母跟著變，體重變了就提示重算", async ({ page, request }) => {
	const account = await newAccount(request, "body");
	await loginAs(page, account);
	await openMe(page);

	await page.getByRole("link", { name: "修改身體資料", exact: true }).click();
	await expect(page.getByRole("heading", { name: "身體資料", exact: true })).toBeVisible();
	await expectInputsAtLeast16px(page, "身體資料");
	await page.getByRole("group", { name: "性別", exact: true }).getByLabel("男", { exact: true }).check();
	await page.getByLabel("出生年", { exact: true }).fill("1990");
	await page.getByLabel("身高（cm）", { exact: true }).fill("175");
	await page.getByLabel("活動量", { exact: true }).selectOption("moderate");
	await page.getByRole("group", { name: "目標", exact: true }).getByLabel("減重", { exact: true }).check();
	await page.getByRole("group", { name: "速度", exact: true }).getByLabel("每週 0.5 公斤", { exact: true }).check();
	await expectTouchTargets(page.locator("main button:visible, main label:has(input[type=radio])"), "身體資料");
	await page.getByRole("button", { name: "儲存", exact: true }).click();
	await expect(page.getByRole("heading", { name: "我的", exact: true })).toBeVisible();
	await expect(page.getByTestId("body-profile-card")).toContainText("175 cm");

	await recordWeightOnMe(page, "80");
	await page.getByRole("link", { name: "修改每日目標", exact: true }).click();
	const suggestion = page.getByTestId("suggestion");
	await expect(suggestion.getByRole("button", { name: "套用建議目標", exact: true })).toBeVisible();
	const kcal = (await suggestion.getByTestId("suggestion-kcal").textContent())?.trim();
	expect(kcal).toMatch(/^\d+$/);
	await suggestion.getByRole("button", { name: "套用建議目標", exact: true }).click();
	await expect(page.getByRole("heading", { name: "我的", exact: true })).toBeVisible();

	await page.getByRole("link", { name: "總覽", exact: true }).click();
	await expect(page.getByRole("heading", { name: "總覽", exact: true })).toBeVisible();
	await expect(page.getByTestId("today-kcal")).toContainText(`/ ${kcal} kcal`);

	await openMe(page);
	await expect(page.getByTestId("targets-card")).not.toContainText("體重變了");
	await recordWeightOnMe(page, "78.5"); // 同一天：更正，最新體重是 78.5
	await expect(page.getByTestId("targets-card")).toContainText("體重變了 -1.5 公斤，要重算建議目標嗎？");
});

test("體重頁：兩筆、改一筆、刪一筆", async ({ page, request }) => {
	const account = await newAccount(request, "weight");
	await loginAs(page, account);
	await openMe(page);
	await recordWeightOnMe(page, "80");
	await page.getByTestId("weight-card").getByRole("link", { name: "看全部", exact: true }).click();
	await expect(page.getByRole("heading", { name: "體重", exact: true })).toBeVisible();
	await expectInputsAtLeast16px(page, "體重");

	// 兩天前（日期欄的預設是後端給的今天；測試自己用 UTC 往回推兩天）。
	const dateInput = page.getByLabel("日期", { exact: true });
	const today = await dateInput.inputValue();
	const [y, m, d] = today.split("-").map(Number);
	const twoDaysAgo = new Date(Date.UTC(y ?? 0, (m ?? 1) - 1, (d ?? 1) - 2)).toISOString().slice(0, 10);
	await dateInput.fill(twoDaysAgo);
	await page.getByLabel("體重（公斤）", { exact: true }).fill("81.2");
	await page.getByRole("button", { name: "儲存", exact: true }).click();

	const chart = page.getByTestId("weight-chart");
	await expect(chart.getByRole("img")).toHaveCount(2);
	const rows = page.getByRole("listitem");
	await expect(rows).toHaveCount(2);

	const older = `${Number(twoDaysAgo.slice(5, 7))}/${Number(twoDaysAgo.slice(8, 10))}`; // 同 formatCivilDate
	await page.getByRole("button", { name: `修改 ${older}`, exact: true }).click();
	await page.getByLabel(`${older} 的體重（公斤）`, { exact: true }).fill("81");
	await page.getByRole("button", { name: "儲存", exact: true }).click();
	await expect(page.getByText("81 公斤", { exact: false })).toBeVisible();

	await page.getByRole("button", { name: `刪除 ${older}`, exact: true }).click();
	await page.getByRole("alertdialog").getByRole("button", { name: "刪除", exact: true }).click();
	await expect(rows).toHaveCount(1);
	await expect(chart.getByRole("img")).toHaveCount(1);
	await expectTouchTargets(page.locator("main button:visible"), "體重");
});
```

> 細節以實作為準，**對齊的是名稱**：卡片的 testid（`weight-card`、`body-profile-card`、`targets-card`、`suggestion`、`suggestion-kcal`）、標籤（「體重（公斤）」「日期」）、按鈕（「修改 M/D」）要跟 Task 7–9 寫的一致。清單用 `getByRole("listitem")` 之前確認 `/weight` 上沒有別的 `<li>`（handover §7：巢狀清單）；有就用清單的 `aria-label` 先縮小範圍。
> 「儲存」在 `/weight` 上可能同時有兩顆（記錄的表單、修改中的那一列）：修改時用那一列裡的按鈕（`page.getByRole("listitem").filter({ has: 輸入框 })`）。

- [ ] **Step 3：跑。** `cd frontend && npx playwright test e2e/body-targets.spec.ts` → 2 passed。再跑**整套** `npx playwright test` 兩次 → 都是全綠（基準 50 + 2）。

- [ ] **Step 4：突變**（改前端、重跑這個 spec；前端是 vite dev server 的話改了就生效，否則照 `playwright.config.ts` 的 webServer 重啟）：
  1. `TargetSuggestion` 套用成功不失效 `dailyStats` → 第一條的總覽分母紅（`staleTime` 60 秒內不重抓）。
  2. `WeightForm` 成功不 `invalidateBody` → 第一條最後的提示紅。
  3. 後端：`apply_target_suggestion` 不記 `targets_applied_weight_kg`（改 `app/` 之後 api 容器的 `--reload` 會接手；確認 `docker compose logs api` 有重新載入）→ 第一條最後紅。

  每個改回之後 `git diff` 乾淨。

- [ ] **Step 5：commit。** `cd frontend && npm run -s typecheck && cd .. && git add frontend/e2e/body-targets.spec.ts && git commit -F "$S/body-t10-msg.txt"`（handover §7：Playwright 不做型別檢查，typecheck 一定要跑）。訊息：`test(e2e): 身體資料、套用建議目標、重算提示、體重頁的修改與刪除`。

---

## Task 11：文件

**Files:** `docs/handover.md`、`docs/deployment.md`、`docs/superpowers/specs/2026-10-14-body-targets-design.md`、這份計畫

- [ ] **Step 1：量數字。** 後端整套（條數、時間）、前端 `npm run -s test`（**vitest 印出來的** `Test Files`／`Tests`）、e2e 條數與檔案數、端點數（`grep -c "@router\." app/api/routes/*.py` 加總，應該是 95）、資料表 21。
- [ ] **Step 2：`docs/handover.md`。**
  - §2 的表：端點、測試、資料表、Migration `0001`～`0019`，註明在 `feat/body-targets` 量的、日期。
  - §2 的階段進度表加一列「身體資料與目標（含體重紀錄）」（規格、計畫的路徑）。
  - §10 加一節「身體資料與目標」（照「按讚、留言、通知」那一節的格式）：機制摘要（公式在哪、D8 的下限順序、套用的交易與 409、手動存目標清掉套用體重、`GET /api/weights` 的 `today`、`["body"]` 進離線快取、`/me/body` 的預填規則）；新的東西在哪裡；已知限制（規格 §9 的七點，加上執行中發現的）。
  - §6 或 §7：執行中長出來的新坑與「突變存活才發現」（Task 2、3、5、6、9 各自記下的存活突變），照既有的格式寫。
- [ ] **Step 3：`docs/deployment.md`**：照 `0018` 那一段加 `0019_create_body_tables`——兩張新表、`deploy.sh` 會自己跑、**可以退版**（不在 `ROLLBACK_UNSAFE_REVISIONS`），退版後表與資料留著。
- [ ] **Step 4：規格與計畫的狀態**：規格的「狀態」改成「已實作」並指向「執行中發現的差異」；計畫的「與規格的差異」補上執行中改過的地方。
- [ ] **Step 5：commit。** 掃看不見的字元；`git add docs/handover.md docs/deployment.md docs/superpowers/specs/2026-10-14-body-targets-design.md docs/superpowers/plans/2026-10-14-body-targets.md`。訊息（`$S/body-t11-msg.txt`）：`docs: 身體資料與目標——handover、部署（migration 0019）、規格狀態`。

---

## 完成條件

- [ ] 後端整套 `pytest -q -W error` 全綠；`ruff check .`、`mypy app` 乾淨；`alembic check` 沒有漂移；`0019` 可以 downgrade 再 upgrade。
- [ ] 前端 `npm run -s test`（沒有 `FAIL`、`Unhandled`）、`typecheck`、`lint` 全綠；`schema.d.ts` 跟後端一致（重新產生一次，`git diff --exit-code frontend/src/api/schema.d.ts`）。
- [ ] e2e 整套連跑兩次全綠。
- [ ] 每個 task 的突變都做過、改回，`git status` 只剩 `lunch.jpg`。
- [ ] 好友的任何一個端點都拿不到體重或身體資料（`test_body_privacy.py` 三條、Task 3–5 的跨使用者測試）。
- [ ] handover、deployment、規格狀態更新；沒有 push。
