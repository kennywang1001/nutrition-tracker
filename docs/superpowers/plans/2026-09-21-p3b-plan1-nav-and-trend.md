# P3-B 計畫一：導覽與趨勢 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 app 從兩個畫面擴成四個 tab 的底部導覽，並加上最近七天的熱量趨勢圖。

**Architecture:** 趨勢畫面的日期錨點來自 `GET /api/stats/daily` 回應裡的 `date`（伺服器算的今天），前端只做曆法加減、絕不判斷日界線。圖是手寫 SVG，幾何全部在 JS 裡算成屬性值 —— 因為 jsdom 不做版面計算，只有屬性測得到。

**Tech Stack:** React 19 · react-router 8 · TanStack Query 5 · decimal.js（只透過 `lib/decimal.ts`）· Vitest + Testing Library · Playwright · Biome

**規格：** [2026-09-21-p3b-frontend-design.md](../specs/2026-09-21-p3b-frontend-design.md)

---

## 這份計畫涵蓋規格的哪些部分

| 規格節次 | Task |
|---|---|
| §3.1 底部 tab bar、safe-area | Task 3 |
| §3.2 路由（`/trend` 那一列） | Task 3 |
| §4.1 日期錨點 | Task 5 |
| §4.2 / §4.3 `shiftDays` 與 UTC 陷阱 | Task 2 |
| §4.4 手寫 SVG | Task 4 |
| §4.5 三個資料狀態 | Task 4 |
| §4.6 aria 標籤與幾何斷言 | Task 4 |
| §4.7 補劑依從率 | Task 5 |
| §7.1 `rangeStats` key | Task 5 |
| §7.2 `invalidateQueries(["stats","range"])` | Task 6 |
| §10.2 E2E 第 5 條 | Task 6 |
| §11.4 時區遮住的 bug | Task 2 |

§3.3（管理員 tab）、§5、§6、§7.3、§8.2、§10.2 的 E2E 1–4 在**計畫二**。
理由：管理員 tab 指向的 `/admin/revisions` 畫面在計畫二才存在，先放一個佔位畫面
會是一個沒有人要的中間狀態。`useMe()` 也因此留到計畫二 —— 這份計畫沒有任何
地方需要 `role`。

---

## 開工前必讀

**這三件事在實作中至少有一件會讓你想「順手改掉」，而改掉就會出事。**

### 1. 計畫的文字不是權威

如果你發現實際情況跟這份計畫寫的不一樣 —— 檔案內容不同、指令輸出不同、
某個假設不成立 —— **停下來報告，不要照著計畫硬做，也不要自己悄悄改一個
方向繼續。** 這份計畫是根據 2026-09-21 當天的程式碼寫的，寫的人會錯。

### 2. 綠燈在被觀察到失敗之前不算證據

每一條標著「**突變驗證**」的步驟都要真的做：把實作改壞、跑測試、**親眼看到
它紅**、再改回來。不做這一步而宣稱測試有效，等於沒有測試。

P3-A 的三份計畫裡，有五次「工具跑了，回報成功，但它從來沒有看過那個東西」。

### 3. 不要動 `App.tsx` 裡的「重新整理」按鈕

它現在直接呼叫 `apiFetch<{ display_name: string }>("/api/me")`。
`frontend/e2e/auth.spec.ts:44` 靠它驗證「access token 過期時會自動換票並重送」。

改成 TanStack Query 的 `refetch` 會被 `staleTime: 60_000` 擋掉 —— 按下去什麼
都不會發生，而那條 E2E **不會紅，它只是不再測到任何東西**（規格 §8.1）。

---

## 檔案結構

**新增：**

| 檔案 | 責任 |
|---|---|
| `frontend/tests/helpers/mock-api.ts` | 共用的 fetch mock（目前在 6 個測試檔裡各抄一份，而且有兩個不相容的版本） |
| `frontend/src/lib/civil-date.ts` | 日曆日字串的加減與顯示。**這個模組不得使用任何非 UTC 的 `Date` accessor** |
| `frontend/src/components/TabBar.tsx` | 底部導覽 |
| `frontend/src/components/TrendChart.tsx` | 純渲染的 SVG 長條圖，不自己取資料 |
| `frontend/src/screens/Trend.tsx` | 趨勢畫面：錨點、查詢、把資料交給 `TrendChart` |
| `frontend/src/index.css` | 全站樣式。**這個專案目前一行 CSS 都沒有**，這是第一份 |
| `frontend/tests/civil-date.test.ts` | Task 2 |
| `frontend/tests/tab-bar.test.tsx` | Task 3 |
| `frontend/tests/trend-chart.test.tsx` | Task 4 |
| `frontend/tests/trend.test.tsx` | Task 5 |
| `frontend/e2e/trend.spec.ts` | Task 6 |

**修改：**

| 檔案 | 改什麼 |
|---|---|
| `frontend/tests/{today,log-meal,meal-list,meal-photo,meal-photo-upload,offline}.test.tsx` | 刪掉本地的 `mockApi` / `json`，改 import（Task 1） |
| `frontend/src/lib/decimal.ts` | 加 `maxOf()`（Task 4） |
| `frontend/src/api/queries.ts` | 加 `rangeStats` 與 `rangeStatsAll`（Task 5、Task 6） |
| `frontend/src/App.tsx` | 加 `/trend` 路由、把 `<Nav>` 的連結換成 `<TabBar>`（Task 3） |
| `frontend/src/main.tsx` | `import "./index.css"`（Task 3） |
| `frontend/index.html` | `lang="zh-Hant-TW"`、`<title>` 改掉 scaffold 預設值（Task 3） |
| `frontend/src/screens/LogMeal.tsx` | 加一行失效（Task 6） |
| `docs/superpowers/specs/2026-09-21-p3b-frontend-design.md` | §4.2 的模組位置（Task 2） |

---

## Task 1: 把 fetch mock 抽成共用輔助

**為什麼先做這個：** 這份計畫與計畫二總共會再加 5 個測試檔案，每一個都需要
同一個 fetch mock。現在它在 6 個檔案裡各抄一份，而且已經分岔成兩個**語意不同**
的版本：

- 5 個檔案用 `Record<string, () => Response>` —— **只比對路徑，完全忽略 method**
- `meal-photo-upload.test.tsx` 用 `Route[]`（`{ method, path, handler }`）—— 比對 method + 路徑

計畫二會需要 method 版本，因為 `GET /api/foods`（搜尋）與 `POST /api/foods`
（新增）**是同一個路徑**。再抄 5 份就是讓這個分岔繼續長大。

**這個 Task 不改任何呼叫端。** 兩個既有語意各自保留一個具名的匯出，
所以 6 個檔案的修改是「刪掉本地定義、加一行 import」，是純粹的刪除。
全套測試必須維持原本的數量與全綠 —— 那就是這個重構的驗收條件。

**Files:**
- Create: `frontend/tests/helpers/mock-api.ts`
- Modify: `frontend/tests/today.test.tsx`
- Modify: `frontend/tests/log-meal.test.tsx`
- Modify: `frontend/tests/meal-list.test.tsx`
- Modify: `frontend/tests/meal-photo.test.tsx`
- Modify: `frontend/tests/meal-photo-upload.test.tsx`
- Modify: `frontend/tests/offline.test.tsx`

- [ ] **Step 1: 先記下現在的測試數量**

```bash
cd frontend && npm run test 2>&1 | tail -20
```

把 `Test Files` 與 `Tests` 兩行的數字抄下來。**這個 Task 結束時這兩個數字
必須一模一樣** —— 變多代表有東西被重複跑，變少代表有檔案被整個跳過（而那正是
P3-A 踩過的「工具跑了但沒看那個東西」）。

- [ ] **Step 2: 建立共用輔助**

建 `frontend/tests/helpers/mock-api.ts`：

```ts
import { vi } from "vitest";

/** 一條路由。`method` 省略時代表**任何 method 都算符合** ——
 *  那是 5 個既有測試檔原本的 `Record` 版本的語意，抽出來時不能偷偷改掉。 */
export type Route = {
	method?: string;
	path: string;
	handler: () => Response;
};

/** 依 (method, path) 分派的 fetch mock。**一律先驗 Authorization** ——
 *  沒帶就回 401 信封。這是規格 §9.2 第 2 條：mock 不檢查 header 的話，
 *  「所有請求都要帶 token」這個保證零鑑別力。
 *
 *  `routes` 用陣列、依序比對第一個符合的 —— `/api/meals/11/photo` 這個
 *  URL 同時「包含」`/api/meals`，所以呼叫端要把更具體的路徑排在前面，
 *  否則泛用的 `/api/meals` 路由會搶先吃掉照片端點的請求。
 *
 *  **比對用 `url.includes(path)` 而不是相等**：測試裡的 URL 是相對路徑
 *  （`/api/stats/daily`），但有些呼叫會帶 query string。
 */
export function mockApi(routes: readonly Route[]) {
	return vi
		.spyOn(globalThis, "fetch")
		.mockImplementation(async (input, init) => {
			const url = typeof input === "string" ? input : String(input);
			if (!new Headers(init?.headers).has("authorization")) {
				return new Response(
					JSON.stringify({
						error: {
							code: "NOT_AUTHENTICATED",
							message: "需要登入",
							details: {},
						},
					}),
					{ status: 401, headers: { "content-type": "application/json" } },
				);
			}
			const method = (init?.method ?? "GET").toUpperCase();
			const route = routes.find(
				(candidate) =>
					(candidate.method === undefined ||
						candidate.method.toUpperCase() === method) &&
					url.includes(candidate.path),
			);
			if (route === undefined) {
				throw new Error(`測試沒有為這個路徑準備回應：${method} ${url}`);
			}
			return route.handler();
		});
}

/** 只比對路徑、不管 method 的舊形式。
 *
 *  **保留它是為了讓這次抽取是純粹的刪除** —— 5 個既有測試檔的呼叫端
 *  一個字都不用改。新的測試請用 `mockApi`：計畫二要分辨
 *  `GET /api/foods`（搜尋）與 `POST /api/foods`（新增），那是同一個路徑。
 */
export function mockApiByPath(routes: Record<string, () => Response>) {
	return mockApi(
		Object.entries(routes).map(([path, handler]) => ({ path, handler })),
	);
}

/** JSON 回應。`status` 預設 200 —— `meal-photo-upload.test.tsx` 需要用它
 *  造 422，其他檔案原本的版本沒有這個參數，預設值讓兩邊相容。 */
export function json(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}
```

- [ ] **Step 3: 確認這個新檔案不會被當成測試檔跑**

```bash
cd frontend && npm run test 2>&1 | grep -c "helpers/mock-api"
```

Expected: `0`

Vitest 預設的 include 是 `**/*.{test,spec}.?(c|m)[jt]s?(x)`，`mock-api.ts`
不符合。這一步是確認，不是假設。

- [ ] **Step 4: 改 5 個用 `Record` 形式的檔案**

對 `today.test.tsx`、`log-meal.test.tsx`、`meal-list.test.tsx`、
`meal-photo.test.tsx`、`offline.test.tsx` 各做一次：

1. 刪掉整個本地的 `function mockApi(routes: Record<string, () => Response>) { ... }`
   （連同它上面的 docstring）
2. 刪掉本地的 `function json(body: unknown) { ... }`
   （`meal-photo.test.tsx` **沒有** `json`，跳過這一步）
3. 在 import 區塊最後加上：

```ts
import { json, mockApiByPath as mockApi } from "./helpers/mock-api";
```

> **用 `as mockApi` 別名，不要改呼叫端。** 這個 Task 的價值來自「修改是純粹的
> 刪除」—— 一旦開始改呼叫端，就得逐一驗證每個 mock 的語意有沒有變，
> 而那是一個完全不同量級的工作。
>
> `meal-photo.test.tsx` 沒有 `json`，import 只寫 `mockApiByPath as mockApi`。

- [ ] **Step 5: 改 `meal-photo-upload.test.tsx`**

1. 刪掉 `type Route = { method: string; path: string; handler: () => Response };`
2. 刪掉本地的 `function mockApi(routes: Route[]) { ... }`（連同 docstring）
3. 刪掉本地的 `function json(body: unknown, status = 200) { ... }`
4. 加 import：

```ts
import { json, mockApi } from "./helpers/mock-api";
```

> 這個檔案的呼叫端本來就全部帶 `method`，共用版的 `method?: string`
> 是它的超集，行為不變。

- [ ] **Step 6: 跑全套測試，比對數字**

```bash
cd frontend && npm run test 2>&1 | tail -20
```

Expected: `Test Files` 與 `Tests` 的數字**跟 Step 1 一模一樣**，全綠。
這一步做完時還沒有新增任何測試，所以基準線是 `34` / `138`。

**如果數字變少了：** 有檔案因為語法錯誤整個沒跑起來。Vitest 會把它報成
`Unhandled Errors`，那一行很容易在輸出裡被滑過去 —— 回去看完整輸出。

> **`Test Files` 是實際檔案數的兩倍。** `vite.config.ts` 的
> `typecheck.include` 跟一般的 include 蓋到同一組檔案，所以每個檔案被算
> 兩次（一次執行、一次交給 tsc）。`Tests` 也一樣加倍。
> 實測：17 個檔案 → `34`，加上 Step 7 的新檔案變成 18 → `36`；
> 138 → 加 3 則新測試變成 `144`。**算數字時要記得除以二。**

- [ ] **Step 7: 突變驗證 —— 確認共用的 mock 真的還在驗 Authorization**

把 `helpers/mock-api.ts` 裡的這一段暫時註解掉：

```ts
			if (!new Headers(init?.headers).has("authorization")) {
```

改成 `if (false) {`，跑：

```bash
cd frontend && npm run test 2>&1 | tail -20
```

Expected: **`tests/mock-api-helper.test.ts` 的「沒帶 Authorization 就回 401
信封」那一則紅**（`expected 200 to be 401`），其他全綠。

看到紅之後**改回來**，再跑一次確認全綠。

> ## ⚠️ 這一步的原始寫法是錯的，而它揭出一個原本就存在的洞
>
> **原本寫的 Expected 是「至少有一則測試紅（`auth-refresh` 或 `client`
> 相關的那些依賴 401 觸發換票）」。實測：138 則測試全部照樣綠。**
>
> 那是寫計畫的人（我）猜的，沒有查證。實際情況：
>
> - **用這個 mock 的 6 個檔案，`beforeEach` 都是 `clearTokens()` 緊接著
>   `setTokens()`，而且沒有任何一則測試在 render 之後清掉 token。**
>   所以 mock 裡「沒帶 header 就回 401」那個分支在它們裡面從來沒被走過。
> - `auth-refresh.test.ts` 與 `client.test.ts` 用**自己 inline 的**
>   `vi.spyOn(globalThis, "fetch")`，跟 `helpers/mock-api.ts` 完全無關。
>
> 而重構前 5 個檔案裡各自抄的那份 mock，401 檢查邏輯逐字元相同 ——
> **這是原本就存在的死碼分支，不是抽取造成的迴歸**，只是第一次有人對它
> 做突變測試才揭出來。
>
> **舊註解那句「這個保證零鑑別力」也是誇大的。** 不是零：
> `tests/client.test.ts` 的「帶上 Authorization」與
> `tests/meal-photo.test.tsx` 的「帶著 Authorization 取圖」都在守
> （兩者合起來蓋住 `src/api/client.ts` 的 `fetchWithAuthRetry` 內核）。
> 那個 401 檢查是**後備防線**，不是主守衛。
>
> **所以 Task 1 多做了一件計畫原本沒有的事：** 新增
> `tests/mock-api-helper.test.ts`（3 則）守住那道後備防線本身，並把
> `mock-api.ts` 裡那句誇大的 docstring 改成講實話。
>
> 補那則測試的理由很具體：**下一個跑覆蓋率的人會看到一個沒被觸及的分支，
> 而「清掉死碼」是很現實的下一步** —— 清掉之後這個 mock 會開始靜默接受
> 未認證的請求，那 6 個檔案的測試在 `apiFetch` 不再附上 token 時依然會綠。

- [ ] **Step 8: lint 與型別**

```bash
cd frontend && npm run lint && npm run typecheck
```

Expected: 兩個都是 exit 0。

- [ ] **Step 9: Commit**

> **這個 Task 實際的 commit 是 `abc9d91`，訊息跟下面這份草稿不同** ——
> 草稿裡「依賴 401 換票的測試確實轉紅」那句不是事實（見 Step 7 的實測），
> 而且實際的 commit 還包含了 Step 7 補出來的那個新測試檔。
> 下面保留草稿，是為了讓「計畫原本打算 commit 什麼」跟「實際 commit 了
> 什麼」的差距看得出來。**照 Step 7 的實測結果寫 commit message，
> 不要照抄這一份。**

```bash
git add frontend/tests/
git commit -m "$(cat <<'EOF'
refactor: fetch mock 抽成共用輔助，並統一兩個分岔的版本

6 個測試檔各抄一份 mockApi，而且已經分岔成兩個語意不同的版本：
5 個只比對路徑、完全忽略 method，1 個比對 method + 路徑。

計畫二需要 method 版本——GET /api/foods（搜尋）與 POST /api/foods
（新增）是同一個路徑。再抄 5 份就是讓分岔繼續長大。

兩個語意各自保留一個具名匯出，所以 6 個檔案的修改是純粹的刪除，
呼叫端一個字都沒改。測試數量與 Step 1 記錄的完全一致。

突變驗證：把 Authorization 檢查停掉，依賴 401 換票的測試確實轉紅。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: `shiftDays` —— 曆法加減，而且結構上不可能受時區影響

**Files:**
- Create: `frontend/src/lib/civil-date.ts`
- Create: `frontend/tests/civil-date.test.ts`
- Modify: `docs/superpowers/specs/2026-09-21-p3b-frontend-design.md`

### 這個 Task 跟規格寫的不一樣，而且是刻意的

規格 §4.2 說把 `shiftDays` 放進 `src/lib/dates.ts`，並且用「在非 UTC 時區下跑
測試」來擋住 §4.3 的那個 bug。**那條測試路線在這台機器上很可能行不通**：
Node 對執行期修改 `process.env.TZ` 的支援在 Windows 上一向不可靠，而 V8 會
快取時區。規格自己也寫了「這件事本身要驗，不能假設」。

**所以改成結構性的作法**，跟這個專案處理 `meal-photo` key 的方式同一招 ——
不是去測「它在奇怪的環境下會不會壞」，而是**讓它壞不了**：

1. `shiftDays` 放進自己的模組 `src/lib/civil-date.ts`
2. 這個模組**只准用 `Date.UTC(...)` 與 `toISOString()`**，不准出現任何本地
   時間的 accessor
3. 用一條**原始碼掃描測試**（跟既有的 `tests/decimal-containment.test.ts`
   同一個手法）把這條規則變成紅燈

這樣就不需要一個特殊的測試環境，而且保證比「在某個時區下跑一次」更強。

`dates.ts` 保持原樣（它做的是顯示格式化、用得到本地時間，那是對的）。

- [ ] **Step 1: 寫失敗的測試**

建 `frontend/tests/civil-date.test.ts`：

```ts
/// <reference types="node" />
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { formatCivilDate, shiftDays } from "../src/lib/civil-date";

describe("shiftDays", () => {
	it("往回推六天就是最近七天的起點", () => {
		// 區間兩端都含（app/api/routes/stats.py 的 get_range_stats：
		// 「使用者說『9/1 到 9/7』預期的是 7 天」），所以七天是 -6 不是 -7。
		expect(shiftDays("2026-09-21", -6)).toBe("2026-09-15");
	});

	it("delta 是 0 時原樣回傳", () => {
		expect(shiftDays("2026-09-21", 0)).toBe("2026-09-21");
	});

	it("跨月", () => {
		// 2026 不是閏年
		expect(shiftDays("2026-03-01", -1)).toBe("2026-02-28");
	});

	it("跨閏日", () => {
		expect(shiftDays("2024-03-01", -1)).toBe("2024-02-29");
	});

	it("跨年", () => {
		expect(shiftDays("2026-01-01", -1)).toBe("2025-12-31");
		expect(shiftDays("2026-12-31", 1)).toBe("2027-01-01");
	});

	it("格式不對就拋，不要靜默給出 Invalid Date", () => {
		// 這個函式的輸入永遠來自後端的 date 欄位。哪天那個形狀變了，
		// 要在這裡炸掉，而不是讓 "Invalid Date" 一路流進 query key。
		expect(() => shiftDays("2026-9-21", -1)).toThrow();
		expect(() => shiftDays("", -1)).toThrow();
	});
});

describe("formatCivilDate", () => {
	it("給人看的短日期", () => {
		expect(formatCivilDate("2026-09-05")).toBe("9/5");
		expect(formatCivilDate("2026-12-31")).toBe("12/31");
	});
});

describe("civil-date.ts 不得依賴本地時區", () => {
	it("整個模組沒有任何非 UTC 的 Date accessor", () => {
		// **這條測試是 shiftDays 正確性的真正守衛，行為測試不是。**
		//
		// 規格 §4.3 / §11.4：用本地 accessor 的錯誤實作，在 Asia/Taipei
		// （UTC+8）與 CI（UTC）都會給出正確答案——上面那六條行為測試
		// 全部照樣綠。它只在 UTC 以西壞掉：在 America/New_York，
		// new Date("2026-09-21") 是當地的 9/20 20:00，getDate() 回 20，
		// 整條計算差一天。
		//
		// 也就是說：時區把這個 bug 遮住了，而我們跑測試的兩個環境剛好
		// 都在被遮住的那一側。與其去架一個「在正確的時區下跑」的環境
		// （Node 在 Windows 上對執行期改 process.env.TZ 的支援不可靠），
		// 不如讓那個寫法根本進不了這個檔案。
		//
		// 手法跟 tests/decimal-containment.test.ts 一樣：文件擋不住
		// 重蹈覆轍，紅燈可以。
		const source = readFileSync("src/lib/civil-date.ts", "utf8");
		const forbidden = [
			"getDate",
			"setDate",
			"getMonth",
			"setMonth",
			"getFullYear",
			"setFullYear",
			"getHours",
			"getDay",
			"toLocaleDateString",
			"Date.now",
			"new Date()",
		];

		expect(forbidden.filter((name) => source.includes(name))).toEqual([]);
	});
});
```

- [ ] **Step 2: 跑測試確認它失敗**

```bash
cd frontend && npx vitest run tests/civil-date.test.ts
```

Expected: FAIL，錯誤訊息是找不到模組
`Failed to resolve import "../src/lib/civil-date"`。

- [ ] **Step 3: 寫實作**

建 `frontend/src/lib/civil-date.ts`：

```ts
/** **日曆日的加減與顯示。這個模組不得使用任何本地時間的 `Date` accessor。**
 *
 *  `tests/civil-date.test.ts` 有一條原始碼掃描測試在守這條規則。
 *
 *  ## 為什麼這不違反「前端不算日界線」
 *
 *  `lib/dates.ts` 頂端那條規矩禁止的是**「問現在幾點，然後判斷那是哪一天」**
 *  —— 那件事需要知道使用者的時區，而唯一的事實來源是後端的
 *  `today_in_timezone(user.timezone)`（`app/days.py`）。
 *
 *  這個模組做的是別的事：輸入是一個**伺服器已經決定好的**日曆日字串
 *  （`GET /api/stats/daily` 回應裡的 `date`），輸出是另一個日曆日字串。
 *  **它從頭到尾不問裝置今天幾號。**
 *
 *  所以 `today()` / `startOfDay()` 依然不該存在（在這裡或任何地方）；
 *  `shiftDays` 可以存在。
 *
 *  ## 為什麼一定要 UTC
 *
 *  `new Date("2026-09-21")` 依規範解析成 **UTC 午夜**。接著若用本地
 *  accessor，在 UTC 以西會整個差一天：在 `America/New_York` 那一刻是當地的
 *  9/20 20:00，`getDate()` 回 20。
 *
 *  **而在 `Asia/Taipei`（UTC+8、無日光節約）與 CI（UTC）都看不到這個 bug** ——
 *  錯誤的寫法在這兩個環境都給出正確答案。行為測試因此擋不住它，
 *  只有上面那條掃描測試擋得住。
 */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** 把一個 `YYYY-MM-DD` 往前或往後推 `delta` 天，回傳同樣格式的字串。
 *
 *  用 `slice` 取三段數字而不是解構 `RegExp.exec()` 的結果：在
 *  `noUncheckedIndexedAccess` 之下後者是 `string | undefined`，會逼出一串
 *  跟這個函式的意義無關的 undefined 判斷。`slice` 回的是 `string`。
 *
 *  `Date.UTC` 自己處理溢位（第 0 天是上個月的最後一天、第 32 天是下個月），
 *  所以跨月、跨年、閏日都不需要特別處理。 */
export function shiftDays(isoDate: string, delta: number): string {
	if (!ISO_DATE.test(isoDate)) {
		throw new Error(`shiftDays 只接受 YYYY-MM-DD，收到：${JSON.stringify(isoDate)}`);
	}
	const year = Number(isoDate.slice(0, 4));
	const month = Number(isoDate.slice(5, 7));
	const day = Number(isoDate.slice(8, 10));
	return new Date(Date.UTC(year, month - 1, day + delta))
		.toISOString()
		.slice(0, 10);
}

/** `"2026-09-05"` → `"9/5"`。
 *
 *  純字串切割，不經過 `Date` —— 同樣是為了讓這個模組整體對時區免疫。
 *  `Number()` 是用來去掉前導零的。 */
export function formatCivilDate(isoDate: string): string {
	if (!ISO_DATE.test(isoDate)) {
		throw new Error(
			`formatCivilDate 只接受 YYYY-MM-DD，收到：${JSON.stringify(isoDate)}`,
		);
	}
	return `${Number(isoDate.slice(5, 7))}/${Number(isoDate.slice(8, 10))}`;
}
```

- [ ] **Step 4: 跑測試確認全綠**

```bash
cd frontend && npx vitest run tests/civil-date.test.ts
```

Expected: PASS，9 則測試。

- [ ] **Step 5: 突變驗證 —— 這一步是整個 Task 的重點**

把 `shiftDays` 的實作暫時換成錯誤的本地 accessor 版本：

```ts
export function shiftDays(isoDate: string, delta: number): string {
	if (!ISO_DATE.test(isoDate)) {
		throw new Error(`shiftDays 只接受 YYYY-MM-DD，收到：${JSON.stringify(isoDate)}`);
	}
	const d = new Date(isoDate);
	d.setDate(d.getDate() + delta);
	return d.toISOString().slice(0, 10);
}
```

```bash
cd frontend && npx vitest run tests/civil-date.test.ts
```

**預期（請照這個預期核對，兩件事都要成立）：**

- **六條行為測試全部照樣綠。** 你在 UTC+8，本地 accessor 在這裡剛好對。
- **「整個模組沒有任何非 UTC 的 Date accessor」那條紅**，訊息會列出
  `["getDate", "setDate"]`。

> **如果行為測試也紅了：** 代表你這台機器的時區不是 UTC+8 或 UTC。
> 那不是壞事（那表示你的環境本來就抓得到這個 bug），但請在報告裡寫出
> 你的時區，因為那跟這份計畫的假設不同。
>
> **如果掃描測試沒紅：** 停下來報告 —— 這個 Task 的唯一守衛失效了。

看到預期的結果之後，把實作改回 `Date.UTC` 版本，再跑一次確認全綠。

- [ ] **Step 6: 更新規格，讓它跟實際做法一致**

規格 §4.2 目前說 `shiftDays` 放在 `src/lib/dates.ts`，§4.3 說靠非 UTC 時區
的測試來擋。兩處都要改成實際的作法 —— **不改的話，規格就變成第二個會說謊的
事實來源**，而這個專案在 P3-A 已經因為「同一份文件裡兩處講同一件事然後漂移」
出事五次。

編輯 `docs/superpowers/specs/2026-09-21-p3b-frontend-design.md`：

把 §4.2 的第一句

```
`src/lib/dates.ts` 目前的定位是「只做格式化，不做日界線計算」。加進去的
`shiftDays(isoDate: string, delta: number): string` 看起來像是破例，其實不是：
```

改成

```
`shiftDays(isoDate: string, delta: number): string` 放在**自己的模組**
`src/lib/civil-date.ts`，不是 `dates.ts`（實作時的修正，見計畫一 Task 2）。
`dates.ts` 做顯示格式化、用得到本地時間；`civil-date.ts` 做曆法加減、
**不得使用任何本地時間的 accessor**，兩種責任分開才守得住。

它看起來像是破例，其實不是：
```

把 §4.2 末尾那段 `> **`dates.ts` 的檔頭註解必須同時更新。**` 的整個引言區塊
刪掉（`dates.ts` 不再需要改），換成：

```
> **`dates.ts` 不動。** 它的檔頭寫著「所以這裡沒有 `today()`、沒有
> `startOfDay()`，將來也不該有」—— 那句話依然完全正確，因為 `shiftDays`
> 不住在那裡。
```

把 §4.3 最後那一段以 `> **而「在 Node 裡改 `process.env.TZ` 會不會真的生效」` 開頭
的引言，整段換成：

```
> **實作時改用結構性的守衛，而不是特殊的測試環境**（計畫一 Task 2）。
> Node 在 Windows 上對執行期修改 `process.env.TZ` 的支援不可靠，而 V8 會
> 快取時區 —— 那條路線要先驗它能不能成立，成本比它擋到的東西還高。
>
> 改成：`civil-date.ts` 這個模組**不得出現任何本地時間的 accessor**，
> 由一條原始碼掃描測試（手法同 `tests/decimal-containment.test.ts`）守著。
> 已用突變驗證：換成 `getDate()`/`setDate()` 的版本時，六條行為測試
> **全部照樣綠**，只有掃描那條紅 —— 正好印證了 §11.4 說的「時區遮住了它」。
```

- [ ] **Step 7: lint、型別、全套測試**

```bash
cd frontend && npm run lint && npm run typecheck && npm run test 2>&1 | tail -10
```

Expected: 三個都綠；`Tests` 比 Task 1 記錄的數字多 9。

- [ ] **Step 8: Commit**

```bash
git add frontend/src/lib/civil-date.ts frontend/tests/civil-date.test.ts docs/superpowers/specs/2026-09-21-p3b-frontend-design.md
git commit -m "$(cat <<'EOF'
feat: shiftDays——用結構性守衛取代「在正確時區下跑測試」

趨勢圖要問「最近七天」的起點，而 stats/range 的 from/to 都是必填。
錨點取自 stats/daily 回應裡的 date（伺服器算的今天），前端只做曆法
加減。

規格原本要靠「在非 UTC 時區下跑測試」擋住本地 accessor 的 bug。改掉
了：Node 在 Windows 上對執行期改 process.env.TZ 的支援不可靠，而 V8
會快取時區。改成把 shiftDays 放進自己的模組，規定它不得出現任何本地
時間的 accessor，由原始碼掃描測試守著——手法同 decimal-containment。

突變驗證親眼確認：換成 getDate()/setDate() 的錯誤版本時，六條行為測試
在 UTC+8 底下全部照樣綠，只有掃描那條紅。這正是規格 §11.4 說的
「時區遮住了這個 bug」——行為測試在這裡沒有任何鑑別力。

規格 §4.2 / §4.3 已同步改成實際作法。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: 樣式基礎、底部 tab bar、`/trend` 路由

**這個 Task 引入這個專案的第一行 CSS。** 目前 `frontend/src` 底下沒有任何
`.css`、沒有任何 `className`、沒有任何 `style=` —— `index.html` 也還是 Vite
的 scaffold 預設值（`lang="en"`、`<title>frontend</title>`）。

作法：一份 `src/index.css`，純 class 選擇器，`main.tsx` import 它。
不引入 CSS modules、不引入 Tailwind —— 那是 P3-B 不需要的相依與設定。

**Files:**
- Create: `frontend/src/index.css`
- Create: `frontend/src/components/TabBar.tsx`
- Create: `frontend/tests/tab-bar.test.tsx`
- Modify: `frontend/src/main.tsx`
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/index.html`

- [ ] **Step 1: 寫失敗的測試**

建 `frontend/tests/tab-bar.test.tsx`：

```tsx
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { TabBar } from "../src/components/TabBar";

function renderAt(path: string) {
	return render(
		<MemoryRouter initialEntries={[path]}>
			<TabBar />
		</MemoryRouter>,
	);
}

describe("TabBar", () => {
	it("四個目的地都在", () => {
		renderAt("/");
		for (const name of ["今日總覽", "記一餐", "趨勢", "食物庫"]) {
			expect(screen.getByRole("link", { name })).toBeInTheDocument();
		}
	});

	it("目前所在的那一格標成 aria-current", () => {
		// 用 NavLink 而不是 Link：NavLink 自己會依路由比對加上
		// aria-current="page"。自己用 useLocation 比對字串的話，
		// 「哪一格是亮的」就變成一個要自己維護、而且測試只驗 class
		// 名稱的東西——而 class 名稱跟螢幕閱讀器讀到的東西無關。
		renderAt("/trend");

		expect(screen.getByRole("link", { name: "趨勢" })).toHaveAttribute(
			"aria-current",
			"page",
		);
		expect(screen.getByRole("link", { name: "今日總覽" })).not.toHaveAttribute(
			"aria-current",
		);
	});

	it("在 /log 時亮的是記一餐，不是今日總覽", () => {
		// 這條守的是 NavLink 的 `end`。根路由 "/" 是每一個路徑的前綴，
		// 沒有 end 的話「今日總覽」在任何頁面都會是 aria-current，
		// 而上面那條測試（停在 /trend）**照樣會綠**——因為它只檢查趨勢
		// 那一格亮著，沒檢查別格暗著。這條是專門補那個洞的。
		renderAt("/log");

		expect(screen.getByRole("link", { name: "記一餐" })).toHaveAttribute(
			"aria-current",
			"page",
		);
		expect(screen.getByRole("link", { name: "今日總覽" })).not.toHaveAttribute(
			"aria-current",
		);
	});
});
```

- [ ] **Step 2: 跑測試確認它失敗**

```bash
cd frontend && npx vitest run tests/tab-bar.test.tsx
```

Expected: FAIL，`Failed to resolve import "../src/components/TabBar"`。

- [ ] **Step 3: 寫 TabBar**

建 `frontend/src/components/TabBar.tsx`：

```tsx
import { NavLink } from "react-router";

type Tab = { to: string; label: string; end?: boolean };

/** 底部導覽（規格 §3.1）。
 *
 *  **用 `NavLink` 而不是 `Link`**：NavLink 自己依目前路由加上
 *  `aria-current="page"`。自己拿 `useLocation()` 比字串的話，「哪一格是
 *  亮的」會退化成一個只有 class 名稱看得出來的狀態 —— 而 class 名稱
 *  螢幕閱讀器讀不到，測試驗它也只是在驗我們自己寫的字串。
 *
 *  **`/` 那一格一定要 `end`。** 根路由是每一個路徑的前綴，沒有 `end`
 *  的話「今日總覽」在每一頁都會是 `aria-current`。
 */
const TABS: readonly Tab[] = [
	{ to: "/", label: "今日總覽", end: true },
	{ to: "/log", label: "記一餐" },
	{ to: "/trend", label: "趨勢" },
	{ to: "/foods", label: "食物庫" },
];

export function TabBar() {
	return (
		<nav className="tab-bar" aria-label="主要導覽">
			{TABS.map((tab) => (
				<NavLink key={tab.to} to={tab.to} end={tab.end} className="tab">
					{tab.label}
				</NavLink>
			))}
		</nav>
	);
}
```

> **`/foods` 這個路由在計畫二才存在。** 現在點它會走到一個沒有 `<Route>`
> 比對到的路徑，畫面上 `<Routes>` 什麼都不渲染（tab bar 還在）。
> 這是刻意的：放一個「施工中」的佔位畫面，就是留下一個沒有人會回來刪的東西。

- [ ] **Step 4: 寫 CSS**

建 `frontend/src/index.css`：

```css
/* 這個專案的第一份樣式表（P3-B 計畫一 Task 3）。
   純 class 選擇器，沒有 CSS modules、沒有 Tailwind——P3-B 不需要那些設定。 */

:root {
	/* 底部 tab bar 的高度，加上 iPhone home indicator 的安全區。
	   下面的 main 用同一個變數補 padding，兩個數字因此不可能漂移。 */
	--tab-bar-height: 56px;
	--safe-bottom: env(safe-area-inset-bottom, 0px);
}

body {
	margin: 0;
	font-family: system-ui, -apple-system, "Noto Sans TC", sans-serif;
}

/* tab bar 是 position: fixed，會蓋住內容的最後一行——而「今天最後吃的
   那一餐」正好就在那個位置（規格 §3.1）。這裡補回等高的空間。 */
.app-main {
	padding: 0 12px calc(var(--tab-bar-height) + var(--safe-bottom) + 12px);
}

.tab-bar {
	position: fixed;
	bottom: 0;
	left: 0;
	right: 0;
	display: flex;
	/* 有 home indicator 的機子（iPhone X 之後），最底下一排會被系統的
	   手勢區遮掉一截。墊高這個量之後才看得完整（規格 §3.1）。 */
	padding-bottom: var(--safe-bottom);
	border-top: 1px solid #ddd;
	background: #fff;
}

.tab {
	flex: 1;
	/* 44px 是可點選區的下限；這裡給 56 是為了讓中文標籤不會貼邊。 */
	min-height: var(--tab-bar-height);
	display: flex;
	align-items: center;
	justify-content: center;
	text-decoration: none;
	color: #555;
	font-size: 14px;
}

.tab[aria-current="page"] {
	color: #111;
	font-weight: 600;
}
```

- [ ] **Step 5: 跑測試確認全綠**

```bash
cd frontend && npx vitest run tests/tab-bar.test.tsx
```

Expected: PASS，3 則。

- [ ] **Step 6: 突變驗證 —— 確認 `end` 真的被守著**

把 `TABS` 裡 `{ to: "/", label: "今日總覽", end: true }` 的 `end: true` 拿掉。

```bash
cd frontend && npx vitest run tests/tab-bar.test.tsx
```

Expected: **「在 /log 時亮的是記一餐，不是今日總覽」那條紅**
（今日總覽也拿到了 `aria-current="page"`）。

改回來，重跑確認綠。

- [ ] **Step 7: 接進 App.tsx**

修改 `frontend/src/App.tsx`：

1. 把 `Link` 從 react-router 的 import 拿掉（不再用），加入 `Trend` 與 `TabBar` 的 import：

```tsx
import { BrowserRouter, Route, Routes, useNavigate } from "react-router";
```

```tsx
import { TabBar } from "./components/TabBar";
```

2. 把 `Nav` 裡的兩個 `<Link>` 刪掉 —— 導覽改由 `TabBar` 負責。
   **「重新整理」與「登出」兩個按鈕原封不動留著**（見〈開工前必讀〉第 3 點）。
   改完的 `Nav` 是：

```tsx
function Nav({ onLoggedOut }: { onLoggedOut: () => void }) {
	// 「重新整理」按鈕從 main.tsx 搬過來，不是刪掉——計畫一的
	// 「access token 過期時會自動換票並重送」E2E 依賴它打 /api/me。
	//
	// **不要改成 useMe() 的 refetch。** staleTime 是 60 秒，改了之後按下去
	// 什麼都不會發生，而 e2e/auth.spec.ts 那條測試不會紅——它只是不再
	// 測到任何東西（規格 §8.1）。
	//
	// 導覽連結搬到 <TabBar>（P3-B 計畫一 Task 3），這裡只剩下兩個動作。
	const [displayName, setDisplayName] = useState<string | null>(null);

	return (
		<nav>
			<button
				type="button"
				onClick={async () => {
					const me = await apiFetch<{ display_name: string }>("/api/me");
					setDisplayName(me?.display_name ?? null);
				}}
			>
				重新整理
			</button>
			<button
				type="button"
				onClick={async () => {
					await logout();
					onLoggedOut();
				}}
			>
				登出
			</button>
			{displayName !== null && <p>{displayName}</p>}
		</nav>
	);
}
```

3. 用 `<main className="app-main">` 包住 `<Routes>`，並在它後面掛上
   `<TabBar />`。**`<Routes>` 裡維持原本的兩列** —— `/trend` 在 Task 5 才加
   （`Trend` 元件那時候才存在）：

```tsx
			{loggedIn ? (
				<BrowserRouter>
					<Nav onLoggedOut={() => setLoggedIn(false)} />
					<main className="app-main">
						<Routes>
							<Route path="/" element={<Today />} />
							<Route path="/log" element={<LogMealRoute />} />
						</Routes>
					</main>
					<TabBar />
				</BrowserRouter>
			) : (
				<Login onSuccess={() => setLoggedIn(true)} />
			)}
```

- [ ] **Step 8: 接進 main.tsx 與 index.html**

修改 `frontend/src/main.tsx`，在最上面加一行：

```tsx
import "./index.css";
```

修改 `frontend/index.html`：

```html
<html lang="zh-Hant-TW">
```

```html
    <title>飲食紀錄</title>
```

> 兩個都還是 Vite scaffold 的預設值（`lang="en"`、`<title>frontend</title>`）。
> `lang` 不是裝飾：它影響瀏覽器選中日韓字型時挑哪一套字形，也影響螢幕閱讀器
> 用哪個語音。`<title>` 是 PWA 加到主畫面之前分頁上顯示的名字。

- [ ] **Step 9: 全套測試**

```bash
cd frontend && npm run test 2>&1 | tail -15
```

Expected: 全綠。

> **已經先查過了，不需要猜：** `tests/app.test.tsx` 完全沒有查詢導覽連結
> （它只驗登入／登出的畫面切換），所以搬動連結不會動到它。
>
> E2E 那邊也查過：`e2e/daily-loop.spec.ts:86` 用
> `getByRole("link", { name: "記一餐" })` —— `TabBar` 提供同名的連結，
> 而且全頁只有一個，不會變成 strict mode 的多重比對。
> `e2e/auth.spec.ts` 用的是 `getByRole("heading", { name: "今日總覽" })`，
> 指的是 `Today.tsx` 的 `<h1>`，跟 tab 上同名的**連結**靠 role 區分得開。
>
> **所以這一步紅了就是真的有問題**，不要改測試去配合。

- [ ] **Step 10: lint 與型別**

```bash
cd frontend && npm run lint && npm run typecheck
```

Expected: 兩個都是 exit 0。

- [ ] **Step 11: Commit**

```bash
git add frontend/src frontend/tests/tab-bar.test.tsx frontend/index.html
git commit -m "$(cat <<'EOF'
feat: 底部 tab bar，以及這個專案的第一份 CSS

畫面要從兩個變五個，一排頂部連結在手機寬度下會換行，而且在螢幕最上方
——單手拿手機時拇指最遠的地方。每天要按好幾次的「記一餐」不該在那裡。

這個專案在此之前一行 CSS 都沒有：src 底下沒有 .css、沒有 className、
沒有 style=。這份 index.css 是第一份，純 class 選擇器，不引入
CSS modules 或 Tailwind。

兩個版面細節有真實後果：env(safe-area-inset-bottom) 不處理的話，有
home indicator 的機子最底下一排會被遮掉；main 不補等高的 padding 的話
fixed 的 tab bar 會蓋住內容最後一行，而那正是「今天最後吃的那一餐」。

用 NavLink 而不是 Link，因為 aria-current 是螢幕閱讀器讀得到、測試也
斷言得了的東西，class 名稱兩者皆非。

突變驗證：拿掉 "/" 那格的 end，「在 /log 時亮的是記一餐」那條確實轉紅
——根路由是每個路徑的前綴，沒有 end 就每一頁都亮。

順手改掉 index.html 兩個還留著的 Vite scaffold 預設值：lang="en" 與
<title>frontend</title>。lang 影響瀏覽器挑哪套中日韓字形與螢幕閱讀器
的語音，不是裝飾。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: TrendChart —— 純渲染的 SVG 長條圖

**這個 Task 不碰任何查詢。** `TrendChart` 收到一個陣列就畫，拿不到資料時
是呼叫端的事（Task 5）。

### 一個必須先講清楚的實作限制

**jsdom 不做版面計算。** `getBoundingClientRect()` 一律回 0，CSS 的
`height` 讀不出實際像素。

所以：**每一根柱子的幾何必須在 JS 裡算成 SVG 屬性**（`height="80"`），
**不可以交給 CSS**。交給 CSS 的話規格 §4.6 那條幾何斷言在 jsdom 裡讀到的
永遠是空值 —— 測試會變成「斷言兩個 undefined 相等」那種最糟的綠燈。

**Files:**
- Create: `frontend/src/components/TrendChart.tsx`
- Create: `frontend/tests/trend-chart.test.tsx`
- Modify: `frontend/src/lib/decimal.ts`

- [ ] **Step 1: 先加 `maxOf` 到 `lib/decimal.ts`**

圖要算 y 軸上限 —— 也就是一組 `Numeric` 字串的最大值。
`lib/decimal.ts` 是整個前端**唯一**允許 `new Decimal()` 的地方
（`tests/decimal-containment.test.ts` 在守），所以這個函式必須放在那裡。

在 `frontend/src/lib/decimal.ts` 末尾加：

```ts
/** 一組數值的最大值。空陣列回 `"0"`。
 *
 *  給 `TrendChart` 算 y 軸上限用。**放在這裡而不是圖表元件裡**，是因為
 *  比較兩個 `Numeric` 必須經過 `Decimal` —— 用 `Math.max(...values.map(Number))`
 *  就是把浮點誤差請回來，而這個模組存在的理由正是把它擋在外面。 */
export function maxOf(values: readonly Numeric[]): Numeric {
	return values
		.reduce(
			(largest, value) =>
				new Decimal(value).greaterThan(largest) ? new Decimal(value) : largest,
			new Decimal(0),
		)
		.toString();
}
```

- [ ] **Step 2: 寫失敗的測試**

建 `frontend/tests/trend-chart.test.tsx`：

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TrendChart, type TrendDay } from "../src/components/TrendChart";

function macros(kcal: string) {
	return { kcal, protein_g: "0.00", fat_g: "0.00", carb_g: "0.00" };
}

function day(date: string, kcal: string, targetKcal: string | null): TrendDay {
	return {
		date,
		actual: macros(kcal),
		target:
			targetKcal === null
				? null
				: { kcal: targetKcal, protein_g: null, fat_g: null, carb_g: null },
		ratio: null,
	};
}

function bars() {
	return screen.getAllByTestId(/^trend-bar-/);
}

function heightOf(index: number) {
	const bar = bars()[index];
	if (bar === undefined) throw new Error(`沒有第 ${index} 根柱子`);
	return Number(bar.getAttribute("height"));
}

describe("TrendChart", () => {
	it("每一天都有一根柱子，沒吃東西的那天也有", () => {
		// 規格 §4.5（二）：actual 永遠有值，沒吃東西時是 "0.00"，
		// 不是把那天從陣列裡拿掉。後端的 DayTrendResponse docstring
		// 寫著「畫圖要連續」——少畫一根，圖上的七天就變成看起來像六天。
		render(
			<TrendChart
				days={[
					day("2026-09-15", "1800.00", "2000.00"),
					day("2026-09-16", "0.00", "2000.00"),
					day("2026-09-17", "1900.00", "2000.00"),
				]}
			/>,
		);

		expect(bars()).toHaveLength(3);
		expect(
			screen.getByTestId("trend-bar-2026-09-16"),
		).toBeInTheDocument();
	});

	it("柱子的高度比例等於數值的比例", () => {
		// **規格 §4.6：這條是唯一真的碰到「那張圖」的斷言。**
		//
		// 下面那條 aria-label 的測試證明的是「我們把資料組成了字串」——
		// 把 height 的計算整個換成常數，它照樣綠。這條不會。
		//
		// 三天：1000 / 500 / 2000，最大值 2000。
		// 高度應該是 1:0.5:2 的比例。
		render(
			<TrendChart
				days={[
					day("2026-09-15", "1000.00", null),
					day("2026-09-16", "500.00", null),
					day("2026-09-17", "2000.00", null),
				]}
			/>,
		);

		expect(heightOf(0) / heightOf(1)).toBeCloseTo(2);
		expect(heightOf(2) / heightOf(0)).toBeCloseTo(2);
	});

	it("每根柱子的 aria-label 帶得出那天的數字", () => {
		render(<TrendChart days={[day("2026-09-15", "1800.00", "2000.00")]} />);

		expect(screen.getByTestId("trend-bar-2026-09-15")).toHaveAttribute(
			"aria-label",
			"9/15，1800 大卡，目標 2000 大卡",
		);
	});

	it("那天沒有目標時，label 說沒有目標，而且不畫目標線", () => {
		// 規格 §4.5（一）第一層 null：target 整個是 null，那一天沒有生效目標。
		render(<TrendChart days={[day("2026-09-15", "1800.00", null)]} />);

		expect(screen.getByTestId("trend-bar-2026-09-15")).toHaveAttribute(
			"aria-label",
			"9/15，1800 大卡，沒有目標",
		);
		expect(
			screen.queryByTestId("trend-target-2026-09-15"),
		).not.toBeInTheDocument();
	});

	it("有目標但熱量那一項沒設，也不畫目標線", () => {
		// 規格 §4.5（一）第二層 null：target 存在，但 target.kcal 是 null。
		//
		// **這跟上一條是不同的事實**，雖然畫面結果一樣。把兩層壓成
		// `target?.kcal ?? 0` 的話，這裡會畫出一條貼地的目標線，
		// 讀起來是「今天的目標是 0 大卡」。
		render(
			<TrendChart
				days={[
					{
						date: "2026-09-15",
						actual: macros("1800.00"),
						target: {
							kcal: null,
							protein_g: "150.00",
							fat_g: null,
							carb_g: null,
						},
						ratio: null,
					},
				]}
			/>,
		);

		expect(
			screen.queryByTestId("trend-target-2026-09-15"),
		).not.toBeInTheDocument();
		expect(screen.getByTestId("trend-bar-2026-09-15")).toHaveAttribute(
			"aria-label",
			"9/15，1800 大卡，沒有目標",
		);
	});

	it("全部是 0 又沒有目標時不會炸，柱子高度都是 0", () => {
		// 規格 §4.5（三）：y 軸上限會是 0，不能拿它當除數。
		render(
			<TrendChart
				days={[day("2026-09-15", "0.00", null), day("2026-09-16", "0.00", null)]}
			/>,
		);

		expect(bars()).toHaveLength(2);
		expect(heightOf(0)).toBe(0);
		expect(heightOf(1)).toBe(0);
	});

	it("目標比實際高時，目標線在柱子上面", () => {
		// SVG 的 y 軸往下增加，所以「比較高」是 y 比較小。
		render(<TrendChart days={[day("2026-09-15", "1000.00", "2000.00")]} />);

		const bar = screen.getByTestId("trend-bar-2026-09-15");
		const line = screen.getByTestId("trend-target-2026-09-15");

		expect(Number(line.getAttribute("y1"))).toBeLessThan(
			Number(bar.getAttribute("y")),
		);
	});
});
```

- [ ] **Step 3: 跑測試確認它失敗**

```bash
cd frontend && npx vitest run tests/trend-chart.test.tsx
```

Expected: FAIL，`Failed to resolve import "../src/components/TrendChart"`。

- [ ] **Step 4: 寫 TrendChart**

建 `frontend/src/components/TrendChart.tsx`：

```tsx
import type { components } from "../api/schema";
import { formatCivilDate } from "../lib/civil-date";
import { formatMacro, maxOf, ratioOf } from "../lib/decimal";

export type TrendDay = components["schemas"]["DayTrendResponse"];

/** SVG 的座標系。**固定值，不量容器** —— jsdom 不做版面計算，
 *  任何依賴實際寬度的東西在測試裡都會讀到 0。用 viewBox + preserveAspectRatio
 *  讓瀏覽器自己縮放，程式碼裡的座標永遠是這組數字。 */
const VIEW_WIDTH = 280;
const VIEW_HEIGHT = 160;
const BAR_WIDTH_RATIO = 0.6;

/** 最近幾天的熱量長條圖（規格 §4.4–§4.6）。
 *
 *  **純渲染，不取資料。** 呼叫端負責查詢、載入中、錯誤。
 *
 *  ## 幾何一律算成屬性，不交給 CSS
 *
 *  `height`、`y` 都是在這裡算好寫進 SVG 屬性的。**不可以改成用 CSS 控制
 *  柱子高度** —— jsdom 不做版面計算，`getBoundingClientRect()` 回 0，
 *  規格 §4.6 那條「高度比例等於數值比例」的斷言就會退化成在比兩個空值。
 *
 *  ## 兩層 null
 *
 *  `target` 整個是 `null`（那天沒有生效目標）與 `target.kcal` 是 `null`
 *  （有目標但這一項沒設）是**兩個不同的事實**，雖然畫面結果都是不畫目標線。
 *  **不要寫成 `day.target?.kcal ?? 0`** —— 那會把兩層壓成一層，然後畫出
 *  一條貼地的線，讀起來是「今天的目標是 0 大卡」。
 */
export function TrendChart({ days }: { days: readonly TrendDay[] }) {
	// y 軸上限：期間內實際值與目標值的最大值。目標可能整組是 null，
	// 也可能 kcal 那一項是 null——兩種都不參與比較。
	const targetValues = days
		.map((day) => day.target?.kcal ?? null)
		.filter((value): value is string => value !== null);
	const ceiling = maxOf([...days.map((day) => day.actual.kcal), ...targetValues]);

	const slot = VIEW_WIDTH / Math.max(days.length, 1);
	const barWidth = slot * BAR_WIDTH_RATIO;
	const inset = (slot - barWidth) / 2;

	/** 把一個數值換算成 SVG 的 y 座標。
	 *
	 *  `ratioOf` 在 ceiling 是 "0" 時回 `null`（除以 0 沒有意義），
	 *  這裡把它當成「高度 0」—— 規格 §4.5（三）：全都是 0 又沒目標的期間，
	 *  所有柱子貼地，不是炸掉。 */
	const heightOf = (value: string): number => {
		const ratio = ratioOf(value, ceiling);
		return ratio === null ? 0 : ratio * VIEW_HEIGHT;
	};

	return (
		<svg
			viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
			className="trend-chart"
			data-testid="trend-chart"
			role="group"
			aria-label="最近幾天的熱量"
		>
			{days.map((day, index) => {
				const height = heightOf(day.actual.kcal);
				const x = index * slot + inset;
				// 第一層 null（整天沒目標）與第二層 null（這一項沒設）在這裡
				// 一起被收斂成「沒有可畫的目標值」——但收斂發生在讀完兩層之後，
				// 不是用 ?? 0 把它們壓成同一個數字。
				const targetKcal = day.target === null ? null : day.target.kcal;
				const label =
					targetKcal === null
						? `${formatCivilDate(day.date)}，${formatMacro(day.actual.kcal)} 大卡，沒有目標`
						: `${formatCivilDate(day.date)}，${formatMacro(day.actual.kcal)} 大卡，目標 ${formatMacro(targetKcal)} 大卡`;

				return (
					<g key={day.date}>
						<rect
							data-testid={`trend-bar-${day.date}`}
							role="img"
							aria-label={label}
							x={x}
							y={VIEW_HEIGHT - height}
							width={barWidth}
							height={height}
							className="trend-bar"
						/>
						{targetKcal !== null && (
							<line
								data-testid={`trend-target-${day.date}`}
								x1={index * slot}
								x2={(index + 1) * slot}
								y1={VIEW_HEIGHT - heightOf(targetKcal)}
								y2={VIEW_HEIGHT - heightOf(targetKcal)}
								className="trend-target"
							/>
						)}
					</g>
				);
			})}
		</svg>
	);
}
```

> **`formatMacro("1800.00")` 回的是 `"1800"`** —— `Decimal.toString()` 會把
> 尾端的零去掉。上面測試裡的期望值（`1800 大卡`）就是照這個行為寫的。
> 如果你看到的是 `1800.00`，代表 `formatMacro` 的行為跟這裡的假設不同 ——
> **停下來報告，不要直接改測試的期望值去配合。**

- [ ] **Step 5: 加圖的樣式**

在 `frontend/src/index.css` 末尾加：

```css
/* 圖的「大小」由 CSS 決定，但每一根柱子的「高度」不是——那是在
   TrendChart.tsx 裡算成 SVG 屬性的。理由見那個檔案的 docstring：
   jsdom 不做版面計算，交給 CSS 的話幾何就測不到。 */
.trend-chart {
	width: 100%;
	height: auto;
	display: block;
}

.trend-bar {
	fill: #4a7;
}

.trend-target {
	stroke: #c33;
	stroke-width: 2;
	stroke-dasharray: 4 3;
}
```

- [ ] **Step 6: 跑測試確認全綠**

```bash
cd frontend && npx vitest run tests/trend-chart.test.tsx
```

Expected: PASS，7 則。

- [ ] **Step 7: 突變驗證（一）—— 幾何斷言真的在守幾何嗎**

把 `TrendChart.tsx` 裡的

```tsx
						height={height}
```

改成

```tsx
						height={40}
```

```bash
cd frontend && npx vitest run tests/trend-chart.test.tsx
```

**預期：**

- **「柱子的高度比例等於數值的比例」紅**（比例變成 1，期望 2）
- **「全部是 0 又沒有目標時不會炸」紅**（高度變成 40，期望 0）
- **「每根柱子的 aria-label 帶得出那天的數字」照樣綠** ← 這就是規格 §4.6 的重點

把第三點寫進報告 —— 那是這條突變要證明的事：**一份只讀 `aria-label` 的
測試，對「圖畫得對不對」零鑑別力。**

改回來，重跑確認綠。

- [ ] **Step 8: 突變驗證（二）—— 兩層 null 沒有被壓成一層**

把

```tsx
				const targetKcal = day.target === null ? null : day.target.kcal;
```

改成

```tsx
				const targetKcal = day.target?.kcal ?? "0";
```

```bash
cd frontend && npx vitest run tests/trend-chart.test.tsx
```

Expected: **「那天沒有目標時…」與「有目標但熱量那一項沒設…」兩條都紅** ——
目標線被畫出來了，而且 label 變成「目標 0 大卡」。

改回來，重跑確認綠。

- [ ] **Step 9: 全套測試、lint、型別**

```bash
cd frontend && npm run test 2>&1 | tail -10 && npm run lint && npm run typecheck
```

Expected: 全綠。特別注意 `tests/decimal-containment.test.ts` 仍然綠 ——
`maxOf` 加在 `lib/decimal.ts` 裡面，沒有把 `decimal.js` 漏到別的檔案。

- [ ] **Step 10: Commit**

```bash
git add frontend/src frontend/tests/trend-chart.test.tsx
git commit -m "$(cat <<'EOF'
feat: TrendChart——手寫 SVG，幾何算成屬性而不是交給 CSS

不引入圖表庫。Chart.js 畫在 canvas 上，而 jsdom 沒有 canvas，單元測試
只能斷言「有一個 <canvas>」——正好是這個專案一路在抵抗的那種綠燈
（resize-image.ts 當初被隔離就是同一個原因）。Recharts 是 SVG 但依賴
ResizeObserver 與容器寬度，jsdom 裡寬度恆為 0，而且 gzip 後約 100KB，
這是一個要預快取給離線用的 PWA。

同樣的理由決定了實作方式：每根柱子的 height/y 都在 JS 裡算成 SVG 屬性，
不交給 CSS。交給 CSS 的話，規格 §4.6 那條幾何斷言在 jsdom 裡會退化成
在比兩個空值。

突變驗證兩條：
- height 改成常數 → 幾何斷言紅、全 0 那條紅、**aria-label 那條照樣綠**。
  那正是 §4.6 要說的：只讀 aria-label 的測試對「圖對不對」零鑑別力。
- target 的兩層 null 壓成 `?? "0"` → 兩條 null 測試都紅，目標線被畫成
  貼地的一條，讀起來是「今天目標 0 大卡」。

maxOf 加在 lib/decimal.ts——比較兩個 Numeric 必須經過 Decimal，
用 Math.max(...map(Number)) 就是把浮點誤差請回來。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Trend 畫面 —— 日期錨點與查詢

**Files:**
- Create: `frontend/src/screens/Trend.tsx`
- Create: `frontend/tests/trend.test.tsx`
- Modify: `frontend/src/api/queries.ts`
- Modify: `frontend/src/App.tsx`

- [ ] **Step 1: 加 query key**

在 `frontend/src/api/queries.ts` 的 `queryKeys` 裡，`meals` 那一項後面加：

```ts
	/** 趨勢：一段期間的逐日統計。
	 *
	 *  **帶 from / to 兩個參數，而它們來自 `stats/daily` 回應裡的 `date`**
	 *  （規格 §4.1）——`GET /api/stats/range` 的 from/to 都是必填，跟
	 *  `stats/daily` 不一樣，而「今天是哪一天」只有伺服器知道。
	 *
	 *  跟 `dailyStats` 同在 `["stats"]` 底下是刻意的：記一餐之後要一次
	 *  失效掉所有期間的趨勢（見下面的 `rangeStatsAll`），而那個前綴
	 *  不會碰到 `dailyStats`。 */
	rangeStats: (from: string, to: string) =>
		["stats", "range", from, to] as const,
	/** 「所有期間的趨勢」這個前綴，給 `invalidateQueries` 用。
	 *
	 *  寫成一個具名的 key 而不是在呼叫端手打 `["stats", "range"]`，
	 *  理由跟這個檔案頂端說的一樣：兩邊各拼一次字串，某天其中一邊改了，
	 *  失效就靜默失靈。 */
	rangeStatsAll: ["stats", "range"] as const,
```

- [ ] **Step 2: 寫失敗的測試**

建 `frontend/tests/trend.test.tsx`：

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetRefreshStateForTests } from "../src/auth/refresh";
import { clearTokens, setTokens } from "../src/auth/store";
import { Trend } from "../src/screens/Trend";
import { json, mockApi } from "./helpers/mock-api";

function wrap(children: ReactNode) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function macros(kcal: string) {
	return { kcal, protein_g: "0.00", fat_g: "0.00", carb_g: "0.00" };
}

const DAILY = {
	date: "2026-09-21",
	actual: macros("1800.00"),
	target: null,
	ratio: null,
	breakdown: { food: macros("1800.00"), supplement: macros("0.00") },
};

function rangeBody(adherence: string | null) {
	return {
		date_from: "2026-09-15",
		date_to: "2026-09-21",
		adherence,
		trend: [
			"2026-09-15",
			"2026-09-16",
			"2026-09-17",
			"2026-09-18",
			"2026-09-19",
			"2026-09-20",
			"2026-09-21",
		].map((date) => ({
			date,
			actual: macros("1800.00"),
			target: null,
			ratio: null,
		})),
	};
}

beforeEach(() => {
	localStorage.clear();
	clearTokens();
	resetRefreshStateForTests();
	vi.restoreAllMocks();
	setTokens({ access_token: "a", refresh_token: "r" });
});

describe("趨勢畫面", () => {
	it("from / to 是從 stats/daily 回的 date 推出來的，不是前端自己算今天", async () => {
		// **這條是這個畫面的核心保證（規格 §4.1）。**
		//
		// mock 回的「今天」是 2026-09-21，跟這台機器真正的今天無關。
		// 如果實作偷懶用 new Date() 算今天，這裡請求的 from/to 就會是
		// 執行測試的那一天，而不是 09-15 / 09-21——斷言會紅。
		//
		// 這也是為什麼 mock 的日期刻意寫死成一個不可能剛好等於
		// 「執行日」的值：等於的話，錯誤的實作也會通過。
		const fetchMock = mockApi([
			{ path: "/api/stats/range", handler: () => json(rangeBody(null)) },
			{ path: "/api/stats/daily", handler: () => json(DAILY) },
		]);

		render(wrap(<Trend />));
		await screen.findByTestId("trend-chart");

		const rangeCall = fetchMock.mock.calls.find(([input]) =>
			String(input).includes("/api/stats/range"),
		);
		expect(rangeCall).toBeDefined();
		expect(String(rangeCall?.[0])).toContain("from=2026-09-15");
		expect(String(rangeCall?.[0])).toContain("to=2026-09-21");
	});

	it("錨點還沒回來之前不打 range —— from/to 是必填，沒有錨點就沒得問", async () => {
		// GET /api/stats/range 的 from/to 沒有 default（app/api/routes/stats.py）。
		// 少帶會拿到 422，而那個 422 在畫面上會長得像「趨勢壞了」。
		const fetchMock = mockApi([
			{ path: "/api/stats/range", handler: () => json(rangeBody(null)) },
			{ path: "/api/stats/daily", handler: () => json(DAILY) },
		]);

		render(wrap(<Trend />));

		// 第一批請求裡不該有 range——daily 還沒回來。
		expect(
			fetchMock.mock.calls.filter(([input]) =>
				String(input).includes("/api/stats/range"),
			),
		).toHaveLength(0);

		// 等錨點回來之後才出現。
		await screen.findByTestId("trend-chart");
		expect(
			fetchMock.mock.calls.filter(([input]) =>
				String(input).includes("/api/stats/range"),
			).length,
		).toBeGreaterThan(0);
	});

	it("七天全部畫出來", async () => {
		mockApi([
			{ path: "/api/stats/range", handler: () => json(rangeBody(null)) },
			{ path: "/api/stats/daily", handler: () => json(DAILY) },
		]);

		render(wrap(<Trend />));
		await screen.findByTestId("trend-chart");

		expect(screen.getAllByTestId(/^trend-bar-/)).toHaveLength(7);
	});

	it("有依從率時顯示百分比", async () => {
		mockApi([
			{ path: "/api/stats/range", handler: () => json(rangeBody("0.85")) },
			{ path: "/api/stats/daily", handler: () => json(DAILY) },
		]);

		render(wrap(<Trend />));

		expect(await screen.findByTestId("adherence")).toHaveTextContent("85%");
	});

	it("adherence 是 null 時說沒有計畫，不是 0%", async () => {
		// app/schemas/stats.py 寫明：0 會讀成「一次都沒吃」，1 會讀成
		// 「全部做到」，null 的意思是「沒有計畫，這個比率沒有定義」。
		// 顯示成 0% 是把「沒有標準」講成「做得很差」。
		mockApi([
			{ path: "/api/stats/range", handler: () => json(rangeBody(null)) },
			{ path: "/api/stats/daily", handler: () => json(DAILY) },
		]);

		render(wrap(<Trend />));

		const adherence = await screen.findByTestId("adherence");
		expect(adherence).toHaveTextContent("沒有補劑計畫");
		expect(adherence).not.toHaveTextContent("0%");
	});
});
```

- [ ] **Step 3: 跑測試確認它失敗**

```bash
cd frontend && npx vitest run tests/trend.test.tsx
```

Expected: FAIL，`Failed to resolve import "../src/screens/Trend"`。

- [ ] **Step 4: 寫 Trend 畫面**

建 `frontend/src/screens/Trend.tsx`：

```tsx
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "../api/client";
import { queryKeys } from "../api/queries";
import type { components } from "../api/schema";
import { TrendChart } from "../components/TrendChart";
import { shiftDays } from "../lib/civil-date";

type DailyStats = components["schemas"]["DailyStatsResponse"];
type RangeStats = components["schemas"]["RangeStatsResponse"];

/** 最近七天。兩端都含，所以起點是終點往回推 6 天（不是 7）——
 *  `app/api/routes/stats.py` 的 `get_range_stats`：
 *  「使用者說『9/1 到 9/7』預期的是 7 天」。 */
const SPAN_DAYS = 7;

/** 趨勢畫面（規格 §4）。
 *
 *  ## 日期錨點
 *
 *  `GET /api/stats/range` 的 `from` / `to` **都是必填**，跟
 *  `GET /api/stats/daily` 不一樣（後者省略 `date` 時會用
 *  `today_in_timezone(user.timezone)` 幫你算今天）。
 *
 *  所以「最近七天」要先知道今天是幾號 —— 而前端**永遠不自己算日界線**。
 *  解法是拿 `stats/daily` 回應裡的 `date`：那就是伺服器對「這個使用者的
 *  今天是哪一天」的答案，這裡只是讀回來，沒有重新推導它。
 *
 *  **代價是冷快取時有一次瀑布式等待。** 實務上「今日總覽」已經在打同一支
 *  查詢、結果已經在快取裡（`staleTime: 60_000`），所以通常不會真的多一個
 *  往返；離線時它在持久化快取裡，錨點一樣拿得到。
 */
export function Trend() {
	const anchorQuery = useQuery({
		queryKey: queryKeys.dailyStats,
		queryFn: () => apiFetch<DailyStats>("/api/stats/daily"),
	});

	const today = anchorQuery.data?.date ?? null;
	const from = today === null ? null : shiftDays(today, -(SPAN_DAYS - 1));

	const rangeQuery = useQuery({
		// key 一定要有值（TanStack Query 不接受 undefined 的 key），
		// 但 enabled 保證錨點是 null 時不會真的發請求——所以這組空字串
		// 的 key 永遠不會被寫入任何資料。
		queryKey: queryKeys.rangeStats(from ?? "", today ?? ""),
		queryFn: () =>
			apiFetch<RangeStats>(`/api/stats/range?from=${from}&to=${today}`),
		enabled: from !== null && today !== null,
	});

	const range = rangeQuery.data;

	return (
		<section>
			<h1>趨勢</h1>

			{anchorQuery.isError && <p>無法載入趨勢</p>}
			{range === undefined && !anchorQuery.isError && <p>載入中…</p>}

			{range !== undefined && (
				<>
					<TrendChart days={range.trend} />

					{/* 規格 §4.7：null 不能顯示成 0%。
					    0 讀起來是「一次都沒吃」，而 null 的意思是「沒有計畫，
					    這個比率沒有定義」——把「沒有標準」講成「做得很差」。 */}
					<p data-testid="adherence">
						{range.adherence === null
							? "這段期間沒有補劑計畫"
							: `補劑依從率 ${Number(range.adherence).toLocaleString(undefined, {
									style: "percent",
									maximumFractionDigits: 0,
								})}`}
					</p>
				</>
			)}
		</section>
	);
}
```

> **`Number(range.adherence)` 看起來像是違反「數字都是字串」的規矩，但不是。**
> `adherence` 是一個**比率**（0–1），不是營養素數值 —— 它只拿去給
> `toLocaleString` 做百分比顯示，不參與任何加總或比較。
> `MacroBar.tsx` 對 `ratioOf()` 的回傳值也是這樣用的（那個函式回的本來就是
> `number`）。**不要**把它改成 `new Decimal()` —— 那會讓
> `tests/decimal-containment.test.ts` 紅。

- [ ] **Step 5: 跑測試確認全綠**

```bash
cd frontend && npx vitest run tests/trend.test.tsx
```

Expected: PASS，5 則。

- [ ] **Step 6: 突變驗證 —— 錨點真的來自伺服器嗎**

把 `Trend.tsx` 裡的

```tsx
	const today = anchorQuery.data?.date ?? null;
```

改成前端自己算今天：

```tsx
	const today = new Date().toISOString().slice(0, 10);
```

（同時把下一行的 `today === null ? null :` 拿掉以便編譯。）

```bash
cd frontend && npx vitest run tests/trend.test.tsx
```

Expected: **「from / to 是從 stats/daily 回的 date 推出來的」那條紅** ——
請求的 `from` / `to` 變成執行測試那一天，不是 09-15 / 09-21。

改回來，重跑確認綠。

- [ ] **Step 7: 接上路由**

修改 `frontend/src/App.tsx`：

加 import：

```tsx
import { Trend } from "./screens/Trend";
```

在 `<Routes>` 裡加：

```tsx
						<Route path="/trend" element={<Trend />} />
```

- [ ] **Step 8: 全套測試、lint、型別**

```bash
cd frontend && npm run test 2>&1 | tail -10 && npm run lint && npm run typecheck
```

Expected: 全綠。

- [ ] **Step 9: Commit**

```bash
git add frontend/src frontend/tests/trend.test.tsx
git commit -m "$(cat <<'EOF'
feat: 趨勢畫面——日期錨點取自伺服器，不是前端算的今天

GET /api/stats/range 的 from/to 都是必填，跟 stats/daily 不一樣（後者
省略 date 時會用 today_in_timezone(user.timezone)）。所以「最近七天」
要先知道今天是幾號，而前端永遠不自己算日界線。

解法是拿 stats/daily 回應裡的 date 當錨點——那就是伺服器對「這個使用者
的今天是哪一天」的答案，這裡只是讀回來。代價是冷快取時有一次瀑布式
等待，但今日總覽已經在打同一支查詢，通常不會真的多一個往返。

突變驗證：把錨點換成 new Date().toISOString()，「from/to 是從 stats/daily
回的 date 推出來的」那條確實轉紅——mock 回的今天是 2026-09-21，刻意寫死
成一個不可能等於執行日的值，否則錯誤的實作也會通過。

adherence 是 null 時顯示「這段期間沒有補劑計畫」，不是 0%。後端的
docstring 寫明 0 會讀成「一次都沒吃」，而 null 的意思是這個比率沒有定義。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: 記一餐讓趨勢失效，加契約 E2E

**Files:**
- Modify: `frontend/src/screens/LogMeal.tsx`
- Create: `frontend/e2e/trend.spec.ts`

- [ ] **Step 1: 加那一行失效**

在 `frontend/src/screens/LogMeal.tsx` 的 mutation `onSuccess` 裡，
`invalidateQueries({ queryKey: queryKeys.dailyStats })` 那一行後面加：

```tsx
			// 記完一餐，趨勢圖上「今天」那根柱子也變了。不加這一行的話，
			// 記完切到趨勢看到的是舊的數字。
			//
			// **用前綴 `["stats", "range"]` 是刻意的**：rangeStats 的 key 帶
			// from / to 兩個參數，要失效的是「所有期間」。這個前綴不會碰到
			// `["stats", "daily"]`（規格 §7.2）。
			//
			// **而這一行是那條路徑唯一的守衛。** staleTime 是 60 秒，切換路由
			// 的 unmount／remount 不會自動重取（計畫二 Task 6 為此補上的），
			// 所以刪掉它，e2e/trend.spec.ts 會紅。
			queryClient.invalidateQueries({ queryKey: queryKeys.rangeStatsAll });
```

- [ ] **Step 2: 寫 E2E**

建 `frontend/e2e/trend.spec.ts`：

```ts
import { expect, test } from "@playwright/test";

const EMAIL = "kenny.demo@example.com";
const PASSWORD = "demo-pass-12345";

test("記一餐之後，趨勢圖上今天那根柱子跟著變", async ({ page, request }) => {
	// **這條守的是 LogMeal.tsx 那一行 invalidateQueries(rangeStatsAll)。**
	//
	// ⚠️ 跟 daily-loop.spec.ts 一樣，這條測試的鑑別力依賴
	// src/api/queries.ts 的 staleTime（60 秒）。staleTime 是 0 的話，
	// 切換路由讓 Trend unmount／remount，remount 時資料「過期」就會自動
	// 重取——跟有沒有 invalidateQueries 完全無關，這條測試會因為錯誤的
	// 理由變綠。改那個值之前，先把那一行拿掉跑一次確認這條仍然會紅。
	//
	// 記一餐畫面只讀 /api/foods/frequent 與 /api/foods/recent，兩者都只回
	// 「這個使用者記錄過的食物」（app/api/routes/foods.py 的
	// _my_recorded_foods_stmt）。CI 的 e2e job 只用 create-admin 建帳號、
	// 沒有任何餐點資料，所以這裡先用 API 建一個食物、記一筆歷史餐點，
	// 讓它進「最近吃」清單——真正要驗的那次 invalidateQueries 仍然是
	// 透過 UI 觸發的。
	const loginResponse = await request.post("/api/auth/login", {
		data: { email: EMAIL, password: PASSWORD },
	});
	const { access_token: accessToken } = (await loginResponse.json()) as {
		access_token: string;
	};
	const authHeaders = {
		Authorization: `Bearer ${accessToken}`,
		"content-type": "application/json",
	};

	const foodName = `趨勢 E2E 食物 ${Date.now()}`;
	const foodResponse = await request.post("/api/foods", {
		headers: authHeaders,
		data: {
			name: foodName,
			brand: null,
			nutrition: {
				base_unit: "g",
				kcal: "200.00",
				protein_g: "10.00",
				fat_g: "5.00",
				carb_g: "30.00",
			},
		},
	});
	expect(foodResponse.status()).toBe(201);
	const { id: foodId } = (await foodResponse.json()) as { id: number };

	// 先記一筆，讓這個食物進「最近吃」清單，UI 上才點得到。
	const seedResponse = await request.post("/api/meals", {
		headers: authHeaders,
		data: {
			eaten_at: new Date().toISOString(),
			meal_type: "snack",
			note: null,
			items: [{ food_id: foodId, grams: "100.00" }],
		},
	});
	expect(seedResponse.status()).toBe(201);

	await page.goto("/");
	await page.getByLabel("Email").fill(EMAIL);
	await page.getByLabel("密碼").fill(PASSWORD);
	await page.getByRole("button", { name: "登入" }).click();

	// 趨勢畫面：讀「今天」那根柱子的 aria-label。期間的最後一天就是今天，
	// 所以是最後一根。
	await page.getByRole("link", { name: "趨勢" }).click();
	await page.getByTestId("trend-chart").waitFor();
	const todayBar = page.getByTestId("trend-chart").locator("rect").last();
	const before = await todayBar.getAttribute("aria-label");
	expect(before).not.toBeNull();

	// 透過 UI 記一餐。
	await page.getByRole("link", { name: "記一餐" }).click();
	await page.getByText(foodName).first().click();
	await page.getByLabel("公克").fill("250");
	await page.getByRole("button", { name: "送出" }).click();

	// 回到趨勢，同一根柱子的數字必須變了。
	await page.getByRole("link", { name: "趨勢" }).click();
	await page.getByTestId("trend-chart").waitFor();
	await expect(
		page.getByTestId("trend-chart").locator("rect").last(),
	).not.toHaveAttribute("aria-label", before ?? "");
});
```

> **`getByLabel("公克")` 與 `getByRole("button", { name: "送出" })` 這兩個
> 選擇器要對照 `src/screens/LogMeal.tsx` 實際的文字確認。** 這份計畫是照
> 2026-09-21 的程式碼寫的 —— 如果實際的 label 不一樣，**改這裡的選擇器，
> 不要改 `LogMeal.tsx` 去配合這份計畫**（〈開工前必讀〉第 1 點）。

- [ ] **Step 3: 起 prod stack 跑 E2E**

```bash
cd F:/wallet && docker compose up -d --build
```

等 api 健康之後：

```bash
cd frontend && npx playwright test e2e/trend.spec.ts
```

Expected: PASS。

> **本機重複跑會撞到登入限速**（`GLOBAL_LIMIT = 20` / 60 秒，所有 email
> 共用）。連續跑幾輪之後**全部**測試會一起失敗，而症狀看起來像功能壞了。
> 解法：`docker compose restart api`。CI 每次都是全新容器，不受影響。

- [ ] **Step 4: 突變驗證 —— 那一行失效真的是唯一的守衛嗎**

把 Step 1 加的 `invalidateQueries({ queryKey: queryKeys.rangeStatsAll })`
整行刪掉（或註解掉），重新 build 前端並跑：

```bash
cd F:/wallet && docker compose up -d --build
cd frontend && npx playwright test e2e/trend.spec.ts
```

Expected: **FAIL** —— 回到趨勢時 `aria-label` 沒變。

> **如果它沒有紅：** 停下來報告。這代表有別的機制（很可能是 remount 自動
> 重取）讓它變綠，而那正是計畫二 Task 6 踩過的同一個坑 —— 去確認
> `src/api/queries.ts` 的 `staleTime` 還是不是 60 秒。

改回來，重新 build，確認綠。

- [ ] **Step 5: 跑完整的 E2E 與全套測試**

```bash
cd F:/wallet && docker compose restart api
cd frontend && npx playwright test && npm run test 2>&1 | tail -10 && npm run lint && npm run typecheck
```

Expected: 全綠，Playwright 7 條（原本 6 條加這一條）。

- [ ] **Step 6: Commit**

```bash
git add frontend/src/screens/LogMeal.tsx frontend/e2e/trend.spec.ts
git commit -m "$(cat <<'EOF'
feat: 記一餐讓趨勢失效，加契約 E2E

不加的話，記完一餐切到趨勢，今天那根柱子還是舊的。

用前綴 ["stats","range"] 是刻意的：rangeStats 的 key 帶 from/to 兩個
參數，要失效的是所有期間，而這個前綴不會碰到 ["stats","daily"]。
寫成具名的 queryKeys.rangeStatsAll 而不是在呼叫端手打字串——兩邊各拼
一次，某天其中一邊改了失效就靜默失靈。

突變驗證：整行刪掉，e2e/trend.spec.ts 確實轉紅。這條測試的鑑別力依賴
staleTime=60s（計畫二 Task 6 補上的那個值）——staleTime 是 0 的話
remount 會自動重取，這條會因為錯誤的理由變綠，測試檔的註解寫了這件事。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## 收尾

- [ ] **把實測結果寫回這份計畫**

每個 Task 的突變驗證實際看到什麼（哪幾條紅、哪幾條綠、有沒有跟預期不同），
寫進對應的 Step 底下。**跟預期不同的那些特別重要** —— 那是這份計畫錯了，
而下一個人會照著它做。

- [ ] **開 PR**

```bash
git push -u origin feat/p3b-trend-foods-admin
gh pr create --title "P3-B 計畫一：底部導覽與趨勢圖" --body "$(cat <<'EOF'
## 做了什麼

- 底部 tab bar（四格），以及這個專案的第一份 CSS
- 最近七天的熱量趨勢圖，手寫 SVG
- `shiftDays`：日曆日加減，結構上對時區免疫
- fetch mock 抽成共用輔助，順便統一兩個已經分岔的版本

## 三個突變驗證的結果

- **`shiftDays` 換成本地 accessor** → 六條行為測試在 UTC+8 底下**全部照樣綠**，
  只有原始碼掃描那條紅。這正是規格 §11.4 說的「時區遮住了這個 bug」。
- **柱子高度改成常數** → 幾何斷言紅，但 **aria-label 那條照樣綠**。
  §4.6 的重點：只讀 aria-label 的測試對「圖對不對」零鑑別力。
- **刪掉 `invalidateQueries(rangeStatsAll)`** → E2E 紅。

## 不在這個 PR 裡

管理員 tab、食物庫、審核佇列 —— 計畫二。`/foods` 那一格現在點了會是空畫面，
那是刻意的：放佔位畫面就是留一個沒人會回來刪的東西。

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```
