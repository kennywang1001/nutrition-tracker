# 報表看其他月份與匯出資料 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 報表可以一個月一個月往回看（網址記得月份，重新整理、上一頁都對）；「我的」可以把自己全部的餐點、花費、補劑各下載成一個 Excel 打得開的 CSV。

**Architecture:** 月份切換只動前端：報表畫面永遠掛著不帶月份的 `useExpenseSummary(null)`，它回應裡的 `month` 就是後端說的「這個月」；看哪個月寫在 `?month=YYYY-MM`（沒有＝這個月），月份的加減是 `lib/months.ts` 的純字串運算，後端的兩個端點本來就收 `month`（只補釘子）。匯出是三支 `GET /api/export/*.csv`：`app/csv_export.py` 是唯一的 CSV 寫法（儲存格的型別決定要不要擋公式字元），`app/export.py` 的三支 async generator 用 keyset 分塊查詢一塊一塊吐給 `StreamingResponse`，每人每分鐘 6 次（三個端點共用）；前端用既有的換票內核把回應拿成 Blob，`lib/save-file.ts` 存檔（一般是 `<a download>`，iOS 主畫面模式改用系統分享）。

**Tech Stack:** FastAPI · SQLAlchemy 2 async · PostgreSQL 16 · Python `csv` · React 19 · TypeScript strict · TanStack Query v5 · react-router 8 · CSS Modules · Vitest · Playwright · Biome

**依據規格：** `docs/superpowers/specs/2026-10-09-reports-month-export-design.md`（以下稱「規格」；決定的編號 A1…、B1… 指它的 §2）

---

## 執行環境

- 分支 `feat/reports-month-export`（已建立，**不要 push**）。
- 後端在 repo 根目錄（Git Bash）：
  - `./.venv/Scripts/python.exe -m pytest -q -W error`（**一定用 `.venv` 的 python**；整套約 2 分 20 秒，timeout 給 10 分鐘）。需要 dev 的 Postgres：`docker compose up -d`（專案名稱 `wallet`，資料庫在 `localhost:5433`）。**絕對不要跑 `down -v`。**
  - `./.venv/Scripts/python.exe -m ruff check .`、`./.venv/Scripts/python.exe -m mypy app`。**不要跑 `ruff format`**（handover §7）。
- 前端在 `frontend/`：`npx vitest run tests/xxx`、`npm run -s typecheck`、`npm run -s lint`（格式問題用 `npx biome check --write <檔案>`）、`npm run -s test`。驗證時一起 grep `FAIL` 與 `Unhandled`（handover §7）。
  - **vitest 印出來的數字不是剛好兩倍。** 每個檔案跑兩次（執行＋型別），但 `it.each` 在執行那次展開成好幾條、在型別那次算一條。這份計畫寫的都是**印出來的數字**。
- e2e：先 `docker compose up -d --build api`，再在 `frontend/` 跑 `npx playwright test …`（會自己起 dev server）。
- 基準線（`02e35df`，2026-10-09 量的）：後端 `pytest --collect-only -q` **936**；前端 `npm run -s test` 印出 `Test Files 130`、`Tests 1525`；e2e **41**；`grep -c "@router\." app/api/routes/*.py` 加總 **75**。開工前自己再量一次，對不上就照實記下來。
- **`schema.d.ts` 重新產生**（Task 5 動到 `app/api/routes`，在同一個 commit 做；CI 的 `contract` job 會 `git diff --exit-code`）：

  ```bash
  S=C:/Users/user/AppData/Local/Temp/claude/f--wallet/e7b60c93-fbd5-4a61-9c85-74550ff7244b/scratchpad
  PYTHONUTF8=1 PYTHONIOENCODING=utf-8 ./.venv/Scripts/python.exe -c "import json; from app.main import app; print(json.dumps(app.openapi(), ensure_ascii=False))" > "$S/openapi.tmp.json"; (cd frontend && npx openapi-typescript "$S/openapi.tmp.json" -o src/api/schema.d.ts)
  rm "$S/openapi.tmp.json"
  ```

- **Write／Edit；LF。不要留備份檔或暫存腳本在 repo 裡。** 突變後改回並重跑。**`.py` 的突變改回之後 `touch` 那個檔案**（mtime 沒變的話 Python 會繼續用突變版的 `.pyc`）。新檔案的突變 `git checkout --` 救不回來（handover §6 規矩 11）。
- **Commit 規則**：中文 conventional commit，訊息寫在 scratchpad 的檔案裡（`$S/commit-msg.txt`，用 Write 工具），結尾一行 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`，用 `git commit -F "$S/commit-msg.txt"`。`S` 就是上面那個 scratchpad 路徑——**每一次 Bash 呼叫都要重新設**（shell 的變數不會留到下一次）。**明確列出要 add 的檔案；絕對不要 stage `lunch.jpg`**（不要 `git add -A`／`git add .`）。不要 amend。

## 開工前必讀

1. 「Expected: FAIL」沒有如預期失敗 → 停下來回報。預測的紅燈數對不上 → 照實回報是哪幾條、為什麼。
2. 引用的程式碼對不上現況 → 以現況為準並回報。
3. 先寫測試、看它紅，再寫實作。**紅燈要問為什麼紅**（第 8 條規矩）：新模組還不存在時，紅的是 import（collection error／transform error），不是斷言——斷言有沒有咬合力由每個 task 的突變步驟證明。
4. **Task 1 的兩條測試、Task 3 的離線測試在動工前就是綠的，這是預期的**（第 39 種）：它們是釘子，守的是以後有人改壞。看到它沒紅不要去改測試，直接做突變那一步。
5. `tests/helpers/mock-api.ts` 用 `url.includes(path)` **依序**比對（第 43 種）：`/api/expenses` 會吃掉 `/api/expenses/summary` 與任何帶 `?month=` 的請求——越具體的路徑排越前面。
6. **「2026年11月」在報表上出現兩次**（月份標籤、清單的 `<h2>`），**「999.00」在摘要裡也出現兩次**（總計、佔 100% 的那個分類）（第 38 種）。月份標籤用 `within(group).getByRole("status")` 找；總額比 `toHaveTextContent("總計 999.00")`。寫這份計畫時第二個就踩到一次。
7. 斷言「沒有發生」之前先等一個「如果會發生，這時候已經發生了」的訊號（第 41 種）：先等錯誤訊息出現，再斷言沒有存檔；先等那個月載入完，再斷言清單裡沒有那一筆。
8. Playwright 的名稱預設是**子字串比對**：「這個月」⊂「這個月花了多少」、「2026年9月」⊂「2026年9月花了多少」——一律 `exact: true`，正規表示式要有 `^…$`。換頁之後的第一個斷言選只有新頁面才有的東西（第 48、53 種）。
9. e2e 登入後**只用點擊換頁**，不要 `page.goto`（access token 只在記憶體；並行時連續整頁載入會觸發 refresh token 重用、被登出）。Task 8 唯一的 `page.reload()` 用的是那條測試自己開的帳號。
10. `httpx.ASGITransport` 把整個回應收完才交回來，而且未處理的例外會直接從 `client.get()` 冒出來（第 31 種）：「一塊一塊吐」在端點層看不到，直接測 generator。
11. `client` 夾具跟測試共用一個 session、而且**不關它**（第 14 種）：「session 會不會在串流到一半被關掉」在那個夾具裡不存在，Task 5 有一條自己覆寫 `get_db` 的測試守這件事。
12. **不要跑「keyset 改成 `>=`」這個突變**：它讓 generator 永遠查到同一塊，測試不會紅，只會跑不完（寫這份計畫時實際卡住過一次）。
13. jsdom 的 `<a>.click()` 會去「導覽」（沒有實作）、`navigator` 沒有 `standalone`／`canShare`／`share`：Task 6 的測試自己攔 `HTMLAnchorElement.prototype.click`、自己用 `Object.defineProperty` 裝上去並在 `afterEach` 拿掉。
14. JSX children 位置的 `biome-ignore` 要寫成 `{/* biome-ignore … */}`（handover §7）；沒有作用的 suppression 本身會被 lint 擋下來。

## 這份計畫裡的程式碼已經整份跑過一次

寫計畫時在一個用完就刪的 git worktree（`02e35df`，沒有 commit、沒有留在 repo 裡）把下面每一段程式碼照抄進去跑過：

| | 結果 |
|---|---|
| 後端 `pytest -q -W error` | **980 passed**（936 ＋ 44），138 秒；`ruff check .`、`mypy app` 乾淨 |
| 前端 `npm run -s test` | `Test Files 138 passed`、`Tests 1631 passed`、`Type Errors no errors`；`typecheck`、`lint` 乾淨 |
| `schema.d.ts` 重新產生 | 只多三條路徑與三個 operation（＋120 行） |
| e2e（對著那個 worktree 起的 uvicorn 與 vite） | 新的 3 條綠；整套 **44 passed** |
| 突變 | 後端 26 個、前端 35 個、e2e 7 個，除了下面那一個以外**全部紅**；每個 task 的表格寫的是實測紅了哪幾條 |

所以每個 task「Expected: PASS」的數字是量出來的。**「Expected: FAIL」（實作之前的紅燈）沒有量**——那些是預測，對不上照實回報。
跑完之後只改過三處**註解**的文字（`ratelimit.py` 的規格章節編號、`conftest.py` 的 docstring、`test_export.py` 的一行說明），沒有再動任何會執行的東西。

實測時改掉的三件事（已經反映在下面的程式碼裡）：

- **`populate_existing` 拿掉了。** 原本餐點項目的查詢加了它，理由是「共用 session 的測試會讀到工廠留在記憶體的 `Decimal("150")` 而不是 `150.00`」（第 30、49 種）。
  突變存活：session 的 identity map 是弱參照，工廠建的 `MealItem` 沒有人握著就被回收了，查詢拿到的本來就是資料庫的值。那一行沒有任何測試看得到它的效果，刪掉。
  **如果之後有測試握著 `MealItem` 物件再去比匯出的份量，會看到 `150` 而不是 `150.00`——那是測試的問題，在測試裡 `refresh`。**
- **`role="status"` 不需要 `biome-ignore`**，`role="group"` 需要（理由照抄 `MoneyKeypad.tsx`）。
- **`.monthSwitch button:disabled` 不用寫**：`ui.module.css` 已經有 `.secondary:disabled { opacity: 0.4 }`。

## 開工前已經查證過的事實

| 事實 | 出處 |
|---|---|
| `GET /api/expenses` 與 `/summary` 都收 `month: str \| None = Query(default=None, pattern=YEAR_MONTH_PATTERN)`，共用 `_resolve_month()`（省略＝`this_month_in_timezone(user.timezone)`，界線＝`month_bounds`）；summary 回 `month`（正規化的 `YYYY-MM`） | `app/api/routes/expenses.py:38-56, 87-143, 163-205` |
| `YEAR_MONTH_PATTERN = r"^(19\|20)\d{2}-(0[1-9]\|1[0-2])$"`；不符是 FastAPI 的 422 | `app/schemas/expense.py:33` |
| 清單 `limit` 預設 100、最多 500；前端不帶 `limit` | `app/api/routes/expenses.py:90`、`frontend/src/api/expenses.ts` |
| 既有的月份測試：預設這個月、明確月份、0000-01 與 13 月 422、summary 的月界線（只有 summary、只有 12 月那一側） | `tests/test_expenses_crud.py:72-135`、`tests/test_expenses_summary.py:67-87` |
| `KeyedRateLimiter(limit, window_seconds, code, message)`：每次 `hit(key)` 都算，超過丟 `TooManyRequestsError`（429＋`Retry-After`）；模組層單例由 `tests/conftest.py` 的 autouse fixture 重置 | `app/ratelimit.py:163-205`、`tests/conftest.py:73-83` |
| `get_db` 是 `async with SessionLocal() as session: yield session`；`client` 夾具覆寫成 `yield db_session`（不關） | `app/db.py`、`tests/conftest.py` |
| **FastAPI 0.141.1（venv、lock、dev 容器三處都是）**：`yield` 依賴在 `StreamingResponse` **送完之後**才收尾；`Depends(dep, scope="function")` 則是第一塊之前就收尾（實測順序 `open, chunk, chunk, closed` 對 `open, closed, chunk, chunk`） | 寫計畫時的探針；`requirements-lock.txt:21` |
| `StreamingResponse(media_type="text/csv; charset=utf-8", headers={…})` 的 `content-type` 就是那個字串；`response_class=StreamingResponse`＋`responses={200: {"content": {"text/csv": …}}}` 讓 OpenAPI 只列 `text/csv` | 同上 |
| `item_join_query()`：`MealItem ⨝ FoodRevision（釘住的那一版）⨝ Food`；`scale(revision, quantity_g)` 四捨五入到兩位 | `app/meal_reads.py:9`、`app/nutrition.py:49` |
| 資料庫保證：`expenses.amount > 0`、`meal_items.quantity_g > 0`、`supplement_intakes.dose > 0`、營養素 `>= 0`——**沒有會是負數的數字欄** | `app/models/expense.py`、`meal.py`、`supplement.py`、`food.py` |
| `meals` 有 `note`（編輯畫面會寫）、`is_private`、`photo_path`；`supplement_intakes` 有 `dose` 與四個營養素快照，名稱在 `supplements` | `app/models/meal.py`、`supplement.py`；`frontend/src/screens/EditMeal.tsx` |
| 測試工廠：`create_expense(…, amount, category, spent_at, note, meal)`、`create_meal(…, eaten_at, meal_type, items=[(revision, quantity_g)], note, photo_path)`、`create_food(…, created_by, owner, name, brand, kcal…, base_unit)`、`create_supplement(…, created_by, owner, name, brand)`、`create_intake(…, supplement, dose, taken_at, kcal…)`；使用者時區用 `user.timezone = "…"; await db_session.commit()` 改 | `tests/factories.py` |
| 前端的中文標籤：分類 飲食／交通／日用／娛樂／醫療／居住／其他；餐別 早餐／午餐／晚餐／點心 | `frontend/src/api/expenses.ts`、`api/meals.ts` |
| `useExpenses(month)`／`useExpenseSummary(month)`：`null` 不帶 `?month=`；key `["expenses","list"\|"summary", month]`；`expensesAll = ["expenses"]`。除了報表，只有總覽用 `useExpenseSummary(null)` | `frontend/src/api/expenses.ts`、`api/queries.ts:123-140`、`screens/Overview.tsx` |
| `["expenses"]` 不在 `NOT_PERSISTED`；`shouldDehydrateQuery` 收 success 或「error 而且有 data」 | `frontend/src/api/persist.ts:79` |
| 趨勢頁的作法：`placeholderData: keepPreviousData`、`isPlaceholderData` → `{ "aria-busy": true, className: styles.stale }`、`.stale { opacity: var(--opacity-stale) }` | `frontend/src/screens/Trend.tsx:102-112`、`Trend.module.css` |
| `ui.secondary`：44px 的外框按鈕；`.secondary:disabled { opacity: 0.4 }`；`ui.sectionTitle`：小字灰色標題 | `frontend/src/components/ui.module.css:36, 139, 158` |
| `fetchWithAuthRetry(path, init)`：帶 token、401 換票重送一次；`fetchPhotoBlob` 是它的 blob 版 | `frontend/src/api/client.ts:40, 89` |
| 429 的訊息寫法：`` `${caught.message}（${caught.retryAfterSeconds} 秒後可再試）` `` | `frontend/src/screens/ChangePassword.tsx:48` |
| `role="group"` 要 `biome-ignore lint/a11y/useSemanticElements` | `frontend/src/components/MoneyKeypad.tsx:105` |
| `src/test/setup.ts` 替 jsdom 補了 `URL.createObjectURL`／`revokeObjectURL` | 同檔 |
| e2e：`newAccount(request, label)`、`loginAs(page, account)`、`login(page)`（示範帳號）、`expectTouchTargets(locator, where)`；記帳的點法在 `money-loop.spec.ts`；Playwright 預設 1280×720＝電腦版 | `frontend/e2e/new-account.ts`、`touch-targets.ts`、`money-loop.spec.ts` |
| 既有 e2e 用到報表標題的只有 `getByRole("heading", { name: "這個月", exact: true })`；沒有任何選擇器的名稱是「上個月」「下個月」「匯出資料」「餐點」「花費」的子字串或母字串（「補劑」只有 `exact` 的標題） | `grep -rn` `frontend/e2e` |

## 與規格的差異

目前沒有。

### 執行中發現的差異

（執行時填：實作跟計畫不一樣的地方、預測錯的紅燈、新踩到的「綠燈說謊」。）

## 檔案結構

| 檔案 | 負責什麼 | Task |
|---|---|---|
| `tests/test_expenses_summary.py`（改） | 明確帶月份時清單與報表切在同一個月界線；未來月份是空的不是錯誤 | 1 |
| `frontend/src/lib/months.ts`（新）、`frontend/tests/months.test.ts`（新） | `isYearMonth`、`shiftMonth`、`formatYearMonth`；不用 `Date` | 2 |
| `frontend/src/api/expenses.ts`（改） | 兩個 hook 加 `keepPreviousData` | 3 |
| `frontend/src/screens/Expenses.tsx`、`Expenses.module.css`（改） | 月份切換、`?month=`、標題、載入中 | 3 |
| `frontend/tests/expenses-month.test.tsx`（新）、`tests/offline.test.tsx`（改） | | 3 |
| `app/csv_export.py`（新）、`tests/test_csv_export.py`（新） | CSV 的唯一寫法：BOM、引號、公式字元 | 4 |
| `app/export.py`（新） | 三支分塊的 async generator、欄位、中文標籤 | 5 |
| `app/api/routes/export.py`（新）、`app/main.py`（改） | 三個端點、標頭、限速的呼叫 | 5 |
| `app/ratelimit.py`（改）、`tests/conftest.py`（改）、`pyproject.toml`（改） | `export_rate_limiter`；重置；`fastapi>=0.118` | 5 |
| `tests/test_export.py`（新）、`frontend/src/api/schema.d.ts`（重新產生） | | 5 |
| `frontend/src/api/client.ts`（改）、`frontend/src/lib/save-file.ts`（新） | `fetchDownload`；`saveBlob` | 6 |
| `frontend/tests/client.test.ts`（改）、`tests/save-file.test.ts`（新） | | 6 |
| `frontend/src/api/export.ts`、`src/components/ExportCard.tsx`、`ExportCard.module.css`（新）、`src/screens/Me.tsx`（改） | 「匯出資料」卡片 | 7 |
| `frontend/tests/export-card.test.tsx`（新）、`tests/me.test.tsx`（改） | | 7 |
| `frontend/e2e/reports-export.spec.ts`（新） | 換月份、匯出花費、手機尺寸 | 8 |
| `docs/handover.md`、規格（改） | | 9 |

---

## Task 1：後端——月份參數的查證與兩條釘子

**不改任何程式。** `GET /api/expenses` 與 `/summary` 已經收 `month`、有驗證、月界線用 `month_bounds`（規格 A3、§3.1）。缺的是兩件以前前端走不到、所以沒有測試的事：

- 明確帶月份時，**清單**也用使用者時區切月（既有的月界線測試只測了 summary、只測了 12 月那一側）。
- 未來的月份是 200 的空結果（前端在知道這個月之前可能先照網址問一次）。

**Files:**
- Modify: `tests/test_expenses_summary.py`

- [ ] **Step 1: 加兩條測試**——接在 `tests/test_expenses_summary.py` 的最後面（檔頭已經有 `UTC`、`datetime`、`create_expense`、`create_user`、`auth` 的 import）：

```python
async def test_list_and_summary_agree_on_explicit_months_at_the_local_boundary(
    client, db_session
):
    """報表可以看其他月份之後（報表月份與匯出規格 §2），明確帶 `month` 的清單與報表
    都要用使用者時區切月，而且切在同一個地方。

    台北 11/30 23:59:59 ＝ UTC 11/30 15:59:59（11 月的最後一秒）；
    台北 12/01 00:00:00 ＝ UTC 11/30 16:00:00（12 月的第一刻）。
    兩筆在 UTC 都是 11 月 30 日：用 UTC 切月，兩筆都會算進 11 月。
    """
    user = await create_user(db_session)  # timezone 預設 Asia/Taipei
    await create_expense(
        db_session,
        user=user,
        amount=111,
        spent_at=datetime(2026, 11, 30, 15, 59, 59, tzinfo=UTC),
        note="十一月的最後一筆",
    )
    await create_expense(
        db_session,
        user=user,
        amount=222,
        spent_at=datetime(2026, 11, 30, 16, 0, tzinfo=UTC),
        note="十二月的第一筆",
    )

    seen = {}
    for month in ("2026-11", "2026-12"):
        listing = await client.get(f"/api/expenses?month={month}", headers=auth(user))
        summary = await client.get(f"/api/expenses/summary?month={month}", headers=auth(user))
        seen[month] = (
            [item["note"] for item in listing.json()],
            summary.json()["total"],
            summary.json()["month"],
        )

    assert seen == {
        "2026-11": (["十一月的最後一筆"], "111.00", "2026-11"),
        "2026-12": (["十二月的第一筆"], "222.00", "2026-12"),
    }


async def test_a_future_month_is_empty_not_an_error(client, db_session):
    """前端在知道「這個月是哪個月」之前，可能先照網址上的月份問一次（手打的未來月份）。
    那一次要是 200 的空報表，不是 422——畫面才不會先閃一個錯誤再退回這個月。"""
    user = await create_user(db_session)
    await create_expense(db_session, user=user, amount=100)  # 2026-12-15

    listing = await client.get("/api/expenses?month=2099-12", headers=auth(user))
    summary = await client.get("/api/expenses/summary?month=2099-12", headers=auth(user))

    assert (listing.status_code, listing.json()) == (200, [])
    assert summary.json() == {"month": "2099-12", "total": "0.00", "by_category": []}
```

- [ ] **Step 2: 跑**

Run: `./.venv/Scripts/python.exe -m pytest -q -W error tests/test_expenses_summary.py`
Expected: `9 passed`。**動工前就是綠的，這是預期的**（開工前必讀第 4 點）。

- [ ] **Step 3: 突變**（證明第一條咬得到；每個改完跑 `./.venv/Scripts/python.exe -m pytest -q -W error tests/test_expenses_summary.py tests/test_expenses_crud.py`）

| 突變（`app/api/routes/expenses.py`） | 實測 |
|---|---|
| `list_expenses` 的 `_resolve_month(month, user.timezone)` → `_resolve_month(month, "UTC")` | `1 failed, 32 passed`：只有新的 `test_list_and_summary_agree_…`（既有測試沒有一條守清單的月界線） |
| `get_summary` 的 `_resolve_month(month, user.timezone)` → `_resolve_month(month, "UTC")` | `2 failed, 31 passed`：既有的 `test_summary_respects_user_timezone_at_the_month_boundary` 與新的那條 |

改回之後 `touch app/api/routes/expenses.py`，重跑確認 `33 passed`。

第二條（未來的月份）沒有現成的一行可以突變——後端沒有「擋未來月份」的程式碼。它紅的方式是以後有人加上那個檢查；不用硬找一個突變。

- [ ] **Step 4: lint 與 commit**

Run: `./.venv/Scripts/python.exe -m ruff check tests/test_expenses_summary.py`（乾淨）；`git status --short` 只有這個檔案與 `lunch.jpg`。

```
test(backend): 明確帶月份的清單與報表切在同一個月界線，未來的月份是空的不是錯誤

報表要能看其他月份了：以前前端固定不帶 month，「明確帶月份的清單也用使用者時區切月」
沒有任何測試（既有的月界線測試只測 summary）。不改程式，補兩條釘子；
突變 list_expenses 用 UTC 切月，只有新的那條紅。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

```bash
git add tests/test_expenses_summary.py
git commit -F "$S/commit-msg.txt"
```

---

## Task 2：前端——`lib/months.ts`

月份字串的加減與顯示（規格 A4、A5）。純函式，不碰畫面。

**Files:**
- Create: `frontend/src/lib/months.ts`、`frontend/tests/months.test.ts`

- [ ] **Step 1: 寫失敗的測試** `frontend/tests/months.test.ts`：

```ts
/// <reference types="node" />
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { formatYearMonth, isYearMonth, shiftMonth } from "../src/lib/months";

describe("isYearMonth", () => {
	it.each(["2026-10", "1900-01", "2099-12", "2000-02"])(
		"%s 是月份",
		(value) => {
			expect(isYearMonth(value)).toBe(true);
		},
	);

	// 後端的 YEAR_MONTH_PATTERN 不收的，這裡也不收——送出去會是 422。
	it.each([
		"",
		"2026-13",
		"2026-00",
		"2026-1",
		"2026-010",
		"0000-01",
		"1899-12",
		"2100-01",
		" 2026-10",
		"2026-10 ",
		"2026-10-01",
		"2026/10",
		"abcd-ef",
	])("%j 不是月份", (value) => {
		expect(isYearMonth(value)).toBe(false);
	});
});

describe("shiftMonth", () => {
	it("同一年裡往前、往後", () => {
		expect(shiftMonth("2026-10", -1)).toBe("2026-09");
		expect(shiftMonth("2026-09", 1)).toBe("2026-10");
	});

	it("跨年：1 月的上個月是去年 12 月，12 月的下個月是明年 1 月", () => {
		// 一年只有這兩個月會寫錯（後端的 month_bounds 也是在 12 月進位）。
		expect(shiftMonth("2026-01", -1)).toBe("2025-12");
		expect(shiftMonth("2026-12", 1)).toBe("2027-01");
	});

	it("一次推好幾個月", () => {
		expect(shiftMonth("2026-03", -14)).toBe("2025-01");
		expect(shiftMonth("2026-03", 0)).toBe("2026-03");
	});

	it("推出後端收的範圍回 null", () => {
		expect(shiftMonth("1900-01", -1)).toBeNull();
		expect(shiftMonth("2099-12", 1)).toBeNull();
	});

	it("格式不對就拋", () => {
		expect(() => shiftMonth("2026-9", -1)).toThrow();
		expect(() => shiftMonth("", 1)).toThrow();
	});
});

describe("formatYearMonth", () => {
	it("給人看的月份，月份不補零", () => {
		expect(formatYearMonth("2026-09")).toBe("2026年9月");
		expect(formatYearMonth("2026-10")).toBe("2026年10月");
	});

	it("格式不對就拋", () => {
		expect(() => formatYearMonth("2026-13")).toThrow();
	});
});

describe("lib/months.ts 不問現在幾點", () => {
	it("原始碼（去掉註解之後）沒有用到 Date", () => {
		// 「這個月是哪個月」只有後端知道。這個模組哪天長出 `new Date()`，
		// 在台北與 CI（UTC）大部分時候都是對的，只在月初、月底那幾個小時錯
		// ——行為測試擋不住，原始碼掃描擋得住（同 tests/civil-date.test.ts）。
		const code = readFileSync("src/lib/months.ts", "utf8")
			.replace(/\/\*[\s\S]*?\*\//g, "")
			.replace(/\/\/.*$/gm, "");
		expect(code).toContain("export function shiftMonth"); // 真的讀到程式碼了
		expect(code).not.toMatch(/\bDate\b/);
	});
});
```

- [ ] **Step 2: 跑，確認紅**

Run（在 `frontend/`）: `npx vitest run tests/months.test.ts 2>&1 | grep -E "FAIL|Unhandled|Tests |Error"`
Expected: FAIL——找不到 `../src/lib/months`（import 解析失敗，整個檔案 0 條測試在跑）。

- [ ] **Step 3: 實作** `frontend/src/lib/months.ts`：

```ts
/** **月份字串（`YYYY-MM`）的加減與顯示。這個模組不問「現在是哪個月」。**
 *
 *  跟 `lib/civil-date.ts` 同一條規矩：輸入是一個**已經決定好的**月份——後端報表
 *  回應裡的 `month`（`this_month_in_timezone(user.timezone)` 算的），或網址上的
 *  `?month=`——輸出是另一個月份字串。「這個月是哪個月」只有後端知道
 *  （`lib/dates.ts` 檔頭）；這裡純粹做字串與整數運算，完全不碰裝置的時鐘
 *  （`tests/months.test.ts` 有一條原始碼掃描守著）。
 */

/** 後端 `YEAR_MONTH_PATTERN`（`app/schemas/expense.py`）的同一條規則：19xx／20xx 年、
 *  01–12 月。範圍外的值送出去會是 422，所以在這裡就當成「不是月份」。 */
const YEAR_MONTH = /^(19|20)\d{2}-(0[1-9]|1[0-2])$/;

export function isYearMonth(value: string): boolean {
	return YEAR_MONTH.test(value);
}

/** 往前或往後推 `delta` 個月。推出後端收的範圍（1900-01 到 2099-12）回 `null`——
 *  呼叫端據此停用按鈕，而不是送一個會被 422 的月份。 */
export function shiftMonth(month: string, delta: number): string | null {
	if (!isYearMonth(month)) {
		throw new Error(
			`shiftMonth 只接受 YYYY-MM，收到：${JSON.stringify(month)}`,
		);
	}
	// 從西元 0 年 1 月起算的月數：加減之後再拆回年與月，跨年不用特別處理。
	const index =
		Number(month.slice(0, 4)) * 12 + (Number(month.slice(5, 7)) - 1) + delta;
	const year = Math.floor(index / 12);
	const shifted = `${String(year).padStart(4, "0")}-${String((index % 12) + 1).padStart(2, "0")}`;
	return isYearMonth(shifted) ? shifted : null;
}

/** `"2026-09"` → `"2026年9月"`。純字串切割，`Number()` 去掉前導零。 */
export function formatYearMonth(month: string): string {
	if (!isYearMonth(month)) {
		throw new Error(
			`formatYearMonth 只接受 YYYY-MM，收到：${JSON.stringify(month)}`,
		);
	}
	return `${Number(month.slice(0, 4))}年${Number(month.slice(5, 7))}月`;
}
```

- [ ] **Step 4: 跑，確認綠**

Run: `npx vitest run tests/months.test.ts 2>&1 | grep -E "FAIL|Unhandled|Tests |Type Errors"`
Expected: `Tests  35 passed (35)`、`Type Errors  no errors`。

- [ ] **Step 5: 突變**

| 突變（`src/lib/months.ts`） | 實測 |
|---|---|
| `const year = Math.floor(index / 12);` → `const year = Number(month.slice(0, 4));`（不進位） | `3 failed`：跨年、一次推好幾個月、推出範圍回 null |
| 同一行後面加 `+ 0 * new Date().getFullYear()` | `1 failed`：原始碼掃描那條 |

改回，重跑綠。

- [ ] **Step 6: 型別、lint、commit**

Run: `npm run -s typecheck`（沒有輸出）、`npx biome check src/lib/months.ts tests/months.test.ts`（乾淨）。

```
feat(frontend): 月份字串的加減與顯示（lib/months.ts）

報表要看其他月份：isYearMonth（跟後端的 YEAR_MONTH_PATTERN 同一條規則）、shiftMonth
（推出 1900-01～2099-12 回 null）、formatYearMonth（2026年9月）。純字串運算，不用 Date
——「這個月是哪個月」只有後端知道；原始碼掃描測試守著。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

```bash
git add frontend/src/lib/months.ts frontend/tests/months.test.ts
git commit -F "$S/commit-msg.txt"
```

---

## Task 3：前端——報表的月份切換

規格 §4.1、決定 A1–A14。

**Files:**
- Create: `frontend/tests/expenses-month.test.tsx`
- Modify: `frontend/src/api/expenses.ts`、`frontend/src/screens/Expenses.tsx`、`frontend/src/screens/Expenses.module.css`、`frontend/tests/offline.test.tsx`

- [ ] **Step 1: 寫失敗的測試** `frontend/tests/expenses-month.test.tsx`（新檔；既有的 `tests/expenses.test.tsx` 一個字都不用改）：

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation, useNavigate } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetRefreshStateForTests } from "../src/auth/refresh";
import { clearTokens, setTokens } from "../src/auth/store";
import { Expenses } from "../src/screens/Expenses";
import expensesStyles from "../src/screens/Expenses.module.css";
import { json, mockApi, type Route } from "./helpers/mock-api";

/** 換月份時調淡卡片的 class（同 trend.test.tsx 的作法：真的不見了會變成
 *  "undefined"，斷言一樣紅，不會空字串假綠）。 */
const STALE_CLASS = String(expensesStyles.stale);

/** 後端說的這個月是 2026-12；上個月是 2026-11。 */
const DEC_SUMMARY = {
	month: "2026-12",
	total: "180.00",
	by_category: [{ category: "food", total: "180.00", count: 1 }],
};
const DEC_ROW = {
	id: 1,
	amount: "180.00",
	category: "food" as const,
	spent_at: "2026-12-15T04:00:00+00:00",
	note: "十二月的便當",
	meal_id: null,
};
const NOV_SUMMARY = {
	month: "2026-11",
	total: "999.00",
	by_category: [{ category: "transport", total: "999.00", count: 1 }],
};
const NOV_ROW = {
	id: 2,
	amount: "999.00",
	category: "transport" as const,
	spent_at: "2026-11-20T04:00:00+00:00",
	note: "十一月的高鐵",
	meal_id: null,
};

/** 十二月（沒帶 `?month=`）的兩個端點。**放在最後面**：mock 用 `url.includes(path)`
 *  依序比對，`/api/expenses` 會吃掉 `/api/expenses/summary` 與任何帶 `?month=` 的請求
 *  （第 43 種）——越具體的越前面。 */
const DECEMBER: Route[] = [
	{
		method: "GET",
		path: "/api/expenses/summary",
		handler: () => json(DEC_SUMMARY),
	},
	{ method: "GET", path: "/api/expenses", handler: () => json([DEC_ROW]) },
];

const NOVEMBER: Route[] = [
	{
		method: "GET",
		path: "/api/expenses/summary?month=2026-11",
		handler: () => json(NOV_SUMMARY),
	},
	{
		method: "GET",
		path: "/api/expenses?month=2026-11",
		handler: () => json([NOV_ROW]),
	},
];

/** 目前的網址，外加一顆「上一頁」——分辨換月份是 push 還是 replace 用的。 */
function LocationProbe() {
	const location = useLocation();
	const navigate = useNavigate();
	return (
		<>
			<span data-testid="location">{location.pathname + location.search}</span>
			<button type="button" onClick={() => navigate(-1)}>
				測試用：上一頁
			</button>
		</>
	);
}

/** 在 `entries` 的最後一個網址上畫報表（前面的是「之前去過的頁面」）。 */
function renderAt(...entries: string[]) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return render(
		<QueryClientProvider client={client}>
			<MemoryRouter initialEntries={entries} initialIndex={entries.length - 1}>
				<Expenses />
				<LocationProbe />
			</MemoryRouter>
		</QueryClientProvider>,
	);
}

/** 這個 spy 收到過的 GET 網址。 */
function requested(fetchMock: ReturnType<typeof mockApi>): string[] {
	return fetchMock.mock.calls
		.filter(([, init]) => (init?.method ?? "GET").toUpperCase() === "GET")
		.map(([input]) => String(input));
}

function location(): string {
	return screen.getByTestId("location").textContent ?? "";
}

/** 月份切換那一組。「2026年11月」同時是月份標籤與清單的標題——一律限定範圍找
 *  （第 38 種）。 */
function switcher() {
	return within(screen.getByRole("group", { name: "切換月份" }));
}
const previousButton = () => switcher().getByRole("button", { name: "上個月" });
const nextButton = () => switcher().getByRole("button", { name: "下個月" });
const monthLabel = () => switcher().getByRole("status");

beforeEach(() => {
	localStorage.clear();
	clearTokens();
	resetRefreshStateForTests();
	vi.restoreAllMocks();
	setTokens({ access_token: "a", refresh_token: "r" });
});

describe("報表：切換月份", () => {
	it("沒帶月份：顯示後端說的這個月，「下個月」不能按", async () => {
		mockApi(DECEMBER);
		renderAt("/reports");

		expect(await screen.findByText("十二月的便當")).toBeInTheDocument();
		expect(monthLabel()).toHaveTextContent("2026年12月");
		expect(nextButton()).toBeDisabled();
		expect(previousButton()).toBeEnabled();
		expect(
			screen.getByRole("heading", { name: "這個月花了多少" }),
		).toBeInTheDocument();
		expect(screen.getByRole("heading", { name: "這個月" })).toBeInTheDocument();
		expect(location()).toBe("/reports");
	});

	it("還不知道這個月是哪個月：兩顆都不能按（前端不拿裝置的日期猜）", async () => {
		let resolveSummary: (response: Response) => void = () => {};
		mockApi([
			{
				method: "GET",
				path: "/api/expenses/summary",
				handler: () =>
					new Promise<Response>((resolve) => {
						resolveSummary = resolve;
					}),
			},
			{ method: "GET", path: "/api/expenses", handler: () => json([DEC_ROW]) },
		]);
		renderAt("/reports");

		// 清單已經回來了，報表（也就是「這個月是哪個月」）還沒。
		expect(await screen.findByText("十二月的便當")).toBeInTheDocument();
		expect(previousButton()).toBeDisabled();
		expect(nextButton()).toBeDisabled();
		expect(monthLabel()).toHaveTextContent("這個月");

		resolveSummary(json(DEC_SUMMARY));

		await waitFor(() => expect(previousButton()).toBeEnabled());
		expect(monthLabel()).toHaveTextContent("2026年12月");
		expect(nextButton()).toBeDisabled();
	});

	it("上個月：網址帶上月份，清單與報表都換成那個月，標題跟著改；下個月回到沒有參數的網址", async () => {
		const fetchMock = mockApi([...NOVEMBER, ...DECEMBER]);
		renderAt("/reports");
		await screen.findByText("十二月的便當");

		await userEvent.click(previousButton());

		expect(await screen.findByText("十一月的高鐵")).toBeInTheDocument();
		expect(location()).toBe("/reports?month=2026-11");
		expect(requested(fetchMock)).toContain(
			"/api/expenses/summary?month=2026-11",
		);
		expect(requested(fetchMock)).toContain("/api/expenses?month=2026-11");
		expect(monthLabel()).toHaveTextContent("2026年11月");
		expect(
			screen.getByRole("heading", { name: "2026年11月花了多少" }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("heading", { name: "2026年11月" }),
		).toBeInTheDocument();
		// 「999.00」在摘要裡出現兩次（總計、佔 100% 的那個分類）——比整段文字（第 38 種）。
		expect(screen.getByTestId("expense-summary")).toHaveTextContent(
			"總計 999.00",
		);
		expect(screen.queryByText("十二月的便當")).not.toBeInTheDocument();
		expect(nextButton()).toBeEnabled();

		await userEvent.click(nextButton());

		expect(await screen.findByText("十二月的便當")).toBeInTheDocument();
		// 回到這個月＝沒有參數，不是 ?month=2026-12。
		expect(location()).toBe("/reports");
		expect(
			screen.getByRole("heading", { name: "這個月花了多少" }),
		).toBeInTheDocument();
		expect(nextButton()).toBeDisabled();

		// 換月份是 push：上一頁回到十一月。
		await userEvent.click(
			screen.getByRole("button", { name: "測試用：上一頁" }),
		);
		expect(location()).toBe("/reports?month=2026-11");
		expect(await screen.findByText("十一月的高鐵")).toBeInTheDocument();
	});

	it("新的月份還在載入：留著上一個月的資料但調淡、標成載入中；月份與標題已經是新的", async () => {
		let resolveSummary: (response: Response) => void = () => {};
		let resolveList: (response: Response) => void = () => {};
		mockApi([
			{
				method: "GET",
				path: "/api/expenses/summary?month=2026-11",
				handler: () =>
					new Promise<Response>((resolve) => {
						resolveSummary = resolve;
					}),
			},
			{
				method: "GET",
				path: "/api/expenses?month=2026-11",
				handler: () =>
					new Promise<Response>((resolve) => {
						resolveList = resolve;
					}),
			},
			...DECEMBER,
		]);
		renderAt("/reports");
		await screen.findByText("十二月的便當");
		expect(screen.getByTestId("month-summary")).not.toHaveAttribute(
			"aria-busy",
		);
		expect(screen.getByTestId("month-list")).not.toHaveAttribute("aria-busy");

		await userEvent.click(previousButton());

		// 十一月的兩個回應都還掛著。
		expect(monthLabel()).toHaveTextContent("2026年11月");
		expect(
			screen.getByRole("heading", { name: "2026年11月花了多少" }),
		).toBeInTheDocument();
		for (const testId of ["month-summary", "month-list"]) {
			expect(screen.getByTestId(testId)).toHaveAttribute("aria-busy", "true");
			expect(screen.getByTestId(testId)).toHaveClass(STALE_CLASS);
		}
		expect(screen.getByText("十二月的便當")).toBeInTheDocument();
		expect(screen.queryByText("載入中…")).not.toBeInTheDocument();
		// 按下去的那顆還在、焦點沒跑掉。
		expect(document.activeElement).toBe(previousButton());

		resolveSummary(json(NOV_SUMMARY));
		resolveList(json([NOV_ROW]));

		expect(await screen.findByText("十一月的高鐵")).toBeInTheDocument();
		for (const testId of ["month-summary", "month-list"]) {
			expect(screen.getByTestId(testId)).not.toHaveAttribute("aria-busy");
			expect(screen.getByTestId(testId)).not.toHaveClass(STALE_CLASS);
		}
		expect(screen.queryByText("十二月的便當")).not.toBeInTheDocument();
	});

	it("重新整理停在過去的月份：一開始就問那個月，不先問這個月的清單", async () => {
		const fetchMock = mockApi([...NOVEMBER, ...DECEMBER]);
		renderAt("/reports?month=2026-11");

		expect(await screen.findByText("十一月的高鐵")).toBeInTheDocument();
		await waitFor(() => expect(nextButton()).toBeEnabled());
		expect(monthLabel()).toHaveTextContent("2026年11月");
		expect(
			screen.getByRole("heading", { name: "2026年11月" }),
		).toBeInTheDocument();
		expect(location()).toBe("/reports?month=2026-11");
		// 這個月只問了報表（為了知道這個月是哪個月），沒有問清單。
		expect(requested(fetchMock).sort()).toEqual([
			"/api/expenses/summary",
			"/api/expenses/summary?month=2026-11",
			"/api/expenses?month=2026-11",
		]);
	});

	it.each([["2026-13"], ["2026-1"], ["abc"], [""]])(
		"?month=%s 格式不對：當成這個月，網址用 replace 清掉，而且沒有拿它去問後端",
		async (bad) => {
			const fetchMock = mockApi(DECEMBER);
			renderAt("/", `/reports?month=${bad}`);

			expect(await screen.findByText("十二月的便當")).toBeInTheDocument();
			await waitFor(() => expect(location()).toBe("/reports"));
			expect(monthLabel()).toHaveTextContent("2026年12月");
			expect(
				requested(fetchMock).filter((url) => url.includes("month=")),
			).toEqual([]);

			// replace：上一頁回到進報表之前的那一頁，不是回到壞掉的網址（再被清一次）。
			await userEvent.click(
				screen.getByRole("button", { name: "測試用：上一頁" }),
			);
			expect(location()).toBe("/");
		},
	);

	it("未來的月份：後端回了這個月才知道，退回這個月並用 replace 清掉網址", async () => {
		mockApi([
			{
				method: "GET",
				path: "/api/expenses/summary?month=2027-01",
				handler: () =>
					json({ month: "2027-01", total: "0.00", by_category: [] }),
			},
			{
				method: "GET",
				path: "/api/expenses?month=2027-01",
				handler: () => json([]),
			},
			...DECEMBER,
		]);
		renderAt("/", "/reports?month=2027-01");

		expect(await screen.findByText("十二月的便當")).toBeInTheDocument();
		await waitFor(() => expect(location()).toBe("/reports"));
		expect(monthLabel()).toHaveTextContent("2026年12月");
		expect(
			screen.getByRole("heading", { name: "這個月花了多少" }),
		).toBeInTheDocument();
		expect(nextButton()).toBeDisabled();

		await userEvent.click(
			screen.getByRole("button", { name: "測試用：上一頁" }),
		);
		expect(location()).toBe("/");
	});

	it("?month 剛好是這個月：照樣是「這個月」，下個月不能按，網址不動", async () => {
		mockApi([
			{
				method: "GET",
				path: "/api/expenses/summary?month=2026-12",
				handler: () => json(DEC_SUMMARY),
			},
			{
				method: "GET",
				path: "/api/expenses?month=2026-12",
				handler: () => json([DEC_ROW]),
			},
			...DECEMBER,
		]);
		renderAt("/reports?month=2026-12");

		expect(await screen.findByText("十二月的便當")).toBeInTheDocument();
		expect(
			await screen.findByRole("heading", { name: "這個月花了多少" }),
		).toBeInTheDocument();
		expect(nextButton()).toBeDisabled();
		expect(previousButton()).toBeEnabled();
		expect(location()).toBe("/reports?month=2026-12");
	});

	it("這個月的報表讀不到：過去的月份照樣看得到、可以再往前，但不能往後", async () => {
		mockApi([
			...NOVEMBER,
			{
				method: "GET",
				path: "/api/expenses/summary",
				handler: () =>
					json({ error: { code: "X", message: "x", details: {} } }, 500),
			},
			{ method: "GET", path: "/api/expenses", handler: () => json([]) },
		]);
		renderAt("/reports?month=2026-11");

		expect(await screen.findByText("十一月的高鐵")).toBeInTheDocument();
		expect(monthLabel()).toHaveTextContent("2026年11月");
		expect(previousButton()).toBeEnabled();
		expect(nextButton()).toBeDisabled();
		expect(location()).toBe("/reports?month=2026-11");
	});

	it("過去的月份沒有資料、讀不到時，說的是那個月，不是「這個月」", async () => {
		mockApi([
			{
				method: "GET",
				path: "/api/expenses/summary?month=2026-11",
				handler: () =>
					json({ month: "2026-11", total: "0.00", by_category: [] }),
			},
			{
				method: "GET",
				path: "/api/expenses?month=2026-11",
				handler: () => json([]),
			},
			{
				method: "GET",
				path: "/api/expenses/summary?month=2026-10",
				handler: () =>
					json({ error: { code: "X", message: "x", details: {} } }, 500),
			},
			{
				method: "GET",
				path: "/api/expenses?month=2026-10",
				handler: () => json([]),
			},
			...DECEMBER,
		]);
		renderAt("/reports?month=2026-11");

		expect(await screen.findByText("2026年11月沒有支出")).toBeInTheDocument();
		expect(screen.getByText("2026年11月沒有記錄花費")).toBeInTheDocument();
		expect(screen.queryByText(/這個月還沒有/)).not.toBeInTheDocument();

		await userEvent.click(previousButton());

		expect(
			await screen.findByText("無法載入2026年10月的報表"),
		).toBeInTheDocument();
		expect(location()).toBe("/reports?month=2026-10");
	});

	it("在過去的月份刪掉一筆：重抓的是那個月的清單與報表", async () => {
		let deleted = false;
		const fetchMock = mockApi([
			{
				method: "DELETE",
				path: "/api/expenses/2",
				handler: () => {
					deleted = true;
					return new Response(null, { status: 204 });
				},
			},
			{
				method: "GET",
				path: "/api/expenses/summary?month=2026-11",
				handler: () =>
					json(
						deleted
							? { month: "2026-11", total: "0.00", by_category: [] }
							: NOV_SUMMARY,
					),
			},
			{
				method: "GET",
				path: "/api/expenses?month=2026-11",
				handler: () => json(deleted ? [] : [NOV_ROW]),
			},
			...DECEMBER,
		]);
		renderAt("/reports?month=2026-11");
		const row = await screen.findByTestId("expense-2");

		await userEvent.click(within(row).getByRole("button", { name: "刪除" }));
		await userEvent.click(
			within(row).getByRole("button", { name: "確定刪除" }),
		);

		expect(
			await screen.findByText("2026年11月沒有記錄花費"),
		).toBeInTheDocument();
		expect(await screen.findByText("2026年11月沒有支出")).toBeInTheDocument();
		expect(
			requested(fetchMock).filter(
				(url) => url === "/api/expenses?month=2026-11",
			),
		).toHaveLength(2);
		expect(location()).toBe("/reports?month=2026-11");
	});
});
```

- [ ] **Step 2: 離線的那一條**——`frontend/tests/offline.test.tsx`。

先讓 `wrap` 收網址（把既有的 `function wrap(client: QueryClient, children: ReactNode) { … }` 整個換掉；既有的呼叫端不用改）：

```tsx
function wrap(
	client: QueryClient,
	children: ReactNode,
	// 報表的月份在網址上（`?month=`）：要測「停在某個月重新載入」就給網址。
	entries: string[] = ["/"],
) {
	return (
		<PersistQueryClientProvider
			client={client}
			persistOptions={createOfflinePersistOptions(window.localStorage)}
		>
			<MemoryRouter initialEntries={entries}>{children}</MemoryRouter>
		</PersistQueryClientProvider>
	);
}
```

再把這一條加在 `describe("離線 L2：持久化與「最後更新於」", …)` 的最後面（最後一個 `});` 之前）：

```tsx
	it("過去月份的報表也進離線快取：離線重新載入停在那個月，資料還在", async () => {
		// 報表可以看其他月份之後（報表月份與匯出規格 §2）：`["expenses", "list" | "summary",
		// "2026-08"]` 跟這個月的 key（月份是 null）走同一條持久化規則。這一條在 persist.ts
		// 沒有任何改動的情況下就該是綠的——它守的是以後有人把 "expenses" 加進
		// NOT_PERSISTED、或讓帶月份的 key 換了命名空間。
		const august = {
			month: "2026-08",
			total: "640.00",
			by_category: [
				{ category: "food", total: "400.00", count: 2 },
				{ category: "transport", total: "240.00", count: 1 },
			],
		};
		const routes = {
			// 具體的排前面（url.includes 依序比對）。
			"/api/expenses/summary?month=2026-08": () => json(august),
			"/api/expenses?month=2026-08": () =>
				json([
					{
						id: 7,
						amount: "240.00",
						category: "transport",
						spent_at: "2026-08-20T04:00:00+00:00",
						note: "八月的高鐵",
						meal_id: null,
					},
				]),
			"/api/expenses/summary": () =>
				json({ month: "2026-09", total: "0.00", by_category: [] }),
			"/api/expenses": () => json([]),
		};
		const persistedMonths = () =>
			readPersistedQueries()
				.filter((query) => query.queryKey[0] === "expenses")
				.map((query) => JSON.stringify(query.queryKey))
				.sort();

		// 第一階段：線上，停在八月。
		mockApi(routes);
		const first = render(
			wrap(newTestClient(), <Expenses />, ["/reports?month=2026-08"]),
		);
		await screen.findByText("八月的高鐵");
		await waitFor(
			() =>
				expect(persistedMonths()).toEqual([
					JSON.stringify(queryKeys.expenses("2026-08")),
					JSON.stringify(queryKeys.expenseSummary("2026-08")),
					JSON.stringify(queryKeys.expenseSummary(null)),
				]),
			{ timeout: 3000 },
		);
		first.unmount();

		// 第二階段：離線，全新的 QueryClient，同一個網址。
		vi.restoreAllMocks();
		const offline = goOffline();
		render(wrap(newTestClient(), <Expenses />, ["/reports?month=2026-08"]));

		expect(await screen.findByText("八月的高鐵")).toBeInTheDocument();
		expect(screen.getByTestId("expense-summary")).toHaveTextContent(
			"總計 640.00",
		);
		expect(
			screen.getByRole("heading", { name: "2026年8月花了多少" }),
		).toBeInTheDocument();
		// 資料來自 localStorage：還新鮮（staleTime 60 秒），一個請求都沒發。
		expect(offline).not.toHaveBeenCalled();
	});
```

- [ ] **Step 3: 跑，確認紅**

Run: `npx vitest run tests/expenses-month.test.tsx tests/offline.test.tsx 2>&1 | grep -E "FAIL|Unhandled|Tests |Type Errors|×"`
Expected（預測，沒有量）: `expenses-month` 的 14 條執行期測試全紅——找不到名叫「切換月份」的 group（元件還沒有它，這是對的紅）；`offline` 新的那條紅——報表不理 `?month=`，「八月的高鐵」不會出現。`offline` 既有的 10 條仍然綠。

- [ ] **Step 4: 兩個 hook 加 `keepPreviousData`**——`frontend/src/api/expenses.ts`。

檔頭的 import 改成 `import { keepPreviousData, useQuery } from "@tanstack/react-query";`，然後把 `useExpenses` 與 `useExpenseSummary`（含它們的註解）換成：

```ts
/** 這個月（或指定月份）的花費清單。
 *
 *  `month` 為 `null` 時**不帶 `?month=`**，讓後端用使用者時區決定這個月
 *  （`this_month_in_timezone`）。前端不自己算月份——跟 `Today.tsx` 的
 *  `dailyStats` 查詢不自己算今天是同一條規矩（`queryKeys.dailyStats`
 *  不帶日期參數，見 `api/queries.ts` 檔頭註解）。
 *
 *  **`keepPreviousData`**（報表換月份）：`month` 換了、新的那個月還沒回來時，
 *  `data` 先留著上一個月的，`isPlaceholderData` 是 true——報表據此把卡片調淡、
 *  標成載入中，而不是整塊退回「載入中…」。`month` 固定不變的呼叫端（總覽的
 *  `useExpenseSummary(null)`）永遠碰不到這條路。新的月份載入**失敗**時沒有
 *  資料可留：`data` 是 undefined、`isError` 是 true。 */
export function useExpenses(month: string | null) {
	return useQuery({
		queryKey: queryKeys.expenses(month),
		queryFn: () =>
			apiFetch<Expense[]>(
				month === null ? "/api/expenses" : `/api/expenses?month=${month}`,
			),
		placeholderData: keepPreviousData,
	});
}

/** 月報表：總額 + 分類佔比。`month` 的語意、`keepPreviousData` 同 `useExpenses`。
 *
 *  回應裡的 `month` 是後端正規化過的 `YYYY-MM`；`month` 傳 `null` 時它就是
 *  「後端說的這個月」——報表的月份切換拿它當「不能再往後」的界線，不自己算。 */
export function useExpenseSummary(month: string | null) {
	return useQuery({
		queryKey: queryKeys.expenseSummary(month),
		queryFn: () =>
			apiFetch<ExpenseSummary>(
				month === null
					? "/api/expenses/summary"
					: `/api/expenses/summary?month=${month}`,
			),
		placeholderData: keepPreviousData,
	});
}
```

- [ ] **Step 5: 樣式**——`frontend/src/screens/Expenses.module.css`，加在 `.links a { … }` 之後、`.list { … }` 之前：

```css
/* 月份切換：‹ 上個月｜2026年10月｜下個月 ›，手機與電腦版都是一列。
   按鈕的外觀、44px、停用時變淡都來自 ui.secondary；這裡只管排列。
   最寬 420px：電腦版的內容區有 1100px，兩顆按鈕不該被推到兩端。 */
.monthSwitch {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: var(--space-2);
	max-width: 420px;
	margin-bottom: var(--space-3);
}

.monthSwitch button {
	flex: none;
	white-space: nowrap;
}

.monthLabel {
	margin: 0;
	font-size: var(--font-size-total);
	font-weight: 700;
	font-variant-numeric: tabular-nums;
	text-align: center;
}

/* 換月份時留著的是上一個月的資料（keepPreviousData），新的還沒回來：調淡。
   螢幕閱讀器那邊由 aria-busy 說。同 Trend.module.css 的 .stale。 */
.stale {
	opacity: var(--opacity-stale);
}
```

- [ ] **Step 6: 畫面**——`frontend/src/screens/Expenses.tsx`。

import 改三行（其餘不動）：

```tsx
import { type FormEvent, useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router";
```

```tsx
import layout from "../components/layout.module.css";
import ui from "../components/ui.module.css";
import { formatMoney, isPositiveAmount } from "../lib/decimal";
import { formatYearMonth, isYearMonth, shiftMonth } from "../lib/months";
import { useConfirmFocus } from "../lib/use-confirm-focus";
```

`ExpenseRow`（檔案的前半）不動。從 `type MonthSummaryProps = {` 到檔尾整段換成：

```tsx
type MonthSummaryProps = {
	query: ReturnType<typeof useExpenseSummary>;
	/** 看的不是這個月時，那個月的名字（「2026年9月」）；這個月是 `null`。 */
	otherMonth: string | null;
};

/** 一個月的總額與分類佔比。用 early return 取代巢狀三元——跟 `ExpenseRow`
 *  同一個理由，分支一多，巢狀三元就比依序判斷難讀。
 *
 *  **本地 const 是讓窄化撐過 `.map()` callback 的關鍵**：TS 確實會窄化
 *  `query.data` 本身，但窄化不會跟著閉包進到 callback 裡——指到同一個
 *  本地變數就會。 */
function MonthSummary({ query, otherMonth }: MonthSummaryProps) {
	if (query.isPending) return <p>載入中…</p>;
	const summary = query.data;
	// 失敗不能卡在「載入中…」——那會讓使用者以為還在等，而不是知道要重試。
	if (query.isError || summary == null) {
		return (
			<p>
				{otherMonth === null
					? "無法載入本月報表"
					: `無法載入${otherMonth}的報表`}
			</p>
		);
	}
	return (
		<div>
			<p className={styles.monthTotal}>
				總計 <span>{formatMoney(summary.total)}</span>
			</p>
			{/* 沒有支出（總額是 0 或沒有任何分類）時不畫甜甜圈——一個空的圈
			    讀起來像「載入失敗」。總計那一行照樣顯示 0.00。 */}
			{isPositiveAmount(summary.total) && summary.by_category.length > 0 ? (
				<>
					<CategoryDonut rows={summary.by_category} total={summary.total} />
					{summary.by_category.map((row) => (
						<CategoryBar
							key={row.category}
							row={row}
							monthTotal={summary.total}
						/>
					))}
				</>
			) : (
				<p>
					{otherMonth === null ? "這個月還沒有支出" : `${otherMonth}沒有支出`}
				</p>
			)}
		</div>
	);
}

/** 換月份後、新的那個月還沒回來時，畫面上留著的是上一個月的資料
 *  （`keepPreviousData`）：調淡、`aria-busy`，同趨勢頁換期間的作法。 */
function staleProps(stale: boolean) {
	return stale ? { "aria-busy": true, className: styles.stale } : {};
}

/** 報表：一個月的總額、分類佔比與花費清單（可改金額、刪除）。
 *
 *  新增改由「＋」→ 記帳（`AddExpense.tsx`）；入口是 tab bar 的「報表」
 *  （`/reports`，舊網址 `/expenses` 會轉址過來）。
 *
 *  **看哪個月寫在網址上：`?month=YYYY-MM`，沒有就是這個月**（報表月份與匯出
 *  規格 §2）。重新整理、上一頁、下一頁因此都對。
 *
 *  **「這個月」是後端說的，不是裝置的日期。** `useExpenseSummary(null)` 不帶
 *  `?month=`，後端用使用者時區決定（`this_month_in_timezone`），回應的 `month`
 *  就是那個月——「下個月」到這裡為止、網址上的月份有沒有超過，都跟它比。
 *  還不知道（載入中、失敗）的時候不猜：沒帶月份就兩顆都不能按。
 *
 *  **網址上的月份不能用就當成沒帶，並用 `replace` 清掉**（上一頁不會回到一個
 *  只會再被清掉的網址）：格式不對的馬上清；比這個月還後面的，等後端回了這個月
 *  才知道，那時才清。剛好等於這個月的不清——清掉的話，離線快取裡那份「這個月」
 *  如果是上個月留下的，會把人從他要看的月份帶走。
 */
export function Expenses() {
	const queryClient = useQueryClient();
	const [searchParams, setSearchParams] = useSearchParams();

	const currentQuery = useExpenseSummary(null);
	const currentMonth = currentQuery.data?.month ?? null;

	const raw = searchParams.get("month");
	const requested = raw !== null && isYearMonth(raw) ? raw : null;
	// `YYYY-MM` 補零、等長：字串比大小就是月份的先後。
	const isFuture =
		requested !== null && currentMonth !== null && requested > currentMonth;
	/** 要看的月份；`null`＝這個月（讓後端決定）。 */
	const selected = isFuture ? null : requested;
	const needsCleanup = raw !== null && selected === null;

	useEffect(() => {
		if (!needsCleanup) return;
		setSearchParams(
			(current) => {
				const params = new URLSearchParams(current);
				params.delete("month");
				return params;
			},
			{ replace: true },
		);
	}, [needsCleanup, setSearchParams]);

	const expensesQuery = useExpenses(selected);
	const expenses = expensesQuery.data ?? [];
	const summaryQuery = useExpenseSummary(selected);

	/** 畫面上是哪個月；`null`＝沒帶月份，而且還不知道這個月是哪個月。 */
	const shownMonth = selected ?? currentMonth;
	const monthName = shownMonth === null ? null : formatYearMonth(shownMonth);
	const isCurrent = selected === null || selected === currentMonth;
	const otherMonth = isCurrent ? null : monthName;

	const previous = shownMonth === null ? null : shiftMonth(shownMonth, -1);
	const next =
		shownMonth === null || currentMonth === null || shownMonth >= currentMonth
			? null
			: shiftMonth(shownMonth, 1);

	/** 換月份：新的一筆歷史紀錄（預設就是 push）。到這個月就把參數拿掉——
	 *  沒有參數才會跟著後端的「這個月」走，跨月之後不會停在舊的月份。 */
	function goTo(month: string) {
		setSearchParams((current) => {
			const params = new URLSearchParams(current);
			if (month === currentMonth) params.delete("month");
			else params.set("month", month);
			return params;
		});
	}

	return (
		<section>
			<h1>報表</h1>

			{/* 介面改版：「趨勢」不再是 tab，入口在報表——兩者都是「回頭看」。 */}
			<nav className={styles.links} aria-label="報表相關">
				<Link to="/trend">營養趨勢</Link>
			</nav>

			{/* 箭頭是裝飾（aria-hidden）：按鈕的名稱就是「上個月」「下個月」。
			    月份是 role="status"：換月份時螢幕閱讀器會唸出新的月份。 */}
			{/* biome-ignore lint/a11y/useSemanticElements: role=group 與 fieldset 語意相同；fieldset 要另外重設 border、padding、min-inline-size（同 MoneyKeypad） */}
			<div className={styles.monthSwitch} role="group" aria-label="切換月份">
				<button
					type="button"
					className={ui.secondary}
					disabled={previous === null}
					onClick={() => {
						if (previous !== null) goTo(previous);
					}}
				>
					<span aria-hidden="true">‹ </span>上個月
				</button>
				<p className={styles.monthLabel} role="status">
					{monthName ?? "這個月"}
				</p>
				<button
					type="button"
					className={ui.secondary}
					disabled={next === null}
					onClick={() => {
						if (next !== null) goTo(next);
					}}
				>
					下個月<span aria-hidden="true"> ›</span>
				</button>
			</div>

			{/* 電腦版：左＝這個月花了多少、右＝這個月的明細（電腦版版面規格 §4）。
			    本來的順序就是先摘要後明細，手機版照樣往下排。 */}
			<div className={layout.columns}>
				<div>
					<h2>
						{otherMonth === null ? "這個月花了多少" : `${otherMonth}花了多少`}
					</h2>
					<Card testId="expense-summary">
						<div
							data-testid="month-summary"
							{...staleProps(summaryQuery.isPlaceholderData)}
						>
							<MonthSummary query={summaryQuery} otherMonth={otherMonth} />
						</div>
					</Card>
				</div>

				<div>
					<h2>{otherMonth ?? "這個月"}</h2>
					<Card>
						<div
							data-testid="month-list"
							{...staleProps(expensesQuery.isPlaceholderData)}
						>
							{expensesQuery.isPending ? (
								<p>載入中…</p>
							) : expensesQuery.isError ? (
								// 失敗不能落到「這個月還沒有記錄花費」——這是報表畫面，
								// 空清單的措辭會引誘使用者重打一筆，造成重複記帳
								// （跟 MealList.tsx 的 isError 分支同一個理由）。
								<p>無法載入花費清單</p>
							) : expenses.length === 0 ? (
								<p>
									{otherMonth === null
										? "這個月還沒有記錄花費"
										: `${otherMonth}沒有記錄花費`}
								</p>
							) : (
								<ul className={styles.list}>
									{expenses.map((expense) => (
										<ExpenseRow
											key={expense.id}
											expense={expense}
											onChanged={() =>
												// 前綴比對：每個月的清單與報表、總覽的今天支出一起失效
												// ——改的是過去的月份也一樣。
												void queryClient.invalidateQueries({
													queryKey: queryKeys.expensesAll,
												})
											}
										/>
									))}
								</ul>
							)}
						</div>
					</Card>
				</div>
			</div>
		</section>
	);
}
```

- [ ] **Step 7: 跑，確認綠**

Run: `npx vitest run tests/expenses-month.test.tsx tests/expenses.test.tsx tests/months.test.ts 2>&1 | grep -E "FAIL|Unhandled|Tests |Type Errors"`
Expected: `Tests  96 passed (96)`、`Type Errors  no errors`。

Run: `npx vitest run tests/offline.test.tsx 2>&1 | grep -E "FAIL|Unhandled|Tests |Type Errors"`
Expected: `Tests  22 passed (22)`。

Run: `npm run -s test 2>&1 | grep -E "FAIL|Unhandled|Test Files|Tests |Type Errors"`
Expected: `Test Files  134 passed (134)`、`Tests  1587 passed (1587)`、`Type Errors  no errors`（總覽、`app.test` 等既有測試不受 `keepPreviousData` 影響）。

- [ ] **Step 8: 突變**（每個改完跑 `npx vitest run tests/expenses-month.test.tsx tests/expenses.test.tsx tests/months.test.ts`；最後一個跑 `tests/offline.test.tsx`）

| 突變 | 實測紅的 |
|---|---|
| `api/expenses.ts`：兩個 `placeholderData: keepPreviousData,` 拿掉 | 「新的月份還在載入…」 |
| `Expenses.tsx` `goTo`：不管到哪個月都 `params.set("month", month)` | 「上個月：…下個月回到沒有參數的網址」 |
| 清網址的 `{ replace: true }` → `{ replace: false }` | 四條「格式不對」＋「未來的月份」（上一頁回不到 `/`） |
| `const selected = isFuture ? null : requested;` → `= requested;` | 「未來的月份」 |
| `next` 的條件拿掉 `\|\| shownMonth >= currentMonth` | 5 條（「下個月」該停用的地方都可以按了） |
| `previous`：`shiftMonth(shownMonth ?? "2026-12", -1)`（猜一個月份） | 「還不知道這個月是哪個月：兩顆都不能按」 |
| `const requested = raw;`（不驗格式） | 四條「格式不對」 |
| `staleProps` 一律回 `{}` | 「新的月份還在載入…」 |
| `otherMonth` 一律 `null`（標題永遠是「這個月」） | 5 條 |
| `isCurrent = selected === null`（不比 `currentMonth`） | 「?month 剛好是這個月」 |
| `ExpenseRow` 的 `onChanged` 改成只失效 `queryKeys.expenses(null)` | 「在過去的月份刪掉一筆」 |
| `useExpenses(null)`（清單不理月份） | 6 條 |
| `useExpenseSummary(null)`（摘要不理月份） | 5 條 |
| `api/persist.ts` 的 `NOT_PERSISTED` 加 `"expenses"` | `offline.test.tsx`：既有的「上一次離線失敗的查詢…」與新的「過去月份的報表也進離線快取」 |

每個改回之後重跑確認綠（`git diff --stat` 只剩這個 task 要改的檔案）。

- [ ] **Step 9: 型別與 lint**

Run: `npm run -s typecheck`（沒有輸出）、`npm run -s lint`（`No fixes applied`，沒有 error／warning）。

- [ ] **Step 10: Commit**

```
feat(frontend): 報表可以看其他月份——?month=、上個月／下個月、載入中留著上一個月

看哪個月寫在網址上（沒有就是這個月），重新整理、上一頁都對。「這個月」是後端說的
（不帶 month 的報表回應裡的 month），「下個月」到它為止；還不知道的時候不猜。
格式不對或未來的月份當成沒帶，用 replace 清掉。換月份時留著上一個月的資料但調淡、
aria-busy（keepPreviousData，同趨勢頁）。過去月份的標題與空白、失敗的文字說的是那個月。
後端不用改；過去的月份跟這個月走同一條離線快取的規則。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

```bash
git add frontend/src/api/expenses.ts frontend/src/screens/Expenses.tsx frontend/src/screens/Expenses.module.css frontend/tests/expenses-month.test.tsx frontend/tests/offline.test.tsx
git commit -F "$S/commit-msg.txt"
```

---

## Task 4：後端——CSV 的寫法（`app/csv_export.py`）

規格 B3、B4、§3.3。純函式，不碰資料庫、不知道欄位的意思。

**Files:**
- Create: `app/csv_export.py`、`tests/test_csv_export.py`

- [ ] **Step 1: 寫失敗的測試** `tests/test_csv_export.py`：

```python
"""`app/csv_export.py`：CSV 的寫法只有一份（規格 §3.3）。純函式，不碰資料庫。"""

import csv
import io
from decimal import Decimal

import pytest

from app.csv_export import FORMULA_TRIGGERS, UTF8_BOM, encode_header, encode_rows, guard_text


def _parse(raw: bytes) -> list[list[str]]:
    """照試算表的讀法讀回來。`newline=""`：儲存格裡的 CR／LF 要原樣留著。"""
    return list(csv.reader(io.StringIO(raw.decode("utf-8"), newline="")))


@pytest.mark.parametrize(
    "text",
    [
        '=HYPERLINK("http://evil.example","點我")',
        "+886912345678",
        "-5",
        "@SUM(A1:A9)",
        "\t=1+1",
        "\r=1+1",
        "\n=1+1",
    ],
)
def test_text_that_starts_like_a_formula_gets_a_leading_quote(text):
    assert guard_text(text) == "'" + text


@pytest.mark.parametrize(
    "text",
    ["便當", "", "100", "a=b", "3-1", "滷肉飯🍚", " =1+1", "'=1+1", "＝全形等號"],
)
def test_other_text_is_left_alone(text):
    # 只看第一個字元：中間的 = 不是公式；開頭是空白的 Excel 不會當公式。
    assert guard_text(text) == text


def test_every_trigger_character_is_covered_by_the_tests_above():
    # 清單多加一個字元而沒有補測試 → 這裡紅（第 44 種：先確定清單不是空的）。
    assert set(FORMULA_TRIGGERS) == {"=", "+", "-", "@", "\t", "\r", "\n"}


def test_commas_quotes_and_newlines_survive_a_round_trip():
    rows = [
        ("便當, 加蛋", '他說 "好吃"'),
        ("第一行\n第二行", "第一行\r\n第二行"),
        ("滷肉飯🍚", ""),
    ]

    raw = encode_rows(rows)

    assert _parse(raw) == [list(row) for row in rows]
    # 不只是「讀得回來」：真的照 RFC 4180 加了引號、雙引號變兩個、每列 CRLF 結尾。
    text = raw.decode("utf-8")
    assert '"便當, 加蛋","他說 ""好吃"""\r\n' in text
    assert text.endswith("滷肉飯🍚,\r\n")


def test_a_formula_inside_quotes_is_still_guarded():
    raw = encode_rows([('=HYPERLINK("http://evil.example","x")', "ok")])

    assert raw.decode("utf-8") == '"\'=HYPERLINK(""http://evil.example"",""x"")",ok\r\n'


def test_decimals_are_written_plainly_and_never_guarded():
    raw = encode_rows(
        [(Decimal("180.50"), Decimal("1E+2"), Decimal("0.00"), Decimal("-5.00"))]
    )

    # 1E+2 不能寫成科學記號；負數是數字不是公式——加了單引號，試算表就不能加總了。
    assert raw == b"180.50,100,0.00,-5.00\r\n"


def test_none_is_an_empty_cell():
    assert encode_rows([("a", None, "c")]) == b"a,,c\r\n"


def test_the_header_starts_with_a_utf8_bom():
    raw = encode_header(["日期", "熱量(kcal)"])

    assert UTF8_BOM == b"\xef\xbb\xbf"
    assert raw == b"\xef\xbb\xbf" + "日期,熱量(kcal)\r\n".encode()


def test_only_the_header_carries_the_bom():
    assert not encode_rows([("日期",)]).startswith(UTF8_BOM)
```

- [ ] **Step 2: 跑，確認紅**

Run: `./.venv/Scripts/python.exe -m pytest -q -W error tests/test_csv_export.py`
Expected: collection error——`ModuleNotFoundError: No module named 'app.csv_export'`。

- [ ] **Step 3: 實作** `app/csv_export.py`：

```python
"""CSV 的寫法只有這一份（報表月份與匯出規格 §3.3）。

三支匯出端點都經過 `encode_header` / `encode_rows`——引號、換行、公式字元的處理
不會有第二種寫法。這個模組不碰資料庫，也不知道欄位的意思。

**儲存格的型別決定它怎麼寫，不是「第幾欄」決定：**

- `str`：文字。開頭是公式字元（`FORMULA_TRIGGERS`）的前面加一個單引號——Excel、
  Numbers、Google 試算表打開 CSV 時會把 `=`、`+`、`-`、`@` 開頭的儲存格當公式算
  （CSV injection）。備註、食物名稱都是使用者自己打的字，匯出的檔案也可能轉給別人。
- `Decimal`：數字。用 `format(value, "f")` 寫成一般的小數（不會是 `1E+2`），
  **不加單引號**——它不可能是公式，加了反而讓試算表把數字當文字、不能加總。
  資料庫的 CHECK 保證金額、份量、劑量都 > 0；就算哪天出現負數，`-5.00` 也只是一個數字。
- `None`：空的儲存格。

所以呼叫端不能把使用者的文字轉成別的型別再丟進來，也不需要記得「哪幾欄要擋」。
"""

import csv
import io
from collections.abc import Iterable, Sequence
from decimal import Decimal

# Excel 靠開頭的 BOM 才知道這是 UTF-8；沒有的話中文會被當成系統的 ANSI 編碼（亂碼）。
UTF8_BOM = "﻿".encode()

# OWASP 的清單：= + - @、Tab、CR；LF 跟 CR 同一類（開頭的控制字元會被試算表吃掉，
# 後面的 `=` 就變成開頭），一起擋。
FORMULA_TRIGGERS = ("=", "+", "-", "@", "\t", "\r", "\n")

Cell = str | Decimal | None


def guard_text(value: str) -> str:
    """開頭是公式字元的文字，前面加一個單引號；其他原樣回傳。"""
    if value.startswith(FORMULA_TRIGGERS):
        return "'" + value
    return value


def _render(cell: Cell) -> str:
    if cell is None:
        return ""
    if isinstance(cell, Decimal):
        return format(cell, "f")
    return guard_text(cell)


def encode_rows(rows: Iterable[Sequence[Cell]]) -> bytes:
    """幾列資料 → UTF-8 的 CSV 位元組（RFC 4180：逗號分隔、CRLF 換行、必要時加雙引號）。

    引號交給標準函式庫的 `csv`：含逗號、雙引號、換行的儲存格會被包起來，
    裡面的雙引號變成兩個。
    """
    buffer = io.StringIO(newline="")
    writer = csv.writer(buffer, lineterminator="\r\n")
    for row in rows:
        writer.writerow([_render(cell) for cell in row])
    return buffer.getvalue().encode("utf-8")


def encode_header(columns: Sequence[str]) -> bytes:
    """檔案的第一塊：BOM ＋ 標題列。"""
    return UTF8_BOM + encode_rows([columns])
```

- [ ] **Step 4: 跑，確認綠**

Run: `./.venv/Scripts/python.exe -m pytest -q -W error tests/test_csv_export.py`
Expected: `23 passed`。

- [ ] **Step 5: 突變**（`app/csv_export.py`；每個改完重跑上面那一行，改回之後 `touch app/csv_export.py`）

| 突變 | 實測 |
|---|---|
| `guard_text` 直接 `return value` | `8 failed`：七種公式開頭＋「引號裡的公式照樣擋」 |
| `_render` 的 `Decimal` 分支：`return guard_text(format(cell, "f"))` | `1 failed`：`test_decimals_are_written_plainly_and_never_guarded`（`-5.00` 被加了單引號） |
| 同一行改成 `return str(cell)` | `1 failed`：同一條（`1E+2`） |
| `encode_header` 不加 `UTF8_BOM` | `1 failed`：`test_the_header_starts_with_a_utf8_bom` |
| `lineterminator="\r\n"` → `"\n"` | `5 failed`：round-trip、引號裡的公式、Decimal、None、標題 |

- [ ] **Step 6: lint、型別、commit**

Run: `./.venv/Scripts/python.exe -m ruff check app/csv_export.py tests/test_csv_export.py`、`./.venv/Scripts/python.exe -m mypy app`（`Success`）。

```
feat(backend): CSV 的唯一寫法——BOM、RFC 4180 的引號、公式字元

匯出要用的 app/csv_export.py：encode_header（BOM＋標題列）、encode_rows（csv.writer、CRLF）。
儲存格的型別決定怎麼寫：str 是文字，開頭是 = + - @ Tab CR LF 的前面加單引號（CSV injection）；
Decimal 是數字，寫成一般的小數、不加；None 是空的。呼叫端不用記哪幾欄要擋。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

```bash
git add app/csv_export.py tests/test_csv_export.py
git commit -F "$S/commit-msg.txt"
```

---

## Task 5：後端——三支匯出端點、分塊、限速

規格 B1–B2、B5–B12、B17、§3.2–§3.6。

**Files:**
- Create: `app/export.py`、`app/api/routes/export.py`、`tests/test_export.py`
- Modify: `app/ratelimit.py`、`app/main.py`、`tests/conftest.py`、`pyproject.toml`、`frontend/src/api/schema.d.ts`（重新產生）

- [ ] **Step 1: 寫失敗的測試** `tests/test_export.py`：

```python
"""`GET /api/export/{meals,expenses,supplements}.csv`（報表月份與匯出規格 §3）。

讀回來一律用 `csv.reader`（跟試算表同一種讀法），不是自己切逗號——備註裡有逗號、
引號、換行。`httpx.ASGITransport` 會把整個回應收完才交回來，所以「是不是一塊一塊吐」
在端點層看不到，那幾條直接測 `app/export.py` 的 generator。
"""

import csv
import io
from collections.abc import AsyncIterator, Iterator
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import event

from app.db import get_db
from app.export import (
    EXPENSE_CATEGORY_LABELS,
    MEAL_TYPE_LABELS,
    expense_csv,
    meal_csv,
    supplement_csv,
)
from app.main import app
from app.models.expense import ExpenseCategory
from app.models.food import BaseUnit, FoodRevision
from app.models.meal import MealType
from app.ratelimit import EXPORT_LIMIT
from app.security.tokens import create_access_token
from tests.factories import (
    create_expense,
    create_food,
    create_intake,
    create_meal,
    create_supplement,
    create_user,
)

MEALS = "/api/export/meals.csv"
EXPENSES = "/api/export/expenses.csv"
SUPPLEMENTS = "/api/export/supplements.csv"

# 標題列寫死在測試裡，不 import `app.export` 的常數——拿它自己比自己永遠是綠的（第 10 種）。
MEAL_HEADER = [
    "餐點編號", "日期", "時間", "餐別", "食物", "品牌", "份量", "單位",
    "熱量(kcal)", "蛋白質(g)", "脂肪(g)", "碳水(g)", "備註", "只有我看得到",
]  # fmt: skip
EXPENSE_HEADER = ["日期", "時間", "分類", "金額", "備註", "是否餐費"]
SUPPLEMENT_HEADER = [
    "日期", "時間", "補劑", "品牌", "份數", "熱量(kcal)", "蛋白質(g)", "脂肪(g)", "碳水(g)",
]  # fmt: skip

BOM = b"\xef\xbb\xbf"


def auth(user_id: int) -> dict[str, str]:
    return {"Authorization": f"Bearer {create_access_token(user_id)}"}


def _table(content: bytes) -> list[list[str]]:
    """整個檔案讀成列。先確認開頭真的有 BOM，再拿掉它。"""
    assert content.startswith(BOM)
    return list(csv.reader(io.StringIO(content[len(BOM) :].decode("utf-8"), newline="")))


async def _revision(db_session, food) -> FoodRevision:
    revision = await db_session.get(FoodRevision, food.current_revision_id)
    assert revision is not None
    return revision


# ── 回應的形狀 ────────────────────────────────────────────────────────────────


@pytest.fixture
def seen_timezones(monkeypatch) -> list[str]:
    """檔名的日期是「使用者的今天」：固定日期，並記下收到的時區（第 2、22 種）。"""
    seen: list[str] = []

    def fake_today(tz_name: str) -> date:
        seen.append(tz_name)
        return date(2019, 7, 4)

    monkeypatch.setattr("app.api.routes.export.today_in_timezone", fake_today)
    return seen


@pytest.mark.parametrize(
    ("path", "filename", "header"),
    [
        (MEALS, "meals-2019-07-04.csv", MEAL_HEADER),
        (EXPENSES, "expenses-2019-07-04.csv", EXPENSE_HEADER),
        (SUPPLEMENTS, "supplements-2019-07-04.csv", SUPPLEMENT_HEADER),
    ],
)
async def test_an_export_is_a_utf8_csv_attachment_named_after_the_users_today(
    client, db_session, seen_timezones, path, filename, header
):
    user = await create_user(db_session)
    user.timezone = "America/New_York"
    await db_session.commit()

    response = await client.get(path, headers=auth(user.id))

    assert response.status_code == 200
    assert response.headers["content-type"] == "text/csv; charset=utf-8"
    assert response.headers["content-disposition"] == f'attachment; filename="{filename}"'
    assert response.headers["cache-control"] == "no-store"
    assert seen_timezones == ["America/New_York"]
    # 沒有任何資料：只有 BOM 與標題列。
    assert response.content == BOM + (",".join(header) + "\r\n").encode()


@pytest.mark.parametrize("path", [MEALS, EXPENSES, SUPPLEMENTS])
async def test_exports_require_authentication(client, path):
    response = await client.get(path)

    assert response.status_code == 401
    assert response.json()["error"]["code"] == "NOT_AUTHENTICATED"


def test_openapi_says_the_exports_return_csv():
    for path in (MEALS, EXPENSES, SUPPLEMENTS):
        ok = app.openapi()["paths"][path]["get"]["responses"]["200"]
        assert list(ok["content"]) == ["text/csv"]


# ── 內容 ──────────────────────────────────────────────────────────────────────


async def test_expenses_come_oldest_first_with_tricky_notes_intact(client, db_session):
    user = await create_user(db_session)
    meal = await create_meal(db_session, user=user)
    notes = [
        "便當, 加蛋",
        '他說 "好吃"',
        "第一行\n第二行",
        '=HYPERLINK("http://evil.example","x")',
        "+886912345678",
        "-5",
        "@SUM(A1)",
        "滷肉飯🍚",
        None,
    ]
    first = datetime(2026, 3, 10, 4, 0, tzinfo=UTC)  # 台北 12:00
    # 最新的先建：id 的順序跟時間相反，只按 id 排的實作會紅。
    for index in reversed(range(len(notes))):
        await create_expense(
            db_session,
            user=user,
            # 180.5：資料庫存的是 180.50（numeric(10,2)），匯出的要是資料庫裡的樣子。
            amount=Decimal("180.5") if index == 0 else 100 + index,
            category=ExpenseCategory.FOOD if index == 0 else ExpenseCategory.TRANSPORT,
            spent_at=first + timedelta(minutes=index),
            note=notes[index],
            meal=meal if index == 0 else None,
        )

    response = await client.get(EXPENSES, headers=auth(user.id))

    header, *rows = _table(response.content)
    assert header == EXPENSE_HEADER
    assert rows[0] == ["2026-03-10", "12:00", "飲食", "180.50", "便當, 加蛋", "是"]
    assert rows[1] == ["2026-03-10", "12:01", "交通", "101.00", '他說 "好吃"', "否"]
    assert [row[1] for row in rows] == [f"12:0{minute}" for minute in range(9)]
    assert [row[4] for row in rows] == [
        "便當, 加蛋",
        '他說 "好吃"',
        "第一行\n第二行",
        '\'=HYPERLINK("http://evil.example","x")',
        "'+886912345678",
        "'-5",
        "'@SUM(A1)",
        "滷肉飯🍚",
        "",
    ]
    # 金額是數字欄：沒有任何一格被加上單引號。
    assert [row[3] for row in rows[1:]] == [f"{100 + index}.00" for index in range(1, 9)]


async def test_a_meal_is_one_row_per_item_and_an_empty_meal_still_gets_a_row(
    client, db_session
):
    user = await create_user(db_session)
    rice = await create_food(
        db_session, created_by=user, owner=user, name="白飯",
        kcal=130, protein_g=Decimal("2.7"), fat_g=Decimal("0.3"), carb_g=28,
    )  # fmt: skip
    tea = await create_food(
        db_session, created_by=user, owner=user, name="無糖綠茶", brand="=茶裏王",
        kcal=0, protein_g=0, fat_g=0, carb_g=0, base_unit=BaseUnit.ML,
    )  # fmt: skip
    lunch = await create_meal(
        db_session,
        user=user,
        eaten_at=datetime(2026, 3, 10, 4, 30, tzinfo=UTC),
        meal_type=MealType.LUNCH,
        items=[(await _revision(db_session, rice), 150), (await _revision(db_session, tea), 500)],
        note="自己煮",
    )
    lunch.is_private = True
    await db_session.commit()
    empty = await create_meal(
        db_session,
        user=user,
        eaten_at=datetime(2026, 3, 10, 11, 0, tzinfo=UTC),
        meal_type=MealType.DINNER,
    )

    response = await client.get(MEALS, headers=auth(user.id))

    header, *rows = _table(response.content)
    assert header == MEAL_HEADER
    assert rows == [
        [str(lunch.id), "2026-03-10", "12:30", "午餐", "白飯", "", "150.00", "g",
         "195.00", "4.05", "0.45", "42.00", "自己煮", "是"],
        [str(lunch.id), "2026-03-10", "12:30", "午餐", "無糖綠茶", "'=茶裏王", "500.00", "ml",
         "0.00", "0.00", "0.00", "0.00", "自己煮", "是"],
        [str(empty.id), "2026-03-10", "19:00", "晚餐", "", "", "", "", "", "", "", "", "", "否"],
    ]  # fmt: skip
    # 跟 app 裡看到的同一組數字（同一份 join、同一套四捨五入）。
    api = (await client.get(f"/api/meals/{lunch.id}", headers=auth(user.id))).json()
    assert [
        [item["quantity_g"], item["kcal"], item["protein_g"], item["fat_g"], item["carb_g"]]
        for item in api["items"]
    ] == [[row[6], *row[8:12]] for row in rows[:2]]


async def test_supplement_intakes_carry_the_snapshot_taken_at_the_time(client, db_session):
    user = await create_user(db_session)
    whey = await create_supplement(
        db_session, created_by=user, owner=user, name="乳清蛋白", brand="+MyProtein"
    )
    await create_intake(
        db_session,
        user=user,
        supplement=whey,
        dose=2,
        taken_at=datetime(2026, 3, 10, 0, 5, tzinfo=UTC),
        kcal=240,
        protein_g=48,
        fat_g=3,
        carb_g=Decimal("4.5"),
    )

    response = await client.get(SUPPLEMENTS, headers=auth(user.id))

    header, *rows = _table(response.content)
    assert header == SUPPLEMENT_HEADER
    assert rows == [
        ["2026-03-10", "08:05", "乳清蛋白", "'+MyProtein", "2.00",
         "240.00", "48.00", "3.00", "4.50"],
    ]  # fmt: skip


async def test_dates_and_times_follow_the_account_timezone(client, db_session):
    """同一個時刻，兩個時區的人各自看到自己的當地時間。

    UTC 3/2 03:30 ＝ 紐約 3/1 22:30（宵夜算在 3/1）＝ 台北 3/2 11:30。寫死 UTC、寫死台北、
    或用伺服器的時區，紐約那一列的日期都會是 3/2（第 2 種：兩個時區才有鑑別力）。
    """
    instant = datetime(2026, 3, 2, 3, 30, tzinfo=UTC)
    taipei = await create_user(db_session)
    new_york = await create_user(db_session)
    new_york.timezone = "America/New_York"
    await db_session.commit()
    for user in (taipei, new_york):
        await create_meal(db_session, user=user, eaten_at=instant)
        await create_expense(db_session, user=user, spent_at=instant)
        pill = await create_supplement(db_session, created_by=user, owner=user)
        await create_intake(db_session, user=user, supplement=pill, taken_at=instant)

    seen: dict[str, list[tuple[str, str]]] = {}
    for name, user in (("taipei", taipei), ("new_york", new_york)):
        seen[name] = []
        for path, date_column in ((MEALS, 1), (EXPENSES, 0), (SUPPLEMENTS, 0)):
            _, row = _table((await client.get(path, headers=auth(user.id))).content)
            seen[name].append((row[date_column], row[date_column + 1]))

    assert seen == {
        "taipei": [("2026-03-02", "11:30")] * 3,
        "new_york": [("2026-03-01", "22:30")] * 3,
    }


async def test_a_meal_just_after_local_midnight_lands_on_the_new_day(client, db_session):
    # 台北 3/2 00:30 ＝ UTC 3/1 16:30：用 UTC 算日期會寫成 3/1。
    user = await create_user(db_session)  # Asia/Taipei
    await create_meal(db_session, user=user, eaten_at=datetime(2026, 3, 1, 16, 30, tzinfo=UTC))

    _, row = _table((await client.get(MEALS, headers=auth(user.id))).content)

    assert (row[1], row[2]) == ("2026-03-02", "00:30")


def test_every_enum_member_has_a_chinese_label():
    assert set(MEAL_TYPE_LABELS) == set(MealType)
    assert set(EXPENSE_CATEGORY_LABELS) == set(ExpenseCategory)
    assert all(MEAL_TYPE_LABELS.values()) and all(EXPENSE_CATEGORY_LABELS.values())


# ── 只有自己的 ────────────────────────────────────────────────────────────────


async def test_each_export_only_contains_the_callers_own_rows(client, db_session):
    people = {}
    for name in ("alice", "bob"):
        user = await create_user(db_session)
        food = await create_food(db_session, created_by=user, owner=user, name=f"{name}的便當")
        await create_meal(
            db_session,
            user=user,
            items=[(await _revision(db_session, food), 100)],
            note=f"{name}的備註",
            photo_path=f"{user.id}/{name}-photo.jpg",
        )
        await create_expense(db_session, user=user, note=f"{name}的花費")
        pill = await create_supplement(
            db_session, created_by=user, owner=user, name=f"{name}的補劑"
        )
        await create_intake(db_session, user=user, supplement=pill)
        people[name] = user

    for path, marker in ((MEALS, "的便當"), (EXPENSES, "的花費"), (SUPPLEMENTS, "的補劑")):
        text = (await client.get(path, headers=auth(people["alice"].id))).content.decode()
        assert f"alice{marker}" in text
        assert "bob" not in text
        # 每一支都剛好一列資料：自己的那一列。
        assert len(_table(text.encode())) == 2
    meals = (await client.get(MEALS, headers=auth(people["alice"].id))).content.decode()
    assert "alice的備註" in meals
    assert "photo" not in meals  # 照片路徑不匯出


# ── 一塊一塊地讀、一塊一塊地吐 ─────────────────────────────────────────────────


@pytest.fixture
def selects(db_connection) -> Iterator[list[str]]:
    """這條連線上執行過的 SELECT（不含 SAVEPOINT 之類）。"""
    seen: list[str] = []

    def record(conn, cursor, statement, parameters, context, executemany):
        if statement.lstrip().upper().startswith("SELECT"):
            seen.append(statement)

    event.listen(db_connection.sync_connection, "before_cursor_execute", record)
    yield seen
    event.remove(db_connection.sync_connection, "before_cursor_execute", record)


async def test_expenses_are_read_and_emitted_one_bounded_chunk_at_a_time(
    db_session, monkeypatch, selects
):
    monkeypatch.setattr("app.export.EXPORT_CHUNK_ROWS", 2)
    user = await create_user(db_session)
    start = datetime(2026, 3, 10, 4, 0, tzinfo=UTC)
    for index in range(5):
        await create_expense(
            db_session, user=user, spent_at=start + timedelta(minutes=index), note=f"n{index}"
        )
    user_id = user.id
    selects.clear()

    stream = expense_csv(db_session, user_id=user_id, tz_name="Asia/Taipei")
    progress: list[tuple[int, int]] = []  # （這一塊有幾列, 到目前為止查了幾次）
    chunks: list[bytes] = []
    async for chunk in stream:
        chunks.append(chunk)
        progress.append((chunk.count(b"\r\n"), len(selects)))

    # 標題不用查；之後每一塊最多 2 列，而且是「查一次、吐一塊」——不是先全部讀進來再切。
    assert progress == [(1, 0), (2, 1), (2, 2), (1, 3)]
    assert all("LIMIT" in statement for statement in selects)
    assert [row[4] for row in _table(b"".join(chunks))[1:]] == ["n0", "n1", "n2", "n3", "n4"]


async def test_rows_sharing_one_instant_are_neither_skipped_nor_repeated(
    db_session, monkeypatch
):
    # 塊的邊界剛好切在同一個時刻的幾列中間：只用時間當游標會漏掉（或重複）同時刻的列。
    monkeypatch.setattr("app.export.EXPORT_CHUNK_ROWS", 2)
    monkeypatch.setattr("app.export.EXPORT_CHUNK_MEALS", 2)
    user = await create_user(db_session)
    instant = datetime(2026, 3, 10, 4, 0, tzinfo=UTC)
    pill = await create_supplement(db_session, created_by=user, owner=user)
    meal_ids = []
    for index in range(5):
        await create_expense(db_session, user=user, spent_at=instant, note=f"n{index}")
        await create_intake(
            db_session, user=user, supplement=pill, taken_at=instant, dose=index + 1
        )
        meal_ids.append((await create_meal(db_session, user=user, eaten_at=instant)).id)
    user_id = user.id

    async def rows(stream: AsyncIterator[bytes]) -> list[list[str]]:
        return _table(b"".join([chunk async for chunk in stream]))[1:]

    kwargs = {"user_id": user_id, "tz_name": "Asia/Taipei"}
    assert [row[4] for row in await rows(expense_csv(db_session, **kwargs))] == [
        "n0", "n1", "n2", "n3", "n4",
    ]  # fmt: skip
    assert [row[4] for row in await rows(supplement_csv(db_session, **kwargs))] == [
        "1.00", "2.00", "3.00", "4.00", "5.00",
    ]  # fmt: skip
    assert [row[0] for row in await rows(meal_csv(db_session, **kwargs))] == [
        str(meal_id) for meal_id in meal_ids
    ]


async def test_meals_are_read_a_few_meals_at_a_time(db_session, monkeypatch, selects):
    monkeypatch.setattr("app.export.EXPORT_CHUNK_MEALS", 2)
    user = await create_user(db_session)
    food = await create_food(db_session, created_by=user, owner=user)
    revision = await _revision(db_session, food)
    start = datetime(2026, 3, 10, 4, 0, tzinfo=UTC)
    for index in range(3):
        await create_meal(
            db_session,
            user=user,
            eaten_at=start + timedelta(hours=index),
            items=[(revision, 100), (revision, 50)],
        )
    user_id = user.id
    selects.clear()

    sizes = []
    async for chunk in meal_csv(db_session, user_id=user_id, tz_name="Asia/Taipei"):
        sizes.append((chunk.count(b"\r\n"), len(selects)))

    # 一塊 2 餐（各 2 個項目 → 4 列），每一塊兩次查詢：餐、它們的項目。
    assert sizes == [(1, 0), (4, 2), (2, 4)]


async def test_the_database_session_stays_open_until_the_last_chunk(db_session, monkeypatch):
    """`get_db` 的收尾要在串流**結束之後**。

    FastAPI 0.118 之前、或把依賴改成 `scope="function"`，session 會在第一塊送出之前就被關掉
    ——而共用 session 的 `client` 夾具根本不關 session，看不到這件事（第 14 種）。
    """
    user = await create_user(db_session)
    await create_expense(db_session, user=user)
    user_id = user.id
    events: list[str] = []

    async def get_db_spy():
        try:
            yield db_session
        finally:
            events.append("session-closed")

    async def spying(db, **kwargs):
        async for chunk in expense_csv(db, **kwargs):
            events.append("chunk")
            yield chunk

    monkeypatch.setattr("app.api.routes.export.expense_csv", spying)
    app.dependency_overrides[get_db] = get_db_spy
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as raw:
            response = await raw.get(EXPENSES, headers=auth(user_id))
    finally:
        app.dependency_overrides.clear()

    assert response.status_code == 200
    assert events == ["chunk", "chunk", "session-closed"]  # 標題、一塊資料，然後才收尾


# ── 限速 ──────────────────────────────────────────────────────────────────────


async def test_the_three_exports_share_one_budget_per_user(client, db_session):
    alice = await create_user(db_session)
    bob = await create_user(db_session)
    paths = [MEALS, EXPENSES, SUPPLEMENTS]

    allowed = [
        await client.get(paths[index % 3], headers=auth(alice.id))
        for index in range(EXPORT_LIMIT)
    ]
    # 第 7 次打的是 meals——alice 只打過它兩次。每個端點各算各的話，這一次會過。
    blocked = await client.get(MEALS, headers=auth(alice.id))
    someone_else = await client.get(MEALS, headers=auth(bob.id))

    assert EXPORT_LIMIT == 6
    assert [response.status_code for response in allowed] == [200] * 6
    assert blocked.status_code == 429
    assert blocked.json()["error"]["code"] == "TOO_MANY_EXPORTS"
    assert 1 <= int(blocked.headers["Retry-After"]) <= 60
    assert someone_else.status_code == 200  # 別人的額度不受影響
```

- [ ] **Step 2: 跑，確認紅**

Run: `./.venv/Scripts/python.exe -m pytest -q -W error tests/test_export.py`
Expected: collection error——`ModuleNotFoundError: No module named 'app.export'`。

- [ ] **Step 3: 限速器**——`app/ratelimit.py` 的最後面（`session_rate_limiter = …` 之後）加：

```python
EXPORT_LIMIT = 6
EXPORT_WINDOW_SECONDS = 60.0

# 匯出（報表月份與匯出規格 §3.6）：三個端點共用，鍵是使用者 id（`str(user.id)`）。
#
# 每一次匯出都是把這個人的整段歷史讀一遍、握著一條資料庫連線直到下載完——偷到
# access token 的人、或一個寫壞的重試迴圈，不該能一直叫它做。**6 次**：三顆按鈕
# 各按一次是 3 次，手滑再按一輪還在額度內；正常使用碰不到（e2e 一條測試按一次）。
# 鍵是使用者不是端點：分開算的話，額度實際上是三倍。
export_rate_limiter = KeyedRateLimiter(
    limit=EXPORT_LIMIT,
    window_seconds=EXPORT_WINDOW_SECONDS,
    code="TOO_MANY_EXPORTS",
    message="匯出太頻繁，請稍後再試",
)
```

`tests/conftest.py`：import 改成

```python
from app.ratelimit import export_rate_limiter, login_rate_limiter, session_rate_limiter
```

`_reset_login_rate_limiter` 的 docstring 最後加三行、函式最後加一行：

```python
    `export_rate_limiter`（/export/*.csv）也一起重置。它的鍵是使用者 id，而 identity 的
    sequence 不會跟著 rollback，目前每個測試的使用者 id 都不同、不重置也不會互相影響——
    重置是讓「全域單例每個測試都從乾淨的狀態開始」這條規矩沒有例外。
    """
    login_rate_limiter.reset()
    session_rate_limiter.reset()
    export_rate_limiter.reset()
```

- [ ] **Step 4: 內容**——`app/export.py`：

```python
"""匯出自己的資料（報表月份與匯出規格 §3）：三支 async generator，一塊一塊地讀、
一塊一塊地吐，交給 `StreamingResponse`。

**記憶體不隨資料量長。** 每一塊是一次 keyset 查詢（`(時間, id) > 上一塊的最後一列`、
`LIMIT`），寫成 CSV 位元組就交出去，下一塊才讀。不用 OFFSET：越後面越慢，而且匯出到
一半有人新增一筆，後面每一列都會位移。排序鍵帶 `id`：同一個時刻的兩列不會被跳過或重複。

**只讀自己的。** 每個查詢都從 `user_id == 呼叫者` 出發；餐點的項目用上一步查到的
`meal_id` 去拿。`photo_path` 從頭到尾沒有被 SELECT。

**時間是帳號時區（`users.timezone`）的當地時間**，跟報表、今日總覽算「哪一天」用的
同一個時區（`app/days.py`）；跟伺服器所在的時區無關。

**數字跟 app 裡看到的一樣。** 餐點的營養素用 `item_join_query()`（項目釘住的那一版）
與 `scale()`（同一套四捨五入）——跟 `GET /api/meals` 同一份實作，不是另外算一次。
"""

from collections import defaultdict
from collections.abc import AsyncIterator, Sequence
from datetime import datetime
from zoneinfo import ZoneInfo

from sqlalchemy import Row, select, tuple_
from sqlalchemy.ext.asyncio import AsyncSession

from app.csv_export import Cell, encode_header, encode_rows
from app.meal_reads import item_join_query
from app.models.expense import Expense, ExpenseCategory
from app.models.food import Food, FoodRevision
from app.models.meal import Meal, MealItem, MealType
from app.models.supplement import Supplement, SupplementIntake
from app.nutrition import scale

# 一塊讀幾列。花費與補劑一列約一兩百個位元組；餐點一塊是 200 餐（各帶自己的項目）。
# 測試用 monkeypatch 把它們調小——函式每次呼叫才讀這兩個值。
EXPORT_CHUNK_ROWS = 500
EXPORT_CHUNK_MEALS = 200

MEAL_COLUMNS = (
    "餐點編號",
    "日期",
    "時間",
    "餐別",
    "食物",
    "品牌",
    "份量",
    "單位",
    "熱量(kcal)",
    "蛋白質(g)",
    "脂肪(g)",
    "碳水(g)",
    "備註",
    "只有我看得到",
)
EXPENSE_COLUMNS = ("日期", "時間", "分類", "金額", "備註", "是否餐費")
SUPPLEMENT_COLUMNS = (
    "日期",
    "時間",
    "補劑",
    "品牌",
    "份數",
    "熱量(kcal)",
    "蛋白質(g)",
    "脂肪(g)",
    "碳水(g)",
)

# 中文標籤。前端也有一份（`frontend/src/api/meals.ts`、`api/expenses.ts`）；
# `dict[Enum, str]` 加上 `tests/test_export.py` 的「每個成員都有標籤」——
# 加了分類而忘了這裡，是測試紅，不是匯出到一半 KeyError。
MEAL_TYPE_LABELS: dict[MealType, str] = {
    MealType.BREAKFAST: "早餐",
    MealType.LUNCH: "午餐",
    MealType.DINNER: "晚餐",
    MealType.SNACK: "點心",
}
EXPENSE_CATEGORY_LABELS: dict[ExpenseCategory, str] = {
    ExpenseCategory.FOOD: "飲食",
    ExpenseCategory.TRANSPORT: "交通",
    ExpenseCategory.DAILY: "日用",
    ExpenseCategory.ENTERTAINMENT: "娛樂",
    ExpenseCategory.MEDICAL: "醫療",
    ExpenseCategory.HOUSING: "居住",
    ExpenseCategory.OTHER: "其他",
}

_YES, _NO = "是", "否"

# 沒有項目的一餐：食物、品牌、份量、單位、四個營養素都空著。
_NO_FOOD: tuple[Cell, ...] = (None,) * 8


def _local(instant: datetime, tz: ZoneInfo) -> tuple[str, str]:
    """一個時刻在帳號時區的日期（`YYYY-MM-DD`）與時間（`HH:MM`）。"""
    local = instant.astimezone(tz)
    return local.strftime("%Y-%m-%d"), local.strftime("%H:%M")


async def expense_csv(db: AsyncSession, *, user_id: int, tz_name: str) -> AsyncIterator[bytes]:
    """花費：一筆一列，由舊到新。"""
    tz = ZoneInfo(tz_name)
    yield encode_header(EXPENSE_COLUMNS)
    after: tuple[datetime, int] | None = None
    while True:
        # 選欄位而不是整個 ORM 物件：不經過 identity map，拿到的一定是資料庫裡的值
        # （`Numeric(10,2)` 的 "100.00"，不是記憶體裡使用者送來的 "100"——handover §6 第 49 種）。
        query = (
            select(
                Expense.id,
                Expense.spent_at,
                Expense.category,
                Expense.amount,
                Expense.note,
                Expense.meal_id,
            )
            .where(Expense.user_id == user_id)
            .order_by(Expense.spent_at, Expense.id)
            .limit(EXPORT_CHUNK_ROWS)
        )
        if after is not None:
            query = query.where(tuple_(Expense.spent_at, Expense.id) > after)
        rows = (await db.execute(query)).all()
        if not rows:
            return
        lines: list[Sequence[Cell]] = []
        for row in rows:
            day, clock = _local(row.spent_at, tz)
            lines.append(
                (
                    day,
                    clock,
                    EXPENSE_CATEGORY_LABELS[row.category],
                    row.amount,
                    row.note,
                    # 現在還掛在一餐上才算。那一餐被刪掉（SET NULL）之後就是「否」。
                    _YES if row.meal_id is not None else _NO,
                )
            )
        yield encode_rows(lines)
        after = (rows[-1].spent_at, rows[-1].id)


async def supplement_csv(
    db: AsyncSession, *, user_id: int, tz_name: str
) -> AsyncIterator[bytes]:
    """補劑的打卡：一次一列，由舊到新。

    份數與四個營養素是打卡當時寫死的快照（已經乘過份數）；名稱與品牌是補劑**現在**的
    （打卡紀錄只存 `supplement_id`）。
    """
    tz = ZoneInfo(tz_name)
    yield encode_header(SUPPLEMENT_COLUMNS)
    after: tuple[datetime, int] | None = None
    while True:
        query = (
            select(
                SupplementIntake.id,
                SupplementIntake.taken_at,
                Supplement.name,
                Supplement.brand,
                SupplementIntake.dose,
                SupplementIntake.kcal,
                SupplementIntake.protein_g,
                SupplementIntake.fat_g,
                SupplementIntake.carb_g,
            )
            .join(Supplement, SupplementIntake.supplement_id == Supplement.id)
            .where(SupplementIntake.user_id == user_id)
            .order_by(SupplementIntake.taken_at, SupplementIntake.id)
            .limit(EXPORT_CHUNK_ROWS)
        )
        if after is not None:
            query = query.where(
                tuple_(SupplementIntake.taken_at, SupplementIntake.id) > after
            )
        rows = (await db.execute(query)).all()
        if not rows:
            return
        lines: list[Sequence[Cell]] = []
        for row in rows:
            day, clock = _local(row.taken_at, tz)
            lines.append(
                (
                    day,
                    clock,
                    row.name,
                    row.brand,
                    row.dose,
                    row.kcal,
                    row.protein_g,
                    row.fat_g,
                    row.carb_g,
                )
            )
        yield encode_rows(lines)
        after = (rows[-1].taken_at, rows[-1].id)


async def meal_csv(db: AsyncSession, *, user_id: int, tz_name: str) -> AsyncIterator[bytes]:
    """餐點：一個項目一列，由舊到新；同一餐的幾列有同一個「餐點編號」。
    沒有項目的一餐也有一列（食物那幾欄空著）。"""
    tz = ZoneInfo(tz_name)
    yield encode_header(MEAL_COLUMNS)
    after: tuple[datetime, int] | None = None
    while True:
        query = (
            select(Meal.id, Meal.eaten_at, Meal.meal_type, Meal.note, Meal.is_private)
            .where(Meal.user_id == user_id)
            .order_by(Meal.eaten_at, Meal.id)
            .limit(EXPORT_CHUNK_MEALS)
        )
        if after is not None:
            query = query.where(tuple_(Meal.eaten_at, Meal.id) > after)
        meals = (await db.execute(query)).all()
        if not meals:
            return

        # 項目用 `GET /api/meals` 的同一份 join（項目釘住的那一版食物），一次把這一塊的
        # 餐的項目都帶回來——查詢次數跟餐數、項目數無關。
        item_rows = (
            await db.execute(
                item_join_query()
                .where(MealItem.meal_id.in_([meal.id for meal in meals]))
                .order_by(MealItem.id)
            )
        ).all()
        items_by_meal: dict[int, list[Row[tuple[MealItem, FoodRevision, Food]]]] = defaultdict(
            list
        )
        for item_row in item_rows:
            items_by_meal[item_row[0].meal_id].append(item_row)

        lines: list[Sequence[Cell]] = []
        for meal in meals:
            day, clock = _local(meal.eaten_at, tz)
            head: tuple[Cell, ...] = (
                str(meal.id),
                day,
                clock,
                MEAL_TYPE_LABELS[meal.meal_type],
            )
            tail: tuple[Cell, ...] = (meal.note, _YES if meal.is_private else _NO)
            items = items_by_meal.get(meal.id)
            if not items:
                lines.append((*head, *_NO_FOOD, *tail))
                continue
            for item, revision, food in items:
                macros = scale(revision, item.quantity_g)
                lines.append(
                    (
                        *head,
                        food.name,
                        food.brand,
                        # 換算後的量（g 或 ml），記錄當時就凍結了。不匯出「幾份」：
                        # 份量可以事後改名、改重量、刪掉，那不是歷史。
                        item.quantity_g,
                        revision.base_unit.value,
                        macros.kcal,
                        macros.protein_g,
                        macros.fat_g,
                        macros.carb_g,
                        *tail,
                    )
                )
        yield encode_rows(lines)
        after = (meals[-1].eaten_at, meals[-1].id)
```

- [ ] **Step 5: 端點**——`app/api/routes/export.py`：

```python
"""匯出自己的資料成 CSV（報表月份與匯出規格 §3）。

三個端點共用一個限速額度、同一種回應：`text/csv; charset=utf-8`、開頭有 BOM、
`Content-Disposition: attachment`，檔名帶使用者時區的今天。內容在 `app/export.py`，
CSV 的寫法在 `app/csv_export.py`。
"""

from collections.abc import AsyncIterator
from typing import Any

from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.days import today_in_timezone
from app.db import get_db
from app.export import expense_csv, meal_csv, supplement_csv
from app.models.user import User
from app.ratelimit import export_rate_limiter

router = APIRouter(prefix="/export", tags=["export"])

# OpenAPI 上寫明回的是 CSV（預設會寫成 application/json）。
_CSV_RESPONSES: dict[int | str, dict[str, Any]] = {
    200: {
        "description": "CSV（UTF-8，開頭有 BOM）",
        "content": {"text/csv": {"schema": {"type": "string"}}},
    }
}


def _csv_response(body: AsyncIterator[bytes], *, name: str, user: User) -> StreamingResponse:
    """`body` 這時候還沒開始跑：generator 要等 Starlette 送出標頭之後才被迭代。

    **`db` 一定要是預設（request）範圍的依賴**：FastAPI 0.118 起，`yield` 的依賴在回應
    **送完之後**才收尾，串流到一半 session 還開著。改成 `Depends(get_db, scope="function")`
    或退回 0.118 之前，session 會在第一塊送出之前就被關掉（`tests/test_export.py` 有一條守著）。
    """
    today = today_in_timezone(user.timezone)
    return StreamingResponse(
        body,
        media_type="text/csv; charset=utf-8",
        headers={
            "Content-Disposition": f'attachment; filename="{name}-{today.isoformat()}.csv"',
            # 個人資料：不要留在任何中間的快取裡。
            "Cache-Control": "no-store",
        },
    )


@router.get("/meals.csv", response_class=StreamingResponse, responses=_CSV_RESPONSES)
async def export_meals(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> StreamingResponse:
    """自己全部的餐點：一個項目一列，由舊到新。"""
    # 限速在碰資料庫之前；三個端點同一個鍵（這個使用者），共用每分鐘的額度。
    export_rate_limiter.hit(str(user.id))
    return _csv_response(
        meal_csv(db, user_id=user.id, tz_name=user.timezone), name="meals", user=user
    )


@router.get("/expenses.csv", response_class=StreamingResponse, responses=_CSV_RESPONSES)
async def export_expenses(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> StreamingResponse:
    """自己全部的花費：一筆一列，由舊到新。"""
    export_rate_limiter.hit(str(user.id))
    return _csv_response(
        expense_csv(db, user_id=user.id, tz_name=user.timezone), name="expenses", user=user
    )


@router.get("/supplements.csv", response_class=StreamingResponse, responses=_CSV_RESPONSES)
async def export_supplements(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> StreamingResponse:
    """自己全部的補劑打卡：一次一列，由舊到新。"""
    export_rate_limiter.hit(str(user.id))
    return _csv_response(
        supplement_csv(db, user_id=user.id, tz_name=user.timezone),
        name="supplements",
        user=user,
    )
```

`app/main.py`：`from app.api.routes import (…)` 的清單在 `expenses,` 後面加 `export,`；最後一行 `app.include_router(expenses.router, prefix="/api")` 後面加

```python
app.include_router(export.router, prefix="/api")
```

- [ ] **Step 6: FastAPI 的下限**——`pyproject.toml` 的 `dependencies`：

```toml
    # >=0.118：`yield` 的依賴在回應送完之後才收尾——匯出的 StreamingResponse 串流到一半
    # 還要用 get_db 的 session（tests/test_export.py 有一條守著）。lock 檔是 0.141.1。
    "fastapi>=0.118",
```

（取代原本的 `"fastapi>=0.115",`。`requirements-lock.txt` 不用動。）

- [ ] **Step 7: 跑，確認綠**

Run: `./.venv/Scripts/python.exe -m pytest -q -W error tests/test_export.py tests/test_csv_export.py`
Expected: `42 passed`。

Run（timeout 10 分鐘）: `./.venv/Scripts/python.exe -m pytest -q -W error`
Expected: `980 passed`（936 ＋ Task 1 的 2 ＋ Task 4 的 23 ＋ 這裡的 19）。

- [ ] **Step 8: 突變**（每個改完跑 `./.venv/Scripts/python.exe -m pytest -q -W error tests/test_export.py tests/test_csv_export.py`；改回之後 `touch` 那個檔案）

| 突變 | 實測紅的（`tests/test_export.py`） |
|---|---|
| `app/export.py`：拿掉 `.where(Expense.user_id == user_id)` | `test_each_export_only_contains_the_callers_own_rows`、`test_dates_and_times_follow_the_account_timezone` |
| 拿掉 `.where(Meal.user_id == user_id)` | 同上兩條 |
| 拿掉 `.where(SupplementIntake.user_id == user_id)` | 同上兩條 |
| 花費的查詢拿掉 `.limit(EXPORT_CHUNK_ROWS)` | `test_expenses_are_read_and_emitted_one_bounded_chunk_at_a_time` |
| 花費的游標改成 `Expense.spent_at > after[0]` | `test_rows_sharing_one_instant_are_neither_skipped_nor_repeated` |
| 餐點的游標改成 `Meal.eaten_at > after[0]` | 同上 |
| 補劑的游標改成 `SupplementIntake.taken_at > after[0]` | 同上 |
| 花費改成 `.order_by(Expense.id)` | `test_expenses_come_oldest_first_with_tricky_notes_intact` |
| `_local`：`local = instant`（不轉時區） | 5 條（三種內容、兩條時區） |
| `_local`：寫死 `ZoneInfo("Asia/Taipei")` | 只有 `test_dates_and_times_follow_the_account_timezone`——**沒有紐約那個帳號就抓不到**（第 2 種） |
| 沒有項目的一餐直接 `continue`（不寫那一列） | 4 條 |
| 「只有我看得到」一律 `_NO` | `test_a_meal_is_one_row_per_item_…` |
| 「是否餐費」一律 `_NO` | `test_expenses_come_oldest_first_…` |
| `app/api/routes/export.py`：`export_expenses` 的 `Depends(get_db)` → `Depends(get_db, scope="function")` | `test_the_database_session_stays_open_until_the_last_chunk` |
| `export_meals` 的 `hit(str(user.id))` → `hit(f"{user.id}:meals")` | `test_the_three_exports_share_one_budget_per_user` |
| 同一行 → `hit("everyone")` | 同上（bob 也被擋） |
| `today_in_timezone(user.timezone)` → `today_in_timezone("UTC")` | 三條 `test_an_export_is_a_utf8_csv_attachment_…` |
| 拿掉 `Content-Disposition` | 同上三條 |
| `app/csv_export.py`：`guard_text` 直接 `return value` | 這個檔案 3 條（花費、餐點的品牌、補劑的品牌）＋ Task 4 的 8 條 |
| `encode_header` 不加 BOM | 這個檔案 11 條＋ Task 4 的 1 條 |

**不要跑「游標改成 `>=`」**（開工前必讀第 12 點）。

- [ ] **Step 9: lint 與型別**

Run: `./.venv/Scripts/python.exe -m ruff check .`（`All checks passed!`）、`./.venv/Scripts/python.exe -m mypy app`（`Success: no issues found in 78 source files`）。

- [ ] **Step 10: 重新產生 `schema.d.ts`**（指令在「執行環境」）

Expected: `git diff --stat -- frontend/src/api/schema.d.ts` 是 `120 insertions(+)`、沒有刪除——三條路徑（`/api/export/meals.csv`、`expenses.csv`、`supplements.csv`）與三個 operation，回應是 `"text/csv": string`。
Run（在 `frontend/`）: `npm run -s typecheck`（沒有輸出）。

- [ ] **Step 11: Commit**

```
feat(backend): 匯出餐點、花費、補劑的 CSV——分塊串流、每人每分鐘 6 次

GET /api/export/{meals,expenses,supplements}.csv：只有呼叫者自己的全部歷史，由舊到新；
text/csv（UTF-8、開頭有 BOM）、attachment、檔名帶使用者時區的今天、no-store。
時間是帳號時區的當地時間；餐點的營養素用 GET /api/meals 的同一份 join 與四捨五入。
一塊一塊地讀（keyset：(時間, id) > 上一塊最後一列）、一塊一塊地吐，記憶體不隨資料量長；
照片路徑根本不 SELECT。三個端點共用每人每分鐘 6 次的額度（429 TOO_MANY_EXPORTS＋Retry-After）。
串流時 get_db 的 session 要還開著：fastapi 的下限改成 0.118，並有測試守著收尾的順序。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

```bash
git add app/export.py app/api/routes/export.py app/main.py app/ratelimit.py pyproject.toml tests/conftest.py tests/test_export.py frontend/src/api/schema.d.ts
git commit -F "$S/commit-msg.txt"
```

---

## Task 6：前端——`fetchDownload` 與 `saveBlob`

規格 B13、B14、§4.3。兩個沒有畫面的零件：把需要登入的回應拿成 Blob；把 Blob 存成檔案。

**Files:**
- Create: `frontend/src/lib/save-file.ts`、`frontend/tests/save-file.test.ts`
- Modify: `frontend/src/api/client.ts`、`frontend/tests/client.test.ts`

- [ ] **Step 1: 寫失敗的測試**

`frontend/tests/client.test.ts`：第二行的 import 改成 `import { apiFetch, fetchDownload } from "../src/api/client";`，檔案最後面加：

```ts
describe("fetchDownload", () => {
	function csv(disposition: string | null) {
		const headers = new Headers({ "content-type": "text/csv; charset=utf-8" });
		if (disposition !== null) headers.set("content-disposition", disposition);
		return new Response("﻿日期\r\n", { status: 200, headers });
	}

	it("帶上 Authorization，回內容與 Content-Disposition 裡的檔名", async () => {
		setTokens({ access_token: "a", refresh_token: "r" });
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(csv('attachment; filename="expenses-2026-10-09.csv"'));

		const download = await fetchDownload("/api/export/expenses.csv");

		expect(download.filename).toBe("expenses-2026-10-09.csv");
		// 位元組原封不動（開頭的 BOM 還在）。
		expect([
			...new Uint8Array(await download.blob.arrayBuffer()).slice(0, 3),
		]).toEqual([0xef, 0xbb, 0xbf]);
		const init = fetchMock.mock.calls[0]?.[1];
		expect(new Headers(init?.headers).get("authorization")).toBe("Bearer a");
	});

	it.each([[null], ["attachment"], ["inline"]])(
		"沒有檔名可讀（%s）：filename 是 null，由呼叫端決定叫什麼",
		async (disposition) => {
			setTokens({ access_token: "a", refresh_token: "r" });
			vi.spyOn(globalThis, "fetch").mockResolvedValue(csv(disposition));

			const download = await fetchDownload("/api/export/meals.csv");

			expect(download.filename).toBeNull();
		},
	);

	it("401 之後換票並重送一次（跟 apiFetch 同一個內核）", async () => {
		setTokens({ access_token: "old", refresh_token: "r1" });
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(unauthorized())
			.mockResolvedValueOnce(
				ok({ access_token: "new", refresh_token: "r2", token_type: "bearer" }),
			)
			.mockResolvedValueOnce(csv('attachment; filename="meals.csv"'));

		const download = await fetchDownload("/api/export/meals.csv");

		expect(download.filename).toBe("meals.csv");
		expect(fetchMock).toHaveBeenCalledTimes(3);
	});

	it("失敗拋 ApiError，429 帶著 Retry-After 的秒數", async () => {
		setTokens({ access_token: "a", refresh_token: "r" });
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(
				JSON.stringify({
					error: {
						code: "TOO_MANY_EXPORTS",
						message: "匯出太頻繁，請稍後再試",
						details: {},
					},
				}),
				{
					status: 429,
					headers: { "content-type": "application/json", "retry-after": "42" },
				},
			),
		);

		const failure = await fetchDownload("/api/export/meals.csv").catch(
			(caught: unknown) => caught,
		);

		expect(failure).toBeInstanceOf(ApiError);
		expect(failure).toMatchObject({
			status: 429,
			code: "TOO_MANY_EXPORTS",
			retryAfterSeconds: 42,
		});
	});
});
```

`frontend/tests/save-file.test.ts`（新檔）：

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REVOKE_DELAY_MS, saveBlob } from "../src/lib/save-file";

const CSV = new Blob(["﻿日期,金額\r\n2026-10-09,123.45\r\n"], {
	type: "text/csv;charset=utf-8",
});

type Clicked = { href: string; download: string; attached: boolean };

/** 攔下 `<a>` 的點擊（jsdom 的 click 會去「導覽」到 blob: 網址，那沒有實作），
 *  並記下點的當下連結長什麼樣子。 */
function spyOnAnchorClicks(): Clicked[] {
	const clicked: Clicked[] = [];
	vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
		this: HTMLAnchorElement,
	) {
		clicked.push({
			href: this.href,
			download: this.download,
			attached: this.isConnected,
		});
	});
	return clicked;
}

/** 假裝是 iOS「加入主畫面」的模式，並給它一組分享的 API。 */
function pretendIosStandalone(options: {
	canShare: boolean;
	share: () => Promise<void>;
}) {
	const share = vi.fn(options.share);
	const canShare = vi.fn(() => options.canShare);
	Object.defineProperty(navigator, "standalone", {
		value: true,
		configurable: true,
	});
	Object.defineProperty(navigator, "canShare", {
		value: canShare,
		configurable: true,
	});
	Object.defineProperty(navigator, "share", {
		value: share,
		configurable: true,
	});
	return { share, canShare };
}

beforeEach(() => {
	vi.restoreAllMocks();
	vi.useFakeTimers();
	vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:test-1");
	vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
});

afterEach(() => {
	vi.useRealTimers();
	// jsdom 的 navigator 本來沒有這三個屬性：拿掉，下一條測試從乾淨的狀態開始。
	for (const key of ["standalone", "canShare", "share"]) {
		Reflect.deleteProperty(navigator, key);
	}
});

describe("saveBlob：一般的瀏覽器", () => {
	it("用暫時的 object URL 與 <a download> 下載，連結不留在畫面上，過一陣子才釋放 URL", async () => {
		const clicked = spyOnAnchorClicks();

		const result = await saveBlob(CSV, "expenses-2026-10-09.csv", "text/csv");

		expect(result).toBe("downloaded");
		expect(URL.createObjectURL).toHaveBeenCalledWith(CSV);
		expect(clicked).toEqual([
			{
				href: "blob:test-1",
				download: "expenses-2026-10-09.csv",
				attached: true,
			},
		]);
		expect(document.querySelector("a[download]")).toBeNull();
		// 還沒釋放：馬上釋放會讓某些瀏覽器的下載還沒開始讀就失敗。
		expect(URL.revokeObjectURL).not.toHaveBeenCalled();
		vi.advanceTimersByTime(REVOKE_DELAY_MS - 1);
		expect(URL.revokeObjectURL).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
		expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:test-1");
	});

	it("有分享 API 但不是 iOS 主畫面模式（桌面 Chrome、Android）：照樣下載，不跳分享面板", async () => {
		const clicked = spyOnAnchorClicks();
		const { share, canShare } = pretendIosStandalone({
			canShare: true,
			share: async () => {},
		});
		Reflect.deleteProperty(navigator, "standalone");

		const result = await saveBlob(CSV, "meals.csv", "text/csv");

		expect(result).toBe("downloaded");
		expect(clicked).toHaveLength(1);
		expect(share).not.toHaveBeenCalled();
		expect(canShare).not.toHaveBeenCalled();
	});
});

describe("saveBlob：iOS 主畫面模式", () => {
	it("系統分享得了檔案：把同一份內容包成 File 交給分享面板，不建 object URL、不點連結", async () => {
		const clicked = spyOnAnchorClicks();
		const { share, canShare } = pretendIosStandalone({
			canShare: true,
			share: async () => {},
		});

		const result = await saveBlob(CSV, "meals-2026-10-09.csv", "text/csv");

		expect(result).toBe("shared");
		expect(share).toHaveBeenCalledTimes(1);
		const shared = (share.mock.calls[0] as unknown as [{ files: File[] }])[0]
			.files;
		expect(shared).toHaveLength(1);
		const file = shared[0];
		expect(file).toBeInstanceOf(File);
		expect(file?.name).toBe("meals-2026-10-09.csv");
		expect(file?.type).toBe("text/csv");
		expect(file?.size).toBe(CSV.size);
		// canShare 問的就是要分享的那一個檔案。
		expect(canShare).toHaveBeenCalledWith({ files: [file] });
		expect(clicked).toEqual([]);
		expect(URL.createObjectURL).not.toHaveBeenCalled();
	});

	it("使用者把分享面板關掉（AbortError）：不算錯誤，也不再跳下載", async () => {
		const clicked = spyOnAnchorClicks();
		pretendIosStandalone({
			canShare: true,
			share: () => Promise.reject(new DOMException("取消", "AbortError")),
		});

		await expect(saveBlob(CSV, "meals.csv", "text/csv")).resolves.toBe(
			"cancelled",
		);
		expect(clicked).toEqual([]);
	});

	it("分享被拒絕（手勢過期的 NotAllowedError）：退回連結下載", async () => {
		const clicked = spyOnAnchorClicks();
		pretendIosStandalone({
			canShare: true,
			share: () =>
				Promise.reject(new DOMException("手勢過期", "NotAllowedError")),
		});

		await expect(saveBlob(CSV, "meals.csv", "text/csv")).resolves.toBe(
			"downloaded",
		);
		expect(clicked).toHaveLength(1);
		expect(clicked[0]?.download).toBe("meals.csv");
	});

	it("系統說分享不了檔案：連結下載，不呼叫 share", async () => {
		const clicked = spyOnAnchorClicks();
		const { share } = pretendIosStandalone({
			canShare: false,
			share: async () => {},
		});

		await expect(saveBlob(CSV, "meals.csv", "text/csv")).resolves.toBe(
			"downloaded",
		);
		expect(clicked).toHaveLength(1);
		expect(share).not.toHaveBeenCalled();
	});

	it("舊的 iOS 沒有 canShare：連結下載", async () => {
		const clicked = spyOnAnchorClicks();
		Object.defineProperty(navigator, "standalone", {
			value: true,
			configurable: true,
		});

		await expect(saveBlob(CSV, "meals.csv", "text/csv")).resolves.toBe(
			"downloaded",
		);
		expect(clicked).toHaveLength(1);
	});
});
```

- [ ] **Step 2: 跑，確認紅**

Run: `npx vitest run tests/client.test.ts tests/save-file.test.ts 2>&1 | grep -E "FAIL|Unhandled|Tests |Type Errors|Error"`
Expected: FAIL——`client.test.ts` 的 `fetchDownload` 不存在（執行期 `fetchDownload is not a function`，型別那次也報沒有這個 export）；`save-file.test.ts` 找不到 `../src/lib/save-file`。

- [ ] **Step 3: `fetchDownload`**——`frontend/src/api/client.ts`，加在 `fetchPhotoBlob` 之後、最後一行 `export { ApiError };` 之前：

```ts
export type Download = {
	blob: Blob;
	/** `Content-Disposition` 裡的檔名；沒有這個標頭（或讀不出來）是 `null`。 */
	filename: string | null;
};

/** `attachment; filename="meals-2026-10-09.csv"` → `meals-2026-10-09.csv`。
 *  只認後端自己寫的這一種形式（雙引號、ASCII 檔名），不處理 `filename*=`。 */
function parseFilename(header: string | null): string | null {
	if (header === null) return null;
	return /filename="([^"]+)"/.exec(header)?.[1] ?? null;
}

/** 取一個需要認證、要存成檔案的端點（匯出的 CSV），回內容與後端建議的檔名。
 *
 *  **為什麼不是一個 `<a href="/api/export/…">`：** 理由跟照片一樣——那個請求
 *  帶不了 `Authorization`（token 只在記憶體裡，不是 cookie）。所以先用 `fetch`
 *  把整份內容拿成 `Blob`，再交給 `lib/save-file.ts` 存檔。順便得到一個好處：
 *  下載到一半斷線，`response.blob()` 會 reject，使用者看到的是錯誤，不是一個
 *  被截斷卻看起來正常的檔案。
 *
 *  同源，所以 `Content-Disposition` 讀得到（跨來源的話要後端另外開
 *  `Access-Control-Expose-Headers`）。失敗一律拋 `ApiError`，429 帶
 *  `retryAfterSeconds`。 */
export async function fetchDownload(path: string): Promise<Download> {
	const response = await fetchWithAuthRetry(path, {});

	if (!response.ok) {
		throw await parseErrorResponse(response);
	}

	return {
		blob: await response.blob(),
		filename: parseFilename(response.headers.get("content-disposition")),
	};
}
```

- [ ] **Step 4: `saveBlob`**——`frontend/src/lib/save-file.ts`：

```ts
/** 把一個已經在記憶體裡的 `Blob` 交給使用者存成檔案。
 *
 *  **一般情況：暫時的 object URL ＋ `<a download>`。** 建一個看不到的連結、點它、
 *  拿掉，過一陣子再 `revokeObjectURL`。
 *
 *  **iOS「加入主畫面」的 PWA 例外。** 那個模式沒有瀏覽器的外框，也沒有下載管理員；
 *  `<a download>` 指到 `blob:` 網址在不同的 iOS 版本上可能什麼都不發生，或是整個
 *  畫面被換成檔案預覽、沒有路可以回來。所以只在那個模式、而且系統說它分享得了
 *  檔案（`navigator.canShare({ files })`）時，改開系統的分享面板
 *  （「儲存到檔案」、AirDrop、傳給別的 app）。
 *
 *  **為什麼不是「只要有 `canShare` 就用分享」：** 桌面的 Chrome／Edge、Android 的
 *  Chrome 也有 `canShare`，而它們的下載是好的——在那裡跳分享面板是退步。
 *  `navigator.standalone` 只有 iOS Safari 有，從主畫面打開時才是 `true`。
 *
 *  **已知限制：**
 *  - 分享要「使用者手勢」還有效。檔案是按了按鈕之後才去抓的，抓太久手勢會過期，
 *    `share()` 以 `NotAllowedError` 拒絕——那時退回連結的作法（盡力而為）。
 *  - iOS 的這兩條路都沒有在實機上自動測（Playwright 的 WebKit 不是主畫面模式）；
 *    單元測試守的是「走哪一條路」，不是 iOS 真的把檔案存下來。
 *  - 分享面板被使用者關掉（`AbortError`）不算錯誤，也不會再跳下載。
 */

/** 點完連結之後多久才釋放 object URL。馬上釋放在某些瀏覽器（Safari）會讓下載
 *  還沒開始讀就失敗；40 秒是 FileSaver.js 沿用多年的數字。 */
export const REVOKE_DELAY_MS = 40_000;

/** `downloaded`：點了下載連結。`shared`：交給了系統的分享面板。
 *  `cancelled`：使用者把分享面板關掉了。 */
export type SaveResult = "downloaded" | "shared" | "cancelled";

function isIosStandalone(): boolean {
	return (
		(navigator as Navigator & { standalone?: boolean }).standalone === true
	);
}

function errorName(caught: unknown): string | null {
	if (typeof caught !== "object" || caught === null) return null;
	const name = (caught as { name?: unknown }).name;
	return typeof name === "string" ? name : null;
}

export async function saveBlob(
	blob: Blob,
	filename: string,
	mimeType: string,
): Promise<SaveResult> {
	if (isIosStandalone() && typeof navigator.canShare === "function") {
		const file = new File([blob], filename, { type: mimeType });
		if (navigator.canShare({ files: [file] })) {
			try {
				await navigator.share({ files: [file] });
				return "shared";
			} catch (caught) {
				if (errorName(caught) === "AbortError") return "cancelled";
				// 其他的拒絕（多半是手勢過期的 NotAllowedError）：往下走連結那條路。
			}
		}
	}

	const url = URL.createObjectURL(blob);
	const anchor = document.createElement("a");
	anchor.href = url;
	anchor.download = filename;
	// 掛進文件再點：舊版 Firefox 不理會沒有掛在文件上的連結。
	anchor.style.display = "none";
	document.body.append(anchor);
	anchor.click();
	anchor.remove();
	window.setTimeout(() => URL.revokeObjectURL(url), REVOKE_DELAY_MS);
	return "downloaded";
}
```

- [ ] **Step 5: 跑，確認綠**

Run: `npx vitest run tests/client.test.ts tests/save-file.test.ts 2>&1 | grep -E "FAIL|Unhandled|Tests |Type Errors"`
Expected: `Tests  38 passed (38)`（`client` 24、`save-file` 14）、`Type Errors  no errors`。

- [ ] **Step 6: 突變**（跑同一行）

| 突變 | 實測紅的 |
|---|---|
| `save-file.ts`：拿掉 `anchor.download = filename;` | 「用暫時的 object URL 與 <a download> 下載…」、「分享被拒絕…退回連結下載」 |
| `setTimeout(…, REVOKE_DELAY_MS)` → 馬上 `URL.revokeObjectURL(url)` | 「用暫時的 object URL…」（還沒到時間就釋放了） |
| 整行拿掉（永遠不釋放） | 同上 |
| 拿掉 `anchor.remove();` | 同上（連結留在畫面上） |
| 拿掉 `document.body.append(anchor);` | 同上（點的時候沒有掛在文件上） |
| `isIosStandalone() &&` 拿掉（有 `canShare` 就分享） | 「有分享 API 但不是 iOS 主畫面模式…照樣下載」 |
| 拿掉 `AbortError` 那一行 | 「使用者把分享面板關掉…」 |
| catch 裡改成 `throw caught;` | 「分享被拒絕…退回連結下載」 |
| `if (navigator.canShare({ files: [file] }) \|\| true)` | 「系統說分享不了檔案…」 |
| `new File([blob], filename)`（沒有 type） | 「系統分享得了檔案…」 |
| `client.ts`：`filename: null,` | `fetchDownload` 的「帶上 Authorization，回內容與…檔名」「401 之後換票並重送一次」 |
| `client.ts`：`blob: new Blob([await response.text()]),` | `fetchDownload` 的「帶上 Authorization…」——**經過字串轉手 BOM 就不見了** |

- [ ] **Step 7: 型別、lint、整套**

Run: `npm run -s typecheck`、`npm run -s lint`（乾淨）；`npm run -s test 2>&1 | grep -E "FAIL|Unhandled|Test Files|Tests |Type Errors"`
Expected: `Test Files  136 passed (136)`、`Tests  1611 passed (1611)`。

- [ ] **Step 8: Commit**

```
feat(frontend): 下載需要登入的檔案——fetchDownload 與 saveBlob

fetchDownload：跟 apiFetch、照片共用帶票與換票的內核，把回應拿成 Blob（位元組原封不動，
BOM 還在），檔名讀 Content-Disposition。saveBlob：暫時的 object URL＋<a download>，
40 秒後才 revoke；iOS「加入主畫面」的模式（沒有下載管理員）改用系統的分享面板，
使用者關掉不算錯誤，被拒絕就退回連結。桌面與 Android 也有 canShare，但那裡下載是好的，不分享。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

```bash
git add frontend/src/api/client.ts frontend/src/lib/save-file.ts frontend/tests/client.test.ts frontend/tests/save-file.test.ts
git commit -F "$S/commit-msg.txt"
```

---

## Task 7：前端——「我的」的匯出資料卡片

規格 B15、B16、§4.2。

**Files:**
- Create: `frontend/src/api/export.ts`、`frontend/src/components/ExportCard.tsx`、`frontend/src/components/ExportCard.module.css`、`frontend/tests/export-card.test.tsx`
- Modify: `frontend/src/screens/Me.tsx`、`frontend/tests/me.test.tsx`

- [ ] **Step 1: 先 grep e2e**（handover §6「好友關係」那一節的規矩：新增標題或按鈕之前，先看有沒有名稱是它子字串的選擇器）

Run（repo 根目錄）: `grep -rn "匯出\|name: \"餐點\"\|name: \"花費\"\|name: \"補劑\"" frontend/e2e`
Expected: 只有三行 `getByRole("heading", { name: "補劑", exact: true })`（補劑頁的標題，`exact`，不在「我的」）。有別的就先回報。

- [ ] **Step 2: 寫失敗的測試**

`frontend/tests/export-card.test.tsx`（新檔）：

```tsx
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetRefreshStateForTests } from "../src/auth/refresh";
import { clearTokens, setTokens } from "../src/auth/store";
import { ExportCard } from "../src/components/ExportCard";
import { saveBlob } from "../src/lib/save-file";
import { json, mockApi } from "./helpers/mock-api";

// 存檔那一步（object URL、<a download>、iOS 的分享）在 save-file.test.ts；這裡只看
// 卡片交了什麼給它。
vi.mock("../src/lib/save-file", () => ({
	saveBlob: vi.fn(async () => "downloaded"),
}));
const saveBlobMock = vi.mocked(saveBlob);

const BODY = "﻿日期,時間,分類,金額,備註,是否餐費\r\n";

function csv(filename: string | null, body = BODY) {
	const headers = new Headers({ "content-type": "text/csv; charset=utf-8" });
	if (filename !== null) {
		headers.set("content-disposition", `attachment; filename="${filename}"`);
	}
	return new Response(body, { status: 200, headers });
}

function card() {
	return within(screen.getByTestId("export-card"));
}

/** 三顆按鈕現在的文字與能不能按。 */
function buttons(): Array<[string, boolean]> {
	return card()
		.getAllByRole("button")
		.map((button) => [
			button.textContent ?? "",
			!(button as HTMLButtonElement).disabled,
		]);
}

beforeEach(() => {
	localStorage.clear();
	clearTokens();
	resetRefreshStateForTests();
	vi.restoreAllMocks();
	saveBlobMock.mockReset();
	saveBlobMock.mockResolvedValue("downloaded");
	setTokens({ access_token: "a", refresh_token: "r" });
});

describe("匯出資料", () => {
	it("三顆按鈕在名叫「匯出資料」的一組裡", () => {
		render(<ExportCard />);

		const group = screen.getByRole("group", { name: "匯出資料" });
		expect(
			within(group)
				.getAllByRole("button")
				.map((button) => button.textContent),
		).toEqual(["餐點", "花費", "補劑"]);
	});

	it.each([
		["餐點", "/api/export/meals.csv", "meals-2026-10-09.csv"],
		["花費", "/api/export/expenses.csv", "expenses-2026-10-09.csv"],
		["補劑", "/api/export/supplements.csv", "supplements-2026-10-09.csv"],
	])(
		"按「%s」：帶著登入的票打 %s，把內容與後端給的檔名交去存檔",
		async (label, path, filename) => {
			// mockApi 沒收到 Authorization 一律回 401——走得到 handler 就代表票有帶。
			const fetchMock = mockApi([
				{ method: "GET", path, handler: () => csv(filename) },
			]);
			render(<ExportCard />);

			await userEvent.click(card().getByRole("button", { name: label }));

			expect(await card().findByRole("status")).toHaveTextContent(
				`已下載 ${filename}`,
			);
			expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
				path,
			]);
			expect(saveBlobMock).toHaveBeenCalledTimes(1);
			const [blob, savedAs, mimeType] = saveBlobMock.mock.calls[0] ?? [];
			expect(savedAs).toBe(filename);
			expect(mimeType).toBe("text/csv");
			// BOM 要原封不動：經過 .text() 之類的字串轉手會把它吃掉，Excel 就亂碼了。
			expect(
				new Uint8Array(await (blob as Blob).arrayBuffer()).slice(0, 3),
			).toEqual(new Uint8Array([0xef, 0xbb, 0xbf]));
			expect(await (blob as Blob).text()).toBe(BODY.slice(1));
		},
	);

	it("下載中：按的那顆寫「下載中…」，三顆都不能按；回來之後恢復", async () => {
		let respond: (response: Response) => void = () => {};
		mockApi([
			{
				method: "GET",
				path: "/api/export/expenses.csv",
				handler: () =>
					new Promise<Response>((resolve) => {
						respond = resolve;
					}),
			},
		]);
		render(<ExportCard />);

		await userEvent.click(card().getByRole("button", { name: "花費" }));

		expect(buttons()).toEqual([
			["餐點", false],
			["下載中…", false],
			["補劑", false],
		]);
		expect(saveBlobMock).not.toHaveBeenCalled();

		respond(csv("expenses-2026-10-09.csv"));

		await waitFor(() =>
			expect(buttons()).toEqual([
				["餐點", true],
				["花費", true],
				["補劑", true],
			]),
		);
		expect(saveBlobMock).toHaveBeenCalledTimes(1);
	});

	it("429：顯示後端的訊息與還要等幾秒，沒有存任何檔案；再按一次成功就把錯誤清掉", async () => {
		let attempt = 0;
		mockApi([
			{
				method: "GET",
				path: "/api/export/meals.csv",
				handler: () => {
					attempt += 1;
					if (attempt > 1) return csv("meals-2026-10-09.csv");
					return new Response(
						JSON.stringify({
							error: {
								code: "TOO_MANY_EXPORTS",
								message: "匯出太頻繁，請稍後再試",
								details: {},
							},
						}),
						{
							status: 429,
							headers: {
								"content-type": "application/json",
								"retry-after": "42",
							},
						},
					);
				},
			},
		]);
		render(<ExportCard />);

		await userEvent.click(card().getByRole("button", { name: "餐點" }));

		expect(await card().findByRole("alert")).toHaveTextContent(
			"匯出太頻繁，請稍後再試（42 秒後可再試）",
		);
		// 先等到錯誤出現，「沒有存檔」才不是因為還沒跑到（第 41 種）。
		expect(saveBlobMock).not.toHaveBeenCalled();
		expect(card().queryByRole("status")).not.toBeInTheDocument();

		await userEvent.click(card().getByRole("button", { name: "餐點" }));

		expect(await card().findByRole("status")).toHaveTextContent(
			"已下載 meals-2026-10-09.csv",
		);
		expect(card().queryByRole("alert")).not.toBeInTheDocument();
	});

	it("其他失敗（500、連不上）：「下載失敗，請再試一次」，按鈕恢復可以按", async () => {
		mockApi([
			{
				method: "GET",
				path: "/api/export/supplements.csv",
				handler: () =>
					json({ error: { code: "X", message: "x", details: {} } }, 500),
			},
			{
				method: "GET",
				path: "/api/export/meals.csv",
				handler: () => Promise.reject(new TypeError("network request failed")),
			},
		]);
		render(<ExportCard />);

		for (const label of ["補劑", "餐點"]) {
			await userEvent.click(card().getByRole("button", { name: label }));
			expect(await card().findByRole("alert")).toHaveTextContent(
				"下載失敗，請再試一次",
			);
			expect(card().getByRole("button", { name: label })).toBeEnabled();
		}
		expect(saveBlobMock).not.toHaveBeenCalled();
	});

	it("存檔那一步失敗也算下載失敗", async () => {
		saveBlobMock.mockRejectedValue(new Error("boom"));
		mockApi([
			{
				method: "GET",
				path: "/api/export/meals.csv",
				handler: () => csv("meals-2026-10-09.csv"),
			},
		]);
		render(<ExportCard />);

		await userEvent.click(card().getByRole("button", { name: "餐點" }));

		expect(await card().findByRole("alert")).toHaveTextContent(
			"下載失敗，請再試一次",
		);
	});

	it("後端沒給檔名：退回不帶日期的檔名（前端不自己算今天）", async () => {
		mockApi([
			{
				method: "GET",
				path: "/api/export/expenses.csv",
				handler: () => csv(null),
			},
		]);
		render(<ExportCard />);

		await userEvent.click(card().getByRole("button", { name: "花費" }));

		expect(await card().findByRole("status")).toHaveTextContent(
			"已下載 expenses.csv",
		);
		expect(saveBlobMock.mock.calls[0]?.[1]).toBe("expenses.csv");
	});

	it("交給分享面板、或使用者關掉分享面板：不說「已下載」", async () => {
		mockApi([
			{
				method: "GET",
				path: "/api/export/meals.csv",
				handler: () => csv("meals-2026-10-09.csv"),
			},
		]);
		render(<ExportCard />);

		for (const result of ["shared", "cancelled"] as const) {
			saveBlobMock.mockResolvedValue(result);
			const before = saveBlobMock.mock.calls.length;
			await userEvent.click(card().getByRole("button", { name: "餐點" }));
			await waitFor(() =>
				expect(saveBlobMock.mock.calls.length).toBe(before + 1),
			);
			await waitFor(() =>
				expect(card().getByRole("button", { name: "餐點" })).toBeEnabled(),
			);
			expect(card().queryByRole("status")).not.toBeInTheDocument();
			expect(card().queryByRole("alert")).not.toBeInTheDocument();
		}
	});
});
```

`frontend/tests/me.test.tsx` 的最後面加（檔頭的 import 已經有 `within`）：

```tsx
describe("我的：匯出資料", () => {
	it("每個人都有「匯出資料」卡片，在登出之前；畫出來的時候不打任何匯出端點", async () => {
		// 卡片自己的行為在 export-card.test.tsx；這裡只守「我的」有沒有把它放進來。
		const fetchMock = mockApi([
			statsRoute(),
			{ method: "GET", path: "/api/me", handler: () => json(me("user")) },
		]);

		render(wrap(<Me />));

		await screen.findByText("kenny@example.com");
		const card = screen.getByTestId("export-card");
		expect(
			within(card).getByRole("heading", { name: "匯出資料" }),
		).toBeInTheDocument();
		expect(
			within(card)
				.getAllByRole("button")
				.map((button) => button.textContent),
		).toEqual(["餐點", "花費", "補劑"]);
		const logout = screen.getByRole("button", { name: "登出" });
		expect(
			card.compareDocumentPosition(logout) & Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
		expect(
			fetchMock.mock.calls
				.map(([input]) => String(input))
				.filter((url) => url.includes("/api/export")),
		).toEqual([]);
	});
});
```

- [ ] **Step 3: 跑，確認紅**

Run: `npx vitest run tests/export-card.test.tsx tests/me.test.tsx 2>&1 | grep -E "FAIL|Unhandled|Tests |Type Errors|Error"`
Expected: FAIL——`export-card.test.tsx` 找不到 `../src/components/ExportCard`；`me.test.tsx` 新的那條找不到 `export-card`（既有的 16 條執行期測試仍然綠）。

- [ ] **Step 4: API 層**——`frontend/src/api/export.ts`：

```ts
import { fetchDownload } from "./client";

/** 可以匯出的三種資料（報表月份與匯出規格 §3）。`kind` 就是端點的檔名：
 *  `GET /api/export/{kind}.csv`。 */
export const EXPORT_KINDS = [
	{ kind: "meals", label: "餐點" },
	{ kind: "expenses", label: "花費" },
	{ kind: "supplements", label: "補劑" },
] as const;

export type ExportKind = (typeof EXPORT_KINDS)[number]["kind"];

/** 下載一種資料的全部歷史。檔名用後端給的（帶後端算的「今天」——前端不自己算
 *  日期）；後端沒給就退回不帶日期的 `{kind}.csv`。 */
export async function downloadExport(
	kind: ExportKind,
): Promise<{ blob: Blob; filename: string }> {
	const { blob, filename } = await fetchDownload(`/api/export/${kind}.csv`);
	return { blob, filename: filename ?? `${kind}.csv` };
}
```

- [ ] **Step 5: 卡片**——`frontend/src/components/ExportCard.tsx`：

```tsx
import { useId, useState } from "react";
import { ApiError } from "../api/errors";
import { downloadExport, EXPORT_KINDS, type ExportKind } from "../api/export";
import { saveBlob } from "../lib/save-file";
import { Card } from "./Card";
import styles from "./ExportCard.module.css";
import ui from "./ui.module.css";

function describeError(caught: unknown): string {
	// 429：後端的訊息（「匯出太頻繁，請稍後再試」）加上還要等多久，同改密碼的寫法。
	if (caught instanceof ApiError && caught.status === 429) {
		return caught.retryAfterSeconds !== null
			? `${caught.message}（${caught.retryAfterSeconds} 秒後可再試）`
			: caught.message;
	}
	return "下載失敗，請再試一次";
}

/** 「我的」的「匯出資料」（報表月份與匯出規格 §4.2）：三顆按鈕，各下載一種資料的
 *  全部歷史（CSV）。
 *
 *  **不用 `useMutation`**：mutation 在瀏覽器回報離線時會「暫停」，等恢復連線才送
 *  ——下載不該在使用者早就離開這一頁之後自己冒出來。離線時 `fetch` 直接失敗，
 *  顯示錯誤就好。
 *
 *  下載中三顆一起停用：一次一個請求（每個請求後端都握著一條資料庫連線直到傳完），
 *  也不會連按把每分鐘的額度用掉。 */
export function ExportCard() {
	const titleId = useId();
	const [pending, setPending] = useState<ExportKind | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [done, setDone] = useState<string | null>(null);

	async function handleDownload(kind: ExportKind) {
		setPending(kind);
		setError(null);
		setDone(null);
		try {
			const { blob, filename } = await downloadExport(kind);
			const result = await saveBlob(blob, filename, "text/csv");
			// 分享面板自己就是回饋；點了下載連結的才需要說一聲（瀏覽器不一定有動靜）。
			if (result === "downloaded") setDone(`已下載 ${filename}`);
		} catch (caught) {
			setError(describeError(caught));
		} finally {
			setPending(null);
		}
	}

	return (
		<Card testId="export-card">
			<h2 id={titleId} className={`${ui.sectionTitle} ${styles.title}`}>
				匯出資料
			</h2>
			<p className={styles.hint}>
				下載你自己的全部紀錄（CSV 檔，Excel、Numbers 都能打開）。
			</p>
			{/* biome-ignore lint/a11y/useSemanticElements: role=group 與 fieldset 語意相同；fieldset 要另外重設 border、padding、min-inline-size（同 MoneyKeypad） */}
			<div className={styles.actions} role="group" aria-labelledby={titleId}>
				{EXPORT_KINDS.map(({ kind, label }) => (
					<button
						key={kind}
						type="button"
						className={ui.secondary}
						disabled={pending !== null}
						onClick={() => void handleDownload(kind)}
					>
						{pending === kind ? "下載中…" : label}
					</button>
				))}
			</div>
			{error !== null && (
				<p role="alert" className={styles.error}>
					{error}
				</p>
			)}
			{done !== null && (
				<p role="status" className={styles.hint}>
					{done}
				</p>
			)}
		</Card>
	);
}
```

`frontend/src/components/ExportCard.module.css`：

```css
.title {
	margin: 0 0 var(--space-2);
}

.hint {
	margin: 0;
	font-size: 13px;
	color: var(--color-text-muted);
}

/* 三顆按鈕一列、等寬；外觀與 44px 來自 ui.secondary。 */
.actions {
	display: flex;
	gap: var(--space-2);
	margin: var(--space-3) 0 var(--space-2);
}

.actions button {
	flex: 1;
	/* 「下載中…」比「餐點」寬：不換行，也不把另外兩顆擠小。 */
	min-width: 0;
	padding: 0 var(--space-2);
	white-space: nowrap;
}

.error {
	margin: 0;
	color: var(--color-danger);
}
```

- [ ] **Step 6: 放進「我的」**——`frontend/src/screens/Me.tsx`：

import 加一行（照字母順序，在 `Card` 之後）：

```tsx
import { ExportCard } from "../components/ExportCard";
```

元件上方的註解換成：

```tsx
/** 我的：帳號、每日目標、好友、匯出資料、管理員的審核、邀請與所有帳號、登出
 *  （介面改版規格 §5.7、帳號設定規格 §5.1、報表月份與匯出規格 §4.2）。 */
```

`<FriendsCard />` 之後加：

```tsx
			{/* 放在管理員的幾張卡片前面：「所有帳號」可能很長，匯出不該被推到最下面。 */}
			<ExportCard />
```

- [ ] **Step 7: 跑，確認綠**

Run: `npx vitest run tests/export-card.test.tsx tests/me.test.tsx 2>&1 | grep -E "FAIL|Unhandled|Tests |Type Errors"`
Expected: `Tests  52 passed (52)`（`export-card` 18、`me` 34）、`Type Errors  no errors`。

Run: `npm run -s test 2>&1 | grep -E "FAIL|Unhandled|Test Files|Tests |Type Errors"`
Expected: `Test Files  138 passed (138)`、`Tests  1631 passed (1631)`、`Type Errors  no errors`。

- [ ] **Step 8: 突變**（跑 `npx vitest run tests/export-card.test.tsx tests/me.test.tsx tests/client.test.ts tests/save-file.test.ts`）

| 突變 | 實測紅的 |
|---|---|
| `ExportCard.tsx`：`disabled={false}` | 「下載中：…三顆都不能按」 |
| `caught.status === 429` → `=== 430` | 「429：顯示後端的訊息與還要等幾秒…」 |
| 不管 `result` 都 `setDone(…)` | 「交給分享面板、或使用者關掉分享面板：不說『已下載』」 |
| `handleDownload` 開頭不 `setError(null)` | 「429：…再按一次成功就把錯誤清掉」 |
| `finally` 裡不 `setPending(null)` | 4 條（按鈕永遠停用） |
| `api/export.ts`：一律 ``filename: `${kind}.csv` ``（不用後端給的） | 三條「按『…』」＋ 429 那條 |
| `Me.tsx`：拿掉 `<ExportCard />` | `me.test.tsx` 新的那條 |

- [ ] **Step 9: 型別、lint**

Run: `npm run -s typecheck`（沒有輸出）、`npm run -s lint`（乾淨）。

- [ ] **Step 10: Commit**

```
feat(frontend): 「我的」的匯出資料卡片——餐點、花費、補劑各下載一個 CSV

三顆按鈕各打 GET /api/export/{kind}.csv，檔名用後端給的（帶後端算的今天）。
下載中三顆一起停用、按的那顆寫「下載中…」；存好之後 role=status「已下載 …」；
429 顯示後端的訊息與還要等幾秒，其他失敗「下載失敗，請再試一次」（role=alert）。
不用 useMutation：離線時暫停、恢復連線才送的下載會在人離開之後自己冒出來。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

```bash
git add frontend/src/api/export.ts frontend/src/components/ExportCard.tsx frontend/src/components/ExportCard.module.css frontend/src/screens/Me.tsx frontend/tests/export-card.test.tsx frontend/tests/me.test.tsx
git commit -F "$S/commit-msg.txt"
```

---

## Task 8：e2e

規格 §6.3。

**Files:**
- Create: `frontend/e2e/reports-export.spec.ts`

- [ ] **Step 1: 讓 dev 的 API 是新的**

Run（repo 根目錄）: `docker compose up -d --build api`，等 `docker compose ps` 顯示 `healthy`；`curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8000/api/export/meals.csv`
Expected: `401`（路由在、要登入）。`404` 代表容器還是舊的（handover §7：`docker ps` 的 `Up` 不代表活著）。

- [ ] **Step 2: 寫 spec** `frontend/e2e/reports-export.spec.ts`：

```ts
import { readFile } from "node:fs/promises";
import { expect, type Page, test } from "@playwright/test";
import { loginAs, newAccount } from "./new-account.ts";
import { expectTouchTargets, login } from "./touch-targets.ts";

// 兩條會記帳的測試各自開一個新帳號：總額與 CSV 的列數才是確定的（示範帳號同時有
// 別的 worker 在記帳）。登入之後只用點擊換頁；唯一的 `page.reload()` 用的是自己的帳號、
// 只有這一頁，不會跟別的 worker 搶同一張 refresh token。
//
// 名稱一律 exact：「這個月」是「這個月花了多少」的子字串，「2026年9月」是
// 「2026年9月花了多少」的子字串，「花費」「餐點」「補劑」在別的頁面是標題的一部分。

const PHONE = { width: 390, height: 844 };

/** ＋ → 記帳 → 123.45、交通、備註 → 回到總覽（同 money-loop.spec.ts 的點法）。 */
async function addExpense(page: Page, note: string) {
	await page.getByRole("button", { name: "新增紀錄", exact: true }).click();
	await page.getByRole("link", { name: "記帳", exact: true }).click();
	await expect(
		page.getByRole("heading", { name: "記帳", exact: true }),
	).toBeVisible();
	for (const key of ["1", "2", "3", "小數點", "4", "5"]) {
		await page.getByRole("button", { name: key, exact: true }).click();
	}
	await page.getByRole("button", { name: "交通", exact: true }).click();
	await page.getByLabel("備註", { exact: true }).fill(note);
	await page.getByRole("button", { name: "記一筆", exact: true }).click();
	await expect(
		page.getByRole("heading", { name: "總覽", exact: true }),
	).toBeVisible();
}

test("報表看其他月份：上個月沒有剛記的那一筆，網址記得月份，重新整理不會跳回這個月", async ({
	page,
	request,
}) => {
	const account = await newAccount(request, "months");
	await loginAs(page, account);
	const note = `e2e-month-${Date.now()}`;
	await addExpense(page, note);

	await page.getByRole("link", { name: "報表", exact: true }).click();
	await expect(
		page.getByRole("heading", { name: "這個月花了多少", exact: true }),
	).toBeVisible();
	const summary = page.getByTestId("expense-summary");
	const list = page.getByTestId("month-list");
	const previous = page.getByRole("button", { name: "上個月", exact: true });
	const next = page.getByRole("button", { name: "下個月", exact: true });
	await expect(summary).toContainText("總計 123.45");
	await expect(list.getByText(note, { exact: true })).toBeVisible();
	await expect(next).toBeDisabled();
	await expect(page).toHaveURL(/\/reports$/);

	// 上個月：新帳號，什麼都沒有。
	await previous.click();
	await expect(page).toHaveURL(/\/reports\?month=\d{4}-\d{2}$/);
	const pastUrl = page.url();
	const pastHeading = page.getByRole("heading", {
		name: /^\d{4}年\d{1,2}月花了多少$/,
	});
	await expect(pastHeading).toBeVisible();
	// 先等那個月真的載入完（不是還留著、調淡的這個月），再斷言「沒有」。
	await expect(summary).toContainText("總計 0.00");
	await expect(page.getByTestId("month-summary")).not.toHaveAttribute(
		"aria-busy",
		"true",
	);
	await expect(summary).not.toContainText("123.45");
	await expect(list).not.toHaveAttribute("aria-busy", "true");
	await expect(list.getByText(note, { exact: true })).toHaveCount(0);
	await expect(next).toBeEnabled();

	// 重新整理：還在那個月。
	await page.reload();
	await expect(pastHeading).toBeVisible();
	await expect(page).toHaveURL(pastUrl);
	await expect(summary).toContainText("總計 0.00");
	await expect(list.getByText(note, { exact: true })).toHaveCount(0);

	// 下個月＝這個月：網址沒有 ?month，剛記的那一筆在。
	await next.click();
	await expect(
		page.getByRole("heading", { name: "這個月花了多少", exact: true }),
	).toBeVisible();
	await expect(page).toHaveURL(/\/reports$/);
	await expect(summary).toContainText("總計 123.45");
	await expect(list.getByText(note, { exact: true })).toBeVisible();
	await expect(next).toBeDisabled();

	// 換月份是一筆一筆的歷史紀錄：瀏覽器的上一頁回到上個月。
	await page.goBack();
	await expect(page).toHaveURL(pastUrl);
	await expect(pastHeading).toBeVisible();
});

test("匯出花費：下載的 CSV 檔名帶日期、開頭有 BOM、內容有剛記的那一筆", async ({
	page,
	request,
}) => {
	const account = await newAccount(request, "export");
	await loginAs(page, account);
	// 備註故意用 = 開頭：一路走到 CSV 裡要被加上單引號（不會被試算表當公式）。
	const note = `=e2e-export-${Date.now()}`;
	await addExpense(page, note);

	await page.getByRole("link", { name: "我的", exact: true }).click();
	await expect(
		page.getByRole("heading", { name: "匯出資料", exact: true }),
	).toBeVisible();
	const card = page.getByTestId("export-card");

	const downloading = page.waitForEvent("download");
	await card.getByRole("button", { name: "花費", exact: true }).click();
	const download = await downloading;

	expect(download.suggestedFilename()).toMatch(
		/^expenses-\d{4}-\d{2}-\d{2}\.csv$/,
	);
	await expect(card.getByRole("status")).toHaveText(
		`已下載 ${download.suggestedFilename()}`,
	);
	const path = await download.path();
	const bytes = await readFile(path);
	expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
	const lines = bytes.subarray(3).toString("utf8").split("\r\n");
	// 新帳號：標題、剛記的那一筆、結尾的空字串（最後一列也以 CRLF 結束）。
	expect(lines).toHaveLength(3);
	expect(lines[0]).toBe("日期,時間,分類,金額,備註,是否餐費");
	expect(lines[1]).toMatch(
		new RegExp(`^\\d{4}-\\d{2}-\\d{2},\\d{2}:\\d{2},交通,123\\.45,'${note},否$`),
	);
	expect(lines[2]).toBe("");
	// 三顆按鈕都恢復可以按。
	await expect(
		card.getByRole("button", { name: "花費", exact: true }),
	).toBeEnabled();
});

test.describe("手機尺寸", () => {
	test.use({ viewport: PHONE });

	test("月份切換與匯出的按鈕都 ≥ 44px；月份切換排成一列、沒有橫向捲軸", async ({
		page,
	}) => {
		// 只看不改：用共用的示範帳號就好。
		await login(page);
		await page.getByRole("link", { name: "報表", exact: true }).click();
		await expect(
			page.getByRole("heading", { name: "這個月花了多少", exact: true }),
		).toBeVisible();
		const switcher = page.getByRole("group", { name: "切換月份", exact: true });
		const previous = switcher.getByRole("button", {
			name: "上個月",
			exact: true,
		});
		const next = switcher.getByRole("button", { name: "下個月", exact: true });
		// 等「這個月是哪個月」回來：在那之前「上個月」是停用的。
		await expect(previous).toBeEnabled();
		await expectTouchTargets(switcher.getByRole("button"), "月份切換");

		const boxes = await Promise.all(
			[previous, switcher.getByRole("status"), next].map((locator) =>
				locator.boundingBox(),
			),
		);
		const [left, label, right] = boxes;
		if (left === null || label === null || right === null) {
			throw new Error("月份切換的三個元素有一個量不到");
		}
		// 一列：由左到右是 上個月、月份、下個月，三個的垂直中心差不多。
		expect(label.x).toBeGreaterThanOrEqual(left.x + left.width);
		expect(right.x).toBeGreaterThanOrEqual(label.x + label.width);
		const centers = [left, label, right].map((box) => box.y + box.height / 2);
		expect(Math.max(...centers) - Math.min(...centers)).toBeLessThan(4);
		const overflow = await page.evaluate(
			() =>
				document.documentElement.scrollWidth -
				document.documentElement.clientWidth,
		);
		expect(overflow).toBeLessThanOrEqual(0);

		await previous.click();
		await expect(page).toHaveURL(/\/reports\?month=\d{4}-\d{2}$/);
		await expectTouchTargets(switcher.getByRole("button"), "月份切換（上個月）");

		await page.getByRole("link", { name: "我的", exact: true }).click();
		await expect(
			page.getByRole("heading", { name: "匯出資料", exact: true }),
		).toBeVisible();
		await expectTouchTargets(
			page.getByTestId("export-card").getByRole("button"),
			"匯出資料",
		);
	});
});
```

- [ ] **Step 3: 跑新的三條**

Run（在 `frontend/`）: `npx playwright test e2e/reports-export.spec.ts --reporter=line`
Expected: `3 passed`。

已知會讓第一條**假紅**（不是假綠）的情況：測試跨過使用者時區的月底午夜——剛記的那一筆會落在「上個月」。重跑就好。

- [ ] **Step 4: 突變**（每個改完重跑 Step 3；dev server 會熱更新，不用重啟）

| 突變 | 實測 |
|---|---|
| `Expenses.tsx` `goTo`：`else params.delete("month")`（永遠不寫月份） | 第 1、3 條紅：`toHaveURL(/\/reports\?month=…/)` 收到 `/reports` |
| `goTo`：到這個月也 `params.set`（不拿掉參數） | 第 1 條紅：`toHaveURL(/\/reports$/)` 收到 `/reports?month=2026-10` |
| `useExpenses(null)`（清單不理月份） | 第 1 條紅：那一筆在上個月的清單裡（`toHaveCount(0)` 收到 1） |
| `useExpenseSummary(null)`（摘要不理月份） | 第 1 條紅：「總計 0.00」收到「總計 123.45…」 |
| `save-file.ts`：拿掉 `anchor.download = filename;` | 第 2 條紅：檔名變成一串 UUID |
| `Expenses.module.css`：`.monthSwitch` 的 `display: flex` → `block` | 第 3 條紅：三個元素不在一列 |
| `ExportCard.tsx`：按鈕拿掉 `className={ui.secondary}` | 第 3 條紅：「餐點」的高度 21 |

改回，重跑 `3 passed`。

- [ ] **Step 5: 整套 e2e**

Run: `npx playwright test --reporter=line`
Expected: `44 passed`（41 ＋ 3）。既有的 spec 不該需要改；有紅的先看是不是名稱撞到（開工前必讀第 8 點），照實回報。

- [ ] **Step 6: 看一眼畫面**（量高度證明不了排列，handover §7）

用瀏覽器開 `http://localhost:5173`，電腦版寬度與手機寬度（390px）各看一次報表（這個月、上個月）與「我的」的匯出卡片：切換器一列、月份在中間、停用的「下個月」是淡的；三顆匯出按鈕等寬一列。深色模式也看一次（只用了設計變數，應該沒事）。

- [ ] **Step 7: Commit**

```
test(e2e): 報表換月份與匯出花費

換月份（新帳號）：記一筆之後上個月是「總計 0.00」、沒有那一筆、網址有 ?month=；
重新整理還在那個月；下個月回到沒有參數的網址；瀏覽器的上一頁回到上個月。
匯出（新帳號）：下載事件的檔名 expenses-YYYY-MM-DD.csv、開頭是 BOM、剛好一列，
= 開頭的備註在檔案裡前面多了單引號。手機尺寸：按鈕 ≥ 44px、切換器一列、沒有橫向捲軸。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

```bash
git add frontend/e2e/reports-export.spec.ts
git commit -F "$S/commit-msg.txt"
```

---

## Task 9：文件

**Files:**
- Modify: `docs/handover.md`、`docs/superpowers/specs/2026-10-09-reports-month-export-design.md`、這份計畫（「執行中發現的差異」）

- [ ] **Step 1: 量數字**（寫進文件的一律是量出來的，不是這份計畫預測的）

```bash
./.venv/Scripts/python.exe -m pytest -q -W error 2>&1 | tail -1          # 後端
grep -c "@router\." app/api/routes/*.py | awk -F: '{s+=$2} END {print s}'  # 端點（預期 78）
(cd frontend && npm run -s test 2>&1 | grep -E "Test Files|Tests ")       # 前端（印出來的數字）
(cd frontend && npx playwright test --reporter=line 2>&1 | tail -1)       # e2e
```

- [ ] **Step 2: `docs/handover.md`**
  - 檔頭「狀態」補「報表看其他月份與匯出資料已實作於 `feat/reports-month-export`」；「§2 的數字更新於」改成今天。
  - §2 的表：端點、後端測試數、前端測試數（寫明是 vitest 印出來的數字，以及「不是剛好兩倍：`it.each` 在執行那次展開、型別那次算一條」——同時把 §7「vitest 的 `Test Files`／`Tests` 都是實際數量的兩倍」那一列改成這個說法）、e2e。資料表與 Migration 不變。
  - §2「階段進度」加一列「報表看其他月份、匯出資料」：報表的「‹ 上個月｜月份｜下個月 ›」（`?month=YYYY-MM`，這個月由後端決定）；「我的」的匯出資料（餐點／花費／補劑的 CSV：UTF-8＋BOM、帳號時區、分塊串流、每人每分鐘 6 次）；規格與計畫的路徑；✅（`feat/reports-month-export`）。
  - §3「目錄結構」加兩行：`csv_export.py`（CSV 的唯一寫法：BOM、引號、公式字元）、`export.py`（匯出的三支分塊 generator）。
  - §10 加一節 `### 報表看其他月份與匯出資料`（放在「帳號與目標設定」之後），寫：
    - **機制摘要**：
      - 月份：`?month=`、沒有＝這個月；「這個月」＝`useExpenseSummary(null)` 回應的 `month`，報表永遠掛著它；`lib/months.ts` 不用 `Date`；無效／未來 → `replace` 清掉，等於這個月不清；翻到這個月時拿掉參數；`keepPreviousData` 在兩個 hook 裡。**之後有別的畫面要「看某個月／某一天」，照這個形狀：網址放明確的值、沒有值就讓後端決定、界線問後端。**
      - 匯出：`app/csv_export.py` 的型別規則（`str` 擋公式字元、`Decimal` 不擋、`None` 空）——**之後任何要輸出 CSV 的地方都走它**；`app/export.py` 的 keyset 分塊（為什麼不是 OFFSET、為什麼游標帶 `id`）；`get_db` 的 session 靠 FastAPI ≥ 0.118 活到串流結束（`scope="function"` 會壞，有測試）；限速器與鍵；前端 `fetchDownload`＋`saveBlob`，iOS 主畫面模式走分享。
    - **新的東西在哪裡**：後端與前端各一段，列檔案。
    - **已知限制**：照規格 §8 的 17 點（清單 100 筆的既有落差、只能一個月一個月翻、跨月那一刻的舊「這個月」、離線只留最近看過的月份、匯出不是快照、握著一條連線、瀏覽器端整份進記憶體、名稱是現在的、標籤兩份、全形符號不擋、iOS 沒有實機驗證…）。執行中量到跟規格不一樣的，以量到的為準並改規格。
  - §6：執行中如果長出新的「綠燈說謊」，照既有格式加一節（編號接著 53）；沒有就不加。寫計畫時遇到的兩件事值得各記一句（不算新的種類）：
    - 「共用 session 會讀到記憶體裡的舊值」（第 30、49 種）**只在有人握著那個物件時成立**——identity map 是弱參照；為它加的 `populate_existing` 突變存活，刪了。
    - 第 38 種又一次：摘要裡「999.00」出現兩次（總計、佔 100% 的分類）。
  - §7 的陷阱表加（各一列）：
    - **突變成無限迴圈**：keyset 的 `>` 改成 `>=` 不會讓測試紅，只會跑不完——突變工具要有 timeout，被砍掉之後記得把檔案改回來。
    - **`StreamingResponse` 與 `yield` 依賴**：FastAPI ≥ 0.118 才是「送完才收尾」；`ASGITransport` 把回應收完才交回來，分塊要直接測 generator。
    - 執行中實測到的其他坑（如果有）。

- [ ] **Step 3: 規格與計畫**
  - 規格：檔頭的「**狀態：** 設計定稿，待實作」改成「**狀態：** 已實作（`feat/reports-month-export`）」；執行中跟規格不一樣的地方補在「與原始決定的差異」後面。
  - 這份計畫的「執行中發現的差異」：每個 task 預測錯的紅燈、改過的程式碼、量到的數字跟計畫不同的地方。

- [ ] **Step 4: 檢查**：`git diff --stat` 只有這三個檔案；用 Edit／Write 改（Windows 上用 Python 文字模式寫 markdown 會把整份轉成 CRLF，handover §7）——`git diff` 不該出現整份檔案的變動。

- [ ] **Step 5: Commit**

```
docs: 報表看其他月份與匯出資料的交接說明

交接文件：進度、量到的數字、機制摘要（月份由網址與後端決定；CSV 的型別規則、
keyset 分塊、session 活到串流結束）、已知限制（清單 100 筆、跨月那一刻、匯出不是快照、
iOS 主畫面模式沒有實機驗證…）。規格與計畫補上執行中發現的差異。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

```bash
git add docs/handover.md docs/superpowers/specs/2026-10-09-reports-month-export-design.md docs/superpowers/plans/2026-10-09-reports-month-export.md
git commit -F "$S/commit-msg.txt"
```

---

## 完成條件

- 後端：`pytest -q -W error` 全綠（936 → 實際數字，預期 980）、`ruff check .`、`mypy app` 乾淨。沒有 migration。
- `schema.d.ts` 跟後端一致（重新產生後 `git diff --exit-code` 是 0）。
- 前端：`typecheck`、`lint`、`test` 全綠（印出來的 `Tests` 1525 → 預期 1631）。
- e2e：整套全綠（41 → 44）。
- 每個 task 的突變都紅過、也都改回了（`git status --short` 只剩 `?? lunch.jpg`）。
- 手動看過一次畫面（Task 8 Step 6）。**iOS 主畫面模式的匯出要請使用者在 iPhone 上實際按一次**（規格 §8 第 16 點）——這是唯一沒有任何自動測試碰得到的路徑，結果寫進 handover。
- 沒有 push。
