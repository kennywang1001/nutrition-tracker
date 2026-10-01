# P5 計畫二：記帳前端 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓使用者在 app 裡記一筆花費、看到「這個月花了多少、花在哪」，並在記一餐時順手填金額。

**Architecture:** 一個新的 `/expenses` 路由（清單 + 新增 + 改/刪 + 月報表），入口放在「今日總覽」底下（不加第六個 tab）。所有金額一律經過 `lib/decimal.ts`，`LogMeal` 多一個選填的金額欄位。

**Tech Stack:** Vite · React 19 · TypeScript strict · TanStack Query · react-router 8 · decimal.js · Vitest + Testing Library · Biome

**依據規格：** `docs/superpowers/specs/2026-09-28-p5-expenses-design.md` §6（已審核通過）

---

## 執行環境

- **venv 不在 PATH 上。** 後端指令用 `./.venv/Scripts/python.exe -m ...`。
- 前端指令在 `frontend/` 目錄下跑：
  - 測試：`npm run -s test`（= `vitest run`）
  - 單檔：`npx vitest run tests/expenses.test.tsx`
  - 型別：`npm run -s typecheck`（= `tsc -b`）
  - lint：`npm run -s lint`（= `biome check .`）
- **不要跑 `ruff format --check`**（那是後端的事，而且不是這個專案的閘門）。
- **Docker 可能沒開。** 這份計畫是純前端，測試不需要資料庫；但如果你要跑後端測試，先 `docker ps` 確認 `wallet-db-1` healthy。
- 基準線（master，`d042bd7`）：後端 **598 passed**、前端 **56 檔 280 passed**。

---

## 開工前必讀：這份計畫的文字沒有權威性

**上一份計畫（P5 計畫一）在執行時被抓到 13 個錯誤**，其中 12 個由實作者發現、1 個由 CI 發現。

所以：

1. 每一個「Expected: FAIL」如果**沒有**如預期失敗，**停下來回報**，不要調整測試讓它變紅。綠燈本身就是發現。
2. 預測「只紅 1 條」而實際紅 3 條，**也要回報**。
3. 檔案清單漏東西是常態（計畫一漏了 `frontend/src/api/schema.d.ts`，CI 的 contract job 才抓到）。發現要改的檔案不在清單上，**回報，不要默默改**。
4. 引用既有程式碼的地方（行號、函式名）對不上時，**以現況為準**並回報差異。

---

## 開工前已經查證過的事實

這些是我寫計畫時**實際讀過原始碼**確認的，不是憑記憶：

| 事實 | 出處 |
|---|---|
| `apiFetch<T>(path, init)` 回 `Promise<T \| null>`（204 → `null`），失敗拋 `ApiError` | `frontend/src/api/client.ts` |
| **`formatMacro()` 用 `.toString()`，所以 `"250.50"` 會顯示成 `250.5`** | `frontend/src/lib/decimal.ts`；已用 node 實測 |
| → 金額要 `.toFixed(2)` 才會是 `"250.50"` | 同上實測 |
| **只有 `lib/decimal.ts` 可以 `import decimal.js`，而且有原始碼掃描測試在守** | `frontend/tests/decimal-containment.test.ts` |
| `queryKeys` 是所有 query key 的唯一事實來源 | `frontend/src/api/queries.ts` |
| `mockApi(routes)` 依序比對、用 `url.includes(path)`，**更具體的路徑要排前面** | `frontend/tests/helpers/mock-api.ts` |
| `mockApi` 一律先驗 `authorization`，沒帶就回 401 | 同上 |
| 同一路徑要分辨 GET/POST 必須給 `method` | 同上的註解 |
| 路由在 `App.tsx` 的 `<Routes>` 裡；react-router 8 依「靜態片段比動態片段具體」排名，不是宣告順序 | `frontend/src/App.tsx:94-115` |
| 補劑的入口是 `Today.tsx` 的 `<Link to="/supplements">新增補劑</Link>` | `frontend/src/screens/Today.tsx:167` |
| `NOT_PERSISTED` 以 `queryKey[0]` 判斷要不要進離線快取 | `frontend/src/api/persist.ts:77-81,104` |
| 產生的型別名：`ExpenseResponse` / `ExpenseCreateRequest` / `ExpenseUpdateRequest` / `ExpenseSummaryResponse` / `CategoryTotal` / `ExpenseCategory` | `frontend/src/api/schema.d.ts:1006-1130` |
| `ExpenseResponse` 的 `amount` / `total` 都是 `string`，`count` 是 `number` | 同上 |

---

## 一個這份計畫刻意避開的地雷

**不要用 `<input type="datetime-local">` 送 `spent_at`。**

P5 計畫一的最終審查發現並修掉了一個只在 production 會錯的 bug：後端現在用
`AwareDatetime`，**沒有時區 offset 的 datetime 一律回 422**。而
`<input type="datetime-local">` 產出的正是 `"2026-11-30T23:30"` 這種沒有 offset 的格式。

所以這份計畫：

- **新增花費時 `spent_at` 一律是 `new Date().toISOString()`**（永遠帶 `Z`），沒有日期選擇器
- **編輯時只能改 `amount` / `category` / `note`，不能改日期**

「改日期」刻意不做（YAGNI：花費是當下記的）。將來真的要做時，**必須把
`datetime-local` 的值轉成帶 offset 的字串再送**，否則會拿到 422，而那個 422
的訊息不會告訴你是時區的問題。

---

## 檔案結構

| 檔案 | 負責什麼 |
|---|---|
| `frontend/src/lib/decimal.ts`（改） | 多一個 `formatMoney()`。**金額的格式化只能在這裡**（有掃描測試在守） |
| `frontend/src/api/queries.ts`（改） | 多兩個 query key |
| `frontend/src/api/expenses.ts`（新） | 讀取 hooks（清單、月報表）＋ 型別別名。**只有資料存取，沒有畫面** |
| `frontend/src/screens/Expenses.tsx`（新） | `/expenses` 畫面：清單 + 新增表單 + 改/刪 + 月報表 |
| `frontend/src/components/CategoryBar.tsx`（新） | 一列分類佔比。**不是 `MacroBar`**——那個有「目標值」的概念，這裡沒有 |
| `frontend/src/App.tsx`（改） | 加 `/expenses` 路由 |
| `frontend/src/screens/Today.tsx`（改） | 加入口 `<Link to="/expenses">` |
| `frontend/src/screens/LogMeal.tsx`（改） | 多一個選填的金額欄位 |
| `frontend/tests/decimal.test.ts`（改） | `formatMoney` 的測試 |
| `frontend/tests/expenses.test.tsx`（新） | `/expenses` 畫面的測試 |
| `frontend/tests/today.test.tsx`（改） | 入口連結的測試 |
| `frontend/tests/log-meal.test.tsx`（改） | 金額欄位的測試 |

**`Expenses.tsx` 不拆成多個檔案**：清單、新增、改刪、月報表共用同一組 state 與同一個 query，拆開會讓它們散掉。如果它長到 400 行以上再回頭拆。

---

## Task 1：`formatMoney()`

**Files:**
- Modify: `frontend/src/lib/decimal.ts`
- Test: `frontend/tests/decimal.test.ts`

**為什麼排第一**：純函式、不碰網路，而且後面每一個任務都要用它。而且它修掉一個真實的顯示錯誤。

- [ ] **Step 1: 寫失敗的測試**

加到 `frontend/tests/decimal.test.ts` 檔尾（**先讀一次現有的 import，`formatMoney` 要加進去**）：

```ts
describe("formatMoney", () => {
	it("保留兩位小數——錢的 250.50 不能顯示成 250.5", () => {
		// 這是 formatMacro 不能拿來用的原因：它走 .toString()，
		// 而 Decimal 會把尾數的 0 正規化掉（已用 node 實測）。
		// 營養素顯示成 250.5 沒問題，金額顯示成 250.5 是錯的。
		expect(formatMoney("250.50")).toBe("250.50");
	});

	it("整數也補到兩位", () => {
		expect(formatMoney("250")).toBe("250.00");
	});

	it("零是 0.00，不是 0", () => {
		// 後端空月份回的就是 "0.00"（app/api/routes/expenses.py 的 _ZERO）。
		expect(formatMoney("0.00")).toBe("0.00");
		expect(formatMoney("0")).toBe("0.00");
	});

	it("不因浮點誤差失真", () => {
		// 0.1 + 0.2 的經典問題：這個函式只做格式化不做運算，
		// 但它必須忠實呈現後端送來的字串，不能中途變成 number。
		expect(formatMoney("0.30")).toBe("0.30");
		expect(formatMoney("99999999.99")).toBe("99999999.99");
	});
});

describe("formatMacro 與 formatMoney 的差別（這就是不能共用的證據）", () => {
	it("同一個輸入，兩者輸出不同", () => {
		expect(formatMacro("250.50")).toBe("250.5");
		expect(formatMoney("250.50")).toBe("250.50");
	});
});
```

- [ ] **Step 2: 跑測試確認它失敗**

```
cd frontend
npx vitest run tests/decimal.test.ts
```

Expected: 失敗。`formatMoney` 還不存在——可能是 TypeScript 編譯錯誤
（`tsc -b` 在 vitest 的 typecheck 階段），也可能是執行期的
`formatMoney is not a function`。**照實回報是哪一種。**

- [ ] **Step 3: 實作**

在 `frontend/src/lib/decimal.ts` 的 `formatMacro` **之後**加上：

```ts
/** 金額的顯示字串，固定兩位小數。
 *
 *  **不能用 `formatMacro()`。** 那個函式走 `Decimal.toString()`，而 Decimal
 *  會把尾數的 0 正規化掉——`"250.50"` 變成 `"250.5"`（已用 node 實測）。
 *  營養素顯示成 `250.5` 沒問題；金額顯示成 `250.5` 是錯的，而且是那種
 *  「看起來只是少一個字」、實際上讓人懷疑系統算錯錢的錯。
 *
 *  後端的 `amount` 是 `numeric(10,2)`、`summary.total` 是 Decimal 相加的
 *  結果，兩者都保證最多兩位小數，所以 `toFixed(2)` 不會四捨五入掉任何
 *  真實的精度——它只是把顯示補齊。
 */
export function formatMoney(value: Numeric): string {
	return new Decimal(value).toFixed(2);
}
```

- [ ] **Step 4: 跑測試確認通過**

```
npx vitest run tests/decimal.test.ts
```
Expected: 全部 PASS

- [ ] **Step 5: 確認沒有破壞 decimal 圍堵的掃描測試**

```
npx vitest run tests/decimal-containment.test.ts
```
Expected: PASS

> 這條測試掃 `src/` 底下所有 `.ts`/`.tsx`，只允許 `src/lib/decimal.ts`
> 出現 `decimal.js`。**後面的任務如果在畫面裡 `new Decimal()`，會被這條擋下來**
> ——那是刻意的，金額的所有運算與格式化都只能經過這個模組。

- [ ] **Step 6: 突變測試——證明那幾條測試真的守得住**

把實作暫時改回 `.toString()`：

```ts
	return new Decimal(value).toString();
```

```
npx vitest run tests/decimal.test.ts
```
Expected: `formatMoney` 的 4 條裡**至少 3 條 FAIL**
（`250.50`→`250.5`、`250`→`250`、`0`→`0`），以及「兩者輸出不同」那條也 FAIL。

> `formatMoney("0.30")` 這條可能照樣綠（`Decimal("0.30").toString()` 是 `"0.3"`
> ——應該也會紅）。**照實回報哪幾條紅、哪幾條綠。**

**改回 `.toFixed(2)`。**

- [ ] **Step 7: 靜態檢查**

```
npm run -s typecheck
npm run -s lint
```
Expected: 兩者都通過

- [ ] **Step 8: Commit**

```bash
git add frontend/src/lib/decimal.ts frontend/tests/decimal.test.ts
git commit -m "feat(decimal): 加上 formatMoney，金額固定兩位小數

formatMacro 走 Decimal.toString()，而 Decimal 會把尾數的 0 正規化掉——
\"250.50\" 變成 \"250.5\"（node 實測）。營養素那樣沒問題，金額那樣是錯的。

放在 lib/decimal.ts 是因為 tests/decimal-containment.test.ts 用原始碼掃描
強制「只有這個檔案可以 import decimal.js」。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 2：query key 與資料存取層

**Files:**
- Modify: `frontend/src/api/queries.ts`
- Create: `frontend/src/api/expenses.ts`
- Test: `frontend/tests/queries.test.tsx`

- [ ] **Step 1: 加 query key**

在 `frontend/src/api/queries.ts` 的 `queryKeys` 物件裡，`mealPhoto` **之前**加上：

```ts
	/** 某個月的花費清單。`month` 是 `"YYYY-MM"`，或 `null` 代表
	 *  「讓後端決定這個月」（後端省略 `?month=` 時走
	 *  `this_month_in_timezone(user.timezone)`）——跟 `dailyStats` 不帶日期
	 *  是同一條規矩：**前端不該自己算現在是哪個月**。
	 *
	 *  `null` 要出現在 key 裡（而不是省略），否則「這個月」與某個明確月份
	 *  會撞成同一個 key。 */
	expenses: (month: string | null) => ["expenses", "list", month] as const,
	/** 某個月的報表。**刻意掛在 `["expenses"]` 底下。**
	 *
	 *  這跟 `mealPhoto` 的決定正好相反，而且理由是對稱的：照片不該被
	 *  「記一餐」連帶失效（照片沒變、而且每張 500KB），但**報表一定要被
	 *  「記一筆花費」連帶失效**——錢變了，清單跟總額必須一起重取。
	 *
	 *  所以新增／修改／刪除之後只要
	 *  `invalidateQueries({ queryKey: expensesAll })`，前綴比對會同時打到
	 *  清單與報表，那正是要的行為。 */
	expenseSummary: (month: string | null) =>
		["expenses", "summary", month] as const,
	/** 「所有月份的花費與報表」這個前綴，給 `invalidateQueries` 用。
	 *
	 *  寫成具名 key 而不是在呼叫端手打 `["expenses"]`，理由跟這個檔案頂端
	 *  說的一樣：兩邊各拼一次字串，某天其中一邊改了，失效就靜默失靈——
	 *  而症狀是「記了一筆花費，總額沒變」。 */
	expensesAll: ["expenses"] as const,
```

- [ ] **Step 2: 寫資料存取層**

Create `frontend/src/api/expenses.ts`:

```ts
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "./client";
import { queryKeys } from "./queries";
import type { components } from "./schema";

export type Expense = components["schemas"]["ExpenseResponse"];
export type ExpenseCategory = components["schemas"]["ExpenseCategory"];
export type ExpenseSummary = components["schemas"]["ExpenseSummaryResponse"];
export type CategoryTotal = components["schemas"]["CategoryTotal"];

/** 分類的中文標籤。**七個值必須全部列出。**
 *
 *  型別是 `Record<ExpenseCategory, string>`（不是 `Partial`）——漏一個
 *  就是 TypeScript 編譯錯誤。後端加分類時（規格 §3.4 明說這份清單會改），
 *  重新產生 `schema.d.ts` 之後這裡會立刻紅，而不是在畫面上顯示一個
 *  英文代碼。 */
export const CATEGORY_LABELS: Record<ExpenseCategory, string> = {
	food: "飲食",
	transport: "交通",
	daily: "日用",
	entertainment: "娛樂",
	medical: "醫療",
	housing: "居住",
	other: "其他",
};

/** 顯示用的分類順序。跟 `CATEGORY_LABELS` 一樣是七個全列。
 *
 *  新增表單的下拉選單用這個順序，**不是 `Object.keys()`** ——
 *  物件的鍵順序雖然在實務上穩定，但那不是我們想依賴的保證，
 *  而「飲食排第一」是刻意的（它是最常用的那個）。 */
export const CATEGORY_ORDER: readonly ExpenseCategory[] = [
	"food",
	"transport",
	"daily",
	"entertainment",
	"medical",
	"housing",
	"other",
];

/** 這個月（或指定月份）的花費清單。
 *
 *  `month` 為 `null` 時**不帶 `?month=`**，讓後端用使用者時區決定這個月
 *  （`this_month_in_timezone`）。前端不自己算月份——跟 `useDailyStats`
 *  不自己算今天是同一條規矩。 */
export function useExpenses(month: string | null) {
	return useQuery({
		queryKey: queryKeys.expenses(month),
		queryFn: () =>
			apiFetch<Expense[]>(
				month === null ? "/api/expenses" : `/api/expenses?month=${month}`,
			),
	});
}

/** 月報表：總額 + 分類佔比。`month` 的語意同 `useExpenses`。 */
export function useExpenseSummary(month: string | null) {
	return useQuery({
		queryKey: queryKeys.expenseSummary(month),
		queryFn: () =>
			apiFetch<ExpenseSummary>(
				month === null
					? "/api/expenses/summary"
					: `/api/expenses/summary?month=${month}`,
			),
	});
}
```

- [ ] **Step 3: 寫 query key 的測試**

加到 `frontend/tests/queries.test.tsx` 檔尾（**先讀現有 import**）：

```ts
describe("花費的 query key", () => {
	it("expensesAll 是清單與報表兩者的前綴", () => {
		// 這條守的是「記一筆花費之後，清單跟總額要一起重取」。
		// TanStack Query 的 invalidateQueries 是前綴比對，所以兩個 key
		// 都必須以 expensesAll 開頭——否則失效會靜默漏掉其中一個，
		// 症狀是「記了一筆，總額沒變」。
		const prefix = queryKeys.expensesAll;
		expect(queryKeys.expenses(null).slice(0, prefix.length)).toEqual([
			...prefix,
		]);
		expect(queryKeys.expenseSummary(null).slice(0, prefix.length)).toEqual([
			...prefix,
		]);
	});

	it("清單與報表是不同的 key——不會互相覆蓋", () => {
		expect(queryKeys.expenses("2026-12")).not.toEqual(
			queryKeys.expenseSummary("2026-12"),
		);
	});

	it("null（這個月）與明確月份是不同的 key", () => {
		// null 必須出現在 key 裡。省略的話「這個月」跟某個明確月份會撞成
		// 同一份快取，而使用者會看到錯的月份資料。
		expect(queryKeys.expenses(null)).not.toEqual(
			queryKeys.expenses("2026-12"),
		);
	});
});
```

- [ ] **Step 4: 跑測試確認通過**

```
cd frontend
npx vitest run tests/queries.test.ts tests/queries.test.tsx
```

> 檔名我沒有確認是 `.ts` 還是 `.tsx`——`ls` 顯示是 `queries.test.tsx`。
> 如果指令報找不到檔案，用實際存在的那個，並回報。

Expected: 全部 PASS（這一步是純資料結構，不需要先紅）

- [ ] **Step 5: 突變測試——證明前綴那條守得住**

把 `expenseSummary` 暫時改成獨立命名空間：

```ts
	expenseSummary: (month: string | null) =>
		["expense-summary", month] as const,
```

```
npx vitest run tests/queries.test.tsx
```
Expected: `expensesAll 是清單與報表兩者的前綴` **FAIL**

**改回來。**

- [ ] **Step 6: 靜態檢查**

```
npm run -s typecheck
npm run -s lint
```
Expected: 兩者都通過

- [ ] **Step 7: Commit**

```bash
git add frontend/src/api/queries.ts frontend/src/api/expenses.ts frontend/tests/queries.test.tsx
git commit -m "feat(expenses): query key 與資料存取層

expenseSummary 刻意掛在 [\"expenses\"] 底下——跟 mealPhoto 的決定相反，
而理由是對稱的：照片不該被記一餐連帶失效（沒變、每張 500KB），但報表
一定要被記一筆花費連帶失效（錢變了，清單跟總額要一起重取）。

month 為 null 時不帶 ?month=，讓後端用使用者時區決定這個月——前端不自己
算月份，跟 dailyStats 不自己算今天同一條規矩。null 必須出現在 key 裡，
否則「這個月」會跟某個明確月份撞成同一份快取。

CATEGORY_LABELS 是 Record 不是 Partial：後端加分類時（規格 §3.4 說會改）
重新產生 schema.d.ts 之後這裡會編譯錯誤，而不是在畫面上顯示英文代碼。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 3：`/expenses` 畫面——清單與新增

**Files:**
- Create: `frontend/src/screens/Expenses.tsx`
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/screens/Today.tsx`
- Test: `frontend/tests/expenses.test.tsx`
- Test: `frontend/tests/today.test.tsx`

- [ ] **Step 1: 寫失敗的測試**

Create `frontend/tests/expenses.test.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetRefreshStateForTests } from "../src/auth/refresh";
import { clearTokens, setTokens } from "../src/auth/store";
import { Expenses } from "../src/screens/Expenses";
import { json, mockApi } from "./helpers/mock-api";

// 不需要 MemoryRouter：這個畫面沒有 <Link> 也沒有 useNavigate
// （清單、新增、改刪、報表全在同一個畫面裡，跟 Supplements.tsx 同一個作法）。
function wrap(children: ReactNode) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const LUNCH = {
	id: 1,
	amount: "180.00",
	category: "food" as const,
	spent_at: "2026-12-15T04:00:00+00:00",
	note: "便當",
	meal_id: 11,
};

const TRAIN = {
	id: 2,
	amount: "250.50",
	category: "transport" as const,
	spent_at: "2026-12-14T02:00:00+00:00",
	note: null,
	meal_id: null,
};

const EMPTY_SUMMARY = { month: "2026-12", total: "0.00", by_category: [] };

/** 從 fetch 的 spy 裡挖出某一次請求送出的 JSON body。
 *
 *  **用 `fetchMock.mock.calls` 而不是再包一層 spy。** `mockApi()` 回傳的就是
 *  `vi.spyOn()` 的結果，呼叫記錄裡本來就有 `init`——再疊一層
 *  `vi.spyOn(globalThis, "fetch")` 去攔 body 不只多餘，還會因為
 *  `beforeEach` 的 `vi.restoreAllMocks()` 與疊加順序變得很難推理。
 *
 *  回傳 `Record<string, unknown> | null` 而不是 `any`：biome 的
 *  `recommended` preset 含 `noExplicitAny`，而測試檔也在 lint 範圍內
 *  （`biome.jsonc` 的 `includes` 只排除 `src/api/schema.d.ts`）。
 *  欄位取出來是 `unknown`，`expect(...)` 照樣吃得下。
 *
 *  **呼叫端一律用 `sent?.欄位`**：回傳型別含 `null`，strict 模式下
 *  直接 `sent.欄位` 是編譯錯誤。而 `undefined` 也不會等於期望值，
 *  所以斷言的鑑別力沒有因為 `?.` 而變弱。 */
function sentBody(
	fetchMock: ReturnType<typeof mockApi>,
	method: string,
	pathPart: string,
): Record<string, unknown> | null {
	const call = fetchMock.mock.calls.find(
		([input, init]) =>
			(init?.method ?? "GET").toUpperCase() === method.toUpperCase() &&
			String(input).includes(pathPart),
	);
	if (call === undefined) return null;
	return JSON.parse(String(call[1]?.body));
}

/** 這個 spy 收到過的所有 HTTP method。 */
function methodsOf(fetchMock: ReturnType<typeof mockApi>): string[] {
	return fetchMock.mock.calls.map(([, init]) =>
		(init?.method ?? "GET").toUpperCase(),
	);
}

beforeEach(() => {
	localStorage.clear();
	clearTokens();
	resetRefreshStateForTests();
	vi.restoreAllMocks();
	setTokens({ access_token: "a", refresh_token: "r" });
});

describe("記帳 /expenses", () => {
	it("顯示這個月的花費，金額保留兩位小數", async () => {
		mockApi([
			// 更具體的路徑排前面：mock-api 用 url.includes(path) 依序比對，
			// "/api/expenses" 會先吃掉 "/api/expenses/summary" 的請求。
			{
				method: "GET",
				path: "/api/expenses/summary",
				handler: () => json(EMPTY_SUMMARY),
			},
			{
				method: "GET",
				path: "/api/expenses",
				handler: () => json([LUNCH, TRAIN]),
			},
		]);

		render(wrap(<Expenses />));

		expect(await screen.findByText("便當")).toBeInTheDocument();
		// 250.50 不能顯示成 250.5——這是 formatMoney 存在的理由
		expect(screen.getByText("250.50")).toBeInTheDocument();
		expect(screen.getByText("180.00")).toBeInTheDocument();
		// 分類顯示中文，不是 "food"
		expect(screen.getByText("飲食")).toBeInTheDocument();
		expect(screen.getByText("交通")).toBeInTheDocument();
	});

	it("沒有花費時講明白，不是空白畫面", async () => {
		mockApi([
			{
				method: "GET",
				path: "/api/expenses/summary",
				handler: () => json(EMPTY_SUMMARY),
			},
			{ method: "GET", path: "/api/expenses", handler: () => json([]) },
		]);

		render(wrap(<Expenses />));

		expect(await screen.findByText("這個月還沒有記錄花費")).toBeInTheDocument();
	});

	it("新增一筆花費，送出的 spent_at 帶時區偏移", async () => {
		const fetchMock = mockApi([
			{
				method: "GET",
				path: "/api/expenses/summary",
				handler: () => json(EMPTY_SUMMARY),
			},
			{ method: "GET", path: "/api/expenses", handler: () => json([]) },
			{
				method: "POST",
				path: "/api/expenses",
				handler: () => json(TRAIN, 201),
			},
		]);

		render(wrap(<Expenses />));
		await screen.findByText("這個月還沒有記錄花費");

		await userEvent.type(screen.getByLabelText("金額"), "250.50");
		await userEvent.selectOptions(screen.getByLabelText("分類"), "transport");
		await userEvent.click(screen.getByRole("button", { name: "記一筆" }));

		await waitFor(() =>
			expect(sentBody(fetchMock, "POST", "/api/expenses")).not.toBeNull(),
		);
		const sent = sentBody(fetchMock, "POST", "/api/expenses");
		expect(sent?.amount).toBe("250.50");
		expect(sent?.category).toBe("transport");
		// **關鍵斷言**：後端用 AwareDatetime，沒有 offset 的 datetime 會 422。
		// toISOString() 永遠以 Z 結尾。
		expect(sent?.spent_at).toMatch(/(Z|[+-]\d{2}:\d{2})$/);
	});

	it("金額留空時不送請求", async () => {
		const fetchMock = mockApi([
			{
				method: "GET",
				path: "/api/expenses/summary",
				handler: () => json(EMPTY_SUMMARY),
			},
			{ method: "GET", path: "/api/expenses", handler: () => json([]) },
		]);

		render(wrap(<Expenses />));
		await screen.findByText("這個月還沒有記錄花費");
		const before = fetchMock.mock.calls.length;

		await userEvent.click(screen.getByRole("button", { name: "記一筆" }));

		expect(await screen.findByRole("alert")).toHaveTextContent("請輸入金額");
		// 沒有多打任何請求——驗證擋在前端，不是靠後端回 422
		expect(fetchMock.mock.calls.length).toBe(before);
	});
});
```

- [ ] **Step 2: 跑測試確認它失敗**

```
cd frontend
npx vitest run tests/expenses.test.tsx
```

Expected: 全部失敗，`Cannot find module '../src/screens/Expenses'`
（或 TypeScript 編譯錯誤）。**照實回報。**

- [ ] **Step 3: 寫畫面**

Create `frontend/src/screens/Expenses.tsx`:

```tsx
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { apiFetch } from "../api/client";
import { ApiError } from "../api/errors";
import {
	CATEGORY_LABELS,
	CATEGORY_ORDER,
	type Expense,
	type ExpenseCategory,
	useExpenses,
} from "../api/expenses";
import { queryKeys } from "../api/queries";
import { formatMoney } from "../lib/decimal";

/** 一筆花費的顯示列。 */
function ExpenseRow({ expense }: { expense: Expense }) {
	return (
		<li data-testid={`expense-${expense.id}`}>
			<span>{CATEGORY_LABELS[expense.category]}</span>
			<span>{formatMoney(expense.amount)}</span>
			{expense.note !== null && <span>{expense.note}</span>}
			{/* meal_id 有值代表這筆是記一餐時順手填的餐費（規格 §4.1）。
			    標示出來，使用者才知道為什麼刪掉那一餐之後這筆錢還在。 */}
			{expense.meal_id !== null && <span>（餐費）</span>}
		</li>
	);
}

/** 記帳：這個月的花費清單 + 新增。
 *
 *  **入口在 `Today.tsx`，不是第六個 tab**（規格 §6.1、§6.2 方向 1）——
 *  tab bar 現在 4 格（管理員 5 格），320px 寬度下第六格只剩 53.3px，
 *  而「今日總覽」四個字約 56px，塞不進去。
 *
 *  **`month` 固定傳 `null`**：讓後端用使用者時區決定「這個月」
 *  （`this_month_in_timezone`）。前端沒有月份選擇器——規格 §1.1 要回答的
 *  是「**這個**月花了多少」，看別的月份不在範圍內（規格 §8）。
 */
export function Expenses() {
	const queryClient = useQueryClient();
	const expensesQuery = useExpenses(null);
	const expenses = expensesQuery.data ?? [];

	const [amount, setAmount] = useState("");
	const [category, setCategory] = useState<ExpenseCategory>("food");
	const [note, setNote] = useState("");
	const [error, setError] = useState<string | null>(null);

	const createExpense = useMutation({
		mutationFn: () =>
			apiFetch<Expense>("/api/expenses", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					// 金額一律以字串送出，不要 Number()（規格 §2.4）。
					amount,
					category,
					// **一律用 toISOString()，永遠帶 Z。**
					// 後端是 AwareDatetime，沒有 offset 的 datetime 會回 422
					// （P5 計畫一最終審查修掉的那個 bug）。這也是這個畫面
					// 刻意沒有日期選擇器的原因之一——<input type="datetime-local">
					// 產出的就是沒有 offset 的格式。
					spent_at: new Date().toISOString(),
					note: note.trim() === "" ? null : note.trim(),
				}),
			}),
		onSuccess: () => {
			setAmount("");
			setNote("");
			setError(null);
			// 一次失效打到清單與報表兩者（queryKeys.expensesAll 是兩者的前綴）。
			queryClient.invalidateQueries({ queryKey: queryKeys.expensesAll });
		},
		onError: (caught: unknown) => {
			if (caught instanceof ApiError && caught.code === "VALIDATION_ERROR") {
				setError("金額格式不對，請輸入大於 0 的數字");
				return;
			}
			setError("記帳失敗，請再試一次");
		},
	});

	function handleSubmit() {
		// 擋在前端，不是靠後端回 422——空字串送出去只會換來一個
		// 使用者看不懂的驗證錯誤，而且白打一次請求。
		if (amount.trim() === "") {
			setError("請輸入金額");
			return;
		}
		setError(null);
		createExpense.mutate();
	}

	return (
		<section>
			<h1>記帳</h1>

			<h2>記一筆</h2>
			<div>
				<label htmlFor="expense-amount">金額</label>
				{/* inputMode="decimal" 讓手機跳數字鍵盤。
				    font-size 由 index.css 的全域規則保證 ≥16px（iOS Safari
				    在 <16px 時會自動放大整個頁面，P3-C 踩過）——
				    **不要在這裡覆寫成更小的字**。 */}
				<input
					id="expense-amount"
					type="text"
					inputMode="decimal"
					value={amount}
					onChange={(event) => setAmount(event.target.value)}
				/>
			</div>
			<div>
				<label htmlFor="expense-category">分類</label>
				<select
					id="expense-category"
					value={category}
					onChange={(event) =>
						setCategory(event.target.value as ExpenseCategory)
					}
				>
					{CATEGORY_ORDER.map((value) => (
						<option key={value} value={value}>
							{CATEGORY_LABELS[value]}
						</option>
					))}
				</select>
			</div>
			<div>
				<label htmlFor="expense-note">備註</label>
				<input
					id="expense-note"
					type="text"
					value={note}
					onChange={(event) => setNote(event.target.value)}
				/>
			</div>
			<button type="button" onClick={handleSubmit}>
				記一筆
			</button>
			{error !== null && <p role="alert">{error}</p>}

			<h2>這個月</h2>
			{expensesQuery.isPending ? (
				<p>載入中…</p>
			) : expenses.length === 0 ? (
				<p>這個月還沒有記錄花費</p>
			) : (
				<ul>
					{expenses.map((expense) => (
						<ExpenseRow key={expense.id} expense={expense} />
					))}
				</ul>
			)}
		</section>
	);
}
```

- [ ] **Step 4: 加路由**

Modify `frontend/src/App.tsx` — 在 `<Route path="/supplements" ... />` 之後加：

```tsx
							{/* 記帳（P5 計畫二）。刻意不加第六個 tab，入口在
								Today.tsx——320px 寬度下 tab bar 第六格只剩 53.3px，
								而「今日總覽」四個字約 56px（規格 §6.1、§6.2 方向 1）。 */}
							<Route path="/expenses" element={<Expenses />} />
```

並在檔案上方的 import 加上 `Expenses`（跟其他 screen 同一種形式，照字母序插入）。

- [ ] **Step 5: 加入口連結**

Modify `frontend/src/screens/Today.tsx` — 在 `<MealList />` 之後、`<h2>今日補劑</h2>` 之前加：

```tsx
			{/* 記帳的入口（P5 計畫二）。跟「新增補劑」同一個作法：
			    不加第六個 tab（規格 §6.2 方向 1）。 */}
			<Link to="/expenses">記帳</Link>
```

`Link` 已經在這個檔案 import 過了（`<Link to="/supplements">`），不用再加。

- [ ] **Step 6: 加入口的測試**

加到 `frontend/tests/today.test.tsx` 的 `describe` 裡。

**已查證過的現況**：這個檔案用 `mockApiByPath as mockApi`（**物件形式**）、
`wrap()` 裡有 `MemoryRouter`（因為「今日補劑」已經有一個 `<Link>`），
而既有測試只 mock `/api/stats/daily` 與 `/api/supplements/today` 兩條。

```tsx
	it("有記帳的入口連結", async () => {
		// 這條守的是「記帳有一條進得去的路」。這個專案已經**三次**蓋好後端
		// 卻沒有任何前端入口（食物、補劑、記帳），沒有這條測試，拿掉那個
		// <Link> 不會有任何東西變紅。
		mockApi({
			"/api/stats/daily": () => json(STATS_WITH_TARGET),
			"/api/supplements/today": () => json([]),
		});

		render(wrap(<Today />));

		const link = await screen.findByRole("link", { name: "記帳" });
		expect(link).toHaveAttribute("href", "/expenses");
	});
```

> **刻意不 mock `/api/meals`**，跟既有測試一致。`<MealList />` 掛在 `Today`
> 裡面會去打那個端點，而 `mockApi` 對沒準備的路徑會 throw —— 那個 throw
> 被 TanStack Query 接住變成 query 的 error 狀態（`wrap()` 設了
> `retry: false`），不會讓測試失敗。既有的 4 條測試就是這樣過的。
>
> **如果加了這條之後既有測試開始紅，回報** —— 那代表我對這個行為的理解有誤。

- [ ] **Step 7: 跑測試確認通過**

```
npx vitest run tests/expenses.test.tsx tests/today.test.tsx
```
Expected: 全部 PASS

- [ ] **Step 8: 突變測試——證明 `spent_at` 那條守得住**

把 `spent_at` 暫時改成沒有 offset 的格式：

```ts
					spent_at: "2026-12-15T12:00:00",
```

```
npx vitest run tests/expenses.test.tsx
```
Expected: `新增一筆花費，送出的 spent_at 帶時區偏移` **FAIL**
（正規表示式不符）。

> 這條測試是在前端守一個**後端的**約束。它不會發現後端改掉 `AwareDatetime`，
> 但它會發現前端開始送 naive datetime——而那是這兩邊之間唯一真的會壞的方向。

**改回 `new Date().toISOString()`。**

- [ ] **Step 9: 突變測試——證明入口連結那條守得住**

把 `Today.tsx` 的 `<Link to="/expenses">記帳</Link>` 整行暫時刪掉。

```
npx vitest run tests/today.test.tsx
```
Expected: `有記帳的入口連結` **FAIL**

**改回來。**

- [ ] **Step 10: 靜態檢查**

```
npm run -s typecheck
npm run -s lint
```
Expected: 兩者都通過

- [ ] **Step 11: Commit**

```bash
git add frontend/src/screens/Expenses.tsx frontend/src/App.tsx frontend/src/screens/Today.tsx frontend/tests/expenses.test.tsx frontend/tests/today.test.tsx
git commit -m "feat(expenses): /expenses 畫面——清單與新增

入口在 Today.tsx 不是第六個 tab（規格 §6.2 方向 1）：320px 下 tab bar
第六格只剩 53.3px，而「今日總覽」四個字約 56px。

spent_at 一律用 new Date().toISOString()，永遠帶 Z。後端是 AwareDatetime，
naive datetime 會回 422（計畫一最終審查修掉的那個 bug）——這也是這個畫面
刻意沒有日期選擇器的原因，datetime-local 產出的就是沒有 offset 的格式。
有一條測試用正規表示式守這件事。

入口連結也有測試守：這個專案已經兩次蓋好後端卻沒有前端入口（食物、補劑），
沒有那條測試，拿掉 <Link> 不會有任何東西變紅。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 4：改與刪一筆花費

**Files:**
- Modify: `frontend/src/screens/Expenses.tsx`
- Test: `frontend/tests/expenses.test.tsx`

**範圍**：只能改 `amount` / `category` / `note`。**不能改日期**——理由見本文件開頭「刻意避開的地雷」。

刪除**要確認步驟**（跟 P6 的決定一致：誤觸就永久失去資料）。

- [ ] **Step 1: 寫失敗的測試**

加到 `frontend/tests/expenses.test.tsx` 的 `describe` 裡：

```tsx
	it("改掉一筆的金額", async () => {
		const fetchMock = mockApi([
			{
				method: "GET",
				path: "/api/expenses/summary",
				handler: () => json(EMPTY_SUMMARY),
			},
			{ method: "GET", path: "/api/expenses", handler: () => json([TRAIN]) },
			{
				method: "PATCH",
				path: "/api/expenses/2",
				handler: () => json({ ...TRAIN, amount: "300.00" }),
			},
		]);

		render(wrap(<Expenses />));
		await screen.findByText("250.50");

		await userEvent.click(screen.getByRole("button", { name: "修改" }));
		const amountInput = screen.getByLabelText("修改金額");
		await userEvent.clear(amountInput);
		await userEvent.type(amountInput, "300");
		await userEvent.click(screen.getByRole("button", { name: "儲存" }));

		await waitFor(() =>
			expect(sentBody(fetchMock, "PATCH", "/api/expenses/2")).not.toBeNull(),
		);
		const sent = sentBody(fetchMock, "PATCH", "/api/expenses/2");
		expect(sent?.amount).toBe("300");
		// **關鍵**：不送 spent_at。送了就要帶 offset，而這個畫面沒有
		// 日期選擇器——不送最安全，而且後端的 exclude_unset 會正確處理。
		expect(sent).not.toHaveProperty("spent_at");
		// 也不送 meal_id：後端的 ExpenseUpdateRequest 根本沒有這個欄位
		// （extra="ignore" 會丟掉它），但前端也不該送。
		expect(sent).not.toHaveProperty("meal_id");
	});

	it("刪除要先確認", async () => {
		const fetchMock = mockApi([
			{
				method: "GET",
				path: "/api/expenses/summary",
				handler: () => json(EMPTY_SUMMARY),
			},
			{ method: "GET", path: "/api/expenses", handler: () => json([TRAIN]) },
		]);

		render(wrap(<Expenses />));
		await screen.findByText("250.50");
		const before = fetchMock.mock.calls.length;

		await userEvent.click(screen.getByRole("button", { name: "刪除" }));

		// 按了刪除之後**還沒有**打任何請求——先出現確認
		expect(fetchMock.mock.calls.length).toBe(before);
		expect(screen.getByText("確定要刪掉這筆花費嗎？")).toBeInTheDocument();
	});

	it("確認之後才真的刪", async () => {
		const fetchMock = mockApi([
			{
				method: "GET",
				path: "/api/expenses/summary",
				handler: () => json(EMPTY_SUMMARY),
			},
			{ method: "GET", path: "/api/expenses", handler: () => json([TRAIN]) },
			{
				method: "DELETE",
				path: "/api/expenses/2",
				handler: () => new Response(null, { status: 204 }),
			},
		]);

		render(wrap(<Expenses />));
		await screen.findByText("250.50");

		await userEvent.click(screen.getByRole("button", { name: "刪除" }));
		await userEvent.click(screen.getByRole("button", { name: "確定刪除" }));

		await waitFor(() => expect(methodsOf(fetchMock)).toContain("DELETE"));
	});

	it("取消確認就不刪", async () => {
		const fetchMock = mockApi([
			{
				method: "GET",
				path: "/api/expenses/summary",
				handler: () => json(EMPTY_SUMMARY),
			},
			{ method: "GET", path: "/api/expenses", handler: () => json([TRAIN]) },
		]);

		render(wrap(<Expenses />));
		await screen.findByText("250.50");

		await userEvent.click(screen.getByRole("button", { name: "刪除" }));
		await userEvent.click(screen.getByRole("button", { name: "取消" }));

		expect(methodsOf(fetchMock)).not.toContain("DELETE");
		expect(screen.queryByText("確定要刪掉這筆花費嗎？")).not.toBeInTheDocument();
	});
```

- [ ] **Step 2: 跑測試確認它失敗**

```
npx vitest run tests/expenses.test.tsx
```
Expected: 新加的 4 條 FAIL（找不到「修改」/「刪除」按鈕），Task 3 的 4 條照樣 PASS。

- [ ] **Step 3: 實作**

在 `frontend/src/screens/Expenses.tsx` 裡：

把 `ExpenseRow` 整個換成下面這個版本（它現在需要 callback）：

```tsx
type RowProps = {
	expense: Expense;
	onEdited: () => void;
};

/** 一筆花費：顯示、修改、刪除。
 *
 *  **確認步驟用畫面上的一段文字 + 兩個按鈕，不是 `window.confirm()`。**
 *  `window.confirm` 在 jsdom 裡是未實作的（會需要 stub），而且不能用
 *  螢幕閱讀器讀到的方式表達「這是一個需要決定的狀態」。這裡用一個
 *  `useState` 開關 + `role="alertdialog"`，測試與無障礙都直接可用。
 *
 *  **不能改日期。** `spent_at` 不在可改欄位裡——改日期需要一個
 *  `<input type="datetime-local">`，而它產出的是沒有時區 offset 的字串，
 *  後端的 `AwareDatetime` 會回 422。真的要做時必須先轉成帶 offset 的格式
 *  （見計畫開頭「刻意避開的地雷」）。
 */
function ExpenseRow({ expense, onEdited }: RowProps) {
	const [editing, setEditing] = useState(false);
	const [confirmingDelete, setConfirmingDelete] = useState(false);
	const [draftAmount, setDraftAmount] = useState(expense.amount);
	const [rowError, setRowError] = useState<string | null>(null);

	const save = useMutation({
		mutationFn: () =>
			apiFetch<Expense>(`/api/expenses/${expense.id}`, {
				method: "PATCH",
				headers: { "content-type": "application/json" },
				// **只送 amount。** 後端用 exclude_unset，沒帶的欄位不動。
				// 刻意不送 spent_at（沒有日期選擇器）也不送 meal_id（不可改）。
				body: JSON.stringify({ amount: draftAmount }),
			}),
		onSuccess: () => {
			setEditing(false);
			setRowError(null);
			onEdited();
		},
		onError: () => setRowError("修改失敗，請再試一次"),
	});

	const remove = useMutation({
		mutationFn: () =>
			apiFetch(`/api/expenses/${expense.id}`, { method: "DELETE" }),
		onSuccess: () => {
			setConfirmingDelete(false);
			onEdited();
		},
		onError: () => setRowError("刪除失敗，請再試一次"),
	});

	return (
		<li data-testid={`expense-${expense.id}`}>
			<span>{CATEGORY_LABELS[expense.category]}</span>
			<span>{formatMoney(expense.amount)}</span>
			{expense.note !== null && <span>{expense.note}</span>}
			{/* meal_id 有值代表這筆是記一餐時順手填的餐費（規格 §4.1）。
			    標示出來，使用者才知道為什麼刪掉那一餐之後這筆錢還在。 */}
			{expense.meal_id !== null && <span>（餐費）</span>}

			{editing ? (
				<>
					<label htmlFor={`edit-amount-${expense.id}`}>修改金額</label>
					<input
						id={`edit-amount-${expense.id}`}
						type="text"
						inputMode="decimal"
						value={draftAmount}
						onChange={(event) => setDraftAmount(event.target.value)}
					/>
					<button type="button" onClick={() => save.mutate()}>
						儲存
					</button>
					<button type="button" onClick={() => setEditing(false)}>
						放棄
					</button>
				</>
			) : (
				<button type="button" onClick={() => setEditing(true)}>
					修改
				</button>
			)}

			{confirmingDelete ? (
				<div role="alertdialog" aria-label="確認刪除">
					<p>確定要刪掉這筆花費嗎？</p>
					<button type="button" onClick={() => remove.mutate()}>
						確定刪除
					</button>
					<button
						type="button"
						onClick={() => setConfirmingDelete(false)}
					>
						取消
					</button>
				</div>
			) : (
				<button type="button" onClick={() => setConfirmingDelete(true)}>
					刪除
				</button>
			)}

			{rowError !== null && <p role="alert">{rowError}</p>}
		</li>
	);
}
```

在 `Expenses()` 裡，把渲染清單那段的 `<ExpenseRow key={expense.id} expense={expense} />` 改成：

```tsx
						<ExpenseRow
							key={expense.id}
							expense={expense}
							onEdited={() =>
								queryClient.invalidateQueries({
									queryKey: queryKeys.expensesAll,
								})
							}
						/>
```

- [ ] **Step 4: 跑測試確認通過**

```
npx vitest run tests/expenses.test.tsx
```
Expected: 全部 PASS（Task 3 的 4 條 + 新的 4 條 = 8 條）

- [ ] **Step 5: 突變測試——證明「確認才刪」守得住**

把刪除按鈕暫時改成直接刪：

```tsx
				<button type="button" onClick={() => remove.mutate()}>
					刪除
				</button>
```

```
npx vitest run tests/expenses.test.tsx
```
Expected: `刪除要先確認` **FAIL**（會看到多出來的 DELETE 請求），
`取消確認就不刪` 也 **FAIL**（找不到「取消」按鈕）。

**改回來。**

- [ ] **Step 6: 突變測試——證明「不送 spent_at」守得住**

把 PATCH 的 body 暫時改成一起送日期：

```ts
				body: JSON.stringify({
					amount: draftAmount,
					spent_at: "2026-12-15T12:00:00",
				}),
```

```
npx vitest run tests/expenses.test.tsx
```
Expected: `改掉一筆的金額` **FAIL**（`expect(sent).not.toHaveProperty("spent_at")`）。

> 這條測試守的是一個**現在還沒發生的 bug**：將來有人加日期選擇器時，
> 如果直接把 `datetime-local` 的值塞進來，這條會紅並提醒他要先轉成
> 帶 offset 的格式。

**改回來。**

- [ ] **Step 7: 靜態檢查**

```
npm run -s typecheck
npm run -s lint
```
Expected: 兩者都通過

- [ ] **Step 8: Commit**

```bash
git add frontend/src/screens/Expenses.tsx frontend/tests/expenses.test.tsx
git commit -m "feat(expenses): 改與刪一筆花費

刪除要先確認：誤觸就永久失去資料。確認用畫面上的 role=\"alertdialog\"
不是 window.confirm——後者在 jsdom 裡未實作（要 stub），而且表達不出
「這是一個需要決定的狀態」給螢幕閱讀器。

只能改 amount。刻意不能改日期：那需要 <input type=\"datetime-local\">，
而它產出的是沒有時區 offset 的字串，後端的 AwareDatetime 會回 422。
有一條測試斷言 PATCH 的 body 不含 spent_at——它守的是一個還沒發生的 bug，
將來有人加日期選擇器時會紅並提醒他先轉格式。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 5：月報表

**Files:**
- Create: `frontend/src/components/CategoryBar.tsx`
- Modify: `frontend/src/screens/Expenses.tsx`
- Test: `frontend/tests/expenses.test.tsx`

- [ ] **Step 1: 寫失敗的測試**

加到 `frontend/tests/expenses.test.tsx` 的 `describe` 裡：

```tsx
	it("月報表顯示總額與各分類佔比", async () => {
		mockApi([
			{
				method: "GET",
				path: "/api/expenses/summary",
				handler: () =>
					json({
						month: "2026-12",
						total: "400.00",
						by_category: [
							{ category: "food", total: "350.00", count: 2 },
							{ category: "transport", total: "50.00", count: 1 },
						],
					}),
			},
			{ method: "GET", path: "/api/expenses", handler: () => json([]) },
		]);

		render(wrap(<Expenses />));

		expect(await screen.findByText("400.00")).toBeInTheDocument();
		const foodRow = screen.getByTestId("category-food");
		expect(foodRow).toHaveTextContent("飲食");
		expect(foodRow).toHaveTextContent("350.00");
		// 350/400 = 87.5% → 四捨五入到整數是 88%
		expect(foodRow).toHaveTextContent("88%");
		expect(screen.getByTestId("category-transport")).toHaveTextContent("13%");
	});

	it("空月份的總額是 0.00，不是空白也不是錯誤", async () => {
		mockApi([
			{
				method: "GET",
				path: "/api/expenses/summary",
				handler: () => json({ month: "2026-12", total: "0.00", by_category: [] }),
			},
			{ method: "GET", path: "/api/expenses", handler: () => json([]) },
		]);

		render(wrap(<Expenses />));

		expect(await screen.findByText("0.00")).toBeInTheDocument();
	});

	it("總額為 0 時不畫任何分類長條，也不除以零", async () => {
		// by_category 是空的，所以不會有佔比要算——但如果實作先算
		// ratio 再判斷，0/0 會是 NaN，畫面會出現 "NaN%"。
		mockApi([
			{
				method: "GET",
				path: "/api/expenses/summary",
				handler: () => json({ month: "2026-12", total: "0.00", by_category: [] }),
			},
			{ method: "GET", path: "/api/expenses", handler: () => json([]) },
		]);

		render(wrap(<Expenses />));

		await screen.findByText("0.00");
		expect(screen.queryByText(/NaN/)).not.toBeInTheDocument();
	});
```

- [ ] **Step 2: 跑測試確認它失敗**

```
npx vitest run tests/expenses.test.tsx
```
Expected: 新加的 3 條裡至少 `月報表顯示總額與各分類佔比` FAIL
（找不到 `category-food`）。

> `空月份的總額是 0.00` 這條**可能一開始就綠**——`"0.00"` 這個字串
> 也許剛好出現在別的地方。**如果它一開始就綠，回報**，那代表它在測
> 別的東西。

- [ ] **Step 3: 寫分類長條元件**

Create `frontend/src/components/CategoryBar.tsx`:

```tsx
import {
	CATEGORY_LABELS,
	type CategoryTotal,
} from "../api/expenses";
import { formatMoney, ratioOf } from "../lib/decimal";

type Props = {
	row: CategoryTotal;
	/** 這個月的總額，用來算佔比。`"0.00"` 時 `ratioOf` 會回 `null`。 */
	monthTotal: string;
};

/** 一列分類佔比：分類名稱、金額、佔這個月的百分比。
 *
 *  **刻意不重用 `MacroBar`**（規格 §6.3）。`MacroBar` 的模型是
 *  「實際 vs 目標」，而且有「有目標但這一項沒設」這個第二層 null 的
 *  概念——花費沒有目標（預算不在範圍內，規格 §8），硬套會多出一個
 *  永遠是 null 的欄位，那是在說謊。
 *
 *  **佔比一律走 `ratioOf()`**（`lib/decimal.ts`），這裡不做任何
 *  `Number(a) / Number(b)`——那是把浮點誤差請回來，而
 *  `tests/decimal-containment.test.ts` 也會擋下直接 `new Decimal()`。
 *
 *  百分比用 `toLocaleString` 的 `style: "percent"`，不自己 `* 100`——
 *  跟 `MacroBar` 同一個理由：轉換留給 Intl，不是手寫算術。
 */
export function CategoryBar({ row, monthTotal }: Props) {
	const share = ratioOf(row.total, monthTotal);

	return (
		<div data-testid={`category-${row.category}`}>
			<span>{CATEGORY_LABELS[row.category]}</span>
			<span>{formatMoney(row.total)}</span>
			<span>{row.count} 筆</span>
			{/* share 為 null 代表總額是 0（ratioOf 對 0 回 null，不是
			    Infinity 也不是 NaN）——那時候沒有佔比可言，不畫。 */}
			{share !== null && (
				<span>
					{share.toLocaleString(undefined, {
						style: "percent",
						maximumFractionDigits: 0,
					})}
				</span>
			)}
		</div>
	);
}
```

- [ ] **Step 4: 接到畫面上**

在 `frontend/src/screens/Expenses.tsx`：

import 加上：

```tsx
import { CategoryBar } from "../components/CategoryBar";
```

並把 `useExpenses` 那一行的 import 改成同時取 `useExpenseSummary`：

```tsx
import {
	CATEGORY_LABELS,
	CATEGORY_ORDER,
	type Expense,
	type ExpenseCategory,
	useExpenses,
	useExpenseSummary,
} from "../api/expenses";
```

在 `Expenses()` 的 `expensesQuery` 之後加：

```tsx
	const summaryQuery = useExpenseSummary(null);
	const summary = summaryQuery.data ?? null;
```

並在 `<h2>這個月</h2>` 那一段**之前**插入報表：

```tsx
			<h2>這個月花了多少</h2>
			{summary === null ? (
				<p>載入中…</p>
			) : (
				<div>
					<p>
						總計 <span>{formatMoney(summary.total)}</span>
					</p>
					{summary.by_category.map((row) => (
						<CategoryBar
							key={row.category}
							row={row}
							monthTotal={summary.total}
						/>
					))}
				</div>
			)}
```

- [ ] **Step 5: 跑測試確認通過**

```
npx vitest run tests/expenses.test.tsx
```
Expected: 全部 PASS（11 條）

- [ ] **Step 6: 突變測試——證明佔比真的算對**

把 `CategoryBar` 的 `monthTotal` 暫時改成用 `row.total` 當分母
（那會讓每一列都是 100%）：

```tsx
	const share = ratioOf(row.total, row.total);
```

```
npx vitest run tests/expenses.test.tsx
```
Expected: `月報表顯示總額與各分類佔比` **FAIL**（88% 與 13% 都變成 100%）。

**改回 `monthTotal`。**

- [ ] **Step 7: 靜態檢查**

```
npm run -s typecheck
npm run -s lint
```
Expected: 兩者都通過

- [ ] **Step 8: Commit**

```bash
git add frontend/src/components/CategoryBar.tsx frontend/src/screens/Expenses.tsx frontend/tests/expenses.test.tsx
git commit -m "feat(expenses): 月報表——總額與分類佔比

CategoryBar 刻意不重用 MacroBar（規格 §6.3）：後者的模型是「實際 vs 目標」
而且有「有目標但這一項沒設」的第二層 null，而花費沒有目標（預算不在範圍
內，規格 §8）。硬套會多出一個永遠是 null 的欄位，那是在說謊。

佔比走 ratioOf()，總額為 0 時它回 null 而不是 NaN 或 Infinity——
有一條測試斷言畫面上不會出現 \"NaN\"。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 6：記一餐順手填金額

**Files:**
- Modify: `frontend/src/screens/LogMeal.tsx`
- Test: `frontend/tests/log-meal.test.tsx`

**這是唯一會動到既有核心畫面的任務。** `LogMeal.tsx` 是這個 app 的首頁，動它要小心。

- [ ] **Step 1: 寫失敗的測試**

加到 `frontend/tests/log-meal.test.tsx` 的 `describe("記一餐", ...)` 裡。

**這個檔案的慣例跟 `tests/expenses.test.tsx` 不一樣，照它的來：**

- 它 import 的是 `import { json, mockApiByPath as mockApi } from "./helpers/mock-api";`
  ——**物件形式**（只比對路徑、不分 method），不是陣列形式
- 送出按鈕的文字是 **「記錄」**，不是「記這一餐」
- 「選一個食物」是 `await userEvent.click(await screen.findByText("滷肉飯"))`
  （`FREQUENT_FOODS` 裡 id=1 的那筆），選完需要 `/api/foods/1/portions` 這條路由

```tsx
	it("填了金額就一起送出 cost", async () => {
		const fetchMock = mockApi({
			"/api/foods/frequent": () => json(FREQUENT_FOODS),
			"/api/foods/recent": () => json([]),
			"/api/foods/1/portions": () => json([]),
			"/api/meals": () => json({ id: 99 }, 201),
		});

		render(wrap(<LogMeal onSaved={vi.fn()} />));
		await userEvent.click(await screen.findByText("滷肉飯"));

		await userEvent.type(screen.getByLabelText("金額（選填）"), "180");
		await userEvent.click(screen.getByRole("button", { name: "記錄" }));

		await waitFor(() => {
			const call = fetchMock.mock.calls.find(
				([input, init]) =>
					(init?.method ?? "GET").toUpperCase() === "POST" &&
					String(input).includes("/api/meals"),
			);
			expect(call).toBeDefined();
			expect(JSON.parse(String(call?.[1]?.body)).cost).toBe("180");
		});
	});

	it("沒填金額時不送 cost 欄位", async () => {
		// **不是送 null、也不是送空字串。** 後端的 cost 是
		// `Decimal | None = Field(default=None, gt=0, ...)`：
		// - 送 "" → Pydantic 擋成 422
		// - 送 null → 合法，但語意上繞了一圈
		// - 不帶 → 後端的 default=None 生效，最乾淨
		const fetchMock = mockApi({
			"/api/foods/frequent": () => json(FREQUENT_FOODS),
			"/api/foods/recent": () => json([]),
			"/api/foods/1/portions": () => json([]),
			"/api/meals": () => json({ id: 99 }, 201),
		});

		render(wrap(<LogMeal onSaved={vi.fn()} />));
		await userEvent.click(await screen.findByText("滷肉飯"));

		await userEvent.click(screen.getByRole("button", { name: "記錄" }));

		await waitFor(() => {
			const call = fetchMock.mock.calls.find(
				([input, init]) =>
					(init?.method ?? "GET").toUpperCase() === "POST" &&
					String(input).includes("/api/meals"),
			);
			expect(call).toBeDefined();
			expect(JSON.parse(String(call?.[1]?.body))).not.toHaveProperty("cost");
		});
	});
```

> **`json({ id: 99 }, 201)` 這個回應是刻意極簡的。** 既有測試（例如
> 409 那條）也只回它需要的那幾個欄位——`LogMeal` 成功後只呼叫
> `onSaved()` 並清表單，不讀回應的內容。如果實作後發現它真的讀了某個
> 欄位而炸開，**回報**，那代表我對這個畫面的理解有誤。

- [ ] **Step 2: 跑測試確認它失敗**

```
npx vitest run tests/log-meal.test.tsx
```
Expected: 新加的 2 條裡，`填了金額就一起送出 cost` FAIL
（找不到「金額（選填）」這個 label）。

> `沒填金額時不送 cost 欄位` 這條**一開始就會綠**——因為現在根本沒有
> `cost` 欄位。**那是預期的，它是迴歸防護**：守的是實作完之後，
> 沒填金額時不要多送一個 `cost: ""` 或 `cost: null`。

- [ ] **Step 3: 實作**

在 `frontend/src/screens/LogMeal.tsx`：

**已查證過的現況（`frontend/src/screens/LogMeal.tsx`）：**

- `queryKeys` **已經 import 了**（第 6 行），不用再加
- `ApiError` 來自 `"../api/errors"`（第 4 行），不是 `"../api/client"`
- `onSuccess` 在第 134 行，裡面依序是：5 個 `invalidateQueries`
  （`dailyStats` / `rangeStatsAll` / `frequentFoods` / `recentFoods` / `meals`，
  第 137–156 行）、然後 `setSelectedFood(null)`（157）、`setQuantity("1")`（159）

在既有的 `const [quantity, setQuantity] = useState("1");`（第 74 行）之後加：

```tsx
	// 選填的餐費（P5 規格 §4.1）。有值時 POST /api/meals 會在同一個交易裡
	// 建一筆 category=food、meal_id 指過來的支出。
	const [cost, setCost] = useState("");
```

在送出的 `body: JSON.stringify({...})` 裡，`items` 之後加：

```tsx
					// **留空時整個不帶這個欄位**，不是送 "" 也不是送 null。
					// 後端是 `cost: Decimal | None = Field(default=None, gt=0, ...)`：
					// 送 "" 會被 Pydantic 擋成 422；送 null 雖然合法但語意繞了
					// 一圈；不帶讓後端的 default=None 生效，最乾淨。
					...(cost.trim() === "" ? {} : { cost: cost.trim() }),
```

在表單裡（餐別的選擇之後）加上欄位：

```tsx
			<div>
				<label htmlFor="meal-cost">金額（選填）</label>
				{/* 填了就會在同一個交易裡記一筆餐費（規格 §4.1）。
				    inputMode="decimal" 讓手機跳數字鍵盤；字級由 index.css
				    的全域規則保證 ≥16px（iOS Safari 的自動放大，P3-C 踩過）。 */}
				<input
					id="meal-cost"
					type="text"
					inputMode="decimal"
					value={cost}
					onChange={(event) => setCost(event.target.value)}
				/>
			</div>
```

在 `onSuccess` 裡，`setQuantity("1")`（第 159 行）旁邊加上：

```tsx
				setCost("");
```

並且在那個 `onSuccess` 裡，既有的 `invalidateQueries` 之後加上：

```tsx
				// 餐費會建出一筆支出——記帳的清單與報表都要重取。
				queryClient.invalidateQueries({ queryKey: queryKeys.expensesAll });
```

> `queryKeys` 已經在第 6 行 import 了（查證過），不用再加。
> 這一行要放在既有那 5 個 `invalidateQueries` 之後（第 156 行的
> `queryKeys.meals` 下面），跟它們同一區塊。

- [ ] **Step 4: 跑測試確認通過**

```
npx vitest run tests/log-meal.test.tsx
```
Expected: 全部 PASS

- [ ] **Step 5: 跑整個前端測試套件**

```
npm run -s test
```
Expected: 全部 PASS。基準線是 56 檔 280 條，這份計畫新增一個檔案與若干條。

> **這一步不是形式。** `LogMeal.tsx` 是首頁，加一個欄位最可能的副作用是
> 某個既有測試用 `getByLabelText` 或 `getAllByRole("textbox")` 抓欄位時
> 抓到多的那一個。

- [ ] **Step 6: 突變測試——證明「不填就不送」守得住**

把那行展開暫時改成一律送出：

```tsx
					cost: cost.trim(),
```

```
npx vitest run tests/log-meal.test.tsx
```
Expected: `沒填金額時不送 cost 欄位` **FAIL**（body 裡出現 `cost: ""`）。

**改回展開的寫法。**

- [ ] **Step 7: 靜態檢查**

```
npm run -s typecheck
npm run -s lint
```
Expected: 兩者都通過

- [ ] **Step 8: Commit**

```bash
git add frontend/src/screens/LogMeal.tsx frontend/tests/log-meal.test.tsx
git commit -m "feat(meals): 記一餐可以順手填金額

留空時整個不帶 cost 欄位，不是送 \"\" 也不是送 null：後端是
cost: Decimal | None = Field(default=None, gt=0, ...)，送空字串會被
Pydantic 擋成 422。有一條測試斷言 body 不含 cost。

成功後一併失效 expensesAll——餐費會建出一筆支出，記帳的清單與報表
都要重取。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## 收尾

- [ ] **跑完整的前端檢查**

```
cd frontend
npm run -s typecheck
npm run -s lint
npm run -s test
```
Expected: 全部通過

- [ ] **在 320px 寬度下真的看一次**

規格 §6.1 明寫那段 tab bar 的算術**不是在真機上量的**。這個計畫沒有加第六格，
所以 tab bar 不會變——但新的 `/expenses` 畫面本身要在 320px 下看一次：

```
npm run dev
```

用瀏覽器的裝置模擬器設成 **320px 寬**，確認：

1. 金額輸入框、分類下拉、按鈕都不會橫向溢出
2. 分類長條那一列（分類名 + 金額 + 筆數 + 百分比）在 320px 下不會擠爛
3. **點進金額輸入框時頁面不會自動放大**（iOS Safari 的 16px 規則；
   在桌機 Chromium 上看不出來，這一項要在真的 iPhone 上確認）

- [ ] **跑 E2E（如果有涉及的話）**

```
npx playwright test
```

> 這份計畫沒有改既有的 E2E 流程，但 `LogMeal.tsx` 多了一個欄位。
> **如果有任何 E2E 用 `getAllByRole("textbox")` 之類的方式抓欄位，會受影響。**

- [ ] **更新 handover §6「綠燈說謊」**

這一輪的候選（如果執行時真的遇到）：

- **`formatMacro` 拿來格式化金額，顯示會少一位小數而不會報錯。** 型別都是
  `string`，TypeScript 不會抗議，畫面上「250.5」看起來也像個正常數字——
  只有把它跟收據對照時才會發現。
- **「有入口連結」這件事如果沒有測試，拿掉連結不會有任何東西變紅。**
  這個專案已經三次蓋好後端卻沒有前端入口（食物、補劑、記帳）。

- [ ] **開 PR**

```bash
git push -u origin <branch>
gh pr create --base master --title "P5 計畫二：記帳前端" --body "..."
```

PR 內文要包含：規格連結、六個任務的摘要、**以及實作過程中發現的所有計畫錯誤**。

---

## 自我檢查（對照規格 §6）

| 規格要求 | 對應任務 |
|---|---|
| §6.1 tab bar 塞不下第六格 | Task 3（不加 tab，入口在 Today） |
| §6.2 方向 1：記帳放今日總覽底下 | Task 3 Step 5 |
| §6.3 `/expenses`：清單 + 新增 | Task 3 |
| §6.3 `/expenses`：點進去改/刪 | Task 4 |
| §6.3 月報表：總額 + 分類長條 | Task 5 |
| §6.3 **不重用 `MacroBar`** | Task 5 的 `CategoryBar` docstring |
| §6.3 記一餐表單多一個選填金額 | Task 6 |
| §6.3 金額輸入框 `font-size: 16px` | Task 3、Task 6（靠 `index.css` 全域規則，註解明寫不要覆寫） |
| §6.3 金額一律用 `decimal.js`、不用 `Number` | Task 1 的 `formatMoney`，而且 `decimal-containment.test.ts` 在守 |

**兩處我自己加上、規格沒寫的東西，理由都在計畫裡：**

1. **`formatMoney`**（Task 1）——規格只說「金額一律用 `decimal.js`」，沒說
   既有的 `formatMacro` 不能用。實測發現它會把 `"250.50"` 顯示成 `250.5`。
2. **刪除要確認**（Task 4）——規格 §5.1 只說「`DELETE` 是硬刪」。確認步驟是
   前端的決定，跟 P6 餐點刪除的決定保持一致。

**一處刻意比規格窄：** §6.3 說「點進去改」，但這份計畫**只能改金額**，
不能改分類、備註與日期。日期是因為 `AwareDatetime`（見開頭的地雷），
分類與備註純粹是 YAGNI——真的需要時加兩個欄位就有，而且
`ExpenseUpdateRequest` 後端早就支援了。**這一點實作時不要自己擴大範圍。**
