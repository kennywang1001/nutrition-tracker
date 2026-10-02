# 介面改版第一階段 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 app 改成 MOZE 式的外觀與記錄流程：總覽｜報表｜＋｜飲食｜我的、自訂鍵盤記帳、記一餐可選填照片、深色模式。

**Architecture:** 後端只多 `GET /api/expenses?date=`。前端用 CSS Modules＋`index.css` 的設計變數（深色模式只覆寫變數）、`lucide-react` 圖示。新畫面：`Overview`（`/`）、`AddExpense`（`/expenses/new`）、`Me`（`/me`）；既有的 `Today` 搬到 `/diet`、`Expenses` 搬到 `/reports`、`LogMeal` 搬到 `/meals/new`。

**Tech Stack:** FastAPI · Vite · React 19 · TypeScript strict · TanStack Query · react-router 8 · decimal.js · lucide-react · Vitest + Testing Library · Playwright · Biome

**依據規格：** `docs/superpowers/specs/2026-10-02-ui-redesign-phase1-design.md`（已審核）

---

## 執行環境

- **venv 不在 PATH 上。** 後端指令用 `./.venv/Scripts/python.exe -m ...`，在 repo 根目錄跑。
- 後端測試需要測試資料庫：先 `docker ps` 確認 `wallet-db-1` 是 healthy。
- 前端指令在 `frontend/` 底下跑：
  - 全部測試：`npm run -s test`；單檔：`npx vitest run tests/xxx.test.tsx`
  - 型別：`npm run -s typecheck`；lint：`npm run -s lint`
- **Vitest 會把每個測試檔再跑一次型別檢查**，所以測試數量看起來是實際 `it()` 的兩倍，型別錯誤會以一個額外失敗的檔案出現。
- 基準線（master `7ae05a4`）：前端 **58 檔 342 passed**。
- Biome 會要求重新排版（長的 import 拆行等）。在本任務列出的檔案裡做機械性排版修正沒問題，回報時提一句。
- Commit 結尾一律：`Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`。中文 commit 訊息用全形標點（shell 吃掉的話用 `git commit -F 檔案`）。

---

## 開工前必讀：這份計畫的文字沒有權威性

P5 計畫一被抓到 13 個錯誤，P5 計畫二被抓到 6 個以上——**幾乎全是「憑印象寫的」**。

1. 每一個「Expected: FAIL」如果**沒有**如預期失敗，**停下來回報**，不要調整測試讓它變紅。綠燈本身就是發現。
2. 預測「紅 N 條」而實際不是 N，**照實回報是哪幾條**。
3. 要改的檔案不在清單上，**回報，不要默默改**。
4. 引用既有程式碼的地方對不上時，**以現況為準**並回報差異。
5. **在有表單又有清單的畫面上，裸的 `screen.getByText` 預設就該懷疑**（handover §6 第 38 種）：同一段文字常常同時出現在 `<option>` 或另一列裡。

---

## 開工前已經查證過的事實

| 事實 | 出處 |
|---|---|
| `GET /api/meals` 不帶 `date` 時回使用者時區的今天；`date` 參數名就叫 `date`，型別 `date \| None` | `app/api/routes/meals.py:363-381` |
| `day_bounds(day, tz_name)` 回 UTC 半開區間 | `app/days.py` |
| `GET /api/expenses` 目前只有 `month` 與 `limit`；不帶參數是「這個月」 | `app/api/routes/expenses.py:85-128` |
| 422 的寫法：`raise UnprocessableEntityError(code, message)` | `app/errors.py:53` |
| 支出的跨使用者隔離測試在 `tests/test_expenses_crud.py`（不在 `test_cross_user_isolation.py`） | 前者第 137 行 |
| 使用者預設時區 `Asia/Taipei` | `app/models/user.py:31` |
| `npm run gen:api` 要打 `localhost:8000`——本機 api 容器目前壞掉（`No module named 'anthropic'`），所以 Task 1 改用 `app.openapi()` 匯出 JSON 再產生 | `frontend/package.json:15` |
| **`lucide-react` 1.49.0 沒有 `PieChart`，叫 `ChartPie`**；`LucideIcon` 型別有匯出 | 已解開 npm 套件檢查 `dist/lucide-react.d.ts` |
| 本計畫用到的圖示全部存在：`Utensils Bus ShoppingBag Gamepad2 Pill House Ellipsis LayoutDashboard ChartPie Salad CircleUser Plus X Delete Check Camera Coffee Sun Moon Cookie Wallet` | 同上 |
| `tsconfig.app.json` 有 `"types": ["vite/client"]`——`*.module.css` 的型別已經有了 | `frontend/tsconfig.app.json` |
| **頂端 `<Nav>` 的「重新整理」按鈕是 `e2e/auth.spec.ts` 測「token 過期自動換票」的唯一路徑**，而且**不能**改成 `useMe().refetch`（`staleTime` 60 秒，按了什麼都不會發生、那條 e2e 卻不會紅） | `src/App.tsx:42-80`、`src/api/me.ts` 的 docstring |
| `queryKeys.meals` 是 `["meals"]`，`MealList` 用它打 `GET /api/meals` | `src/api/queries.ts:41`、`src/screens/MealList.tsx:135` |
| `queryKeys.dailyStats` 在 `Today.tsx` 與 `Trend.tsx` 各寫了一次完全相同的 `useQuery` | 兩個檔案 |
| `Trend.tsx` 已經用「`stats/daily` 回應裡的 `date`」當「今天」——這次的總覽沿用同一個先例 | `src/screens/Trend.tsx:21-35` |
| `uploadMealPhoto(mealId, file)` 目前**沒有匯出**；`useUploadMealPhoto(mealId)` 綁死一個 mealId | `src/api/photos.ts` |
| 照片上傳會呼叫 `shrinkToLongestEdge`（用 canvas，jsdom 沒有）——測試要 `vi.mock("../src/lib/resize-image", …)` | `tests/meal-photo-upload.test.tsx:19` |
| jsdom 沒有 `URL.createObjectURL`，`src/test/setup.ts` 已經補了一個假的 | `src/test/setup.ts` |
| `tests/app.test.tsx` 第二條用「所有請求都回 `[]`」的 mock——新總覽拿到 `[]` 會當掉，要換掉 | `tests/app.test.tsx:30-54` |
| 白字在 `#ff7a59` 上對比只有約 2.6:1 | 手算，Task 2 的測試會實際驗 |

---

## 與規格的差異（寫計畫時發現，已決定）

1. **主色拆成兩個變數。** 規格 §4.1 只有一個 `--color-primary: #ff7a59`。但白字在它上面對比只有約 2.6:1，連大字的 3:1 都不到。所以：
   - `--color-accent: #ff7a59`：只用在**沒有文字壓在上面**的裝飾（進度條、選取框、分類高亮）。
   - `--color-action: #b8432a`：按鈕底色、作用中的 tab、連結文字——白字在上面、它在淺色背景上都 ≥ 4.5:1。
   - 深色模式：兩者都是 `#ff8a6b`，按鈕上的字改用深色 `#1f1f1f`。
   - 這些數字由 Task 2 的對比度測試實際驗證，**不是靠手算**。
2. **`--color-text-muted` 從 `#777777` 改成 `#6b6b6b`。** `#777` 在白底上是 4.48:1，差一點不到 4.5。
3. **`?date=` 的隔離測試放在 `tests/test_expenses_crud.py`**，不是規格寫的 `test_cross_user_isolation.py`——支出的隔離測試本來就在前者。
4. **記一餐沒有 ✕ 關閉鈕。** tab bar 在所有畫面都看得到，離開的路已經在那裡；記帳畫面有 ✕ 是因為鍵盤佔滿下半部，視覺上像一個獨立的面板。

---

## 檔案結構

| 檔案 | 負責什麼 |
|---|---|
| `app/api/routes/expenses.py`（改） | `GET /api/expenses` 多 `?date=` |
| `tests/test_expenses_crud.py`（改） | `?date=` 的測試 |
| `frontend/src/api/schema.d.ts`（重新產生） | 反映 `?date=` |
| `frontend/package.json`、`package-lock.json`（改） | 加 `lucide-react` |
| `frontend/src/index.css`（改） | 設計變數、深色模式、全域基底樣式 |
| `frontend/tests/css-tokens.test.ts`（新） | 對比度、深色模式覆寫完整、module CSS 不寫色碼 |
| `frontend/src/components/Card.tsx`＋`.module.css`（新） | 圓角卡片 |
| `frontend/src/components/IconBadge.tsx`＋`.module.css`（新） | 彩色圓形＋白色圖示；`CategoryIcon`、`MealTypeIcon` |
| `frontend/src/api/expenses.ts`（改） | `CATEGORY_COLORS`、`CATEGORY_ICONS`、`useExpensesByDate` |
| `frontend/src/api/meals.ts`（新） | `Meal` 型別、`MEAL_TYPE_LABELS`、`MEAL_TYPE_ICONS`、`useTodayMeals` |
| `frontend/src/api/stats.ts`（新） | `DailyStats` 型別、`useDailyStats` |
| `frontend/src/api/queries.ts`（改） | `expensesByDate` |
| `frontend/src/lib/keypad.ts`（新） | `applyKey`、`normalizeAmount`（純函式） |
| `frontend/src/lib/decimal.ts`（改） | `isPositiveAmount` |
| `frontend/src/components/MoneyKeypad.tsx`＋`.module.css`（新） | 數字鍵盤 |
| `frontend/src/components/TabBar.tsx`（重寫）＋`.module.css`（新） | 四格＋「＋」 |
| `frontend/src/components/AddSheet.tsx`＋`.module.css`（新） | 「＋」滑出的面板 |
| `frontend/src/screens/Me.tsx`＋`.module.css`（新） | 我的 |
| `frontend/src/screens/Overview.tsx`＋`.module.css`（新） | 總覽 |
| `frontend/src/lib/timeline.ts`（新） | `buildTimeline`（純函式） |
| `frontend/src/screens/AddExpense.tsx`＋`.module.css`（新） | 記帳 |
| `frontend/src/App.tsx`（改） | 路由、轉址、移除 `<Nav>` |
| `frontend/src/screens/LogMeal.tsx`（改）＋`.module.css`（新） | 選填照片、新外觀 |
| `frontend/src/api/photos.ts`（改） | 匯出 `uploadMealPhoto` |
| `frontend/src/screens/Today.tsx`、`MealList.tsx`、`Expenses.tsx`（改）＋各自 `.module.css`（新） | 落點與新外觀 |
| `frontend/e2e/*.spec.ts`（改） | 新路由與新入口 |

---

## Task 1：後端 `GET /api/expenses?date=`

**Files:**
- Modify: `app/api/routes/expenses.py`（imports 與 `list_expenses`）
- Test: `tests/test_expenses_crud.py`
- Regenerate: `frontend/src/api/schema.d.ts`

**為什麼排第一：** 總覽的時間線要用它。前端不自己算日界線（`frontend/src/lib/dates.ts` 頂端的規矩），所以「今天的支出」只能靠後端。

- [ ] **Step 1: 寫失敗的測試**

加到 `tests/test_expenses_crud.py`，放在 `test_list_expenses_only_returns_my_own` 之後：

```python
async def test_list_expenses_by_date_uses_the_users_local_day(client, db_session):
    """`?date=` 是使用者時區（Asia/Taipei）的一天，不是 UTC 的一天。

    台北 12/15 00:00 = UTC 12/14 16:00。三筆分別落在台北的 12/14 23:59、
    12/15 00:01、12/16 00:00——只有中間那筆屬於台北的 12/15。

    **第三筆是必要的**：它落在 UTC 的 12/15 裡。如果實作誤用 UTC 的一天，
    回的會是第三筆而不是第二筆，測試才分辨得出兩種實作。
    """
    user = await create_user(db_session)
    await create_expense(
        db_session, user=user, amount=1, spent_at=datetime(2026, 12, 14, 15, 59, tzinfo=UTC)
    )
    await create_expense(
        db_session, user=user, amount=2, spent_at=datetime(2026, 12, 14, 16, 1, tzinfo=UTC)
    )
    await create_expense(
        db_session, user=user, amount=3, spent_at=datetime(2026, 12, 15, 16, 0, tzinfo=UTC)
    )

    response = await client.get("/api/expenses?date=2026-12-15", headers=auth(user))

    assert response.status_code == 200
    assert [item["amount"] for item in response.json()] == ["2.00"]


async def test_list_expenses_by_date_only_returns_my_own(client, db_session):
    alice = await create_user(db_session)
    bob = await create_user(db_session)
    noon_in_taipei = datetime(2026, 12, 15, 4, 0, tzinfo=UTC)
    await create_expense(db_session, user=alice, amount=100, spent_at=noon_in_taipei)
    await create_expense(db_session, user=bob, amount=200, spent_at=noon_in_taipei)

    response = await client.get("/api/expenses?date=2026-12-15", headers=auth(alice))

    assert response.status_code == 200
    assert [item["amount"] for item in response.json()] == ["100.00"]


async def test_list_expenses_rejects_date_and_month_together(client, db_session):
    """兩個都帶時沒有一個「對」的解讀——擇一靜默忽略另一個，呼叫端會拿到
    跟它以為的不一樣的資料，而且沒有任何訊號。"""
    user = await create_user(db_session)

    response = await client.get(
        "/api/expenses?date=2026-12-15&month=2026-12", headers=auth(user)
    )

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "DATE_AND_MONTH_EXCLUSIVE"


async def test_list_expenses_rejects_malformed_date(client, db_session):
    user = await create_user(db_session)

    response = await client.get("/api/expenses?date=2026-13-01", headers=auth(user))

    assert response.status_code == 422
```

- [ ] **Step 2: 跑測試確認它失敗**

```
./.venv/Scripts/python.exe -m pytest tests/test_expenses_crud.py -q
```

Expected：新加的 **4 條全部 FAIL**。現在 `date` 會被 FastAPI 當成未知參數忽略，所以：前兩條拿到「這個月（現在的真實月份）」的資料而不是 12/15 的；第三條回 200；第四條回 200。既有的測試全部 PASS。**實際結果不同就照實回報。**

- [ ] **Step 3: 實作**

`app/api/routes/expenses.py` 的 imports 改成／加上：

```python
from datetime import date, datetime
```

```python
from app.days import day_bounds, month_bounds, this_month_in_timezone
from app.errors import UnprocessableEntityError
```

`list_expenses` 的簽章加一個參數，函式本體最前面加兩段判斷；docstring 最前面加一段說明（原有的「**沒有 offset。**」與「**已知落差**」兩段原樣保留在後面）：

```python
@router.get("", response_model=list[ExpenseResponse])
async def list_expenses(
    month: str | None = Query(default=None, pattern=YEAR_MONTH_PATTERN),
    date: date | None = Query(default=None),
    limit: int = Query(default=100, ge=1, le=500),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[ExpenseResponse]:
    """這個月（或某一天）的花費，由新到舊。

    **`?date=` 是使用者時區的一天**，跟 `GET /api/meals?date=` 同一個
    `day_bounds()`——總覽的時間線把兩者放在同一條線上，兩邊對「今天」
    的看法不同的話，午夜前後的支出會跟餐點分到不同天。

    **不帶任何參數時仍然是「這個月」**，不是「今天」：報表的
    `useExpenses(null)` 依賴這個行為。前端要今天的支出時，先從
    `GET /api/stats/daily` 拿後端算好的 `date` 再明確帶進來——前端不自己
    算日界線。

    `date` 與 `month` 同時帶 → 422。擇一靜默忽略另一個的話，呼叫端拿到
    的資料跟它以為的不一樣，而且沒有任何訊號。

    （原有的「沒有 offset」與「已知落差」兩段接在這裡，原樣保留。）
    """
    if month is not None and date is not None:
        raise UnprocessableEntityError(
            "DATE_AND_MONTH_EXCLUSIVE", "date 與 month 只能擇一"
        )

    if date is not None:
        start, end = day_bounds(date, user.timezone)
    else:
        start, end, _ = _resolve_month(month, user.timezone)
```

（上面 docstring 裡括號那一行是給你的指示，不要照抄進程式碼——把原有的兩段放在那個位置。）

後面的查詢不用改，它本來就用 `start` / `end`。

> 參數名叫 `date` 會在函式內遮蔽 `datetime.date` 型別。`meals.py` 的 `list_meals` 是同一個寫法，
> 而這個函式內不需要那個型別。型別註記 `date | None` 在定義當下用的是模組層的 `date`。

- [ ] **Step 4: 跑測試確認通過**

```
./.venv/Scripts/python.exe -m pytest tests/test_expenses_crud.py tests/test_expenses_summary.py -q
```

Expected：全部 PASS。

- [ ] **Step 5: 突變測試——證明「使用者時區」那條守得住**

把 `day_bounds(date, user.timezone)` 暫時改成 `day_bounds(date, "UTC")`：

```
./.venv/Scripts/python.exe -m pytest tests/test_expenses_crud.py -q -k by_date
```

Expected：`test_list_expenses_by_date_uses_the_users_local_day` **FAIL**（拿到 `["3.00"]`）。**改回來。**

- [ ] **Step 6: 跑整個後端測試套件**

```
./.venv/Scripts/python.exe -m pytest -q
```

Expected：全部 PASS（基準線 598 passed，加 4 條）。

- [ ] **Step 7: 重新產生 `schema.d.ts`**

本機的 api 容器壞掉，`npm run gen:api` 打不到 `localhost:8000`，改從 app 物件直接匯出（在 repo 根目錄跑）：

```bash
./.venv/Scripts/python.exe -c "import json; from app.main import app; print(json.dumps(app.openapi(), ensure_ascii=False))" > frontend/openapi.tmp.json
cd frontend
npx openapi-typescript openapi.tmp.json -o src/api/schema.d.ts
rm openapi.tmp.json
git diff --stat src/api/schema.d.ts
```

Expected：`schema.d.ts` 只有 `list_expenses_api_expenses_get` 的 query 多了 `date?: string | null` 之類的幾行。**如果 diff 很大**（例如整份重新排序），代表產生器版本或輸入跟 CI 不同——停下來回報，不要 commit。

- [ ] **Step 8: 前端型別檢查**

```
cd frontend
npm run -s typecheck
```

Expected：通過。

- [ ] **Step 9: Commit**

訊息（用 `git commit -F` 從檔案讀）：

```
feat(expenses): GET /api/expenses 多一個 ?date=，依使用者時區取一天

總覽的時間線要「今天的支出」。跟 GET /api/meals?date= 用同一個
day_bounds()，兩邊對今天的看法才會一致。

不帶參數仍然是這個月，不是今天——報表依賴這個行為。前端要今天時，從
stats/daily 的回應拿後端算好的 date 再帶進來，不自己算日界線。

date 與 month 同時帶回 422 DATE_AND_MONTH_EXCLUSIVE：擇一靜默忽略另一個，
呼叫端拿到的資料跟它以為的不一樣，而且沒有訊號。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

```bash
git add app/api/routes/expenses.py tests/test_expenses_crud.py frontend/src/api/schema.d.ts
```

---

## Task 2：設計變數、深色模式、`lucide-react`、`Card`

**Files:**
- Modify: `frontend/package.json`、`frontend/package-lock.json`
- Modify: `frontend/src/index.css`
- Create: `frontend/tests/css-tokens.test.ts`
- Create: `frontend/src/components/Card.tsx`、`frontend/src/components/Card.module.css`

- [ ] **Step 1: 安裝 `lucide-react`**

```
cd frontend
npm install lucide-react@^1.49.0
```

Expected：`package.json` 的 `dependencies` 多一行 `"lucide-react": "^1.49.0"`。

- [ ] **Step 2: 寫失敗的測試**

Create `frontend/tests/css-tokens.test.ts`：

```ts
/// <reference types="node" />
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// 跟 decimal-containment.test.ts 同一種作法：用原始碼掃描把「規矩」變成紅燈。
// 規格 §4.1：元件只引用變數、不寫色碼；深色模式只在 index.css 覆寫同一組名字。

const css = readFileSync("src/index.css", "utf8");

function colorTokens(block: string): Map<string, string> {
	const tokens = new Map<string, string>();
	for (const match of block.matchAll(
		/(--color-[\w-]+)\s*:\s*(#[0-9a-fA-F]{6})\s*;/g,
	)) {
		const [, name, value] = match;
		if (name !== undefined && value !== undefined) {
			tokens.set(name, value.toLowerCase());
		}
	}
	return tokens;
}

const light = colorTokens(css.match(/:root\s*\{([^}]*)\}/)?.[1] ?? "");
const dark = colorTokens(
	css.match(/prefers-color-scheme:\s*dark\)\s*\{\s*:root\s*\{([^}]*)\}/)?.[1] ??
		"",
);

/** WCAG 2.x 的相對亮度。 */
function luminance(hex: string): number {
	const [r = 0, g = 0, b = 0] = [1, 3, 5]
		.map((start) => Number.parseInt(hex.slice(start, start + 2), 16) / 255)
		.map((channel) =>
			channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
		);
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
	const [high = 0, low = 0] = [luminance(a), luminance(b)].sort(
		(x, y) => y - x,
	);
	return (high + 0.05) / (low + 0.05);
}

/** 文字（前景）× 它會壓在上面的底色。每一組都要 ≥ 4.5:1（WCAG AA 一般文字）。
 *
 *  `--color-accent` **刻意不在這裡**：它只用在沒有文字壓在上面的裝飾
 *  （進度條、選取框），見計畫「與規格的差異」第 1 點。 */
const PAIRS: ReadonlyArray<readonly [string, string]> = [
	["--color-text", "--color-bg"],
	["--color-text", "--color-surface"],
	["--color-text-muted", "--color-bg"],
	["--color-text-muted", "--color-surface"],
	["--color-action", "--color-bg"],
	["--color-action", "--color-surface"],
	["--color-on-action", "--color-action"],
	["--color-danger", "--color-bg"],
	["--color-danger", "--color-surface"],
];

function collectModuleCss(dir: string): string[] {
	return readdirSync(dir).flatMap((entry) => {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) return collectModuleCss(full);
		return entry.endsWith(".module.css") ? [full] : [];
	});
}

describe("設計變數", () => {
	it("解析器真的抓到了淺色的顏色變數", () => {
		// 少了這條，正規表示式寫錯時 light 是空的，「深色覆寫了每一個」會
		// 因為兩邊都空而通過——handover §6 一再出現的那種綠燈說謊。
		expect(light.size).toBeGreaterThanOrEqual(9);
	});

	it("深色模式覆寫了每一個顏色變數", () => {
		expect([...dark.keys()].sort()).toEqual([...light.keys()].sort());
	});

	for (const [theme, tokens] of [
		["淺色", light],
		["深色", dark],
	] as const) {
		for (const [foreground, background] of PAIRS) {
			it(`${theme}：${foreground} 在 ${background} 上至少 4.5:1`, () => {
				const fg = tokens.get(foreground);
				const bg = tokens.get(background);
				expect(fg, foreground).toBeDefined();
				expect(bg, background).toBeDefined();
				expect(
					contrast(fg ?? "#000000", bg ?? "#000000"),
				).toBeGreaterThanOrEqual(4.5);
			});
		}
	}

	it("元件的 module CSS 不寫色碼", () => {
		const offenders = collectModuleCss("src")
			.filter((file) =>
				/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/.test(readFileSync(file, "utf8")),
			)
			.map((file) => file.replace(/\\/g, "/"));

		expect(offenders).toEqual([]);
	});
});
```

- [ ] **Step 3: 跑測試確認它失敗**

```
npx vitest run tests/css-tokens.test.ts
```

Expected：
- 「解析器真的抓到了淺色的顏色變數」FAIL（現在的 `:root` 沒有任何 `--color-*`）
- 「深色模式覆寫了每一個顏色變數」**PASS**（兩邊都是空的——這正是第一條要存在的理由）
- 18 條對比度全部 FAIL（`toBeDefined` 失敗）
- 「元件的 module CSS 不寫色碼」**PASS**（還沒有任何 module CSS）

**照實回報。**

- [ ] **Step 4: 改 `index.css`**

把 `frontend/src/index.css` 從第一行到 `.app-main { … }` 結束的這一段，換成下面這段。**`.tab-bar`、`.tab`、`.tab[aria-current="page"]`、`.trend-*`、`.food-*` 與檔尾的 `input, select, textarea` 規則原樣保留**（`.tab-bar` / `.tab` 在 Task 5 刪）。

```css
/* 樣式表的兩層（介面改版第一階段，規格 §4）：
   1. 這個檔案：設計變數、深色模式、全域基底樣式。
   2. 每個元件自己的 *.module.css：只能引用這裡的變數，不能寫色碼——
      tests/css-tokens.test.ts 會掃，也會驗每一組文字/底色的對比度。

   **深色模式只在這裡覆寫同一組變數名稱**，元件裡不寫任何
   prefers-color-scheme。這樣「加一個新顏色卻忘了深色版本」會被
   css-tokens.test.ts 的「深色模式覆寫了每一個顏色變數」抓到。 */

:root {
	/* 讓瀏覽器原生的控制項（捲軸、還沒改樣式的 input/select）也跟著深淺色。 */
	color-scheme: light dark;

	/* 底部 tab bar 的高度，加上 iPhone home indicator 的安全區。
	   下面的 main 用同一個變數補 padding，兩個數字因此不可能漂移。 */
	--tab-bar-height: 56px;
	--safe-bottom: env(safe-area-inset-bottom, 0px);
	/* 中間「＋」凸出 tab bar 上緣的高度（規格 §4.4）。 */
	--add-button-overhang: 20px;

	/* 珊瑚橘拆成兩個（計畫「與規格的差異」第 1 點）：
	   accent 只給沒有文字壓在上面的裝飾；action 給按鈕底色與連結文字。
	   白字在 #ff7a59 上只有約 2.6:1。 */
	--color-accent: #ff7a59;
	--color-accent-soft: #ffe9e2;
	--color-action: #b8432a;
	--color-on-action: #ffffff;
	--color-bg: #f6f6f8;
	--color-surface: #ffffff;
	--color-text: #222222;
	--color-text-muted: #6b6b6b;
	--color-border: #e5e5e5;
	--color-danger: #c0392b;
	/* 彩色圓形徽章上的白色圖示（IconBadge）。兩種模式都是白色，但深色
	   區塊仍然要寫一次——「深色覆寫了每一個顏色變數」那條測試要求的。
	   徽章旁邊一定有文字標籤，圖示是裝飾，不列入對比度的組合。 */
	--color-on-badge: #ffffff;

	--shadow-raised: 0 2px 6px rgb(0 0 0 / 25%);
	/* 「＋」面板背後的半透明遮罩。 */
	--scrim: rgb(0 0 0 / 40%);

	--radius-card: 12px;
	--radius-button: 10px;
	--space-1: 4px;
	--space-2: 8px;
	--space-3: 12px;
	--space-4: 16px;
	--space-6: 24px;
	--font-size-amount: 34px;
	--font-size-total: 20px;
}

@media (prefers-color-scheme: dark) {
	:root {
		--color-accent: #ff8a6b;
		--color-accent-soft: #3a2620;
		--color-action: #ff8a6b;
		/* 深色模式的按鈕是亮的珊瑚橘，上面的字要用深色才讀得到。 */
		--color-on-action: #1f1f1f;
		--color-bg: #16161a;
		--color-surface: #24242a;
		--color-text: #eeeeee;
		--color-text-muted: #a0a0a0;
		--color-border: #333333;
		--color-danger: #ff7675;
		--color-on-badge: #ffffff;
	}
}

body {
	margin: 0;
	font-family: system-ui, -apple-system, "Noto Sans TC", sans-serif;
	background: var(--color-bg);
	color: var(--color-text);
}

a {
	color: var(--color-action);
}

/* tab bar 是 position: fixed，會蓋住內容的最後一行。這裡補回等高的空間，
   加上「＋」凸出 tab bar 上緣的那一截（規格 §4.4）——少算那一截，
   最後一列內容的中間會被「＋」的圓蓋住。 */
.app-main {
	padding: 0 var(--space-3)
		calc(
			var(--tab-bar-height) + var(--safe-bottom) + var(--add-button-overhang) +
				var(--space-3)
		);
}
```

> `--shadow-raised` 裡有 `rgb(`。「不寫色碼」那條測試**只掃 `*.module.css`**，`index.css` 本來就是放顏色的地方。

- [ ] **Step 5: 跑測試確認通過**

```
npx vitest run tests/css-tokens.test.ts
```

Expected：全部 PASS。**如果某一組對比度 FAIL**，代表計畫手算的數字錯了：把那個顏色調深（淺色）或調亮（深色）到通過為止，在回報裡寫下最後的值。**不要降低 4.5 的門檻。**

- [ ] **Step 6: 突變測試**

1. 把深色的 `--color-text-muted` 暫時改成 `#555555` → Expected：「深色：--color-text-muted 在 --color-bg 上至少 4.5:1」與「深色：--color-text-muted 在 --color-surface 上至少 4.5:1」**FAIL**。改回來。
2. 把深色區塊裡的 `--color-danger` 那一行暫時刪掉 → Expected：「深色模式覆寫了每一個顏色變數」**FAIL**（加上深色 danger 的兩條對比度）。改回來。
3. 建一個暫時的 `src/components/Tmp.module.css`，內容 `.x { color: #fff; }` → Expected：「元件的 module CSS 不寫色碼」**FAIL**。刪掉它。

- [ ] **Step 7: 建立 `Card`**

Create `frontend/src/components/Card.module.css`：

```css
.card {
	background: var(--color-surface);
	border-radius: var(--radius-card);
	padding: var(--space-3) var(--space-4);
	margin: var(--space-2) 0;
}
```

Create `frontend/src/components/Card.tsx`：

```tsx
import type { ReactNode } from "react";
import styles from "./Card.module.css";

type Props = {
	children: ReactNode;
	/** 給測試定位用；卡片本身沒有語意角色。 */
	testId?: string;
};

/** 圓角卡片（規格 §4.1）。只負責外觀，不帶任何語意——需要標題或清單
 *  語意的地方，由呼叫端在裡面放 `<h2>`、`<ul>`。 */
export function Card({ children, testId }: Props) {
	return (
		<div className={styles.card} data-testid={testId}>
			{children}
		</div>
	);
}
```

> `Card` 沒有自己的測試：它沒有行為只有外觀，而 jsdom 不算版面。之後每個畫面的測試都會間接渲染到它。

- [ ] **Step 8: 靜態檢查與全部測試**

```
npm run -s typecheck
npm run -s lint
npm run -s test
```

Expected：全部通過。**`lint` 可能會報 `index.css`**（Biome 也 lint CSS）：排版問題就 `npx biome check --write src/index.css` 並回報；規則問題（不認得某個寫法）就停下來回報。

- [ ] **Step 9: Commit**

```
feat(ui): 設計變數、深色模式、lucide-react 與 Card

設計變數放在 index.css，深色模式只覆寫同一組名字；元件的 module CSS
只能引用變數。css-tokens.test.ts 用原始碼掃描守三件事：深色模式覆寫了
每一個顏色、每組文字/底色至少 4.5:1、module CSS 不寫色碼。

珊瑚橘拆成 accent（裝飾）與 action（按鈕、連結）：白字在 #ff7a59 上只有
約 2.6:1。text-muted 從 #777 改成 #6b6b6b（#777 在白底是 4.48:1）。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

```bash
git add frontend/package.json frontend/package-lock.json frontend/src/index.css frontend/tests/css-tokens.test.ts frontend/src/components/Card.tsx frontend/src/components/Card.module.css
```

---

## Task 3：資料 hooks、分類與餐別的圖示

**Files:**
- Create: `frontend/src/api/stats.ts`
- Create: `frontend/src/api/meals.ts`
- Modify: `frontend/src/api/expenses.ts`（`CATEGORY_COLORS`、`CATEGORY_ICONS`、`useExpensesByDate`）
- Modify: `frontend/src/api/queries.ts`（`expensesByDate`）
- Modify: `frontend/src/screens/Today.tsx`、`frontend/src/screens/Trend.tsx`（改用 `useDailyStats`）
- Modify: `frontend/src/screens/MealList.tsx`（改用 `useTodayMeals` 與 `MEAL_TYPE_LABELS`）
- Create: `frontend/src/components/IconBadge.tsx`、`frontend/src/components/IconBadge.module.css`
- Test: `frontend/tests/queries.test.tsx`、`frontend/tests/icon-badge.test.tsx`（新）

**為什麼要抽 `useDailyStats` / `useTodayMeals`：** 總覽是 `dailyStats` 的第三個、`meals` 的第二個使用者。同一個 query key 在好幾個檔案裡各寫一份 `queryFn`，哪天其中一份改了，快取裡的資料形狀就看誰先掛載——那種 bug 只在特定的導覽順序下出現。

- [ ] **Step 1: 寫失敗的測試**

加到 `frontend/tests/queries.test.tsx` 既有的 `describe("花費的 query key", …)` 裡面：

```ts
	it("expensesByDate 也掛在 expensesAll 底下", () => {
		// 總覽的「今天的支出」要在記帳、記一餐、改刪之後一起重取。
		// 那些地方都只失效 expensesAll——前綴不對的話，總覽會停在舊資料。
		const prefix = queryKeys.expensesAll;
		expect(
			queryKeys.expensesByDate("2026-12-15").slice(0, prefix.length),
		).toEqual([...prefix]);
	});
```

Create `frontend/tests/icon-badge.test.tsx`：

```tsx
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CATEGORY_COLORS } from "../src/api/expenses";
import { CategoryIcon, MealTypeIcon } from "../src/components/IconBadge";

describe("IconBadge", () => {
	it("分類圖示：圖示對螢幕閱讀器隱藏，底色是那個分類的顏色", () => {
		const { container } = render(<CategoryIcon category="transport" />);

		const svg = container.querySelector("svg");
		expect(svg).not.toBeNull();
		// 圖示旁邊一定有文字標籤；圖示本身要隱藏，不然螢幕閱讀器會念兩次
		// （或念出一個沒意義的 SVG 名稱）。
		expect(svg).toHaveAttribute("aria-hidden", "true");
		expect(container.firstElementChild).toHaveStyle({
			backgroundColor: CATEGORY_COLORS.transport,
		});
	});

	it("餐別圖示用飲食分類的顏色", () => {
		const { container } = render(<MealTypeIcon mealType="lunch" />);

		expect(container.firstElementChild).toHaveStyle({
			backgroundColor: CATEGORY_COLORS.food,
		});
	});

	it("每個分類的顏色都不一樣", () => {
		// 複製貼上一列忘了改顏色，畫面上兩個分類就分不出來——型別擋不住這個。
		const colors = Object.values(CATEGORY_COLORS);
		expect(new Set(colors).size).toBe(colors.length);
	});
});
```

- [ ] **Step 2: 跑測試確認它失敗**

```
cd frontend
npx vitest run tests/queries.test.tsx tests/icon-badge.test.tsx
```

Expected：`queries.test.tsx` 的新條目 FAIL（`expensesByDate` 不存在——型別錯誤或 `is not a function`）；`icon-badge.test.tsx` 整個檔案 FAIL（找不到模組）。**照實回報是哪一種失敗。**

- [ ] **Step 3: 加 query key**

`frontend/src/api/queries.ts` 的 `queryKeys` 裡，`expensesAll` **之後**加：

```ts
	/** 某一天的支出（總覽的時間線）。`date` 是後端 `GET /api/stats/daily`
	 *  回的 `"YYYY-MM-DD"`——前端不自己算今天是哪天；`null` 代表還不知道
	 *  （query 不會發出，見 `useExpensesByDate`）。
	 *
	 *  **掛在 `["expenses"]` 底下**：記帳、記一餐、報表改刪之後都只失效
	 *  `expensesAll`，前綴比對會一起打到它。 */
	expensesByDate: (date: string | null) =>
		["expenses", "day", date] as const,
```

- [ ] **Step 4: 建 `api/stats.ts`**

Create `frontend/src/api/stats.ts`：

```ts
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "./client";
import { queryKeys } from "./queries";
import type { components } from "./schema";

export type DailyStats = components["schemas"]["DailyStatsResponse"];

/** 今天的營養素統計。**不帶 `date`**：後端用使用者時區的今天
 *  （`app/days.py` 的 `today_in_timezone`）。
 *
 *  原本 `Today.tsx` 與 `Trend.tsx` 各寫一份一模一樣的 `useQuery`；總覽是
 *  第三個使用者，所以抽出來——同一個 key 有好幾份 `queryFn`，哪天其中
 *  一份改了，快取裡的資料形狀就看哪個畫面先掛載。
 *
 *  回應裡的 `date` 是後端算好的「使用者時區的今天」：趨勢頁拿它當區間
 *  終點、總覽拿它查今天的支出——兩者都不自己算日界線。 */
export function useDailyStats() {
	return useQuery({
		queryKey: queryKeys.dailyStats,
		queryFn: () => apiFetch<DailyStats>("/api/stats/daily"),
	});
}
```

在 `Today.tsx` 與 `Trend.tsx` 裡，把各自的 `useQuery({ queryKey: queryKeys.dailyStats, queryFn: … })` 換成 `useDailyStats()`，`DailyStats` 型別改從 `../api/stats` 匯入。**兩個檔案原本 `queryFn` 前面的註解（為什麼不傳 date）保留，搬到呼叫 `useDailyStats()` 的那一行上面。** 改完後沒用到的 import（`useQuery`、`components` 等）讓 typecheck／lint 告訴你，刪掉。

> 如果其中一個檔案的 `queryFn` 跟上面的不完全一樣（例如帶了參數），**停下來回報**，不要合併。

- [ ] **Step 5: 建 `api/meals.ts`**

Create `frontend/src/api/meals.ts`：

```ts
import { useQuery } from "@tanstack/react-query";
import { Coffee, Cookie, type LucideIcon, Moon, Sun } from "lucide-react";
import { apiFetch } from "./client";
import { queryKeys } from "./queries";
import type { components } from "./schema";

export type Meal = components["schemas"]["MealResponse"];
export type MealType = components["schemas"]["MealType"];

/** 餐別的中文標籤。`Record` 不是 `Partial`：後端加餐別時漏一個就是編譯錯誤。 */
export const MEAL_TYPE_LABELS: Record<MealType, string> = {
	breakfast: "早餐",
	lunch: "午餐",
	dinner: "晚餐",
	snack: "點心",
};

/** 餐別的圖示（規格 §4.2）。顏色一律用飲食分類的橘色，見 `MealTypeIcon`。 */
export const MEAL_TYPE_ICONS: Record<MealType, LucideIcon> = {
	breakfast: Coffee,
	lunch: Sun,
	dinner: Moon,
	snack: Cookie,
};

/** 今天的餐。**不帶 `date`**：後端用使用者時區的今天。
 *
 *  `MealList` 與總覽共用同一份快取（`queryKeys.meals`）——記一餐之後
 *  `LogMeal` 失效那個 key，兩個畫面一起更新。 */
export function useTodayMeals() {
	return useQuery({
		queryKey: queryKeys.meals,
		queryFn: () => apiFetch<Meal[]>("/api/meals"),
	});
}
```

在 `MealList.tsx` 裡：刪掉檔案裡自己的 `MEAL_TYPE_LABELS` 與 `Meal` / `MealType` 型別別名，改從 `../api/meals` 匯入 `MEAL_TYPE_LABELS`、`type Meal`；`MealList()` 裡的 `useQuery({ queryKey: queryKeys.meals, … })` 換成 `useTodayMeals()`。**`MealList()` 上方那段「不帶 date 參數」的 docstring 保留。** 沒用到的 import 刪掉。

- [ ] **Step 6: 分類的顏色、圖示與「某一天的支出」**

`frontend/src/api/expenses.ts`：

imports 加上：

```ts
import {
	Bus,
	Ellipsis,
	Gamepad2,
	House,
	type LucideIcon,
	Pill,
	ShoppingBag,
	Utensils,
} from "lucide-react";
```

在 `CATEGORY_ORDER` **之後**加：

```ts
/** 分類的顏色（規格 §4.2）。`Record` 不是 `Partial`，理由同 `CATEGORY_LABELS`。
 *
 *  **色碼寫在這裡、不寫在 CSS 變數**：這是「資料」（每個分類一個固定的
 *  識別色），不是主題——深淺色模式都一樣。`IconBadge` 用 inline style 套上。
 *
 *  白色圖示壓在這些顏色上的對比度大多不到 3:1，**這是刻意接受的**：
 *  徽章旁邊一定有文字標籤，圖示是裝飾（`aria-hidden`），不是唯一的資訊來源。 */
export const CATEGORY_COLORS: Record<ExpenseCategory, string> = {
	food: "#ff9f43",
	transport: "#54a0ff",
	daily: "#1dd1a1",
	entertainment: "#a29bfe",
	medical: "#ff6b6b",
	housing: "#feca57",
	other: "#8395a7",
};

/** 分類的圖示。名稱以 lucide-react 1.49 實際匯出的為準（`PieChart` 這種
 *  舊名已經不存在了——寫計畫時解開套件確認過）。 */
export const CATEGORY_ICONS: Record<ExpenseCategory, LucideIcon> = {
	food: Utensils,
	transport: Bus,
	daily: ShoppingBag,
	entertainment: Gamepad2,
	medical: Pill,
	housing: House,
	other: Ellipsis,
};
```

在檔尾加：

```ts
/** 某一天的支出。`date` 由呼叫端從 `useDailyStats()` 的回應拿——
 *  **前端不自己算今天**。`null` 時不發請求（`enabled: false`）。
 *
 *  注意：`enabled: false` 的 query 在 TanStack Query v5 是
 *  `isPending: true`。呼叫端要自己處理「拿不到 date」的情況（例如
 *  `stats/daily` 失敗），不然畫面會永遠停在「載入中」。 */
export function useExpensesByDate(date: string | null) {
	return useQuery({
		queryKey: queryKeys.expensesByDate(date),
		queryFn: () => apiFetch<Expense[]>(`/api/expenses?date=${date}`),
		enabled: date !== null,
	});
}
```

- [ ] **Step 7: 建 `IconBadge`**

Create `frontend/src/components/IconBadge.module.css`：

```css
.small,
.large {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	border-radius: 50%;
	color: var(--color-on-badge);
	flex-shrink: 0;
}

.small {
	width: 28px;
	height: 28px;
}

.large {
	width: 44px;
	height: 44px;
}
```

Create `frontend/src/components/IconBadge.tsx`：

```tsx
import type { LucideIcon } from "lucide-react";
import {
	CATEGORY_COLORS,
	CATEGORY_ICONS,
	type ExpenseCategory,
} from "../api/expenses";
import { MEAL_TYPE_ICONS, type MealType } from "../api/meals";
import styles from "./IconBadge.module.css";

type Size = "small" | "large";

type Props = {
	icon: LucideIcon;
	/** 任何 CSS 顏色：分類色（`CATEGORY_COLORS`）或 `var(--color-action)`。 */
	color: string;
	size?: Size;
};

/** 彩色圓形＋白色圖示（規格 §5.1）。**圖示一律 `aria-hidden`**：
 *  呼叫端一定要在旁邊放文字標籤，徽章本身不是資訊來源。 */
export function IconBadge({ icon: Icon, color, size = "small" }: Props) {
	return (
		<span
			className={size === "large" ? styles.large : styles.small}
			style={{ backgroundColor: color }}
		>
			<Icon aria-hidden="true" size={size === "large" ? 22 : 16} />
		</span>
	);
}

export function CategoryIcon({
	category,
	size,
}: {
	category: ExpenseCategory;
	size?: Size;
}) {
	return (
		<IconBadge
			icon={CATEGORY_ICONS[category]}
			color={CATEGORY_COLORS[category]}
			size={size}
		/>
	);
}

/** 餐別圖示。顏色用飲食分類的橘色——時間線上一眼看出「這一列是吃的」。 */
export function MealTypeIcon({
	mealType,
	size,
}: {
	mealType: MealType;
	size?: Size;
}) {
	return (
		<IconBadge
			icon={MEAL_TYPE_ICONS[mealType]}
			color={CATEGORY_COLORS.food}
			size={size}
		/>
	);
}
```

> lucide 的圖示預設 `stroke="currentColor"`，所以白色來自 `.small` / `.large` 的 `color: var(--color-on-badge)`，不需要在這裡傳 `color`。

- [ ] **Step 8: 跑測試確認通過**

```
npx vitest run tests/queries.test.tsx tests/icon-badge.test.tsx tests/today.test.tsx tests/trend.test.tsx tests/meal-list.test.tsx
```

Expected：全部 PASS。後三個是這次重構碰到的既有測試，**應該不需要改任何一條**——需要改的話停下來回報。

- [ ] **Step 9: 突變測試**

1. 把 `expensesByDate` 暫時改成 `["expense-day", date] as const` → Expected：「expensesByDate 也掛在 expensesAll 底下」**FAIL**。改回來。
2. 把 `CATEGORY_COLORS.other` 暫時改成 `"#ff9f43"`（跟 food 一樣）→ Expected：「每個分類的顏色都不一樣」**FAIL**。改回來。

- [ ] **Step 10: 靜態檢查與全部測試**

```
npm run -s typecheck
npm run -s lint
npm run -s test
```

Expected：全部通過。

- [ ] **Step 11: Commit**

```
refactor(api): 抽出 useDailyStats、useTodayMeals，加上分類與餐別的圖示

總覽是 dailyStats 的第三個、meals 的第二個使用者。同一個 query key 在
好幾個檔案各寫一份 queryFn，哪天其中一份改了，快取的資料形狀就看哪個
畫面先掛載。

CATEGORY_COLORS／CATEGORY_ICONS 跟 CATEGORY_LABELS 一樣是 Record：後端加
分類時漏了顏色或圖示會編譯失敗。新增 expensesByDate，掛在 ["expenses"]
底下，既有的 expensesAll 失效會一起打到它。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

```bash
git add frontend/src/api/stats.ts frontend/src/api/meals.ts frontend/src/api/expenses.ts frontend/src/api/queries.ts frontend/src/screens/Today.tsx frontend/src/screens/Trend.tsx frontend/src/screens/MealList.tsx frontend/src/components/IconBadge.tsx frontend/src/components/IconBadge.module.css frontend/tests/queries.test.tsx frontend/tests/icon-badge.test.tsx
```

---

## Task 4：數字鍵盤

**Files:**
- Create: `frontend/src/lib/keypad.ts`
- Modify: `frontend/src/lib/decimal.ts`（`isPositiveAmount`）
- Create: `frontend/src/components/MoneyKeypad.tsx`、`frontend/src/components/MoneyKeypad.module.css`
- Test: `frontend/tests/keypad.test.ts`（新）、`frontend/tests/decimal.test.ts`、`frontend/tests/money-keypad.test.tsx`（新）

**規則全部放在純函式裡**（規格 §5.1）：元件只負責畫按鈕、把按鍵交給 `applyKey`。這樣每一條規則都能不渲染畫面就測。

- [ ] **Step 1: 寫失敗的測試（純函式）**

Create `frontend/tests/keypad.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { applyKey, type KeypadKey, normalizeAmount } from "../src/lib/keypad";

function press(keys: readonly KeypadKey[], start = ""): string {
	return keys.reduce<string>((current, key) => applyKey(current, key), start);
}

describe("applyKey", () => {
	it("數字依序接上", () => {
		expect(press(["1", "2", "3"])).toBe("123");
	});

	it("只能有一個小數點", () => {
		expect(press(["1", ".", "5", "."])).toBe("1.5");
	});

	it("小數最多兩位，第三位直接忽略", () => {
		expect(press(["1", ".", "2", "3", "4"])).toBe("1.23");
	});

	it("整數最多 8 位（後端 numeric(10,2)）", () => {
		expect(press(["1", "2", "3", "4", "5", "6", "7", "8", "9"])).toBe(
			"12345678",
		);
	});

	it("整數滿 8 位之後仍然可以打小數", () => {
		expect(
			press(["1", "2", "3", "4", "5", "6", "7", "8", ".", "9", "9"]),
		).toBe("12345678.99");
	});

	it("開頭的 0 會被取代，不會出現 007", () => {
		expect(press(["0", "0", "7"])).toBe("7");
	});

	it("0.5 是合法的", () => {
		expect(press(["0", ".", "5"])).toBe("0.5");
	});

	it("空字串時按小數點變成 0.", () => {
		expect(press(["."])).toBe("0.");
	});

	it("刪除鍵刪最後一個字元", () => {
		expect(press(["1", "2", "backspace"])).toBe("1");
	});

	it("空字串時按刪除不做事", () => {
		expect(press(["backspace"])).toBe("");
	});
});

describe("normalizeAmount", () => {
	it("去掉結尾的小數點", () => {
		// 鍵盤允許打出 "5."（使用者正要打小數），但送出時不該帶著它。
		expect(normalizeAmount("5.")).toBe("5");
	});

	it("其他情況原樣回傳", () => {
		expect(normalizeAmount("5.5")).toBe("5.5");
		expect(normalizeAmount("")).toBe("");
	});
});
```

加到 `frontend/tests/decimal.test.ts` 檔尾（**先把 `isPositiveAmount` 加進檔案頂端的 import**）：

```ts
describe("isPositiveAmount", () => {
	it.each(["", "0", "0.", "0.00", "abc", "-1"])(
		"%s 不是正數（也不丟例外）",
		(value) => {
			// 鍵盤打到一半的字串是常態，不是錯誤——✓ 按鈕每次重繪都會問一次。
			expect(isPositiveAmount(value)).toBe(false);
		},
	);

	it.each(["0.01", "5.", "12345678.99"])("%s 是正數", (value) => {
		expect(isPositiveAmount(value)).toBe(true);
	});
});
```

- [ ] **Step 2: 跑測試確認它失敗**

```
npx vitest run tests/keypad.test.ts tests/decimal.test.ts
```

Expected：`keypad.test.ts` 整個檔案 FAIL（找不到模組）；`decimal.test.ts` 的 `isPositiveAmount` 條目 FAIL（型別錯誤加 `is not a function`），既有條目 PASS。

- [ ] **Step 3: 實作純函式**

Create `frontend/src/lib/keypad.ts`：

```ts
/** 記帳鍵盤的規則（規格 §5.1）。**純函式，不碰畫面**——每一條規則都在
 *  `tests/keypad.test.ts` 有一條測試。
 *
 *  只有數字、小數點、刪除（使用者選的，沒有加減運算）。 */

export type KeypadKey =
	| "0"
	| "1"
	| "2"
	| "3"
	| "4"
	| "5"
	| "6"
	| "7"
	| "8"
	| "9"
	| "."
	| "backspace";

/** 後端 `amount` 是 `numeric(10,2)`：整數最多 8 位、小數最多 2 位。 */
const MAX_INTEGER_DIGITS = 8;
const MAX_FRACTION_DIGITS = 2;

export function applyKey(current: string, key: KeypadKey): string {
	if (key === "backspace") return current.slice(0, -1);

	if (key === ".") {
		if (current.includes(".")) return current;
		return current === "" ? "0." : `${current}.`;
	}

	const [integerPart = "", fractionPart] = current.split(".");
	if (fractionPart !== undefined) {
		return fractionPart.length >= MAX_FRACTION_DIGITS ? current : current + key;
	}
	// 整數部分只有一個 0 時，新的數字取代它——不會出現 "007"。
	if (integerPart === "0") return key;
	if (integerPart.length >= MAX_INTEGER_DIGITS) return current;
	return current + key;
}

/** 送出前的正規化：去掉結尾的小數點（`"5."` → `"5"`）。 */
export function normalizeAmount(value: string): string {
	return value.endsWith(".") ? value.slice(0, -1) : value;
}
```

在 `frontend/src/lib/decimal.ts` 的 `formatMoney` **之後**加：

```ts
/** 金額字串是否大於 0。空字串、`"0."`、`"abc"` 都回 `false`，**不丟例外**——
 *  記帳鍵盤打到一半的字串是常態，✓ 按鈕每次重繪都會問一次。
 *
 *  放在這裡而不是 `lib/keypad.ts`：判斷「是不是 0」要經過 `Decimal`
 *  （`"0.00"`、`"0."` 用字串比對很容易漏），而只有這個檔案可以 import
 *  decimal.js（`tests/decimal-containment.test.ts`）。 */
export function isPositiveAmount(value: string): boolean {
	if (value.trim() === "") return false;
	try {
		return new Decimal(value).greaterThan(0);
	} catch {
		return false;
	}
}
```

- [ ] **Step 4: 跑測試確認通過**

```
npx vitest run tests/keypad.test.ts tests/decimal.test.ts tests/decimal-containment.test.ts
```

Expected：全部 PASS。**如果 `"5."` 那條失敗**（decimal.js 不接受結尾的小數點），回報——那代表 `isPositiveAmount` 要先 `normalizeAmount` 再判斷，而這個依賴方向要重新想。

- [ ] **Step 5: 寫失敗的測試（元件）**

Create `frontend/tests/money-keypad.test.tsx`：

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { MoneyKeypad } from "../src/components/MoneyKeypad";
import { isPositiveAmount } from "../src/lib/decimal";

/** 鍵盤是受控元件，測試要有人幫它保管 state——跟 AddExpense 的用法一樣。 */
function Harness() {
	const [amount, setAmount] = useState("");
	return (
		<form onSubmit={(event) => event.preventDefault()}>
			<output aria-label="金額">{amount}</output>
			<MoneyKeypad
				value={amount}
				onChange={setAmount}
				submitDisabled={!isPositiveAmount(amount)}
			/>
		</form>
	);
}

describe("MoneyKeypad", () => {
	it("按鍵依序組成金額", async () => {
		render(<Harness />);

		for (const name of ["1", "2", "小數點", "5"]) {
			await userEvent.click(screen.getByRole("button", { name }));
		}

		expect(screen.getByLabelText("金額")).toHaveTextContent("12.5");
	});

	it("刪除鍵刪掉最後一個字", async () => {
		render(<Harness />);

		await userEvent.click(screen.getByRole("button", { name: "1" }));
		await userEvent.click(screen.getByRole("button", { name: "2" }));
		await userEvent.click(screen.getByRole("button", { name: "刪除" }));

		expect(screen.getByLabelText("金額")).toHaveTextContent(/^1$/);
	});

	it("金額是空的時候不能按「記一筆」，打了數字之後才可以", async () => {
		render(<Harness />);

		expect(screen.getByRole("button", { name: "記一筆" })).toBeDisabled();

		await userEvent.click(screen.getByRole("button", { name: "3" }));

		expect(screen.getByRole("button", { name: "記一筆" })).toBeEnabled();
	});

	it("「記一筆」是送出鈕，數字鍵不是", () => {
		// 數字鍵如果是 type="submit"，每按一個數字表單就送出一次。
		render(<Harness />);

		expect(screen.getByRole("button", { name: "記一筆" })).toHaveAttribute(
			"type",
			"submit",
		);
		expect(screen.getByRole("button", { name: "7" })).toHaveAttribute(
			"type",
			"button",
		);
	});
});
```

- [ ] **Step 6: 跑測試確認它失敗**

```
npx vitest run tests/money-keypad.test.tsx
```

Expected：整個檔案 FAIL（找不到 `MoneyKeypad`）。

- [ ] **Step 7: 實作元件**

Create `frontend/src/components/MoneyKeypad.module.css`：

```css
/* 4 欄：數字 3 欄＋右邊一欄放刪除（第 1 列）與記一筆（第 2～4 列）。
   刪除與記一筆是明確擺放的，其他按鍵依 DOM 順序自動填空格。 */
.keypad {
	display: grid;
	grid-template-columns: repeat(4, 1fr);
	gap: var(--space-2);
}

.key {
	min-height: 52px;
	border: none;
	border-radius: var(--radius-button);
	background: var(--color-surface);
	color: var(--color-text);
	font-size: 22px;
	font-variant-numeric: tabular-nums;
	display: flex;
	align-items: center;
	justify-content: center;
}

.backspace {
	grid-column: 4;
	grid-row: 1;
	background: var(--color-accent-soft);
}

.submit {
	grid-column: 4;
	grid-row: 2 / span 3;
	background: var(--color-action);
	color: var(--color-on-action);
}

.submit:disabled {
	opacity: 0.4;
}

.zero {
	grid-column: span 2;
}
```

Create `frontend/src/components/MoneyKeypad.tsx`：

```tsx
import { Check, Delete } from "lucide-react";
import { applyKey, type KeypadKey } from "../lib/keypad";
import styles from "./MoneyKeypad.module.css";

type Props = {
	value: string;
	onChange: (next: string) => void;
	/** ✓ 不能按的條件由呼叫端決定（通常是 `!isPositiveAmount(value)` 或送出中）。 */
	submitDisabled: boolean;
};

const DIGIT_ROWS: ReadonlyArray<ReadonlyArray<KeypadKey>> = [
	["7", "8", "9"],
	["4", "5", "6"],
	["1", "2", "3"],
];

/** 記帳的數字鍵盤（規格 §5.1）。**規則全在 `lib/keypad.ts` 的 `applyKey`**，
 *  這裡只畫按鈕。
 *
 *  「記一筆」是 `type="submit"`：鍵盤要放在呼叫端的 `<form>` 裡，送出由
 *  那個表單的 `onSubmit` 處理（備註欄按 Enter 也會走同一條路）。其他按鍵
 *  一律 `type="button"`，不然每按一個數字表單就送出一次。 */
export function MoneyKeypad({ value, onChange, submitDisabled }: Props) {
	const press = (key: KeypadKey) => onChange(applyKey(value, key));

	return (
		<div className={styles.keypad} role="group" aria-label="數字鍵盤">
			{DIGIT_ROWS.flat().map((digit) => (
				<button
					key={digit}
					type="button"
					className={styles.key}
					onClick={() => press(digit)}
				>
					{digit}
				</button>
			))}
			<button
				type="button"
				aria-label="刪除"
				className={`${styles.key} ${styles.backspace}`}
				onClick={() => press("backspace")}
			>
				<Delete aria-hidden="true" />
			</button>
			<button
				type="submit"
				aria-label="記一筆"
				className={`${styles.key} ${styles.submit}`}
				disabled={submitDisabled}
			>
				<Check aria-hidden="true" />
			</button>
			<button
				type="button"
				aria-label="小數點"
				className={styles.key}
				onClick={() => press(".")}
			>
				.
			</button>
			<button
				type="button"
				className={`${styles.key} ${styles.zero}`}
				onClick={() => press("0")}
			>
				0
			</button>
		</div>
	);
}
```

> DOM 順序是 7 8 9 4 5 6 1 2 3 ⌫ ✓ . 0。刪除與 ✓ 用 `grid-column`／`grid-row` 明確擺放，其他按鍵依序填滿剩下的格子：第 1 列 7 8 9、第 2 列 4 5 6、第 3 列 1 2 3、第 4 列「.」與跨兩欄的「0」。**這要在瀏覽器裡看一次**（jsdom 不算版面）——收尾的人工檢查清單有這一項。

- [ ] **Step 8: 跑測試確認通過**

```
npx vitest run tests/money-keypad.test.tsx tests/keypad.test.ts
```

Expected：全部 PASS。

- [ ] **Step 9: 突變測試**

1. 把 `applyKey` 裡小數位數那一行改成永遠 `current + key` → Expected：「小數最多兩位，第三位直接忽略」**FAIL**。改回來。
2. 把 `if (integerPart === "0") return key;` 刪掉 → Expected：「開頭的 0 會被取代」**FAIL**（得到 `"007"`）。改回來。
3. 把 ✓ 按鈕的 `type="submit"` 改成 `type="button"` → Expected：「「記一筆」是送出鈕，數字鍵不是」**FAIL**。改回來。

- [ ] **Step 10: 靜態檢查與全部測試**

```
npm run -s typecheck
npm run -s lint
npm run -s test
```

- [ ] **Step 11: Commit**

```
feat(ui): 記帳的數字鍵盤

規則全部是純函式（lib/keypad.ts 的 applyKey）：一個小數點、小數最多兩位、
整數最多 8 位（後端 numeric(10,2)）、開頭的 0 被取代、空字串按小數點變
0.。元件只畫按鈕。

isPositiveAmount 放在 lib/decimal.ts：判斷「是不是 0」要經過 Decimal，
而只有那個檔案可以 import decimal.js。打到一半的字串回 false，不丟例外。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

```bash
git add frontend/src/lib/keypad.ts frontend/src/lib/decimal.ts frontend/src/components/MoneyKeypad.tsx frontend/src/components/MoneyKeypad.module.css frontend/tests/keypad.test.ts frontend/tests/decimal.test.ts frontend/tests/money-keypad.test.tsx
```

---

## Task 5：tab bar、「＋」面板、我的、路由與轉址

**Files:**
- Rewrite: `frontend/src/components/TabBar.tsx`；Create: `frontend/src/components/TabBar.module.css`
- Create: `frontend/src/components/AddSheet.tsx`、`frontend/src/components/AddSheet.module.css`
- Create: `frontend/src/screens/Me.tsx`、`frontend/src/screens/Me.module.css`
- Create: `frontend/src/screens/Overview.tsx`（**這個任務只是一個標題**，Task 7 才填內容）
- Modify: `frontend/src/App.tsx`（路由、轉址、移除 `<Nav>`）
- Modify: `frontend/src/index.css`（刪掉 `.tab-bar`、`.tab`、`.tab[aria-current="page"]`）
- Modify: `frontend/src/screens/Today.tsx`（`<h1>` 改成「飲食」）、`frontend/src/screens/Expenses.tsx`（`<h1>` 改成「報表」）
- Test: `frontend/tests/tab-bar.test.tsx`（重寫）、`frontend/tests/me.test.tsx`（新）、`frontend/tests/app.test.tsx`（重寫）

**這個任務結束時的中間狀態**（下一個任務會補上）：`AddSheet` 的「記帳」連到 `/expenses/new`，但那個路由要到 Task 6 才存在——點下去會是空白的 `<main>`。總覽只有標題。這是刻意的：每個任務各自可以測、可以 commit。

### 三個不能弄丟的東西

1. **「重新整理」按鈕搬到「我的」，行為一個字都不能改。** `e2e/auth.spec.ts` 用它測「access token 過期時會自動換票並重送」——它必須是直接 `apiFetch("/api/me")`，**不能**改成 `useMe().refetch()`（`staleTime` 60 秒，按了什麼都不會發生，那條 e2e 卻不會紅）。原本 `<Nav>` 裡那段註解跟著搬過去。
2. **「入口」的測試。** 這個專案三次蓋好後端卻沒有前端入口（handover §6）。「＋」→「記帳」、「＋」→「記一餐」各要有一條拿掉就會紅的測試。
3. **管理員的「審核」入口**從 tab bar 搬到「我的」，原本 `tab-bar.test.tsx` 裡守它的三條測試（看得到／看不到／載入中不閃一下）跟著搬到 `me.test.tsx`。

- [ ] **Step 1: 重寫 `tab-bar.test.tsx`**

整個檔案換成：

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { TabBar } from "../src/components/TabBar";

// 介面改版：TabBar 不再呼叫 useMe()（管理員的「審核」搬到「我的」，
// 見 tests/me.test.tsx），所以不需要 QueryClientProvider 也不需要 mock API。

function renderAt(path: string) {
	return render(
		<MemoryRouter initialEntries={[path]}>
			<TabBar />
		</MemoryRouter>,
	);
}

describe("TabBar", () => {
	it("四個目的地都在，連到對的路由", () => {
		renderAt("/");

		for (const [name, href] of [
			["總覽", "/"],
			["報表", "/reports"],
			["飲食", "/diet"],
			["我的", "/me"],
		] as const) {
			expect(screen.getByRole("link", { name })).toHaveAttribute("href", href);
		}
	});

	it("目前所在的那一格標成 aria-current，別格沒有", () => {
		renderAt("/reports");

		expect(screen.getByRole("link", { name: "報表" })).toHaveAttribute(
			"aria-current",
			"page",
		);
		expect(screen.getByRole("link", { name: "飲食" })).not.toHaveAttribute(
			"aria-current",
		);
	});

	it("在 /diet 時亮的是飲食，不是總覽", () => {
		// 守的是「用 NavLink，不要自己拿 useLocation() 比字串」：
		// "/diet".startsWith("/") 為真，自己比字串的實作會讓總覽也亮起來。
		// （`end` 對根路由那一格在 react-router 8.3.1 是無作用的保險——
		// NavLink 對 to="/" 有內建特例，詳見舊版這個檔案的說明與 TabBar.tsx。）
		renderAt("/diet");

		expect(screen.getByRole("link", { name: "飲食" })).toHaveAttribute(
			"aria-current",
			"page",
		);
		expect(screen.getByRole("link", { name: "總覽" })).not.toHaveAttribute(
			"aria-current",
		);
	});

	it("「新增紀錄」打開面板，裡面有記帳與記一餐兩個入口", async () => {
		// **入口測試。** 這個專案三次蓋好後端卻沒有前端入口（食物、補劑、
		// 記帳——handover §6）。拿掉面板裡任何一個連結，這條會紅。
		renderAt("/");

		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

		await userEvent.click(screen.getByRole("button", { name: "新增紀錄" }));

		const sheet = screen.getByRole("dialog", { name: "新增紀錄" });
		expect(sheet).toBeInTheDocument();
		expect(screen.getByRole("link", { name: "記帳" })).toHaveAttribute(
			"href",
			"/expenses/new",
		);
		expect(screen.getByRole("link", { name: "記一餐" })).toHaveAttribute(
			"href",
			"/meals/new",
		);
	});

	it("按 Esc 關掉面板", async () => {
		renderAt("/");
		await userEvent.click(screen.getByRole("button", { name: "新增紀錄" }));

		await userEvent.keyboard("{Escape}");

		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
	});

	it("按「取消」關掉面板", async () => {
		renderAt("/");
		await userEvent.click(screen.getByRole("button", { name: "新增紀錄" }));

		await userEvent.click(screen.getByRole("button", { name: "取消" }));

		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
	});

	it("點了入口之後面板關掉", async () => {
		// 不關的話，使用者到了記帳畫面，面板還蓋在上面。
		renderAt("/");
		await userEvent.click(screen.getByRole("button", { name: "新增紀錄" }));

		await userEvent.click(screen.getByRole("link", { name: "記帳" }));

		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
	});

	it("面板打開時焦點移到第一個入口", async () => {
		// 鍵盤與螢幕閱讀器的使用者按下「＋」之後，焦點不能留在背後被遮住的按鈕上。
		renderAt("/");

		await userEvent.click(screen.getByRole("button", { name: "新增紀錄" }));

		expect(screen.getByRole("link", { name: "記帳" })).toHaveFocus();
	});
});
```

- [ ] **Step 2: 寫 `me.test.tsx`**

Create `frontend/tests/me.test.tsx`：

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetRefreshStateForTests } from "../src/auth/refresh";
import { clearTokens, setTokens } from "../src/auth/store";
import { Me } from "../src/screens/Me";
import { json, mockApi } from "./helpers/mock-api";

function me(role: "user" | "admin") {
	return {
		id: 1,
		email: "kenny@example.com",
		display_name: "Kenny",
		role,
		timezone: "Asia/Taipei",
	};
}

function wrap(children: ReactNode) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return (
		<QueryClientProvider client={client}>
			<MemoryRouter>{children}</MemoryRouter>
		</QueryClientProvider>
	);
}

beforeEach(() => {
	localStorage.clear();
	clearTokens();
	resetRefreshStateForTests();
	vi.restoreAllMocks();
	setTokens({ access_token: "a", refresh_token: "r" });
});

describe("我的", () => {
	it("顯示帳號的 email", async () => {
		mockApi([{ method: "GET", path: "/api/me", handler: () => json(me("user")) }]);

		render(wrap(<Me onLoggedOut={vi.fn()} />));

		expect(await screen.findByText("kenny@example.com")).toBeInTheDocument();
	});

	it("管理員看得到「審核」入口", async () => {
		// 從 tab bar 的第五格搬過來（介面改版）。前端藏起連結只是可用性，
		// 真正的授權在後端 require_admin。
		mockApi([{ method: "GET", path: "/api/me", handler: () => json(me("admin")) }]);

		render(wrap(<Me onLoggedOut={vi.fn()} />));

		expect(await screen.findByRole("link", { name: "審核" })).toHaveAttribute(
			"href",
			"/admin/revisions",
		);
	});

	it("一般使用者看不到「審核」", async () => {
		mockApi([{ method: "GET", path: "/api/me", handler: () => json(me("user")) }]);

		render(wrap(<Me onLoggedOut={vi.fn()} />));

		// 先等 email 出現，確保 useMe() 已經解析完——否則下面只是在證明
		// 「還沒 fetch 完」，不是「查完之後仍然沒有」。
		await screen.findByText("kenny@example.com");
		expect(screen.queryByRole("link", { name: "審核" })).not.toBeInTheDocument();
	});

	it("useMe 還在載入時看不到「審核」——不要先閃一下再消失", () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(
			() => new Promise(() => {}),
		);

		render(wrap(<Me onLoggedOut={vi.fn()} />));

		expect(screen.queryByRole("link", { name: "審核" })).not.toBeInTheDocument();
	});

	it("「重新整理」直接打 /api/me 並顯示名稱", async () => {
		// 這顆按鈕是 e2e/auth.spec.ts 測「token 過期自動換票」的唯一路徑。
		// 這條測試守的是「它真的會發出一個新的請求」——改成 useMe().refetch()
		// 的話，staleTime 內按下去不會打 API。
		const fetchMock = mockApi([
			{ method: "GET", path: "/api/me", handler: () => json(me("user")) },
		]);
		render(wrap(<Me onLoggedOut={vi.fn()} />));
		await screen.findByText("kenny@example.com");
		const before = fetchMock.mock.calls.length;

		await userEvent.click(screen.getByRole("button", { name: "重新整理" }));

		expect(await screen.findByText("Kenny")).toBeInTheDocument();
		expect(fetchMock.mock.calls.length).toBe(before + 1);
	});

	it("登出之後通知外層", async () => {
		const onLoggedOut = vi.fn();
		mockApi([
			{ method: "GET", path: "/api/me", handler: () => json(me("user")) },
			{
				method: "POST",
				path: "/api/auth/logout",
				handler: () => new Response(null, { status: 204 }),
			},
		]);
		render(wrap(<Me onLoggedOut={onLoggedOut} />));

		await userEvent.click(screen.getByRole("button", { name: "登出" }));

		await waitFor(() => expect(onLoggedOut).toHaveBeenCalled());
	});
});
```

> 已查證（`src/auth/session.ts`）：`logout()` 走 `apiFetch`，有 access token 就會帶上，所以 `mockApi` 的 Authorization 檢查會過；而且它**不管伺服器回什麼都在 `finally` 清掉本地狀態**，所以這條測試對回應的細節不敏感。

- [ ] **Step 3: 重寫 `app.test.tsx`**

整個檔案換成：

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { queryClient } from "../src/api/queries";
import { resetRefreshStateForTests } from "../src/auth/refresh";
import { clearTokens, setTokens } from "../src/auth/store";

const ME = {
	id: 1,
	email: "kenny@example.com",
	display_name: "Kenny",
	role: "user",
	timezone: "Asia/Taipei",
};
const STATS = {
	date: "2026-10-02",
	actual: { kcal: "0.00", protein_g: "0.00", fat_g: "0.00", carb_g: "0.00" },
	target: null,
	ratio: null,
};
const EMPTY_SUMMARY = { month: "2026-10", total: "0.00", by_category: [] };

function jsonResponse(body: unknown) {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

/** App 一掛上去會打好幾個端點（總覽、tab bar 切過去的畫面、我的）。
 *
 *  用子字串依序比對，**更具體的路徑排前面**（`/api/expenses/summary`
 *  在 `/api/expenses` 之前、`/api/meals` 在 `/api/me` 之前）。
 *
 *  **每個端點都回正確的形狀**：舊版「所有請求都回 `[]`」會讓總覽拿到
 *  `[]` 當月報表，`formatMoney(undefined)` 直接把 render 炸掉。 */
function mockBackend() {
	return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
		const url = String(input);
		const method = (init?.method ?? "GET").toUpperCase();
		if (method === "POST" && url.includes("/api/auth/logout")) {
			return new Response(null, { status: 204 });
		}
		// **`/api/meals` 必須在 `/api/me` 之前**："/api/meals".includes("/api/me")
		// 為真——順序反過來，總覽的餐點清單會拿到使用者物件然後當掉。
		if (url.includes("/api/meals")) return jsonResponse([]);
		if (url.includes("/api/me")) return jsonResponse(ME);
		if (url.includes("/api/stats/daily")) return jsonResponse(STATS);
		if (url.includes("/api/expenses/summary")) return jsonResponse(EMPTY_SUMMARY);
		if (url.includes("/api/expenses")) return jsonResponse([]);
		if (url.includes("/api/supplements/today")) return jsonResponse([]);
		throw new Error(`app.test 沒有為這個請求準備回應：${method} ${url}`);
	});
}

beforeEach(() => {
	localStorage.clear();
	clearTokens();
	resetRefreshStateForTests();
	vi.restoreAllMocks();
	// queryClient 是模組層單例，同一個檔案的多個 it() 之間會留存。
	queryClient.clear();
	// App 用 BrowserRouter，路徑來自 jsdom 的 window.location——每一條
	// 測試都從根路徑開始，轉址測試再自己換。
	window.history.replaceState(null, "", "/");
});

describe("App", () => {
	it("沒有 token 時顯示登入畫面", () => {
		render(<App />);
		expect(screen.getByRole("heading", { name: "登入" })).toBeInTheDocument();
	});

	it("有 token 時首頁是總覽", async () => {
		// 介面改版：`/` 從「記一餐」換成「總覽」，記一餐要從「＋」進去
		// （規格 §3.3：這是使用者選了「＋ 先選」的直接代價，不是迴歸）。
		setTokens({ access_token: "a", refresh_token: "r" });
		mockBackend();

		render(<App />);

		expect(
			await screen.findByRole("heading", { name: "總覽" }),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("heading", { name: "登入" }),
		).not.toBeInTheDocument();
	});

	it("舊網址 /today 轉到飲食", async () => {
		// 手機上可能有書籤或 PWA 的舊狀態（規格 §3.3）。
		setTokens({ access_token: "a", refresh_token: "r" });
		mockBackend();
		window.history.replaceState(null, "", "/today");

		render(<App />);

		expect(
			await screen.findByRole("heading", { name: "飲食" }),
		).toBeInTheDocument();
		expect(window.location.pathname).toBe("/diet");
	});

	it("舊網址 /expenses 轉到報表", async () => {
		setTokens({ access_token: "a", refresh_token: "r" });
		mockBackend();
		window.history.replaceState(null, "", "/expenses");

		render(<App />);

		expect(
			await screen.findByRole("heading", { name: "報表" }),
		).toBeInTheDocument();
		expect(window.location.pathname).toBe("/reports");
	});

	it("從「我的」登出之後回到登入畫面", async () => {
		setTokens({ access_token: "a", refresh_token: "r" });
		mockBackend();
		render(<App />);

		await userEvent.click(await screen.findByRole("link", { name: "我的" }));
		await userEvent.click(await screen.findByRole("button", { name: "登出" }));

		expect(
			await screen.findByRole("heading", { name: "登入" }),
		).toBeInTheDocument();
	});
});
```

- [ ] **Step 4: 跑測試確認它失敗**

```
cd frontend
npx vitest run tests/tab-bar.test.tsx tests/me.test.tsx tests/app.test.tsx
```

Expected：
- `tab-bar.test.tsx`：「四個目的地」「aria-current」「在 /diet 時」與五條面板相關的測試 FAIL（現在的 TabBar 是舊的四格、而且需要 QueryClient——可能整個檔案在 render 時就炸掉，照實回報是哪一種）
- `me.test.tsx`：整個檔案 FAIL（找不到 `Me`）
- `app.test.tsx`：「沒有 token」PASS；其他 4 條 FAIL

- [ ] **Step 5: `AddSheet`**

Create `frontend/src/components/AddSheet.module.css`：

```css
.layer {
	position: fixed;
	inset: 0;
	z-index: 20;
	display: flex;
	flex-direction: column;
	justify-content: flex-end;
}

.backdrop {
	position: absolute;
	inset: 0;
	border: none;
	padding: 0;
	background: var(--scrim);
}

.sheet {
	position: relative;
	background: var(--color-surface);
	border-radius: var(--radius-card) var(--radius-card) 0 0;
	padding: var(--space-4) var(--space-4)
		calc(var(--space-4) + var(--safe-bottom));
	display: flex;
	flex-direction: column;
	gap: var(--space-3);
	box-shadow: var(--shadow-raised);
}

.choices {
	display: grid;
	grid-template-columns: 1fr 1fr;
	gap: var(--space-3);
}

.choice {
	display: flex;
	flex-direction: column;
	align-items: center;
	gap: var(--space-2);
	padding: var(--space-4);
	border-radius: var(--radius-card);
	background: var(--color-bg);
	color: var(--color-text);
	text-decoration: none;
	font-weight: 600;
}

.cancel {
	min-height: 44px;
	border: none;
	background: transparent;
	color: var(--color-text-muted);
	font-size: 16px;
}
```

Create `frontend/src/components/AddSheet.tsx`：

```tsx
import { Utensils, Wallet } from "lucide-react";
import { useEffect, useRef } from "react";
import { Link } from "react-router";
import { CATEGORY_COLORS } from "../api/expenses";
import styles from "./AddSheet.module.css";
import { IconBadge } from "./IconBadge";

type Props = { onClose: () => void };

/** 「＋」滑出的面板：記帳或記一餐（規格 §3.1、§5.1）。
 *
 *  三種關法：「取消」、點背景、按 Esc。開著時是 `role="dialog"`＋
 *  `aria-modal`，焦點一打開就移到第一個入口——不然鍵盤使用者的焦點會
 *  留在被遮住的「＋」上。
 *
 *  背景是一顆 `tabIndex={-1}` 的按鈕而不是 `<div onClick>`：Biome 的
 *  a11y 規則不接受沒有鍵盤對應的可點擊 div；鍵盤使用者用 Esc 或「取消」。 */
export function AddSheet({ onClose }: Props) {
	const firstChoice = useRef<HTMLAnchorElement>(null);

	useEffect(() => {
		firstChoice.current?.focus();
	}, []);

	useEffect(() => {
		function closeOnEscape(event: KeyboardEvent) {
			if (event.key === "Escape") onClose();
		}
		window.addEventListener("keydown", closeOnEscape);
		return () => window.removeEventListener("keydown", closeOnEscape);
	}, [onClose]);

	return (
		<div className={styles.layer}>
			<button
				type="button"
				className={styles.backdrop}
				aria-label="關閉"
				tabIndex={-1}
				onClick={onClose}
			/>
			<div
				role="dialog"
				aria-modal="true"
				aria-label="新增紀錄"
				className={styles.sheet}
			>
				<div className={styles.choices}>
					<Link
						ref={firstChoice}
						to="/expenses/new"
						className={styles.choice}
						onClick={onClose}
					>
						<IconBadge icon={Wallet} color="var(--color-action)" size="large" />
						記帳
					</Link>
					<Link to="/meals/new" className={styles.choice} onClick={onClose}>
						<IconBadge
							icon={Utensils}
							color={CATEGORY_COLORS.food}
							size="large"
						/>
						記一餐
					</Link>
				</div>
				<button type="button" className={styles.cancel} onClick={onClose}>
					取消
				</button>
			</div>
		</div>
	);
}
```

- [ ] **Step 6: `TabBar`**

Create `frontend/src/components/TabBar.module.css`：

```css
.bar {
	position: fixed;
	bottom: 0;
	left: 0;
	right: 0;
	z-index: 10;
	display: flex;
	/* 有 home indicator 的機子，最底下一排會被系統的手勢區遮掉一截。 */
	padding-bottom: var(--safe-bottom);
	background: var(--color-surface);
	border-top: 1px solid var(--color-border);
}

.tab {
	flex: 1;
	/* 44px 是可點選區的下限；56 讓圖示加兩個字的標籤不會貼邊。 */
	min-height: var(--tab-bar-height);
	display: flex;
	flex-direction: column;
	align-items: center;
	justify-content: center;
	gap: 2px;
	text-decoration: none;
	color: var(--color-text-muted);
	font-size: 12px;
}

.active {
	color: var(--color-action);
	font-weight: 600;
}

.addSlot {
	flex: 1;
	display: flex;
	justify-content: center;
}

.add {
	width: 52px;
	height: 52px;
	/* 凸出 tab bar 上緣（規格 §4.4）。.app-main 的底部留白有把這一截算進去。 */
	margin-top: calc(-1 * var(--add-button-overhang));
	border: none;
	border-radius: 50%;
	background: var(--color-action);
	color: var(--color-on-action);
	display: flex;
	align-items: center;
	justify-content: center;
	box-shadow: var(--shadow-raised);
}
```

`frontend/src/components/TabBar.tsx` 整個換成：

```tsx
import {
	ChartPie,
	CircleUser,
	LayoutDashboard,
	type LucideIcon,
	Plus,
	Salad,
} from "lucide-react";
import { useState } from "react";
import { NavLink } from "react-router";
import { AddSheet } from "./AddSheet";
import styles from "./TabBar.module.css";

type Tab = { to: string; label: string; icon: LucideIcon; end?: boolean };

/** 底部導覽：總覽｜報表｜＋｜飲食｜我的（介面改版規格 §3.1）。
 *
 *  **用 `NavLink` 而不是 `Link`**：NavLink 自己依目前路由加上
 *  `aria-current="page"`。自己拿 `useLocation()` 比字串的話，「哪一格是
 *  亮的」會退化成只有 class 名稱看得出來的狀態，而 `"/diet".startsWith("/")`
 *  為真——總覽會跟著亮（`tests/tab-bar.test.tsx` 守這件事）。
 *
 *  **`/` 那一格的 `end` 在 react-router 8.3.1 是無作用的保險**：NavLink 對
 *  `to="/"` 有內建特例。留著是因為它精確表達意圖。
 *
 *  **「＋」不是一個路由**，是一顆打開 `AddSheet` 的按鈕。管理員的「審核」
 *  搬到「我的」——tab bar 因此對所有人都是固定的 4＋1 格，320px 寬時每格
 *  64px，圖示加兩個字的標籤放得下。 */
const LEFT_TABS: readonly Tab[] = [
	{ to: "/", label: "總覽", icon: LayoutDashboard, end: true },
	{ to: "/reports", label: "報表", icon: ChartPie },
];

const RIGHT_TABS: readonly Tab[] = [
	{ to: "/diet", label: "飲食", icon: Salad },
	{ to: "/me", label: "我的", icon: CircleUser },
];

function TabLink({ tab }: { tab: Tab }) {
	const Icon = tab.icon;
	return (
		<NavLink
			to={tab.to}
			end={tab.end}
			className={({ isActive }) =>
				isActive ? `${styles.tab} ${styles.active}` : styles.tab
			}
		>
			<Icon aria-hidden="true" size={22} />
			<span>{tab.label}</span>
		</NavLink>
	);
}

export function TabBar() {
	const [sheetOpen, setSheetOpen] = useState(false);

	return (
		<>
			<nav className={styles.bar} aria-label="主要導覽">
				{LEFT_TABS.map((tab) => (
					<TabLink key={tab.to} tab={tab} />
				))}
				<div className={styles.addSlot}>
					<button
						type="button"
						className={styles.add}
						aria-label="新增紀錄"
						aria-haspopup="dialog"
						aria-expanded={sheetOpen}
						onClick={() => setSheetOpen(true)}
					>
						<Plus aria-hidden="true" size={28} />
					</button>
				</div>
				{RIGHT_TABS.map((tab) => (
					<TabLink key={tab.to} tab={tab} />
				))}
			</nav>
			{sheetOpen && <AddSheet onClose={() => setSheetOpen(false)} />}
		</>
	);
}
```

刪掉 `frontend/src/index.css` 裡的 `.tab-bar`、`.tab`、`.tab[aria-current="page"]` 三條規則（連同它們上面的註解）。

- [ ] **Step 7: `Me`**

Create `frontend/src/screens/Me.module.css`：

```css
.email {
	margin: 0;
	font-weight: 600;
}

.secondary {
	min-height: 44px;
	padding: 0 var(--space-4);
	border: 1px solid var(--color-border);
	border-radius: var(--radius-button);
	background: var(--color-surface);
	color: var(--color-text);
	font-size: 16px;
}

.logout {
	width: 100%;
	min-height: 44px;
	margin-top: var(--space-4);
	border: none;
	border-radius: var(--radius-button);
	background: var(--color-surface);
	color: var(--color-danger);
	font-size: 16px;
	font-weight: 600;
}
```

Create `frontend/src/screens/Me.tsx`：

```tsx
import { useState } from "react";
import { Link } from "react-router";
import { apiFetch } from "../api/client";
import { useMe } from "../api/me";
import { logout } from "../auth/session";
import { Card } from "../components/Card";
import styles from "./Me.module.css";

type Props = { onLoggedOut: () => void };

/** 我的：帳號、登出、管理員的審核入口（介面改版規格 §5.7）。 */
export function Me({ onLoggedOut }: Props) {
	const meQuery = useMe();
	const me = meQuery.data;
	// `me?.role` 而不是先判斷 isPending：useMe() 還在載入時 data 是
	// undefined，`undefined?.role === "admin"` 自然是 false——「審核」一開始
	// 就不畫，不會先閃一下再消失。
	const isAdmin = me?.role === "admin";

	// 從原本 App.tsx 的 <Nav> 搬過來，行為一個字都沒改（介面改版 Task 5）。
	//
	// **不要改成 useMe() 的 refetch。** staleTime 是 60 秒，改了之後按下去
	// 什麼都不會發生，而 e2e/auth.spec.ts 那條「access token 過期時會自動
	// 換票並重送」不會紅——它只是不再測到任何東西（P3-A 規格 §8.1）。
	const [displayName, setDisplayName] = useState<string | null>(null);

	return (
		<section>
			<h1>我的</h1>

			<Card>
				{meQuery.isPending ? (
					<p>載入中…</p>
				) : meQuery.isError || me == null ? (
					<p>無法載入帳號資料</p>
				) : (
					<p className={styles.email}>{me.email}</p>
				)}
			</Card>

			{isAdmin && (
				<Card>
					<Link to="/admin/revisions">審核</Link>
				</Card>
			)}

			<Card>
				<button
					type="button"
					className={styles.secondary}
					onClick={async () => {
						const fresh = await apiFetch<{ display_name: string }>("/api/me");
						setDisplayName(fresh?.display_name ?? null);
					}}
				>
					重新整理
				</button>
				{displayName !== null && <p>{displayName}</p>}
			</Card>

			<button
				type="button"
				className={styles.logout}
				onClick={async () => {
					await logout();
					onLoggedOut();
				}}
			>
				登出
			</button>
		</section>
	);
}
```

- [ ] **Step 8: 總覽的佔位**

Create `frontend/src/screens/Overview.tsx`：

```tsx
/** 總覽（介面改版規格 §5.2）。Task 7 才填內容；這個任務只讓 `/` 有東西。 */
export function Overview() {
	return (
		<section>
			<h1>總覽</h1>
		</section>
	);
}
```

- [ ] **Step 9: 路由與轉址**

`frontend/src/App.tsx`：

1. **刪掉整個 `Nav` 元件**（「重新整理」已經搬到 `Me`）以及 `<Nav onLoggedOut={…} />` 那一行；`apiFetch`、`logout` 的 import 沒用到了，刪掉。
2. import 加上 `Navigate`（從 `react-router`）、`Me`、`Overview`（照字母序）。
3. `LogMealRoute` 改成記完導回 `/`，docstring 換成：

```tsx
/** `/meals/new`（介面改版）：記完一餐之後導回總覽。
 *
 *  **導回 `/`，不是留在記一餐**：使用者記完要的是立刻看到「數字變了」——
 *  總覽的今天熱量與時間線。留在原地等於畫面上什麼都沒發生，使用者會以為
 *  沒記進去、再記一次。 */
function LogMealRoute() {
	const navigate = useNavigate();
	return <LogMeal onSaved={() => navigate("/")} />;
}
```

4. `<Routes>` 換成下面這樣（`/foods`、`/foods/new`、`/foods/:id`、`/supplements`、`/admin/revisions` 上面原有的註解保留；`/today`、`/expenses` 舊的註解刪掉，換成這裡的）：

```tsx
						<Routes>
							{/* 介面改版（規格 §3.2）：總覽｜報表｜＋｜飲食｜我的。
								「＋」不是路由，是 TabBar 裡打開 AddSheet 的按鈕。 */}
							<Route path="/" element={<Overview />} />
							<Route path="/reports" element={<Expenses />} />
							<Route path="/diet" element={<Today />} />
							<Route
								path="/me"
								element={<Me onLoggedOut={() => setLoggedIn(false)} />}
							/>
							<Route path="/meals/new" element={<LogMealRoute />} />
							{/* 舊網址轉址（規格 §3.3）：手機上可能有書籤或 PWA 的舊
								狀態。`replace`：上一頁不會回到一個只會再轉走的網址。 */}
							<Route path="/today" element={<Navigate to="/diet" replace />} />
							<Route
								path="/expenses"
								element={<Navigate to="/reports" replace />}
							/>
							<Route path="/trend" element={<Trend />} />
							<Route path="/foods" element={<FoodLibrary />} />
							<Route path="/foods/new" element={<NewFood />} />
							<Route path="/foods/:id" element={<FoodDetail />} />
							<Route path="/supplements" element={<Supplements />} />
							<Route path="/admin/revisions" element={<AdminRevisions />} />
						</Routes>
```

> `/expenses/new`（記帳）在 Task 6 加。

5. 標題：`frontend/src/screens/Today.tsx` 的 `<h1>今日總覽</h1>` 改成 `<h1>飲食</h1>`；`frontend/src/screens/Expenses.tsx` 的 `<h1>記帳</h1>` 改成 `<h1>報表</h1>`。

> `grep -rn "今日總覽\|\"記帳\"" frontend/tests` 看看有沒有既有測試斷言這兩個標題，有的話跟著改並回報。

- [ ] **Step 10: 跑測試確認通過**

```
npx vitest run tests/tab-bar.test.tsx tests/me.test.tsx tests/app.test.tsx tests/today.test.tsx tests/expenses.test.tsx
```

Expected：全部 PASS。`today.test.tsx` 的「有記帳的入口連結」**仍然 PASS**（`Today.tsx` 的 `<Link to="/expenses">記帳</Link>` 還在，Task 9 才拿掉）。

- [ ] **Step 11: 突變測試**

1. 把 `AddSheet` 裡「記帳」的 `<Link>` 整段暫時刪掉 → Expected：「「新增紀錄」打開面板，裡面有記帳與記一餐兩個入口」**FAIL**（以及「點了入口之後面板關掉」「焦點移到第一個入口」）。改回來。
2. 把 `AddSheet` 的 Esc `useEffect` 暫時刪掉 → Expected：「按 Esc 關掉面板」**FAIL**。改回來。
3. 把 `Me` 的「重新整理」改成 `onClick={() => void meQuery.refetch()}`、名稱從 `meQuery.data` 拿 → Expected：「「重新整理」直接打 /api/me 並顯示名稱」**FAIL**（staleTime 內不會發請求）。改回來。
4. 把 `/today` 的 `<Navigate>` 路由暫時刪掉 → Expected：「舊網址 /today 轉到飲食」**FAIL**。改回來。

- [ ] **Step 12: 靜態檢查與全部測試**

```
npm run -s typecheck
npm run -s lint
npm run -s test
```

Expected：全部通過。**如果其他測試檔因為 tab bar 改變而紅**（例如某個測試渲染了 `<App>` 或依賴舊的 tab 名稱），列出來回報，不要自己決定怎麼改。

- [ ] **Step 13: Commit**

```
feat(ui): 新的 tab bar、「＋」面板、我的，舊網址轉址

tab bar 改成 總覽｜報表｜＋｜飲食｜我的（規格 §3.1）。「＋」打開面板選
記帳或記一餐；Esc、取消、點背景都能關，打開時焦點移到第一個入口。

頂端的 <Nav> 移除。「重新整理」原封不動搬到「我的」——它是
e2e/auth.spec.ts 測自動換票的唯一路徑，不能改成 useMe().refetch()。
管理員的「審核」也搬到「我的」，原本守它的三條測試跟著搬。

/today → /diet、/expenses → /reports：手機上可能有書籤或 PWA 的舊狀態。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

```bash
git add frontend/src/components/TabBar.tsx frontend/src/components/TabBar.module.css frontend/src/components/AddSheet.tsx frontend/src/components/AddSheet.module.css frontend/src/screens/Me.tsx frontend/src/screens/Me.module.css frontend/src/screens/Overview.tsx frontend/src/App.tsx frontend/src/index.css frontend/src/screens/Today.tsx frontend/src/screens/Expenses.tsx frontend/tests/tab-bar.test.tsx frontend/tests/me.test.tsx frontend/tests/app.test.tsx
```

---

## Task 6：記帳畫面 `/expenses/new`

**Files:**
- Create: `frontend/src/screens/AddExpense.tsx`、`frontend/src/screens/AddExpense.module.css`
- Modify: `frontend/src/App.tsx`（`/expenses/new` 路由）
- Modify: `frontend/src/screens/Expenses.tsx`（**拿掉新增表單**——新增改走「＋」）
- Test: `frontend/tests/add-expense.test.tsx`（新）、`frontend/tests/expenses.test.tsx`（刪掉三條新增相關的測試）

**搬家的帳要對得上：** `expenses.test.tsx` 裡測新增的三條——「新增一筆花費，送出的 spent_at 帶時區偏移」「金額留空時不送請求」「記一筆之後總額跟著更新」——各自在 `add-expense.test.tsx` 有對應：

| 舊的（刪掉） | 新的（`add-expense.test.tsx`） |
|---|---|
| spent_at 帶時區偏移 | 「送出的金額、分類、時間與備註」 |
| 金額留空時不送請求 | 「金額是 0 時不能送出」（鍵盤讓「空白」變成按鈕停用，不再是送出後才擋） |
| 記一筆之後總額跟著更新 | 「成功後失效 expensesAll 並離開」——報表在另一個畫面了，守的是「失效有發出去」；「失效會打到報表」由 `queries.test.tsx` 的前綴測試守 |

- [ ] **Step 1: 寫失敗的測試**

Create `frontend/tests/add-expense.test.tsx`：

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { queryKeys } from "../src/api/queries";
import { resetRefreshStateForTests } from "../src/auth/refresh";
import { clearTokens, setTokens } from "../src/auth/store";
import { AddExpense } from "../src/screens/AddExpense";
import { json, mockApi } from "./helpers/mock-api";

const SAVED = {
	id: 2,
	amount: "250.50",
	category: "transport",
	spent_at: "2026-12-14T02:00:00+00:00",
	note: null,
	meal_id: null,
};

function renderScreen(onDone = vi.fn()) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const invalidate = vi.spyOn(client, "invalidateQueries");
	render(
		<QueryClientProvider client={client}>
			<AddExpense onDone={onDone} />
		</QueryClientProvider>,
	);
	return { onDone, invalidate };
}

async function pressKeys(...names: string[]) {
	for (const name of names) {
		await userEvent.click(screen.getByRole("button", { name }));
	}
}

function postBody(
	fetchMock: ReturnType<typeof mockApi>,
): Record<string, unknown> | null {
	const call = fetchMock.mock.calls.find(
		([input, init]) =>
			(init?.method ?? "GET").toUpperCase() === "POST" &&
			String(input).includes("/api/expenses"),
	);
	return call === undefined ? null : JSON.parse(String(call[1]?.body));
}

function errorResponse(status: number, code: string) {
	return json(
		{ error: { code, message: "後端訊息", details: {} } },
		status,
	);
}

beforeEach(() => {
	localStorage.clear();
	clearTokens();
	resetRefreshStateForTests();
	vi.restoreAllMocks();
	setTokens({ access_token: "a", refresh_token: "r" });
});

describe("記帳 /expenses/new", () => {
	it("送出的金額、分類、時間與備註", async () => {
		const fetchMock = mockApi([
			{ method: "POST", path: "/api/expenses", handler: () => json(SAVED, 201) },
		]);
		renderScreen();

		await pressKeys("2", "5", "0", "小數點", "5", "0");
		await userEvent.click(screen.getByRole("button", { name: "交通" }));
		await userEvent.click(screen.getByRole("button", { name: "記一筆" }));

		await waitFor(() => expect(postBody(fetchMock)).not.toBeNull());
		const sent = postBody(fetchMock);
		// 金額以字串送出，不經過 Number()（規格 §2.4）。
		expect(sent?.amount).toBe("250.50");
		expect(sent?.category).toBe("transport");
		// **關鍵斷言**：後端是 AwareDatetime，沒有 offset 的時間會 422。
		expect(sent?.spent_at).toMatch(/(Z|[+-]\d{2}:\d{2})$/);
		expect(sent?.note).toBeNull();
	});

	it("結尾的小數點不會被送出", async () => {
		const fetchMock = mockApi([
			{ method: "POST", path: "/api/expenses", handler: () => json(SAVED, 201) },
		]);
		renderScreen();

		await pressKeys("5", "小數點");
		await userEvent.click(screen.getByRole("button", { name: "記一筆" }));

		await waitFor(() => expect(postBody(fetchMock)?.amount).toBe("5"));
	});

	it("金額是 0 時不能送出", async () => {
		const fetchMock = mockApi([]);
		renderScreen();

		await pressKeys("0");

		expect(screen.getByRole("button", { name: "記一筆" })).toBeDisabled();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("預設分類是飲食，點別的分類會換過去", async () => {
		renderScreen();

		expect(screen.getByRole("button", { name: "飲食" })).toHaveAttribute(
			"aria-pressed",
			"true",
		);

		await userEvent.click(screen.getByRole("button", { name: "交通" }));

		expect(screen.getByRole("button", { name: "交通" })).toHaveAttribute(
			"aria-pressed",
			"true",
		);
		expect(screen.getByRole("button", { name: "飲食" })).toHaveAttribute(
			"aria-pressed",
			"false",
		);
	});

	it("成功後失效 expensesAll 並離開", async () => {
		// 報表、總覽的今天支出都掛在 expensesAll 底下（queries.test.tsx 的
		// 前綴測試）。少了這一行，記完一筆回到總覽，數字不會變——
		// 使用者會以為沒記到，再記一次。
		mockApi([
			{ method: "POST", path: "/api/expenses", handler: () => json(SAVED, 201) },
		]);
		const { onDone, invalidate } = renderScreen();

		await pressKeys("1");
		await userEvent.click(screen.getByRole("button", { name: "記一筆" }));

		await waitFor(() => expect(onDone).toHaveBeenCalled());
		expect(invalidate).toHaveBeenCalledWith({
			queryKey: queryKeys.expensesAll,
		});
	});

	it("後端拒絕金額時顯示具體訊息，金額不清掉", async () => {
		mockApi([
			{
				method: "POST",
				path: "/api/expenses",
				handler: () => errorResponse(422, "VALIDATION_ERROR"),
			},
		]);
		const { onDone } = renderScreen();

		await pressKeys("2", "5", "0");
		await userEvent.click(screen.getByRole("button", { name: "記一筆" }));

		expect(await screen.findByRole("alert")).toHaveTextContent(
			"金額格式不對，請輸入大於 0、最多兩位小數的數字",
		);
		expect(screen.getByLabelText("金額")).toHaveTextContent("250");
		expect(onDone).not.toHaveBeenCalled();
	});

	it("其他失敗顯示通用訊息", async () => {
		mockApi([
			{
				method: "POST",
				path: "/api/expenses",
				handler: () => errorResponse(500, "INTERNAL_ERROR"),
			},
		]);
		renderScreen();

		await pressKeys("1");
		await userEvent.click(screen.getByRole("button", { name: "記一筆" }));

		expect(await screen.findByRole("alert")).toHaveTextContent(
			"記帳失敗，請再試一次",
		);
	});

	it("關閉不送任何請求", async () => {
		const fetchMock = mockApi([]);
		const { onDone } = renderScreen();

		await pressKeys("1");
		await userEvent.click(screen.getByRole("button", { name: "關閉" }));

		expect(onDone).toHaveBeenCalled();
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
```

> **`getByRole("button", { name: "飲食" })` 在這個畫面是安全的**：tab bar 的「飲食」是 link 不是 button，而且這個測試沒有渲染 tab bar。
> 但 `getByText("飲食")` 不安全——不要用。

- [ ] **Step 2: 跑測試確認它失敗**

```
cd frontend
npx vitest run tests/add-expense.test.tsx
```

Expected：整個檔案 FAIL（找不到 `AddExpense`）。

- [ ] **Step 3: 實作**

Create `frontend/src/screens/AddExpense.module.css`：

```css
.screen {
	display: flex;
	flex-direction: column;
	gap: var(--space-3);
}

.header {
	display: flex;
	align-items: center;
}

.header h1 {
	flex: 1;
	margin: 0;
	font-size: 18px;
	text-align: center;
}

/* 標題置中：右邊補一個跟關閉鈕等寬的空位。 */
.header::after {
	content: "";
	width: 44px;
}

.close {
	width: 44px;
	height: 44px;
	border: none;
	background: transparent;
	color: var(--color-text);
	display: flex;
	align-items: center;
	justify-content: center;
}

.amount {
	display: block;
	text-align: right;
	font-size: var(--font-size-amount);
	font-weight: 700;
	font-variant-numeric: tabular-nums;
	padding: var(--space-2) 0;
}

.currency {
	font-size: 18px;
	color: var(--color-text-muted);
	margin-right: var(--space-1);
}

.categories {
	border: none;
	padding: 0;
	margin: 0;
}

.categories legend {
	font-size: 12px;
	color: var(--color-text-muted);
	margin-bottom: var(--space-2);
}

.categoryGrid {
	display: grid;
	grid-template-columns: repeat(4, 1fr);
	gap: var(--space-2);
}

.category {
	display: flex;
	flex-direction: column;
	align-items: center;
	gap: var(--space-1);
	min-height: 44px;
	padding: var(--space-1);
	border: none;
	border-radius: var(--radius-button);
	background: transparent;
	color: var(--color-text-muted);
	font-size: 12px;
}

.category[aria-pressed="true"] {
	background: var(--color-accent-soft);
	color: var(--color-text);
	font-weight: 600;
}

.note {
	display: flex;
	flex-direction: column;
	gap: var(--space-1);
	font-size: 12px;
	color: var(--color-text-muted);
}

/* 字級不在這裡設——index.css 的全域規則保證 input ≥ 16px（iOS 自動放大）。 */
.note input {
	padding: var(--space-2) var(--space-3);
	border: 1px solid var(--color-border);
	border-radius: var(--radius-button);
	background: var(--color-surface);
	color: var(--color-text);
}

.error {
	margin: 0;
	color: var(--color-danger);
}
```

Create `frontend/src/screens/AddExpense.tsx`：

```tsx
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";
import { type FormEvent, useState } from "react";
import { apiFetch } from "../api/client";
import { ApiError } from "../api/errors";
import {
	AMOUNT_FORMAT_ERROR,
	CATEGORY_LABELS,
	CATEGORY_ORDER,
	type Expense,
	type ExpenseCategory,
} from "../api/expenses";
import { queryKeys } from "../api/queries";
import { CategoryIcon } from "../components/IconBadge";
import { MoneyKeypad } from "../components/MoneyKeypad";
import { isPositiveAmount } from "../lib/decimal";
import { normalizeAmount } from "../lib/keypad";
import styles from "./AddExpense.module.css";

type Props = {
	/** 送出成功或按關閉之後。路由層決定去哪裡（`App.tsx` 導回 `/`）。 */
	onDone: () => void;
};

/** 記帳（介面改版規格 §5.3）：大字金額、分類圖示格、備註、數字鍵盤。
 *
 *  **時間固定是「現在」**，沒有日期選擇器：`<input type="datetime-local">`
 *  產出沒有時區 offset 的字串，後端的 `AwareDatetime` 會回 422
 *  （P5 計畫二開頭的地雷）。
 *
 *  整個畫面是一個 `<form>`：鍵盤的 ✓ 是 `type="submit"`，備註欄按 Enter
 *  也走同一條 `handleSubmit`。 */
export function AddExpense({ onDone }: Props) {
	const queryClient = useQueryClient();
	const [amount, setAmount] = useState("");
	const [category, setCategory] = useState<ExpenseCategory>("food");
	const [note, setNote] = useState("");
	const [error, setError] = useState<string | null>(null);

	const save = useMutation({
		mutationFn: () =>
			apiFetch<Expense>("/api/expenses", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					// 字串送出，不經過 Number()（規格 §2.4）；"5." 去掉小數點。
					amount: normalizeAmount(amount),
					category,
					// **一律 toISOString()，永遠帶 Z**——見上面的 docstring。
					spent_at: new Date().toISOString(),
					note: note.trim() === "" ? null : note.trim(),
				}),
			}),
		onSuccess: () => {
			// 報表與總覽的今天支出都掛在 expensesAll 底下，一次失效全部打到。
			void queryClient.invalidateQueries({ queryKey: queryKeys.expensesAll });
			onDone();
		},
		onError: (caught: unknown) => {
			// 失敗時金額與分類**不清掉**（規格 §5.3）：使用者修正之後再按一次就好。
			if (caught instanceof ApiError && caught.code === "VALIDATION_ERROR") {
				setError(AMOUNT_FORMAT_ERROR);
				return;
			}
			setError("記帳失敗，請再試一次");
		},
	});

	function handleSubmit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		// ✓ 停用時按 Enter 仍然會觸發 submit——這裡是第二道防線。
		if (!isPositiveAmount(amount) || save.isPending) return;
		setError(null);
		save.mutate();
	}

	return (
		<form className={styles.screen} onSubmit={handleSubmit}>
			<header className={styles.header}>
				<button
					type="button"
					className={styles.close}
					aria-label="關閉"
					onClick={onDone}
				>
					<X aria-hidden="true" />
				</button>
				<h1>記帳</h1>
			</header>

			<output aria-label="金額" className={styles.amount}>
				<span className={styles.currency} aria-hidden="true">
					$
				</span>
				{amount === "" ? "0" : amount}
			</output>

			<fieldset className={styles.categories}>
				<legend>分類</legend>
				<div className={styles.categoryGrid}>
					{CATEGORY_ORDER.map((value) => (
						<button
							key={value}
							type="button"
							className={styles.category}
							aria-pressed={category === value}
							onClick={() => setCategory(value)}
						>
							<CategoryIcon category={value} />
							{CATEGORY_LABELS[value]}
						</button>
					))}
				</div>
			</fieldset>

			<label className={styles.note}>
				備註
				<input
					type="text"
					maxLength={500}
					value={note}
					onChange={(event) => setNote(event.target.value)}
				/>
			</label>

			{error !== null && (
				<p role="alert" className={styles.error}>
					{error}
				</p>
			)}

			<MoneyKeypad
				value={amount}
				onChange={setAmount}
				submitDisabled={!isPositiveAmount(amount) || save.isPending}
			/>
		</form>
	);
}
```

`frontend/src/App.tsx`：

- import `AddExpense`（字母序）。
- 在 `LogMealRoute` 旁邊加：

```tsx
/** `/expenses/new`：記完或關閉都回總覽。 */
function AddExpenseRoute() {
	const navigate = useNavigate();
	return <AddExpense onDone={() => navigate("/")} />;
}
```

- `<Routes>` 裡 `/meals/new` 之前加：

```tsx
							<Route path="/expenses/new" element={<AddExpenseRoute />} />
```

> 路由排名：react-router 依具體程度排，不是宣告順序，`/expenses/new` 與 `/expenses`（轉址）不會互相搶（`App.tsx` 裡 `/foods/new` 那段註解實測過同一件事）。

- [ ] **Step 4: 從報表拿掉新增表單**

`frontend/src/screens/Expenses.tsx` 的 `Expenses()`：

- 刪掉 `amount`、`category`、`note`、`error` 四個 state、`createExpense` 這個 mutation、`handleSubmit`。
- JSX 裡刪掉 `<h2>記一筆</h2>`、它上面的註解、以及整個新增用的 `<form>…</form>`。
- `Expenses()` 的 docstring 裡講「新增」的部分改成「新增改由「＋」→ 記帳（`AddExpense.tsx`）」。
- 沒用到的 import 讓 typecheck／lint 告訴你（預期至少 `CATEGORY_ORDER`、`ExpenseCategory`；`FormEvent`、`ApiError`、`AMOUNT_FORMAT_ERROR`、`useMutation` **仍然被 `ExpenseRow` 用到**，不要刪）。

`frontend/tests/expenses.test.tsx`：刪掉三條——「新增一筆花費，送出的 spent_at 帶時區偏移」「金額留空時不送請求」「記一筆之後總額跟著更新」。刪完之後沒人用的 helper（如果有）一起刪掉。

- [ ] **Step 5: 跑測試確認通過**

```
npx vitest run tests/add-expense.test.tsx tests/expenses.test.tsx
```

Expected：全部 PASS。

- [ ] **Step 6: 突變測試**

1. `spent_at` 暫時改成 `"2026-12-15T12:00:00"` → Expected：「送出的金額、分類、時間與備註」**FAIL**。改回來。
2. 刪掉 `onSuccess` 裡的 `invalidateQueries` → Expected：「成功後失效 expensesAll 並離開」**FAIL**。改回來。
3. 把 `amount: normalizeAmount(amount)` 改成 `amount` → Expected：「結尾的小數點不會被送出」**FAIL**。改回來。

- [ ] **Step 7: 靜態檢查與全部測試**

```
npm run -s typecheck
npm run -s lint
npm run -s test
```

- [ ] **Step 8: Commit**

```
feat(expenses): 記帳畫面改成大字金額、分類圖示格與數字鍵盤

新增從報表搬到「＋」→ 記帳（/expenses/new）。時間固定是現在、一律
toISOString()——沒有日期選擇器，因為 datetime-local 沒有時區 offset，
後端的 AwareDatetime 會回 422。

失敗時金額與分類不清掉。報表的三條新增測試搬到 add-expense.test.tsx；
「記一筆之後總額跟著更新」改成守「失效有發出去」，「失效會打到報表」
由 queries.test.tsx 的前綴測試守。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

```bash
git add frontend/src/screens/AddExpense.tsx frontend/src/screens/AddExpense.module.css frontend/src/App.tsx frontend/src/screens/Expenses.tsx frontend/tests/add-expense.test.tsx frontend/tests/expenses.test.tsx
```

---

## Task 7：總覽 `/`

**Files:**
- Create: `frontend/src/lib/timeline.ts`
- Rewrite: `frontend/src/screens/Overview.tsx`；Create: `frontend/src/screens/Overview.module.css`
- Test: `frontend/tests/timeline.test.ts`（新）、`frontend/tests/overview.test.tsx`（新）

- [ ] **Step 1: 寫失敗的測試（純函式）**

Create `frontend/tests/timeline.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import type { Expense } from "../src/api/expenses";
import type { Meal } from "../src/api/meals";
import { buildTimeline } from "../src/lib/timeline";

function meal(id: number, eatenAt: string): Meal {
	return {
		id,
		eaten_at: eatenAt,
		meal_type: "lunch",
		note: null,
		photo_path: null,
		items: [],
		kcal: "500.00",
		protein_g: "0.00",
		fat_g: "0.00",
		carb_g: "0.00",
	};
}

function expense(
	id: number,
	spentAt: string,
	mealId: number | null = null,
	amount = "100.00",
): Expense {
	return {
		id,
		amount,
		category: mealId === null ? "transport" : "food",
		spent_at: spentAt,
		note: null,
		meal_id: mealId,
	};
}

describe("buildTimeline", () => {
	it("有餐費的那一餐只出現一次，金額併進那一列", () => {
		const rows = buildTimeline(
			[meal(11, "2026-12-15T04:30:00+00:00")],
			[expense(1, "2026-12-15T04:30:00+00:00", 11, "180.00")],
		);

		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ kind: "meal", cost: "180.00" });
	});

	it("對不上今天任何一餐的支出各自一列", () => {
		// 包括 meal_id 有值、但那一餐不在今天清單裡的（跨日的邊界情況）——
		// 錢不能因為對不上就消失。
		const rows = buildTimeline(
			[meal(11, "2026-12-15T04:30:00+00:00")],
			[
				expense(1, "2026-12-15T01:00:00+00:00"),
				expense(2, "2026-12-15T02:00:00+00:00", 99),
			],
		);

		expect(rows.map((row) => row.kind)).toEqual(["meal", "expense", "expense"]);
	});

	it("沒有餐費的餐 cost 是 null", () => {
		const rows = buildTimeline([meal(11, "2026-12-15T04:30:00+00:00")], []);

		expect(rows[0]).toMatchObject({ kind: "meal", cost: null });
	});

	it("由新到舊排序，餐與支出混在一起排", () => {
		const rows = buildTimeline(
			[meal(11, "2026-12-15T03:00:00+00:00")],
			[
				expense(1, "2026-12-15T01:00:00+00:00"),
				expense(2, "2026-12-15T05:00:00+00:00"),
			],
		);

		expect(rows.map((row) => row.key)).toEqual([
			"expense-2",
			"meal-11",
			"expense-1",
		]);
	});

	it("同一餐有兩筆支出時，第二筆單獨一列——不會有錢消失", () => {
		// 現在的後端一餐最多一筆餐費，但這個函式不該靠那個假設才不丟錢。
		const rows = buildTimeline(
			[meal(11, "2026-12-15T04:30:00+00:00")],
			[
				expense(1, "2026-12-15T04:30:00+00:00", 11, "180.00"),
				expense(2, "2026-12-15T04:31:00+00:00", 11, "20.00"),
			],
		);

		expect(rows).toHaveLength(2);
		expect(rows.find((row) => row.kind === "expense")).toMatchObject({
			key: "expense-2",
		});
	});
});
```

> `meal()` 的欄位是照 `MealResponse` 的型別寫的。如果 typecheck 說少了或多了欄位，**以 `schema.d.ts` 為準**補齊並回報。

- [ ] **Step 2: 跑測試確認它失敗**

```
cd frontend
npx vitest run tests/timeline.test.ts
```

Expected：整個檔案 FAIL（找不到模組）。

- [ ] **Step 3: 實作 `buildTimeline`**

Create `frontend/src/lib/timeline.ts`：

```ts
import type { Expense } from "../api/expenses";
import type { Meal } from "../api/meals";

export type TimelineRow =
	| {
			kind: "meal";
			key: string;
			time: string;
			meal: Meal;
			/** 這一餐的餐費（`expenses.meal_id` 指過來的那一筆）；沒有就是 `null`。 */
			cost: string | null;
	  }
	| { kind: "expense"; key: string; time: string; expense: Expense };

/** 總覽的今天時間線（規格 §6.2）：今天的餐與今天的支出排在同一條線上。
 *
 *  1. 支出的 `meal_id` 對得上今天某一餐 → 金額併進那一餐，不另列。
 *     外食記一餐會在後端建「一餐＋一筆指回來的支出」，不併的話同一頓飯
 *     出現兩次。
 *  2. 其他支出各自一列——包括 `meal_id` 有值但那一餐不在清單裡的。
 *     **錢不能因為對不上就消失。**同一餐第二筆支出也照這條規則單獨一列。
 *  3. 依時間由新到舊。這是排序兩個時刻，不是算日界線
 *     （`lib/dates.ts` 頂端那條規矩管的是後者）。 */
export function buildTimeline(
	meals: readonly Meal[],
	expenses: readonly Expense[],
): TimelineRow[] {
	const mealIds = new Set(meals.map((meal) => meal.id));
	const costByMeal = new Map<number, string>();
	const rows: TimelineRow[] = [];

	for (const expense of expenses) {
		if (
			expense.meal_id !== null &&
			mealIds.has(expense.meal_id) &&
			!costByMeal.has(expense.meal_id)
		) {
			costByMeal.set(expense.meal_id, expense.amount);
			continue;
		}
		rows.push({
			kind: "expense",
			key: `expense-${expense.id}`,
			time: expense.spent_at,
			expense,
		});
	}

	for (const meal of meals) {
		rows.push({
			kind: "meal",
			key: `meal-${meal.id}`,
			time: meal.eaten_at,
			meal,
			cost: costByMeal.get(meal.id) ?? null,
		});
	}

	return rows.sort((a, b) => Date.parse(b.time) - Date.parse(a.time));
}
```

- [ ] **Step 4: 跑測試確認通過**

```
npx vitest run tests/timeline.test.ts
```

Expected：全部 PASS。

- [ ] **Step 5: 寫失敗的測試（畫面）**

Create `frontend/tests/overview.test.tsx`：

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetRefreshStateForTests } from "../src/auth/refresh";
import { clearTokens, setTokens } from "../src/auth/store";
import { Overview } from "../src/screens/Overview";
import { json, mockApi, type Route } from "./helpers/mock-api";

function wrap(children: ReactNode) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return (
		<QueryClientProvider client={client}>
			<MemoryRouter>{children}</MemoryRouter>
		</QueryClientProvider>
	);
}

const STATS = {
	date: "2026-12-15",
	actual: {
		kcal: "1240.00",
		protein_g: "50.00",
		fat_g: "40.00",
		carb_g: "150.00",
	},
	target: { kcal: "2000.00", protein_g: null, fat_g: null, carb_g: null },
	ratio: { kcal: "0.62", protein_g: null, fat_g: null, carb_g: null },
};

const SUMMARY = {
	month: "2026-12",
	total: "12480.00",
	by_category: [],
};

const LUNCH = {
	id: 11,
	eaten_at: "2026-12-15T04:30:00+00:00",
	meal_type: "lunch",
	note: null,
	photo_path: null,
	items: [
		{
			id: 1,
			food_id: 1,
			food_name: "滷肉飯",
			portion_id: null,
			quantity: "1",
			quantity_g: "250.00",
			kcal: "620.00",
			protein_g: "18.00",
			fat_g: "22.00",
			carb_g: "82.00",
		},
	],
	kcal: "620.00",
	protein_g: "18.00",
	fat_g: "22.00",
	carb_g: "82.00",
};

const LUNCH_COST = {
	id: 1,
	amount: "180.00",
	category: "food",
	spent_at: "2026-12-15T04:30:00+00:00",
	note: null,
	meal_id: 11,
};

const METRO = {
	id: 2,
	amount: "25.00",
	category: "transport",
	spent_at: "2026-12-15T01:00:00+00:00",
	note: "捷運",
	meal_id: null,
};

/** 預設四個端點都成功；個別測試用 `overrides` 換掉其中一個。
 *  **`/api/expenses/summary` 一定排在 `/api/expenses` 之前**（mock-api 依序
 *  用 `url.includes` 比對）。 */
function mockOverview(overrides: Partial<Record<string, Route["handler"]>> = {}) {
	const handlers: Record<string, Route["handler"]> = {
		"/api/stats/daily": () => json(STATS),
		"/api/expenses/summary": () => json(SUMMARY),
		"/api/expenses": () => json([LUNCH_COST, METRO]),
		"/api/meals": () => json([LUNCH]),
		...overrides,
	};
	return mockApi(
		Object.entries(handlers).flatMap(([path, handler]) =>
			handler === undefined ? [] : [{ method: "GET", path, handler }],
		),
	);
}

function serverError() {
	return json(
		{ error: { code: "INTERNAL_ERROR", message: "壞了", details: {} } },
		500,
	);
}

beforeEach(() => {
	localStorage.clear();
	clearTokens();
	resetRefreshStateForTests();
	vi.restoreAllMocks();
	setTokens({ access_token: "a", refresh_token: "r" });
});

describe("總覽", () => {
	it("顯示本月支出與今天熱量", async () => {
		mockOverview();

		render(wrap(<Overview />));

		const spend = await screen.findByTestId("month-spend");
		expect(await within(spend).findByText("$12480.00")).toBeInTheDocument();
		const kcal = screen.getByTestId("today-kcal");
		expect(await within(kcal).findByText(/1240/)).toBeInTheDocument();
		expect(within(kcal).getByText(/2000/)).toBeInTheDocument();
	});

	it("時間線：有餐費的那一餐只出現一次，支出各自一列，由新到舊", async () => {
		mockOverview();

		render(wrap(<Overview />));

		const rows = await screen.findAllByTestId("timeline-row");
		expect(rows).toHaveLength(2);
		expect(rows[0]).toHaveTextContent("午餐・滷肉飯");
		expect(rows[0]).toHaveTextContent("$180.00");
		expect(rows[1]).toHaveTextContent("捷運");
		expect(rows[1]).toHaveTextContent("$25.00");
	});

	it("今天的支出用後端回的日期去查——前端不自己算今天", async () => {
		const fetchMock = mockOverview();

		render(wrap(<Overview />));
		await screen.findAllByTestId("timeline-row");

		const urls = fetchMock.mock.calls.map(([input]) => String(input));
		expect(urls).toContain("/api/expenses?date=2026-12-15");
	});

	it("月報表失敗時只有那張卡說失敗，時間線照常顯示", async () => {
		mockOverview({ "/api/expenses/summary": serverError });

		render(wrap(<Overview />));

		expect(await screen.findByText("無法載入本月支出")).toBeInTheDocument();
		expect(await screen.findAllByTestId("timeline-row")).toHaveLength(2);
	});

	it("stats 失敗時時間線說失敗，不會永遠停在載入中", async () => {
		// 今天的支出要等 stats 回來才知道日期（enabled 依賴）。stats 失敗時
		// 那個 query 永遠是 pending——沒有特別處理的話，畫面會一直「載入中」。
		mockOverview({ "/api/stats/daily": serverError });

		render(wrap(<Overview />));

		// **只看時間線那一區**：月支出卡在這個時間點可能還在「載入中…」，
		// 用整個畫面的 queryByText 會時紅時綠。
		const timeline = screen.getByRole("region", { name: "今天" });
		expect(
			await within(timeline).findByText("無法載入今天的紀錄"),
		).toBeInTheDocument();
		expect(within(timeline).queryByText("載入中…")).not.toBeInTheDocument();
	});

	it("今天什麼都沒有時講明白", async () => {
		mockOverview({
			"/api/expenses": () => json([]),
			"/api/meals": () => json([]),
		});

		render(wrap(<Overview />));

		expect(await screen.findByText("今天還沒有紀錄")).toBeInTheDocument();
	});
});
```

> 時間線的 `<section aria-labelledby="overview-today">` 有可及名稱「今天」，所以它的角色是 `region`——這條測試靠這個定位。實作時不要把 `aria-labelledby` 拿掉。

- [ ] **Step 6: 跑測試確認它失敗**

```
npx vitest run tests/overview.test.tsx
```

Expected：6 條全部 FAIL（佔位的 `Overview` 只有標題——找不到 `month-spend` 等）。

- [ ] **Step 7: 實作畫面**

Create `frontend/src/screens/Overview.module.css`：

```css
.cards {
	display: grid;
	grid-template-columns: 1fr 1fr;
	gap: var(--space-3);
}

/* 卡片之間的間距由 grid 管，Card 自己的上下 margin 在這裡不需要。 */
.cards > * {
	margin: 0;
}

.label {
	margin: 0 0 var(--space-1);
	font-size: 12px;
	color: var(--color-text-muted);
}

.total {
	margin: 0;
	font-size: var(--font-size-total);
	font-weight: 700;
	font-variant-numeric: tabular-nums;
}

.unit {
	font-size: 12px;
	font-weight: 400;
	color: var(--color-text-muted);
}

.progress {
	width: 100%;
	height: 6px;
	margin-top: var(--space-2);
	accent-color: var(--color-accent);
}

.sectionTitle {
	margin: var(--space-4) 0 0;
	font-size: 14px;
	color: var(--color-text-muted);
}

.timeline {
	list-style: none;
	margin: 0;
	padding: 0;
}

.row {
	display: grid;
	grid-template-columns: auto 1fr auto;
	grid-template-areas:
		"icon title value"
		"icon time value";
	column-gap: var(--space-3);
	align-items: center;
	padding: var(--space-2) 0;
	border-bottom: 1px solid var(--color-border);
}

.row:last-child {
	border-bottom: none;
}

.row > :first-child {
	grid-area: icon;
}

.title {
	grid-area: title;
}

.time {
	grid-area: time;
	font-size: 12px;
	color: var(--color-text-muted);
}

.value {
	grid-area: value;
	font-variant-numeric: tabular-nums;
	font-weight: 600;
}

.notice {
	margin: 0 0 var(--space-3);
	padding: var(--space-3);
	border-radius: var(--radius-card);
	background: var(--color-accent-soft);
	color: var(--color-text);
}
```

`frontend/src/screens/Overview.tsx` 整個換成：

```tsx
import type { ReactNode } from "react";
import {
	CATEGORY_LABELS,
	useExpenseSummary,
	useExpensesByDate,
} from "../api/expenses";
import { MEAL_TYPE_LABELS, useTodayMeals } from "../api/meals";
import { useDailyStats } from "../api/stats";
import { Card } from "../components/Card";
import { CategoryIcon, MealTypeIcon } from "../components/IconBadge";
import { formatTime } from "../lib/dates";
import { formatMacro, formatMoney, ratioOf } from "../lib/decimal";
import { buildTimeline, type TimelineRow } from "../lib/timeline";
import styles from "./Overview.module.css";

function MonthSpendCard() {
	const summaryQuery = useExpenseSummary(null);
	const summary = summaryQuery.data;

	return (
		<Card testId="month-spend">
			<p className={styles.label}>本月支出</p>
			{summaryQuery.isPending ? (
				<p>載入中…</p>
			) : summaryQuery.isError || summary == null ? (
				<p>無法載入本月支出</p>
			) : (
				<p className={styles.total}>${formatMoney(summary.total)}</p>
			)}
		</Card>
	);
}

function TodayKcalCard() {
	const statsQuery = useDailyStats();
	const stats = statsQuery.data;

	if (statsQuery.isPending) {
		return (
			<Card testId="today-kcal">
				<p className={styles.label}>今天熱量</p>
				<p>載入中…</p>
			</Card>
		);
	}
	if (statsQuery.isError || stats == null) {
		return (
			<Card testId="today-kcal">
				<p className={styles.label}>今天熱量</p>
				<p>無法載入今天的熱量</p>
			</Card>
		);
	}

	// 兩層 null（沿用 MacroBar 的語意）：`target` 整個是 null＝今天沒有目標；
	// `target.kcal` 是 null＝有目標但熱量沒設。兩種都只顯示數字、不畫進度條。
	const target = stats.target?.kcal ?? null;
	const ratio = ratioOf(stats.actual.kcal, target);

	return (
		<Card testId="today-kcal">
			<p className={styles.label}>今天熱量</p>
			<p className={styles.total}>
				{formatMacro(stats.actual.kcal)}
				<span className={styles.unit}>
					{target === null ? " kcal" : ` / ${formatMacro(target)} kcal`}
				</span>
			</p>
			{ratio !== null && (
				<progress
					className={styles.progress}
					max={1}
					value={Math.min(ratio, 1)}
					aria-label="熱量進度"
				/>
			)}
		</Card>
	);
}

function TimelineItem({ row }: { row: TimelineRow }) {
	if (row.kind === "meal") {
		const foods = row.meal.items.map((item) => item.food_name).join("、");
		return (
			<li className={styles.row} data-testid="timeline-row">
				<MealTypeIcon mealType={row.meal.meal_type} />
				<span className={styles.title}>
					{MEAL_TYPE_LABELS[row.meal.meal_type]}・
					{foods === "" ? "（沒有項目）" : foods}
				</span>
				<span className={styles.time}>{formatTime(row.time)}</span>
				<span className={styles.value}>
					{row.cost !== null
						? `$${formatMoney(row.cost)}`
						: `${formatMacro(row.meal.kcal)} kcal`}
				</span>
			</li>
		);
	}

	const { expense } = row;
	return (
		<li className={styles.row} data-testid="timeline-row">
			<CategoryIcon category={expense.category} />
			<span className={styles.title}>
				{expense.note ?? CATEGORY_LABELS[expense.category]}
			</span>
			<span className={styles.time}>{formatTime(row.time)}</span>
			<span className={styles.value}>${formatMoney(expense.amount)}</span>
		</li>
	);
}

/** 今天的時間線（規格 §5.2、§6.2）。
 *
 *  **今天的支出要等 `stats/daily` 回來才知道日期**（前端不自己算今天）。
 *  `useExpensesByDate(null)` 是 `enabled: false`，在 TanStack Query v5
 *  的狀態是 `isPending`——所以 stats 失敗時要**先**判斷錯誤，否則畫面會
 *  永遠停在「載入中」。`stats` 回 `null`（204，理論上不會）也當成失敗。 */
function TodayTimeline() {
	const statsQuery = useDailyStats();
	const mealsQuery = useTodayMeals();
	const today = statsQuery.data?.date ?? null;
	const expensesQuery = useExpensesByDate(today);

	const statsUnusable =
		statsQuery.isError || (statsQuery.isSuccess && statsQuery.data === null);

	let body: ReactNode;
	if (statsUnusable || mealsQuery.isError || expensesQuery.isError) {
		body = <p>無法載入今天的紀錄</p>;
	} else if (mealsQuery.isPending || expensesQuery.isPending) {
		body = <p>載入中…</p>;
	} else {
		const rows = buildTimeline(mealsQuery.data ?? [], expensesQuery.data ?? []);
		body =
			rows.length === 0 ? (
				<p>今天還沒有紀錄</p>
			) : (
				<ul className={styles.timeline}>
					{rows.map((row) => (
						<TimelineItem key={row.key} row={row} />
					))}
				</ul>
			);
	}

	return (
		<section aria-labelledby="overview-today">
			<h2 id="overview-today" className={styles.sectionTitle}>
				今天
			</h2>
			<Card>{body}</Card>
		</section>
	);
}

/** 總覽（介面改版規格 §5.2）：本月支出、今天熱量、今天的時間線。
 *  三塊**各自**處理載入與錯誤——一塊失敗不拖垮整頁。
 *  時間線的列只能看、不能點（規格 §1.3）。 */
export function Overview() {
	return (
		<section>
			<h1>總覽</h1>
			<div className={styles.cards}>
				<MonthSpendCard />
				<TodayKcalCard />
			</div>
			<TodayTimeline />
		</section>
	);
}
```

> JSX 裡的 `${formatMoney(…)}`：`$` 是字面上的錢號，後面的 `{…}` 是 JSX 運算式，不是 template literal。

- [ ] **Step 8: 跑測試確認通過**

```
npx vitest run tests/overview.test.tsx tests/timeline.test.ts
```

Expected：全部 PASS。

- [ ] **Step 9: 突變測試**

1. `buildTimeline` 裡把 `continue;` 刪掉（餐費的支出也另列一次）→ Expected：timeline 的「有餐費的那一餐只出現一次」與 overview 的「時間線：有餐費的那一餐只出現一次…」**FAIL**。改回來。
2. `TodayTimeline` 裡把 `statsUnusable ||` 從第一個條件拿掉 → Expected：「stats 失敗時時間線說失敗，不會永遠停在載入中」**FAIL**。改回來。
3. `buildTimeline` 的排序改成 `Date.parse(a.time) - Date.parse(b.time)` → Expected：「由新到舊排序…」**FAIL**。改回來。

- [ ] **Step 10: 靜態檢查與全部測試**

```
npm run -s typecheck
npm run -s lint
npm run -s test
```

Expected：全部通過——**包括 `app.test.tsx`**（它渲染了真的 `Overview`，現在會打四個端點）。如果 `app.test.tsx` 紅了，先看是不是某個端點的 mock 形狀不對，回報。

- [ ] **Step 11: Commit**

```
feat(overview): 總覽——本月支出、今天熱量、今天的時間線

時間線把今天的餐與今天的支出排在一起；有餐費的那一餐只出現一次
（buildTimeline，純函式）。對不上任何一餐的支出各自一列——錢不能因為
對不上就消失。

今天的支出用 stats/daily 回的 date 去查，前端不自己算今天。那個 query
在拿到日期前是 enabled: false（v5 的 isPending），所以 stats 失敗要先
判斷，否則畫面永遠停在載入中——有一條測試守這件事。

三塊各自處理錯誤，一塊失敗不拖垮整頁。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

```bash
git add frontend/src/lib/timeline.ts frontend/src/screens/Overview.tsx frontend/src/screens/Overview.module.css frontend/tests/timeline.test.ts frontend/tests/overview.test.tsx
```

---

## Task 8：記一餐——選填照片、新外觀

**Files:**
- Modify: `frontend/src/api/photos.ts`（匯出 `uploadMealPhoto`）
- Modify: `frontend/src/screens/LogMeal.tsx`；Create: `frontend/src/screens/LogMeal.module.css`
- Modify: `frontend/src/App.tsx`（`LogMealRoute` 帶通知回總覽）
- Modify: `frontend/src/screens/Overview.tsx`（顯示通知）
- Test: `frontend/tests/log-meal.test.tsx`、`frontend/tests/overview.test.tsx`

**這是唯一碰到既有核心畫面邏輯的任務。** `LogMeal` 的既有行為全部保留：搜尋、常吃、最近吃、份量、數量、餐別、選填金額、`isCostValidationError`、`409 FOOD_HAS_NO_REVISION`、5＋1 個 `invalidateQueries`。**「已選擇：{食物名}」這段文字也要保留**——`e2e/mobile-form-zoom.spec.ts` 等它出現。

**存檔分兩步**（規格 §5.4）：先 `POST /api/meals`（含金額），成功且有照片才上傳。**第二步失敗不算整筆失敗**——那一餐（含餐費）已經在後端了，讓 mutation 失敗會讓使用者以為沒記到、再記一次，那就是重複記錢。

- [ ] **Step 1: 匯出 `uploadMealPhoto`**

`frontend/src/api/photos.ts`：`async function uploadMealPhoto(` 改成 `export async function uploadMealPhoto(`，並在它的 docstring 最後加一段：

```ts
 *
 *  **匯出給記一餐用**（介面改版 Task 8）：記一餐要等 `POST /api/meals`
 *  回來才知道 mealId，`useUploadMealPhoto(mealId)` 綁死一個 mealId 用不了。
 *  記一餐成功後自己失效 `queryKeys.meals`（前綴會一起打到這一餐的照片 key）。
```

- [ ] **Step 2: 寫失敗的測試**

`frontend/tests/log-meal.test.tsx`：

在 import 區塊之後、`function wrap` 之前加（照 `tests/meal-photo-upload.test.tsx` 的作法——jsdom 沒有 canvas）：

```tsx
// 上傳會先呼叫 shrinkToLongestEdge 降尺寸，它用 canvas，jsdom 沒有。
// 這裡驗的是「兩步驟的順序與失敗處理」，不是降尺寸本身。
vi.mock("../src/lib/resize-image", () => ({
	shrinkToLongestEdge: vi.fn((file: File) => Promise.resolve(file)),
}));
```

在 `FREQUENT_FOODS` 之後加：

```tsx
function photoFile(size?: number): File {
	const file = new File(["fake-jpeg"], "lunch.jpg", { type: "image/jpeg" });
	if (size !== undefined) {
		// 不真的配置 10MB——只改 size 屬性，前端的大小檢查只看這個。
		Object.defineProperty(file, "size", { value: size });
	}
	return file;
}

function postedUrls(fetchMock: ReturnType<typeof mockApi>): string[] {
	return fetchMock.mock.calls
		.filter(([, init]) => (init?.method ?? "GET").toUpperCase() === "POST")
		.map(([input]) => String(input));
}
```

把 `MAX_PHOTO_BYTES` 加進 import（`import { MAX_PHOTO_BYTES } from "../src/api/photos";`）。

加到 `describe("記一餐", …)` 裡：

```tsx
	it("選了照片：先建立這一餐，再把照片傳到那一餐", async () => {
		// **路徑順序**：mockApiByPath 依物件的鍵順序用 url.includes 比對，
		// "/api/meals/99/photo" 也「包含」"/api/meals"——照片的路徑要排前面。
		const fetchMock = mockApi({
			"/api/foods/frequent": () => json(FREQUENT_FOODS),
			"/api/foods/recent": () => json([]),
			"/api/foods/1/portions": () => json([]),
			"/api/meals/99/photo": () => json({ id: 99 }),
			"/api/meals": () => json({ id: 99 }, 201),
		});
		const onSaved = vi.fn();
		render(wrap(<LogMeal onSaved={onSaved} />));
		await userEvent.click(await screen.findByText("滷肉飯"));

		await userEvent.upload(screen.getByLabelText("照片（選填）"), photoFile());
		await userEvent.click(screen.getByRole("button", { name: "記錄" }));

		await waitFor(() =>
			expect(onSaved).toHaveBeenCalledWith({ photoFailed: false }),
		);
		expect(postedUrls(fetchMock)).toEqual(["/api/meals", "/api/meals/99/photo"]);
		const photoCall = fetchMock.mock.calls.find(([input]) =>
			String(input).includes("/photo"),
		);
		const body = photoCall?.[1]?.body;
		expect(body).toBeInstanceOf(FormData);
		// 欄位名必須是 "file"——後端是 `file: UploadFile = File(...)`。
		expect((body as FormData).get("file")).toBeInstanceOf(File);
	});

	it("沒選照片就只建立這一餐", async () => {
		const fetchMock = mockApi({
			"/api/foods/frequent": () => json(FREQUENT_FOODS),
			"/api/foods/recent": () => json([]),
			"/api/foods/1/portions": () => json([]),
			"/api/meals": () => json({ id: 99 }, 201),
		});
		const onSaved = vi.fn();
		render(wrap(<LogMeal onSaved={onSaved} />));
		await userEvent.click(await screen.findByText("滷肉飯"));

		await userEvent.click(screen.getByRole("button", { name: "記錄" }));

		await waitFor(() =>
			expect(onSaved).toHaveBeenCalledWith({ photoFailed: false }),
		);
		expect(postedUrls(fetchMock)).toEqual(["/api/meals"]);
	});

	it("照片太大：選的當下就擋，不會傳出去", async () => {
		const fetchMock = mockApi({
			"/api/foods/frequent": () => json(FREQUENT_FOODS),
			"/api/foods/recent": () => json([]),
			"/api/foods/1/portions": () => json([]),
			"/api/meals": () => json({ id: 99 }, 201),
		});
		render(wrap(<LogMeal onSaved={vi.fn()} />));
		await userEvent.click(await screen.findByText("滷肉飯"));

		await userEvent.upload(
			screen.getByLabelText("照片（選填）"),
			photoFile(MAX_PHOTO_BYTES + 1),
		);

		expect(await screen.findByRole("alert")).toHaveTextContent("MB 上限");
		expect(screen.queryByAltText("選好的照片")).not.toBeInTheDocument();

		await userEvent.click(screen.getByRole("button", { name: "記錄" }));
		await waitFor(() => expect(postedUrls(fetchMock)).toEqual(["/api/meals"]));
	});

	it("餐存好了、照片傳失敗：不算整筆失敗，告訴外層照片沒傳上去", async () => {
		// 讓 mutation 失敗的話，使用者會以為沒記到、再記一次——
		// 那一餐（含餐費）已經在後端了，那就是重複記錢。
		mockApi({
			"/api/foods/frequent": () => json(FREQUENT_FOODS),
			"/api/foods/recent": () => json([]),
			"/api/foods/1/portions": () => json([]),
			"/api/meals/99/photo": () =>
				json(
					{ error: { code: "INTERNAL_ERROR", message: "壞了", details: {} } },
					500,
				),
			"/api/meals": () => json({ id: 99 }, 201),
		});
		const onSaved = vi.fn();
		render(wrap(<LogMeal onSaved={onSaved} />));
		await userEvent.click(await screen.findByText("滷肉飯"));

		await userEvent.upload(screen.getByLabelText("照片（選填）"), photoFile());
		await userEvent.click(screen.getByRole("button", { name: "記錄" }));

		await waitFor(() =>
			expect(onSaved).toHaveBeenCalledWith({ photoFailed: true }),
		);
		expect(screen.queryByText("記錄失敗，請再試一次")).not.toBeInTheDocument();
	});

	it("移除照片之後就不會上傳", async () => {
		const fetchMock = mockApi({
			"/api/foods/frequent": () => json(FREQUENT_FOODS),
			"/api/foods/recent": () => json([]),
			"/api/foods/1/portions": () => json([]),
			"/api/meals": () => json({ id: 99 }, 201),
		});
		render(wrap(<LogMeal onSaved={vi.fn()} />));
		await userEvent.click(await screen.findByText("滷肉飯"));
		await userEvent.upload(screen.getByLabelText("照片（選填）"), photoFile());
		expect(await screen.findByAltText("選好的照片")).toBeInTheDocument();

		await userEvent.click(screen.getByRole("button", { name: "移除照片" }));
		await userEvent.click(screen.getByRole("button", { name: "記錄" }));

		await waitFor(() => expect(postedUrls(fetchMock)).toEqual(["/api/meals"]));
	});
```

> 這個檔案用的是 `mockApiByPath as mockApi`（物件形式、不分 method）——上面的測試照它的慣例寫。
> `{ id: 99 }` 這個極簡回應沒問題：`LogMeal` 成功後只用 `id` 去傳照片；`uploadMealPhoto` 只要求回應不是 `null`。

加到 `frontend/tests/overview.test.tsx` 的 `describe` 裡：

```tsx
	it("帶著通知進來時顯示通知（例如照片沒傳上去）", async () => {
		mockOverview();
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});

		render(
			<QueryClientProvider client={client}>
				<MemoryRouter
					initialEntries={[{ pathname: "/", state: { notice: "照片沒有傳上去" } }]}
				>
					<Overview />
				</MemoryRouter>
			</QueryClientProvider>,
		);

		expect(await screen.findByRole("status")).toHaveTextContent(
			"照片沒有傳上去",
		);
	});
```

- [ ] **Step 3: 跑測試確認它失敗**

```
cd frontend
npx vitest run tests/log-meal.test.tsx tests/overview.test.tsx
```

Expected：log-meal 新的 5 條 FAIL（找不到「照片（選填）」）；**既有的 log-meal 測試全部 PASS**；overview 新的 1 條 FAIL（沒有 `role="status"`）。

- [ ] **Step 4: 實作**

`frontend/src/screens/LogMeal.tsx`：

**imports** 改／加：

```tsx
import { Camera } from "lucide-react";
import { type ChangeEvent, useEffect, useState } from "react";
```

```tsx
import {
	MAX_PHOTO_BYTES,
	PhotoTooLargeError,
	uploadMealPhoto,
} from "../api/photos";
```

```tsx
import styles from "./LogMeal.module.css";
```

**Props 與通知文字**（取代原本的 `type Props = { onSaved: () => void };`）：

```tsx
type Props = {
	/** `photoFailed`：這一餐存好了，但選的照片沒傳上去（規格 §5.4）。 */
	onSaved: (result: { photoFailed: boolean }) => void;
};

/** 餐存好、照片沒傳上去時給總覽顯示的話。補傳走飲食頁 `MealList` 既有的上傳。 */
export const PHOTO_UPLOAD_FAILED_NOTICE =
	"這一餐已記錄，照片沒有傳上去，可以到飲食頁的那一餐補傳";
```

**state**（加在 `cost` 之後）：

```tsx
	// 選填的照片（介面改版 §5.4）。選的當下就檢查大小，不要等到存檔才發現。
	const [photo, setPhoto] = useState<File | null>(null);
	const [photoError, setPhotoError] = useState<string | null>(null);
	const [photoPreview, setPhotoPreview] = useState<string | null>(null);

	useEffect(() => {
		if (photo === null) {
			setPhotoPreview(null);
			return;
		}
		const url = URL.createObjectURL(photo);
		setPhotoPreview(url);
		// 換照片或離開畫面時釋放，不然每選一次就漏一份 blob。
		return () => URL.revokeObjectURL(url);
	}, [photo]);

	function handlePhotoChange(event: ChangeEvent<HTMLInputElement>) {
		const file = event.target.files?.[0] ?? null;
		// 清掉 input 自己的值：「移除」之後再選同一張，change 才會再觸發。
		event.target.value = "";
		if (file !== null && file.size > MAX_PHOTO_BYTES) {
			setPhoto(null);
			setPhotoError(new PhotoTooLargeError().message);
			return;
		}
		setPhotoError(null);
		setPhoto(file);
	}
```

**`saveMeal` 的 `mutationFn`**：把 `return apiFetch<MealResponse>("/api/meals", {…});` 改成先存成變數，再處理照片。`body` 的內容**一個字都不改**：

```tsx
		mutationFn: async () => {
			if (selectedFood === null) {
				throw new Error("尚未選擇食物");
			}
			const meal = await apiFetch<MealResponse>("/api/meals", {
				/* …原本的 method / headers / body，原樣保留… */
			});
			if (photo === null) return { photoFailed: false };
			// 後端成功時一定回 MealResponse；null 代表 apiFetch 的假設被破壞了，
			// 照片沒地方傳——當成照片失敗，不是整筆失敗。
			if (meal === null) return { photoFailed: true };
			// **第二步失敗不算整筆失敗**（規格 §5.4）：這一餐（含餐費）已經在
			// 後端了。讓 mutation 失敗，使用者會以為沒記到、再記一次——那就是
			// 重複記錢。
			try {
				await uploadMealPhoto(meal.id, photo);
				return { photoFailed: false };
			} catch {
				return { photoFailed: true };
			}
		},
```

（`/* …原本的… */` 那一行是給你的指示：把現有的 `method`、`headers`、`body: JSON.stringify({…})` 整段原樣放回去，包括裡面所有註解。）

**`onSuccess`**：簽章改成 `onSuccess: (result) => {`；既有的 6 個 `invalidateQueries` 與註解不動；`setCost("");` 之後加：

```tsx
			setPhoto(null);
			setPhotoError(null);
```

最後一行 `onSaved();` 改成 `onSaved(result);`。

> 不需要另外失效照片的 key：既有的 `invalidateQueries({ queryKey: queryKeys.meals })` 沒有 `exact`，前綴會一起打到 `["meals", id, "photo"]`（`api/photos.ts` 的 `useUploadMealPhoto` docstring 講過這個前綴行為）。

**表單裡**，`金額（選填）` 那個 `<input>` 之後、`{error !== null && …}` 之前加：

```tsx
					<label htmlFor="meal-photo" className={styles.photoButton}>
						<Camera aria-hidden="true" size={18} />
						照片（選填）
					</label>
					{/* 不加 capture：iPhone 會同時給「拍照」與「從相簿選」
					    （MealList 的補傳有 capture="environment"，那裡的情境是
					    「現在正在吃」，直接開相機比較快）。 */}
					<input
						id="meal-photo"
						type="file"
						accept="image/*"
						className={styles.fileInput}
						onChange={handlePhotoChange}
					/>
					{photoPreview !== null && (
						<div className={styles.preview}>
							<img src={photoPreview} alt="選好的照片" />
							<button type="button" onClick={() => setPhoto(null)}>
								移除照片
							</button>
						</div>
					)}
					{photoError !== null && <p role="alert">{photoError}</p>}
```

**外觀**：只加 `className`，不改結構與文字。

- `<section>` → `<section className={styles.screen}>`
- 搜尋的 `<div>` → `<div className={styles.search}>`
- 常吃／最近吃的 `<ul>` → `<ul className={styles.foods}>`
- 選好食物後的 `<form …>` → 加 `className={styles.form}`
- `<p>已選擇：{selectedFood.name}</p>` → `<p className={styles.selected}>已選擇：{selectedFood.name}</p>`（**文字不能改**）
- 「記錄」按鈕 → 加 `className={styles.save}`

Create `frontend/src/screens/LogMeal.module.css`：

```css
.screen {
	display: flex;
	flex-direction: column;
	gap: var(--space-3);
}

.search {
	display: flex;
	flex-direction: column;
	gap: var(--space-1);
	font-size: 12px;
	color: var(--color-text-muted);
}

/* 字級不在這裡設——index.css 的全域規則保證 input/select ≥ 16px。 */
.search input,
.form input:not([type="file"]),
.form select {
	padding: var(--space-2) var(--space-3);
	border: 1px solid var(--color-border);
	border-radius: var(--radius-button);
	background: var(--color-surface);
	color: var(--color-text);
}

.foods {
	list-style: none;
	margin: 0;
	padding: 0;
	display: flex;
	flex-wrap: wrap;
	gap: var(--space-2);
}

.foods li {
	display: flex;
	align-items: center;
	gap: var(--space-1);
	padding: var(--space-1) var(--space-2);
	border-radius: var(--radius-button);
	background: var(--color-surface);
	font-size: 12px;
	color: var(--color-text-muted);
}

.foods button {
	min-height: 36px;
	border: none;
	background: transparent;
	color: var(--color-text);
	font-size: 14px;
	font-weight: 600;
}

.form {
	display: flex;
	flex-direction: column;
	gap: var(--space-2);
	padding: var(--space-4);
	border-radius: var(--radius-card);
	background: var(--color-surface);
}

.selected {
	margin: 0;
	font-weight: 700;
}

.photoButton {
	display: inline-flex;
	align-items: center;
	gap: var(--space-2);
	min-height: 44px;
	padding: 0 var(--space-3);
	border: 1px dashed var(--color-border);
	border-radius: var(--radius-button);
	color: var(--color-text-muted);
}

/* 視覺上藏起來，但仍然可以被 label 觸發、被測試與 Playwright 找到。
   不用 display:none——那會讓某些瀏覽器忽略 label 的點擊。 */
.fileInput {
	position: absolute;
	width: 1px;
	height: 1px;
	opacity: 0;
}

.preview {
	display: flex;
	align-items: center;
	gap: var(--space-3);
}

.preview img {
	width: 72px;
	height: 72px;
	object-fit: cover;
	border-radius: var(--radius-button);
}

.save {
	min-height: 48px;
	margin-top: var(--space-2);
	border: none;
	border-radius: var(--radius-button);
	background: var(--color-action);
	color: var(--color-on-action);
	font-size: 16px;
	font-weight: 700;
}

.save:disabled {
	opacity: 0.4;
}
```

`frontend/src/App.tsx` 的 `LogMealRoute`：

```tsx
function LogMealRoute() {
	const navigate = useNavigate();
	return (
		<LogMeal
			onSaved={({ photoFailed }) =>
				navigate(
					"/",
					photoFailed
						? { state: { notice: PHOTO_UPLOAD_FAILED_NOTICE } }
						: undefined,
				)
			}
		/>
	);
}
```

（`PHOTO_UPLOAD_FAILED_NOTICE` 從 `./screens/LogMeal` 匯入；docstring 加一句「照片沒傳上去時帶著通知回總覽」。）

`frontend/src/screens/Overview.tsx`：

```tsx
import { useLocation } from "react-router";
```

```tsx
/** 從路由 state 拿通知（例如記一餐「照片沒傳上去」）。state 是 unknown——
 *  任何頁面都可能 navigate 過來，形狀不對就當作沒有。 */
function noticeFrom(state: unknown): string | null {
	if (
		typeof state === "object" &&
		state !== null &&
		"notice" in state &&
		typeof state.notice === "string"
	) {
		return state.notice;
	}
	return null;
}
```

`Overview()` 裡：

```tsx
export function Overview() {
	const notice = noticeFrom(useLocation().state);
	return (
		<section>
			<h1>總覽</h1>
			{notice !== null && (
				<p role="status" className={styles.notice}>
					{notice}
				</p>
			)}
			{/* …其餘不變… */}
		</section>
	);
}
```

- [ ] **Step 5: 跑測試確認通過**

```
npx vitest run tests/log-meal.test.tsx tests/overview.test.tsx tests/meal-photo-upload.test.tsx tests/app.test.tsx
```

Expected：全部 PASS。

- [ ] **Step 6: 突變測試**

1. 把 `mutationFn` 裡的 `try { … } catch { … }` 拿掉，直接 `await uploadMealPhoto(…); return { photoFailed: false };` → Expected：「餐存好了、照片傳失敗…」**FAIL**（`onSaved` 沒被呼叫，畫面顯示「記錄失敗」）。改回來。
2. 把 `handlePhotoChange` 裡的大小檢查拿掉 → Expected：「照片太大：選的當下就擋…」**FAIL**。改回來。

- [ ] **Step 7: 靜態檢查與全部測試**

```
npm run -s typecheck
npm run -s lint
npm run -s test
```

- [ ] **Step 8: Commit**

```
feat(meals): 記一餐可以選填照片，記的當下就能拍

存檔分兩步：先建立這一餐（含金額），成功且有照片才上傳。第二步失敗不算
整筆失敗——那一餐已經在後端了，讓整筆失敗會讓使用者再記一次，就是重複
記錢。照片沒傳上去時帶著通知回總覽，補傳走飲食頁既有的上傳。

照片大小在選的當下就檢查（MAX_PHOTO_BYTES），不等到存檔。不加 capture：
iPhone 會同時給拍照與相簿兩個選項。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

```bash
git add frontend/src/api/photos.ts frontend/src/screens/LogMeal.tsx frontend/src/screens/LogMeal.module.css frontend/src/App.tsx frontend/src/screens/Overview.tsx frontend/tests/log-meal.test.tsx frontend/tests/overview.test.tsx
```

---

## Task 9：飲食與報表的落點與外觀

**Files:**
- Modify: `frontend/src/screens/Today.tsx`；Create: `frontend/src/screens/Today.module.css`
- Modify: `frontend/src/screens/MealList.tsx`；Create: `frontend/src/screens/MealList.module.css`
- Modify: `frontend/src/screens/Expenses.tsx`；Create: `frontend/src/screens/Expenses.module.css`
- Test: `frontend/tests/today.test.tsx`、`frontend/tests/expenses.test.tsx`

**入口的帳要對得上。** 改版拿掉了兩個 tab：「趨勢」與「食物庫」。它們的入口搬到畫面裡，**各要有一條拿掉就會紅的測試**——這個專案三次蓋好功能卻沒有入口（handover §6）：

| 目的地 | 舊入口 | 新入口 | 守的測試 |
|---|---|---|---|
| 記帳 | 飲食頁的「記帳」連結 | 「＋」→ 記帳 | `tab-bar.test.tsx`（Task 5） |
| 記一餐 | 首頁 | 「＋」→ 記一餐 | `tab-bar.test.tsx`（Task 5） |
| 審核 | tab 第五格 | 我的 | `me.test.tsx`（Task 5） |
| **食物庫** | tab | **飲食頁** | **這個任務** |
| **營養趨勢** | tab | **報表頁** | **這個任務** |

- [ ] **Step 1: 寫失敗的測試**

`frontend/tests/today.test.tsx`：

- **刪掉**「有記帳的入口連結」那一條（記帳的入口現在是「＋」，由 `tab-bar.test.tsx` 守）。
- 在同一個 `describe` 裡加：

```tsx
	it("有食物庫的入口連結", async () => {
		// 「食物庫」不再是 tab（介面改版）。沒有這條測試，拿掉這個連結不會
		// 有任何東西變紅——這個專案已經三次蓋好功能卻沒有入口。
		mockApi({
			"/api/stats/daily": () => json(STATS_WITH_TARGET),
			"/api/supplements/today": () => json([]),
		});

		render(wrap(<Today />));

		expect(
			await screen.findByRole("link", { name: "食物庫" }),
		).toHaveAttribute("href", "/foods");
	});
```

> 跟既有的測試一樣刻意不 mock `/api/meals`（`MealList` 打不到會變成 query 的錯誤狀態，不會讓測試失敗）。

`frontend/tests/expenses.test.tsx`：

- `wrap()` 加上 `MemoryRouter`（報表頁多了一個 `<Link>`）：

```tsx
import { MemoryRouter } from "react-router";
```

```tsx
function wrap(children: ReactNode) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return (
		<QueryClientProvider client={client}>
			<MemoryRouter>{children}</MemoryRouter>
		</QueryClientProvider>
	);
}
```

（保留原有函式上方的註解，把「不需要 MemoryRouter」那句改成「需要 MemoryRouter：營養趨勢的入口是 `<Link>`」。）

- 在 `describe` 裡加：

```tsx
	it("有營養趨勢的入口連結", async () => {
		// 「趨勢」不再是 tab（介面改版），入口搬到報表頁。
		mockApi([
			{
				method: "GET",
				path: "/api/expenses/summary",
				handler: () => json(EMPTY_SUMMARY),
			},
			{ method: "GET", path: "/api/expenses", handler: () => json([]) },
		]);

		render(wrap(<Expenses />));

		expect(
			await screen.findByRole("link", { name: "營養趨勢" }),
		).toHaveAttribute("href", "/trend");
	});
```

- [ ] **Step 2: 跑測試確認它失敗**

```
cd frontend
npx vitest run tests/today.test.tsx tests/expenses.test.tsx
```

Expected：兩條新的 FAIL（找不到連結）；其他全部 PASS。

- [ ] **Step 3: 飲食頁**

`frontend/src/screens/Today.tsx`：

- 刪掉 `<Link to="/expenses">記帳</Link>` 與它上面的註解。
- `<h1>飲食</h1>` 之後加入口列：

```tsx
			{/* 介面改版：「食物庫」不再是 tab，入口在這裡（今天吃了什麼的
			    旁邊，就是會想查、想加食物的地方）。補劑管理的入口原本就在下面
			    「今日補劑」區塊，維持不動。 */}
			<nav className={styles.links} aria-label="飲食相關">
				<Link to="/foods">食物庫</Link>
			</nav>
```

- 外觀：營養素那一塊（`stats && (…)` 的兩個分支）各自包進 `<Card>`；`<h2>今日補劑</h2>` 與它下面的連結、清單包進一個 `<Card>`。**不改任何文字、`data-testid`、條件判斷。**
- import `Card` 與 `styles from "./Today.module.css"`。

Create `frontend/src/screens/Today.module.css`：

```css
.links {
	display: flex;
	gap: var(--space-4);
	margin-bottom: var(--space-2);
}

.links a {
	display: inline-flex;
	align-items: center;
	min-height: 44px;
	font-weight: 600;
}
```

`frontend/src/screens/MealList.tsx`：每一個 `MealCard` 的 `<li>` 加 `className={styles.meal}`，外層 `<ul>` 加 `className={styles.meals}`。Create `frontend/src/screens/MealList.module.css`：

```css
.meals {
	list-style: none;
	margin: 0;
	padding: 0;
}

.meal {
	margin: var(--space-2) 0;
	padding: var(--space-3) var(--space-4);
	border-radius: var(--radius-card);
	background: var(--color-surface);
}

.meal h3 {
	margin: 0 0 var(--space-2);
	font-size: 14px;
	color: var(--color-text-muted);
}

.meal img {
	max-width: 100%;
	border-radius: var(--radius-button);
}
```

- [ ] **Step 4: 報表頁**

`frontend/src/screens/Expenses.tsx`：

- import `Link`（`react-router`）、`Card`、`styles from "./Expenses.module.css"`。
- `<h1>報表</h1>` 之後加：

```tsx
			{/* 介面改版：「趨勢」不再是 tab，入口在報表——兩者都是「回頭看」。 */}
			<nav className={styles.links} aria-label="報表相關">
				<Link to="/trend">營養趨勢</Link>
			</nav>
```

- `<div data-testid="expense-summary">…</div>` 改成 `<Card testId="expense-summary">…</Card>`（**`testId` 不能變**，既有測試用它定位）。
- 清單那一段（`expensesQuery.isPending ? … : …`）包進一個 `<Card>`；清單的 `<ul>` 加 `className={styles.list}`。
- `ExpenseRow` 的 `<li>` 加 `className={styles.row}`，金額的 `<span>` 加 `className={styles.amount}`，並在分類名稱前面放 `<CategoryIcon category={expense.category} />`（import 自 `../components/IconBadge`）。

Create `frontend/src/screens/Expenses.module.css`：

```css
.links {
	display: flex;
	gap: var(--space-4);
	margin-bottom: var(--space-2);
}

.links a {
	display: inline-flex;
	align-items: center;
	min-height: 44px;
	font-weight: 600;
}

.list {
	list-style: none;
	margin: 0;
	padding: 0;
}

.row {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: var(--space-2);
	padding: var(--space-2) 0;
	border-bottom: 1px solid var(--color-border);
}

.row:last-child {
	border-bottom: none;
}

.amount {
	margin-left: auto;
	font-weight: 600;
	font-variant-numeric: tabular-nums;
}
```

> **小心 `expenses.test.tsx` 裡依賴結構的斷言**：例如「顯示這個月的花費」用 `within(screen.getByTestId("expense-1")).getByText("飲食")`——加了 `CategoryIcon` 之後，那一列裡的「飲食」文字仍然只有一個（圖示是 `aria-hidden` 的 SVG，沒有文字）。如果有任何既有斷言因為加了圖示而紅，停下來回報。

- [ ] **Step 5: 跑測試確認通過**

```
npx vitest run tests/today.test.tsx tests/expenses.test.tsx tests/meal-list.test.tsx tests/meal-photo-upload.test.tsx tests/meal-photo.test.tsx
```

Expected：全部 PASS。

- [ ] **Step 6: 突變測試**

1. 刪掉 `Today.tsx` 的 `<Link to="/foods">食物庫</Link>` → Expected：「有食物庫的入口連結」**FAIL**。改回來。
2. 刪掉 `Expenses.tsx` 的 `<Link to="/trend">營養趨勢</Link>` → Expected：「有營養趨勢的入口連結」**FAIL**。改回來。

- [ ] **Step 7: 靜態檢查與全部測試**

```
npm run -s typecheck
npm run -s lint
npm run -s test
```

- [ ] **Step 8: Commit**

```
feat(ui): 飲食與報表換上新外觀，食物庫與營養趨勢的入口搬進畫面

「食物庫」「趨勢」不再是 tab：食物庫的入口在飲食頁、營養趨勢在報表頁，
各有一條拿掉就會紅的測試。飲食頁的「記帳」連結拿掉——記帳的入口現在
是「＋」，由 tab-bar.test.tsx 守。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

```bash
git add frontend/src/screens/Today.tsx frontend/src/screens/Today.module.css frontend/src/screens/MealList.tsx frontend/src/screens/MealList.module.css frontend/src/screens/Expenses.tsx frontend/src/screens/Expenses.module.css frontend/tests/today.test.tsx frontend/tests/expenses.test.tsx
```

---

## Task 10：e2e 改走新路由

**Files:**
- Modify: `frontend/e2e/auth.spec.ts`、`admin.spec.ts`、`daily-loop.spec.ts`、`foods.spec.ts`、`trend.spec.ts`、`supplements.spec.ts`、`photo-and-limits.spec.ts`、`mobile-form-zoom.spec.ts`

**e2e 只能用點的換頁，不能 `page.goto()` 換頁**——access token 只在記憶體裡，`goto` 會重新載入、第一個請求帶不到 token（`admin.spec.ts` 的 `navigateWithoutReload` 註解）。

### 對照表（寫計畫時讀過每個檔案的選擇器）

| 舊的 | 新的 |
|---|---|
| 登入後 `expect(page.getByRole("heading", { name: "記一餐" })).toBeVisible()` | `name: "總覽"` |
| `page.getByRole("link", { name: "今日總覽" }).click()` | `name: "飲食"` |
| `expect(page.getByRole("heading", { name: "今日總覽" }))` | 看上下文：剛點了「飲食」→ `"飲食"`；剛記完一餐（會導回 `/`）→ `"總覽"` |
| `page.getByRole("link", { name: "記一餐" }).click()` | `page.getByRole("button", { name: "新增紀錄" }).click();` 然後 `page.getByRole("link", { name: "記一餐" }).click();` |
| `page.getByRole("link", { name: "審核" }).click()` | 先 `page.getByRole("link", { name: "我的" }).click();` 再點「審核」 |
| `page.getByRole("link", { name: "趨勢" }).click()` | 先 `page.getByRole("link", { name: "報表" }).click();` 再點 `"營養趨勢"` |
| `page.getByRole("link", { name: "食物庫" }).click()` | 先 `page.getByRole("link", { name: "飲食" }).click();` 再點「食物庫」 |
| `page.getByRole("button", { name: "重新整理" }).click()` | 先點 `"我的"`（見下面 auth.spec 的說明） |
| mobile-form-zoom：今日總覽 → 記帳 | `"新增紀錄"` → `"記帳"`，等 heading `"記帳"` |

- [ ] **Step 1: 逐檔套用對照表**

```
cd frontend
grep -n "今日總覽\|\"記一餐\"\|\"審核\"\|\"趨勢\"\|\"食物庫\"\|重新整理\|\"記帳\"" e2e/*.ts
```

每一處照對照表改。**每改一處，都讀一下前後兩三行**，確認「現在在哪個畫面」——例如 `foods.spec.ts` 第 53 行在記完一餐之後斷言「今日總覽」，記一餐現在會導回 `/`，所以要改成「總覽」，不是「飲食」。

**`auth.spec.ts` 的換票測試**：在「把 access token 換成無效的」**之前**先點到「我的」——這樣換票測試觸發的就只有「重新整理」這一個請求，不會被換頁時其他畫面的請求先觸發掉：

```ts
	await expect(page.getByRole("heading", { name: "總覽" })).toBeVisible();
	await page.getByRole("link", { name: "我的" }).click();
	await expect(page.getByRole("heading", { name: "我的" })).toBeVisible();

	// （原本的 __forceExpireAccessToken 那段）

	// （原本的 waitForResponse + 點「重新整理」）

	await expect(page.getByRole("heading", { name: "我的" })).toBeVisible();
```

（最後那行原本斷言「記一餐」——它守的是「沒有被踢回登入畫面」，留在「我的」就是那個意思。）

**`mobile-form-zoom.spec.ts`**：

- 記一餐那段（選好食物之後掃一次）不用多做什麼：照片的 `<input type="file">` 在表單裡，會被同一個 `locator("input, select, textarea")` 掃到。
- 記帳那段：記帳畫面現在只有一個 `<input>`（備註），鍵盤是按鈕。掃描照舊，`expectFormControlsAtLeast16px` 會找到那一個。**如果那個 helper 要求「至少找到 N 個控制項」而 N > 1，回報**，不要改 helper 的門檻。

- [ ] **Step 2: 型別檢查**

```
npm run -s typecheck
```

（`tsconfig.e2e.json` 在 `tsc -b` 的 references 裡，所以 e2e 的型別也會檢查。）

- [ ] **Step 3: 跑 e2e**

e2e 要後端在 `localhost:8000`。先確認：

```
curl -s -o /dev/null -w "%{http_code}" http://localhost:8000/api/health
```

- **200**：直接跑 `npx playwright test`。
- **不是 200**：本機的 api 容器在這份計畫寫的時候是壞的（`ModuleNotFoundError: No module named 'anthropic'`——映像檔比 `requirements-lock.txt` 舊）。在 repo 根目錄重建**本機開發用**的容器：

  ```
  docker compose up -d --build api
  ```

  等 `docker ps` 顯示 `wallet-api-1` 是 healthy，再跑 `npx playwright test`。
- **重建之後還是起不來**：不要再往下修，回報 `docker compose logs api --tail 50` 的內容。e2e 改由 CI 驗證（推上去之後看 CI 的 e2e job）。

Expected：全部 PASS。**任何一條紅，先看是不是對照表漏了某個選擇器**；如果是畫面行為的問題（例如某個按鈕找不到），回報。

- [ ] **Step 4: Commit**

```
test(e2e): 改走新的 tab bar 與「＋」

登入後落在總覽；記一餐從「＋」進去；審核、重新整理在「我的」；趨勢與
食物庫的入口在報表與飲食頁。auth.spec 的換票測試先切到「我的」再讓
token 失效，觸發換票的只有「重新整理」那一個請求。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

```bash
git add frontend/e2e
```

---

## 收尾

- [ ] **完整檢查**

```
./.venv/Scripts/python.exe -m pytest -q
cd frontend
npm run -s typecheck
npm run -s lint
npm run -s test
```

Expected：全部通過。

- [ ] **人工確認清單（自動測試看不到的，規格 §8.4）**

`npm run dev`，用瀏覽器的裝置模擬器：

1. **深色模式**：作業系統切到深色，每個新畫面看一次（總覽、記帳、記一餐、飲食、報表、我的、「＋」面板）。特別看：卡片與背景分得出來、按鈕上的字讀得到、分類圖示的白色看得見。
2. **320px 寬**：記帳的分類格（4 欄）與鍵盤（「0」跨兩欄、✓ 跨三列）、總覽的兩張卡並排、時間線、tab bar 的「＋」凸出且不蓋住最後一列。
3. **iPhone 實機**：點記一餐的金額欄、記帳的備註欄，頁面不會自動放大；記一餐的「照片（選填）」會出現「拍照」與「從相簿選」兩個選項。

前兩項 subagent 做不了（沒有瀏覽器）——**列在 PR 裡，交給使用者確認**。

- [ ] **更新 handover**

`docs/handover.md`：

- 「下一步」一節：第 1 階段完成，第 2 階段（圖表、其餘畫面換外觀）與第 3 階段（社群 P7）待做。
- §6「綠燈說謊」：這一輪實際遇到的才寫。寫計畫時已經抓到、執行時要確認的候選：
  - **`"/api/meals".includes("/api/me")` 為真。** 用子字串比對路徑的假後端，順序錯了就會把餐點請求回成使用者物件——測試不是紅在 mock，是紅在畫面當掉，看起來像畫面的 bug。
  - **`enabled: false` 的 query 在 TanStack Query v5 是 `isPending: true`。** 依賴另一個 query 的結果才發出的請求，前一個失敗時會「永遠載入中」，而且不會有任何錯誤。

- [ ] **開 PR**

```bash
git push -u origin feat/ui-redesign-phase1
gh pr create --base master --title "介面改版第一階段：外觀與記錄流程" --body "..."
```

PR 內文：規格與計畫連結、十個任務的摘要、**實作過程中發現的所有計畫錯誤**、上面的人工確認清單。

---

## 自我檢查（對照規格）

| 規格 | 任務 |
|---|---|
| §3.1 tab bar 四格＋「＋」、`AddSheet` | Task 5 |
| §3.2 路由 | Task 5、6 |
| §3.3 舊網址轉址 | Task 5（`app.test.tsx` 兩條） |
| §3.4 移除 `<Nav>`，登出移到我的 | Task 5（「重新整理」原樣搬家） |
| §4.1 設計變數、深色模式 | Task 2（`css-tokens.test.ts`） |
| §4.1 對比度 | Task 2（測試實際計算，不是手算） |
| §4.2 分類顏色與圖示、餐別圖示 | Task 3 |
| §4.3 `tabular-nums` | Task 4、6、7、9 的 module CSS |
| §4.4 16px、44px、安全區、「＋」凸出 | Task 2（`.app-main`）、各 module CSS、Task 10（e2e） |
| §5.1 `MoneyKeypad` 六條規則 | Task 4（每條一個測試） |
| §5.2 總覽 | Task 7 |
| §5.3 記帳 | Task 6 |
| §5.4 記一餐的照片、部分失敗 | Task 8 |
| §5.5 飲食 | Task 5（標題）、Task 9 |
| §5.6 報表 | Task 5（標題）、Task 6（拿掉新增）、Task 9 |
| §5.7 我的 | Task 5 |
| §6.1 `?date=` | Task 1 |
| §6.2 `buildTimeline` | Task 7 |
| §6.3 `expensesByDate` | Task 3 |
| §7 錯誤處理 | Task 6、7、8 |
| §8.2 既有測試搬家 | Task 5、6、9 |
| §8.3 e2e | Task 10 |
| §8.4 人工確認 | 收尾 |
