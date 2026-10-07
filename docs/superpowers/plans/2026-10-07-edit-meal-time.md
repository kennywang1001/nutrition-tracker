# 編輯這一餐可以改時間 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 編輯這一餐可以改日期與時間；那一餐的餐費日期跟著改。

**Architecture:** 後端 `update_meal` 在同一個交易裡把既有餐費的 `spent_at` 設成新的 `eaten_at`。前端 `MealDetailsForm` 多「日期」「時間」兩格（裝置時區、到分鐘），只有真的改了才送 `eaten_at`，未來的時間擋在前端；存好後多失效每日統計、趨勢、支出。

**Tech Stack:** FastAPI · SQLAlchemy async · React 19 · TypeScript · TanStack Query · Vitest

**依據規格：** `docs/superpowers/specs/2026-10-07-edit-meal-time-design.md`

---

## 執行環境

- 分支 `feat/edit-meal-time`。
- 後端：`PYTHONUTF8=1 ./.venv/Scripts/python.exe -m pytest -q`（**一定用 `.venv`**）、`… -m ruff check app tests migrations`、`… -m mypy app`。
- 前端在 `frontend/`：`npx vitest run tests/xxx`、`npm run -s typecheck`、`npm run -s lint`（格式 `npx biome check --write <檔案>`）、`npm run -s test`（**數字是兩倍**）。e2e：`npx playwright test`（後端改了要 `docker compose up -d --build api` 等 healthy）。
- 基準線（master `6e25664`）：後端 798；前端 108 檔 1056；e2e 29。
- Write/Edit；LF（有些 `.py` 工作目錄是 CRLF，寫 LF）。不要在 repo 或 scratchpad 以外留備份或暫存腳本。突變用 Edit 改、跑、改回。
- Commit：`git commit -F <scratchpad 裡的檔案>`，結尾 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`。不要 stage `lunch.jpg`。不要 amend。

## 開工前必讀

1. 「Expected: FAIL」沒有如預期失敗 → 停下來回報。2. 程式碼對不上 → 以現況為準並回報。3. 先寫測試看它紅。
4. 共用交易：斷言「寫進去了」之前先 `await db_session.rollback()`；rollback 之後 ORM 物件過期，先把 id 存成區域變數。

## 已查證的事實

| 事實 | 出處 |
|---|---|
| `update_meal`：`changes = payload.model_dump(exclude_unset=True)`、pop 出 `cost`、其餘 `setattr`；`existing = await _existing_meal_expense(db, meal.id)`；補金額時新的 `Expense(spent_at=meal.eaten_at)`；`IntegrityError` → 409／404；docstring 有「既有餐費的 `spent_at` 不跟著動」 | `app/api/routes/meals.py:352-430` |
| `MealUpdateRequest.eaten_at: AwareInstant \| None`，顯式 null → 422 | `app/schemas/meal.py` |
| `GET /api/expenses?month=YYYY-MM` 回 `list[ExpenseResponse]`（有 `id`），依使用者時區（預設 `Asia/Taipei`）切月 | `app/api/routes/expenses.py` |
| 工廠：`create_meal(..., eaten_at=)`、`create_expense(..., amount, category, spent_at, meal=)` | `tests/factories.py` |
| `EditMeal.tsx` 的 `MealDetailsForm`：`MealChanges` 型別、`mealChanges(meal, draft)` 只放有改的欄位、草稿 `undefined`＝沒動、`edit(setter)` 改值時 reset 上一次結果、`save` 的 `onSuccess` 失效 `queryKeys.meals`（`"cost" in body` 時加 `expensesAll`） | `frontend/src/screens/EditMeal.tsx` |
| `frontend/src/lib/dates.ts`：`formatTime`、`formatDateTime`，開頭寫明「只做顯示格式化，不算日界線」 | 同檔 |
| `queryKeys.dailyStats`、`queryKeys.rangeStatsAll`、`queryKeys.expensesAll` | `frontend/src/api/queries.ts` |
| `edit-meal.test.tsx`：`MEAL.eaten_at = "2026-10-04T12:30:00+08:00"`；`routes(meal, extra)`、`renderEditMeal(client)`、`bodyOf(fetchMock, "PATCH", "/api/meals/5")`、`keysOf(invalidateSpy)` | 同檔 |

---

## Task 1：後端——改時間時餐費日期跟著改

**Files:** Modify `app/api/routes/meals.py`；Create `tests/test_meal_time_edit.py`

- [ ] **Step 1: 寫失敗的測試** `tests/test_meal_time_edit.py`：

```python
from datetime import UTC, datetime

from sqlalchemy import select

from app.models.expense import Expense, ExpenseCategory
from app.security.tokens import create_access_token
from tests.factories import create_expense, create_meal, create_user

OCT_3 = datetime(2026, 10, 3, 4, tzinfo=UTC)  # 台北 10/3 中午
SEP_28 = datetime(2026, 9, 28, 11, tzinfo=UTC)  # 台北 9/28 晚上 7 點


def auth(user):
    return {"Authorization": f"Bearer {create_access_token(user.id)}"}


async def _meal_with_cost(db_session, user):
    meal = await create_meal(db_session, user=user, eaten_at=OCT_3)
    expense = await create_expense(
        db_session,
        user=user,
        amount=120,
        category=ExpenseCategory.FOOD,
        spent_at=OCT_3,
        meal=meal,
    )
    return meal.id, expense.id


async def test_moving_a_meal_moves_its_cost(client, db_session):
    user = await create_user(db_session)
    meal_id, expense_id = await _meal_with_cost(db_session, user)

    response = await client.patch(
        f"/api/meals/{meal_id}", headers=auth(user), json={"eaten_at": "2026-09-28T11:00:00Z"}
    )

    assert response.status_code == 200
    await db_session.rollback()
    spent_at = await db_session.scalar(select(Expense.spent_at).where(Expense.id == expense_id))
    assert spent_at == SEP_28


async def test_the_cost_moves_to_the_new_month_in_the_report(client, db_session):
    user = await create_user(db_session)
    meal_id, expense_id = await _meal_with_cost(db_session, user)

    await client.patch(
        f"/api/meals/{meal_id}", headers=auth(user), json={"eaten_at": "2026-09-28T11:00:00Z"}
    )
    september = await client.get("/api/expenses", headers=auth(user), params={"month": "2026-09"})
    october = await client.get("/api/expenses", headers=auth(user), params={"month": "2026-10"})

    assert expense_id in [e["id"] for e in september.json()]
    assert expense_id not in [e["id"] for e in october.json()]


async def test_a_meal_without_a_cost_just_moves(client, db_session):
    user = await create_user(db_session)
    meal = await create_meal(db_session, user=user, eaten_at=OCT_3)

    response = await client.patch(
        f"/api/meals/{meal.id}", headers=auth(user), json={"eaten_at": "2026-09-28T11:00:00Z"}
    )

    assert response.status_code == 200
    assert response.json()["eaten_at"].startswith("2026-09-28T11:00:00")
    assert response.json()["cost"] is None


async def test_moving_and_adding_a_cost_at_once_uses_the_new_time(client, db_session):
    user = await create_user(db_session)
    meal = await create_meal(db_session, user=user, eaten_at=OCT_3)
    meal_id = meal.id

    response = await client.patch(
        f"/api/meals/{meal_id}",
        headers=auth(user),
        json={"eaten_at": "2026-09-28T11:00:00Z", "cost": "90"},
    )

    assert response.status_code == 200
    await db_session.rollback()
    spent_at = await db_session.scalar(select(Expense.spent_at).where(Expense.meal_id == meal_id))
    assert spent_at == SEP_28
```

- [ ] **Step 2: 跑**：`PYTHONUTF8=1 ./.venv/Scripts/python.exe -m pytest tests/test_meal_time_edit.py -q`。Expected：前兩條 FAIL（`spent_at` 還是 10/3）；後兩條 PASS（守現況）。

- [ ] **Step 3: 實作**——`update_meal` 裡 `existing = await _existing_meal_expense(db, meal.id)` 那一段，在處理 `cost` **之前**加：

```python
    # 改了吃的時間：那一餐的餐費日期跟著改（改時間規格 §3）——報表不能單獨改
    # 餐費的日期，錢屬於吃那一餐的時間。不跟著改的話，補記上個月的晚餐、
    # 把時間改回上個月，錢還留在這個月的報表裡。
```

並調整成：先取 `existing`（不論有沒有送 `cost`），`"eaten_at" in changes and existing is not None` 時 `existing.spent_at = meal.eaten_at`；`cost` 的邏輯沿用同一個 `existing`。docstring 裡「已知的落差：同時改 `eaten_at` 時，**既有**餐費的 `spent_at` 不跟著動」改成「改 `eaten_at` 時餐費的 `spent_at` 跟著改」。照現況的結構改，回報最後的樣子。

- [ ] **Step 4: 跑**：同 Step 2，4 passed；再跑 `tests/test_meals*.py tests/test_meal_cost_unique.py tests/test_expenses*.py -q`。

- [ ] **Step 5: 突變**：拿掉 `existing.spent_at = meal.eaten_at` → 前兩條紅。改回。

- [ ] **Step 6: 全部後端、ruff、mypy**。Expected：802。

- [ ] **Step 7: Commit** `fix(meals): 改吃的時間時，那一餐的餐費日期跟著改`（附一行說明：跨月補記會留在錯的月份）

```bash
git add app/api/routes/meals.py tests/test_meal_time_edit.py
```

---

## Task 2：前端——日期與時間兩格

**Files:** Modify `frontend/src/lib/dates.ts`、`frontend/src/screens/EditMeal.tsx`、`EditMeal.module.css`（需要的話）；Test `frontend/tests/dates.test.ts`、`frontend/tests/edit-meal.test.tsx`（只新增）

- [ ] **Step 1: 寫失敗的測試**

`frontend/tests/dates.test.ts` 加：

```ts
describe("localDateTime", () => {
	it("一個時刻在這台裝置時區的日期與時間（到分鐘）", () => {
		// 用本地時區建構，結果跟測試機的時區無關。
		const instant = new Date(2026, 9, 4, 12, 30, 45).toISOString();

		expect(localDateTime(instant)).toEqual({ date: "2026-10-04", time: "12:30" });
	});

	it("個位數補零", () => {
		const instant = new Date(2026, 0, 5, 7, 3).toISOString();

		expect(localDateTime(instant)).toEqual({ date: "2026-01-05", time: "07:03" });
	});
});
```

（import 加 `localDateTime`。）

`frontend/tests/edit-meal.test.tsx` 的 `describe` 裡加（沿用 `routes`、`renderEditMeal`、`bodyOf`、`keysOf`、`calls`）：

```tsx
	it("日期與時間預填這一餐在裝置時區的時刻", async () => {
		mockApi(routes());
		renderEditMeal();

		const expected = localDateTime(MEAL.eaten_at);
		expect(await screen.findByLabelText("日期")).toHaveValue(expected.date);
		expect(screen.getByLabelText("時間")).toHaveValue(expected.time);
	});

	it("只改日期：送出的 eaten_at 換成新日期、時間不變；之後失效統計、趨勢、支出", async () => {
		const fetchMock = mockApi(routes());
		const client = renderEditMeal();
		const invalidate = vi.spyOn(client, "invalidateQueries");
		const { time } = localDateTime(MEAL.eaten_at);

		const dateInput = await screen.findByLabelText("日期");
		await userEvent.clear(dateInput);
		await userEvent.type(dateInput, "2026-10-02");
		await userEvent.click(screen.getByRole("button", { name: "儲存" }));

		await waitFor(() =>
			expect(bodyOf(fetchMock, "PATCH", "/api/meals/5")).toEqual({
				eaten_at: new Date(`2026-10-02T${time}`).toISOString(),
			}),
		);
		await waitFor(() => {
			const keys = keysOf(invalidate);
			expect(keys).toContainEqual(queryKeys.dailyStats);
			expect(keys).toContainEqual(queryKeys.rangeStatsAll);
			expect(keys).toContainEqual(queryKeys.expensesAll);
		});
	});

	it("沒動日期與時間：PATCH 不帶 eaten_at", async () => {
		const fetchMock = mockApi(routes());
		renderEditMeal();

		await userEvent.selectOptions(await screen.findByLabelText("餐別"), "dinner");
		await userEvent.click(screen.getByRole("button", { name: "儲存" }));

		await waitFor(() =>
			expect(bodyOf(fetchMock, "PATCH", "/api/meals/5")).toEqual({ meal_type: "dinner" }),
		);
	});

	it("未來的時間：顯示訊息、不能儲存", async () => {
		const fetchMock = mockApi(routes());
		renderEditMeal();

		const dateInput = await screen.findByLabelText("日期");
		await userEvent.clear(dateInput);
		await userEvent.type(dateInput, "2099-01-01");

		expect(await screen.findByText("不能選未來的時間")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "儲存" })).toBeDisabled();
		expect(calls(fetchMock, "PATCH", "/api/meals/5")).toHaveLength(0);
	});
```

（import 加 `localDateTime`；`calls`／`keysOf` 的實際簽名照檔案現況。）

- [ ] **Step 2: 跑**：`npx vitest run tests/dates.test.ts tests/edit-meal.test.tsx`。Expected：`localDateTime` 不存在 → 兩個檔案的新測試 FAIL（`edit-meal` 收集時 import 失敗的話整檔紅——照實回報）。「沒動日期與時間」那條在實作前也 PASS 的話是守未來的。

- [ ] **Step 3: 實作**

`frontend/src/lib/dates.ts` 加：

```ts
function pad(value: number): string {
	return String(value).padStart(2, "0");
}

/** 一個時刻在**這台裝置時區**的日期（`YYYY-MM-DD`）與時間（`HH:mm`）——給
 *  `<input type="date">`／`<input type="time">` 用（改時間規格 §2）。只是格式轉換，
 *  不決定「算哪一天」——那照舊是後端依帳號時區的事。 */
export function localDateTime(timestamp: string): { date: string; time: string } {
	const moment = new Date(timestamp);
	return {
		date: `${moment.getFullYear()}-${pad(moment.getMonth() + 1)}-${pad(moment.getDate())}`,
		time: `${pad(moment.getHours())}:${pad(moment.getMinutes())}`,
	};
}
```

`frontend/src/screens/EditMeal.tsx`：
1. `MealChanges` 加 `eaten_at?: string;`。
2. `mealChanges` 的 `draft` 多 `date: string | undefined; time: string | undefined`，函式開頭加：

```ts
	if (draft.date !== undefined || draft.time !== undefined) {
		const original = localDateTime(meal.eaten_at);
		const date = draft.date ?? original.date;
		const time = draft.time ?? original.time;
		// 到分鐘比較：原本的秒數不會讓它被當成「有改」。
		if (date !== original.date || time !== original.time) {
			changes.eaten_at = new Date(`${date}T${time}`).toISOString();
		}
	}
```

3. 新增（模組層）：

```ts
/** 日期與時間的草稿有問題就回訊息：空的、或比現在晚（改時間規格 §4）。 */
function dateTimeProblem(meal: Meal, date?: string, time?: string): string | null {
	if (date === undefined && time === undefined) return null;
	const original = localDateTime(meal.eaten_at);
	const chosenDate = date ?? original.date;
	const chosenTime = time ?? original.time;
	if (chosenDate === "" || chosenTime === "") return "請選日期與時間";
	const chosen = new Date(`${chosenDate}T${chosenTime}`);
	if (Number.isNaN(chosen.getTime())) return "請選日期與時間";
	if (chosen.getTime() > Date.now()) return "不能選未來的時間";
	return null;
}
```

4. `MealDetailsForm`：`const [date, setDate] = useState<string | undefined>(undefined);`、`const [time, setTime] = …`；`mealChanges(meal, { mealType, cost, note, isPrivate, date, time })`；`const problem = dateTimeProblem(meal, date, time);`；「儲存」的 `disabled` 加 `|| problem !== null`、`onSubmit` 也要 `problem === null` 才送；`onSuccess` 清 `setDate(undefined)`、`setTime(undefined)`，而且 `"eaten_at" in body` 時加失效 `queryKeys.dailyStats`、`queryKeys.rangeStatsAll`、`queryKeys.expensesAll`。
5. 餐別欄位**之前**加（今天的日期用 `localDateTime(new Date().toISOString()).date` 當 `max`）：

```tsx
			<label htmlFor="edit-meal-date">日期</label>
			<input
				id="edit-meal-date"
				type="date"
				max={localDateTime(new Date().toISOString()).date}
				value={date ?? localDateTime(meal.eaten_at).date}
				onChange={(event) => edit(setDate)(event.target.value)}
			/>
			<label htmlFor="edit-meal-time">時間</label>
			<input
				id="edit-meal-time"
				type="time"
				value={time ?? localDateTime(meal.eaten_at).time}
				onChange={(event) => edit(setTime)(event.target.value)}
			/>
			{problem !== null && <p role="alert">{problem}</p>}
```

（樣式：`EditMeal.module.css` 的 `.section` 已經處理 `input`——確認 `type="date"`／`"time"` 也是 44px 高、字級 ≥16px；不是的話照既有 input 的規則補。）

- [ ] **Step 4: 跑**：同 Step 2，全綠；`git diff --stat tests/` 只有新增。

- [ ] **Step 5: 突變**：`mealChanges` 的比較改成永遠送 `eaten_at` → 「沒動日期與時間」紅；`dateTimeProblem` 拿掉未來的判斷 → 「未來」紅。改回。

- [ ] **Step 6: 全部前端；本機 api 重建、全部 e2e**。Expected：e2e 29。

- [ ] **Step 7: 用眼睛看一次**：390×844 淺色與深色截「編輯這一餐」的表單，存 scratchpad 的 `edit-time-*.png`，描述。

- [ ] **Step 8: Commit** `feat(meals): 編輯這一餐可以改日期與時間`（附一行：裝置時區、到分鐘比較、未來的時間擋在前端）

```bash
git add frontend/src/lib/dates.ts frontend/src/screens/EditMeal.tsx frontend/tests/dates.test.ts frontend/tests/edit-meal.test.tsx
```

（加上改過的 `EditMeal.module.css`。）

---

## Task 3：交接文件

- [ ] 規格狀態改「已實作」；`docs/handover.md` §8.2「修改與刪除已記錄的餐點」底下的「不能改時間（規格 §1.3）……既有餐費的 `spent_at` 不跟著動」改成已完成。Commit `docs: 交接文件——改吃的時間`。
