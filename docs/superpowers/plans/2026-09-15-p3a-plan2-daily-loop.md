# P3-A 計畫二：每天真的會走的那個迴圈

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把「看今天吃了什麼」與「記一餐」接起來，讓這個 app 從「能登入」變成「每天真的會用」。

**Architecture:** React Router 接多畫面、TanStack Query 管快取與失效、`lib/decimal.ts` 是唯一碰數值的地方。兩個畫面：今日總覽（讀 + 補劑打卡）與記一餐（從「常吃 / 最近吃」快選）。記完一餐要讓今日總覽失效重取 —— 那條失效路徑是這份計畫的核心。

**Tech Stack:** React Router · TanStack Query · decimal.js · Vitest + Testing Library · Playwright

**規格：** [docs/superpowers/specs/2026-09-11-p3a-frontend-design.md](../specs/2026-09-11-p3a-frontend-design.md)
**前一份計畫：** [P3-A 計畫一](2026-09-14-p3a-plan1-foundation-and-login.md)

---

## 範圍：為什麼切在「兩個畫面」而不是三個

計畫一做完了基礎建設與登入。這一份做**每天真的會走的迴圈**：

| | 內容 |
|---|---|
| **這一份** | React Router · TanStack Query · `decimal.ts` · 今日總覽 · 記一餐 · 兩條契約 E2E |
| 計畫三 | 拍照上傳與顯示 · 離線 L2 · 其餘兩條契約 E2E |

**「記一餐 + 今日總覽」本身就是完整的產品迴圈** —— 記錄、然後看到結果。走完這一份，這個 app 每天真的能用。拍照是加分項，不是這個迴圈的一環（規格 §7 把它排在第三位就是這個意思）。

切在這裡還有一個實際理由：**記一餐要讓今日總覽失效重取**，那條路徑需要兩個畫面同時存在才測得到。拍照沒有這種耦合，可以獨立做。

---

## 前提

- 計畫一已合併（PR #7）。master 上：後端 503 個測試、前端 60 個測試、E2E 2 條，CI 五個 job 全綠。
- **Task 1（HTTPS）仍然延後** —— NAS 暫時無法操作。這份計畫的所有東西都不依賴它。
- dev 環境：`docker compose up -d`（api `:8000`、db `:5433`），前端 `cd frontend && npm run dev`（`:5173`，`/api` 已代理）。
- dev 帳號：`kenny.demo@example.com` / `demo-pass-12345`。dev 資料庫已有 20+ 筆餐點橫跨 10 天、7 個食物、3 個補劑、2 段目標期間、24 筆補劑打卡（**刻意有漏**，依從率 0.77）。

---

## 沿用計畫一學到的東西

計畫一被實作找出 **11 個缺陷**，其中四個屬於同一個家族：**「工具跑了、回報成功、但它從來沒看過那個東西」**。這份計畫要繼續帶著那些教訓：

1. **新的測試檔副檔名要確認真的被檢查到。** 這份會加 `.tsx` 測試 —— `typecheck.include` 已經在計畫一改成涵蓋 `?(x)`，但**加完新檔案要用突變確認**（塞一個型別錯誤，確認 `npm run test` 會紅且指得出是哪個檔案）。
2. **新的產出目錄要同時進 `frontend/.gitignore`**（Biome 的 `vcs.useIgnoreFile` 只讀那一份，不會往上找根目錄）。
3. **突變表的預測是推測，不是事實。** 計畫一有兩次高估（我以為某條測試會走到某個分支，它在更早就被攔截了）。跑出來跟預測不符就如實回報。
4. **Windows 上寫檔用 LF。** 而且根因已經在 Task 1 修掉了 —— repo 根目錄
   新增了 `.gitattributes`（`* text=auto eol=lf`）。

   **在那之前，一個乾淨的 clone 在 Windows 上跑 `npm run lint` 會報二十幾個
   錯**（`core.autocrlf=true` 讓 checkout 把 LF 換成 CRLF，而 Biome 要 LF），
   **而 CI（Linux）完全沒有這個問題**。那是一個「結果取決於你在哪台機器上跑」
   的檢查 —— 比永遠紅更糟，因為永遠紅至少是誠實的，這個會讓人以為自己的
   機器壞了然後去關掉 lint。

   只把工作目錄的檔案轉成 LF 是修症狀，下一次 checkout 會再來一次。

---

## 檔案結構

```
frontend/src/
  lib/
    decimal.ts          唯一允許 new Decimal() 的地方
    dates.ts            **只做顯示格式化**，不做日界線計算
  api/
    queries.ts          TanStack Query 的 key 與 query/mutation 定義
  screens/
    Today.tsx           今日總覽
    LogMeal.tsx         記一餐
  components/
    MacroBar.tsx        一個營養素的「攝取 vs 目標」
  App.tsx               Router 與版面
```

**為什麼 `queries.ts` 集中放 query key：** 記一餐要讓今日總覽失效，那代表**兩個畫面共用同一個 key**。分散寫的話，兩邊各拼一次字串，某天其中一邊改了，失效就靜默失靈 —— 而症狀是「記完一餐，總覽數字沒變」，使用者會以為沒記進去。key 只有一個事實來源。

**為什麼 `dates.ts` 只做格式化：** 規格 §5.3。日界線由伺服器決定（`app/days.py` 是唯一來源）。這個限制要寫在檔案頂端的註解裡，因為它是一條靠人記住就會失守的規矩。

---

### Task 1：React Router 與版面

**Files:**
- Modify: `frontend/package.json`
- Create: `frontend/src/App.tsx`
- Modify: `frontend/src/main.tsx`
- Create: `frontend/tests/app.test.tsx`

- [ ] **Step 1: 裝 router**

```bash
cd frontend && npm install react-router
```

> **計畫一刻意沒裝它**，理由是「這一份只有兩個狀態（登入 / 已登入），
> 現在裝等於先建一個只有一條路由的路由器」。**現在有兩個畫面了，裝它是對的。**
>
> 用 `react-router` 而不是 `react-router-dom` —— v7 之後兩個套件合併了，
> `react-router-dom` 只是相容別名。**以實際裝到的版本為準**：如果 import
> 路徑不對，看 `node_modules/react-router/package.json` 的 exports，
> 不要照這裡的字面硬套。

- [ ] **Step 2: 寫失敗的測試**

Create `frontend/tests/app.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { resetRefreshStateForTests } from "../src/auth/refresh";
import { clearTokens, setTokens } from "../src/auth/store";

beforeEach(() => {
	localStorage.clear();
	clearTokens();
	resetRefreshStateForTests();
	vi.restoreAllMocks();
});

describe("App", () => {
	it("沒有 token 時顯示登入畫面", () => {
		render(<App />);
		expect(screen.getByRole("heading", { name: "登入" })).toBeInTheDocument();
	});

	it("有 token 時顯示今日總覽，而不是登入畫面", () => {
		// 重新整理之後不該被踢回登入頁——refresh token 還在 localStorage 裡。
		setTokens({ access_token: "a", refresh_token: "r" });
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify([]), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);

		render(<App />);

		expect(screen.queryByRole("heading", { name: "登入" })).not.toBeInTheDocument();
	});

	it("登出之後回到登入畫面", async () => {
		setTokens({ access_token: "a", refresh_token: "r" });
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }));

		render(<App />);
		await userEvent.click(screen.getByRole("button", { name: "登出" }));

		expect(await screen.findByRole("heading", { name: "登入" })).toBeInTheDocument();
	});
});
```

- [ ] **Step 3: 跑測試確認它失敗**

Run: `cd frontend && npm run test`
Expected: FAIL — 找不到 `../src/App`

- [ ] **Step 4: 實作**

Create `frontend/src/App.tsx`。**以官方 quickstart 為準寫 Router 的接法**，這裡只列出必須成立的行為：

- 未登入（`getRefreshToken() === null`）→ 一律顯示 `<Login>`，不管網址是什麼
- 已登入 → 兩條路由：`/`（今日總覽）與 `/log`（記一餐），加上一個導覽列
- 導覽列有「登出」按鈕，按下去走 `logout()` 然後回到登入畫面
- **這個 task 的兩個畫面先放佔位元件**（`<h1>今日總覽</h1>` / `<h1>記一餐</h1>`），Task 4、5 才填內容

> **為什麼不在這裡寫完整的 `App.tsx` 程式碼：** React Router v7 的 API
> （`createBrowserRouter` vs `<BrowserRouter>` vs framework mode）在不同版本
> 差很多，而我不知道你會裝到哪一版。**照官方 quickstart 接，然後讓上面
> 三條測試通過** —— 測試描述的是行為，不是實作方式。
>
> 這是計畫一學到的：照著我瞎編的設定抄，比照著官方輸出改風險更高。

Modify `frontend/src/main.tsx`：拿掉裡面的登入/已登入狀態機與「重新整理」按鈕，改成只 render `<App />`。

> **「重新整理」按鈕不要刪掉，搬到 `App.tsx` 的導覽列。**
> 計畫一的 E2E `access token 過期時會自動換票並重送` 依賴它 —— 刪掉那條
> E2E 會紅。搬過去之後那條測試應該仍然綠；**跑一次確認**。

- [ ] **Step 5: 跑測試與 E2E**

```bash
cd frontend
npm run lint && npm run typecheck && npm run test && npm run build
npx playwright test          # 預期 2 passed（計畫一那兩條仍然綠）
```

- [ ] **Step 6: 突變驗證**

| 突變 | 預期變紅 |
|---|---|
| 未登入時也 render 導覽列與 `<Today>` | 「沒有 token 時顯示登入畫面」 |
| 登出按鈕只打 API 不清本地狀態 | 「登出之後回到登入畫面」 |

> **Task 1 順帶要修的兩件事（實作時發現）：**
>
> **1. `e2e/auth.spec.ts` 的斷言文字要跟著換。** 計畫一那兩條 E2E 斷言的是
> heading「已登入」，而這個 task 把那個扁平的佔位頁換成了 Router 的
> 「今日總覽」路由。**斷言的意圖不變**（登入成功後不再停在登入畫面），
> 只是文字跟著畫面換。改完跑一次確認那兩條仍然綠。
>
> **2. repo 根目錄加 `.gitattributes`。** 見本計畫開頭第 4 點 ——
> 這是在乾淨 clone 上 `npm run lint` 會不會過的根因。
>
> ```
> * text=auto eol=lf
> *.png binary
> *.jpg binary
> *.jpeg binary
> *.ico binary
> *.svg text eol=lf
> *.woff2 binary
> ```
>
> 加完跑 `git add --renormalize .` 確認索引沒有內容變動（如果有，代表
> 索引裡本來就混著 CRLF，那要另外處理），然後**實測驗證**：
> `rm frontend/src/App.tsx && git checkout -- frontend/src/App.tsx`，
> 確認 checkout 出來的是 LF。

- [ ] **Step 7: Commit**

```bash
git add frontend/ .gitattributes
git commit -m "feat: React Router 與版面"

計畫一刻意沒裝 Router（只有兩個狀態，裝它等於先建一個只有一條路由的
路由器）。現在有兩個畫面了。

「重新整理」按鈕從 main.tsx 搬到導覽列，不是刪掉——計畫一的
「401 → refresh → 重送」E2E 依賴它。"
```

---

### Task 2：TanStack Query

**Files:**
- Modify: `frontend/package.json`
- Create: `frontend/src/api/queries.ts`
- Modify: `frontend/src/App.tsx`
- Create: `frontend/tests/queries.test.tsx`

- [ ] **Step 1: 裝**

```bash
cd frontend && npm install @tanstack/react-query
```

> **規格決策 4 選它的三個理由，現在才全部成立：**
> access token 15 分鐘過期（計畫一的 `apiFetch` 已經處理了 401 重送，
> 這一條其實用不到 Query）、`/api/stats/daily` 天然可快取、
> **記完一餐要讓今日總覽失效重取**。
>
> 第三條是這份計畫的核心，也是計畫一刻意不裝它的理由消失的那一刻。

- [ ] **Step 2: 寫失敗的測試**

Create `frontend/tests/queries.test.tsx`:

```tsx
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { queryKeys } from "../src/api/queries";

describe("query key", () => {
	it("今日總覽與補劑各有自己的 key", () => {
		expect(queryKeys.dailyStats).not.toEqual(queryKeys.supplementsToday);
	});

	it("失效今日總覽不會連帶失效無關的 key", () => {
		// 這條守的是「key 的前綴沒有重疊到不該重疊的東西」。
		// 全部共用一個前綴的話，記一餐會把常吃清單也一起失效掉——
		// 那不是錯誤，但會讓每次記帳多打兩個沒必要的請求。
		const client = new QueryClient();
		client.setQueryData(queryKeys.dailyStats, { marker: "stats" });
		client.setQueryData(queryKeys.frequentFoods, { marker: "foods" });

		client.invalidateQueries({ queryKey: queryKeys.dailyStats });

		expect(client.getQueryState(queryKeys.frequentFoods)?.isInvalidated).toBe(false);
	});
});
```

- [ ] **Step 3: 跑測試確認它失敗**

Run: `cd frontend && npm run test`
Expected: FAIL — 找不到 `../src/api/queries`

- [ ] **Step 4: 實作 query key**

Create `frontend/src/api/queries.ts`:

```ts
/** 所有 query key 的唯一事實來源。
 *
 *  **為什麼集中放：** 記一餐要讓今日總覽失效，那代表兩個畫面共用同一個 key。
 *  分散寫的話兩邊各拼一次字串，某天其中一邊改了，失效就**靜默失靈** ——
 *  而症狀是「記完一餐，總覽的數字沒變」，使用者會以為沒記進去。
 *
 *  **`dailyStats` 刻意不帶日期參數。** 後端省略 `?date=` 時會用
 *  `today_in_timezone(user.timezone)`（規格 §5.3、後端 `app/days.py`）——
 *  前端**不該自己算今天是哪一天**。所以這個 query 沒有參數，
 *  key 也就沒有參數。
 */
export const queryKeys = {
	dailyStats: ["stats", "daily"] as const,
	supplementsToday: ["supplements", "today"] as const,
	frequentFoods: ["foods", "frequent"] as const,
	recentFoods: ["foods", "recent"] as const,
} as const;
```

- [ ] **Step 5: 接上 QueryClientProvider**

`App.tsx` 外面包一層 `QueryClientProvider`。**QueryClient 的實例要建在元件外面或用 `useState` 包住** —— 直接寫在 render 裡每次重繪都會建一個新的，快取等於沒有。

> **另外：`INVALID_TOKEN` 時必須清掉 query 快取**（規格 §6.5）。
> 不清的話，下一個登入的人會先看到上一個人的今日總覽，然後才被重新
> fetch 覆蓋掉 —— **那是使用者會親眼看到的跨使用者資料外洩**。
>
> 接在 `logout()` 與「強制登出」兩條路徑上：`queryClient.clear()`。
> **這一條要有測試**（見 Task 4 Step 2 的最後一條）。

- [ ] **Step 6: 驗證與 Commit**

```bash
cd frontend
npm run lint && npm run typecheck && npm run test && npm run build
git add frontend/
git commit -m "feat: TanStack Query 與集中的 query key

query key 集中在 queries.ts：記一餐要讓今日總覽失效，兩個畫面共用同一個
key。分散寫的話兩邊各拼一次字串，某天其中一邊改了失效就靜默失靈——
而症狀是「記完一餐總覽數字沒變」，使用者會以為沒記進去。

dailyStats 刻意不帶日期參數：後端省略 ?date= 時用使用者時區的今天，
前端不該自己算今天是哪一天。"
```

---

### Task 3：`lib/decimal.ts`

規格 §5.1：**所有數值都是字串**。`Decimal` 序列化成字串以避免浮點誤差。

**Files:**
- Modify: `frontend/package.json`
- Create: `frontend/src/lib/decimal.ts`
- Create: `frontend/tests/decimal.test.ts`

- [ ] **Step 1: 裝**

```bash
cd frontend && npm install decimal.js
```

- [ ] **Step 2: 寫失敗的測試**

Create `frontend/tests/decimal.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { formatMacro, ratioOf, sumMacros } from "../src/lib/decimal";

describe("formatMacro", () => {
	it("保留後端給的小數位", () => {
		expect(formatMacro("180.50")).toBe("180.5");
	});

	it("不經過浮點數", () => {
		// 0.1 + 0.2 在 IEEE 754 是 0.30000000000000004。
		// 這條測試的價值不在這個特定的值，而在於它會因為任何
		// 「改用 parseFloat」的實作而變紅。
		expect(sumMacros(["0.1", "0.2"])).toBe("0.3");
	});

	it("大數值不會失去精度", () => {
		expect(sumMacros(["9007199254740993", "1"])).toBe("9007199254740994");
	});
});

describe("ratioOf", () => {
	it("算出比例", () => {
		expect(ratioOf("90", "100")).toBe(0.9);
	});

	it("目標是 null 時回 null，不是 0", () => {
		// 規格 §5.7：「沒有標準可比」跟「0%」是兩件不同的事。
		// 回 0 的話 UI 會畫出一條空的進度條，看起來像「完全沒吃」。
		expect(ratioOf("90", null)).toBeNull();
	});

	it("目標是 0 時回 null，不是 Infinity", () => {
		// 後端在 target 為 0 時已經回 ratio: null（除以 0 沒有意義），
		// 但前端自己算的時候也要守同一條規則——否則 UI 會出現 Infinity%。
		expect(ratioOf("90", "0")).toBeNull();
	});

	it("實際值是 0 時回 0，不是 null", () => {
		// 這條跟上面兩條是一對：「還沒吃」是一個真實的 0，
		// 不是「沒有標準可比」。混為一談的話，今天還沒吃東西的畫面
		// 會顯示成「沒有設定目標」。
		expect(ratioOf("0", "100")).toBe(0);
	});
});
```

- [ ] **Step 3: 跑測試確認它失敗**

Run: `cd frontend && npm run test`
Expected: FAIL — 找不到 `../src/lib/decimal`

- [ ] **Step 4: 實作**

Create `frontend/src/lib/decimal.ts`:

```ts
import Decimal from "decimal.js";

/** 後端的所有數值都是字串（規格 §5.1）—— `Decimal` 序列化成字串以避免
 *  浮點誤差。這個別名讓型別簽章讀得出「這不是一般的 string」。 */
export type Numeric = string;

/** **這個模組是整個前端唯一允許 `new Decimal()` 的地方。**
 *
 *  跟後端把「每 100 單位的 100」關在 `app/nutrition.py` 是同一個手法：
 *  一個概念只有一個實作位置，其他地方想用錯都沒有入口。
 *
 *  對外只暴露「字串進、字串或 number 出」的函式，不回傳 `Decimal` 實例 ——
 *  回傳的話呼叫端就能在模組外做運算，這個約束等於沒有。
 */

export function formatMacro(value: Numeric): string {
	return new Decimal(value).toString();
}

export function sumMacros(values: readonly Numeric[]): Numeric {
	return values.reduce((total, value) => total.plus(value), new Decimal(0)).toString();
}

/** 攝取 / 目標的比例。`0.9` 代表 90%。
 *
 *  **目標是 `null` 或 `0` 時回 `null`，不是 0 也不是 Infinity。**
 *  「沒有標準可比」跟「0%」是兩件不同的事（規格 §5.7）——
 *  回 0 的話 UI 會畫出一條空的進度條，看起來像「完全沒吃」。
 *
 *  而**實際值**是 0 時要回 `0`：那是一個真實的「還沒吃」。
 */
export function ratioOf(actual: Numeric, target: Numeric | null): number | null {
	if (target === null) return null;
	const targetValue = new Decimal(target);
	if (targetValue.isZero()) return null;
	return new Decimal(actual).dividedBy(targetValue).toNumber();
}
```

- [ ] **Step 5: 跑測試確認通過**

Run: `cd frontend && npm run test`

- [ ] **Step 6: 突變驗證**

| 突變 | 預期變紅 |
|---|---|
| `sumMacros` 改用 `parseFloat` 累加 | 「不經過浮點數」與「大數值不會失去精度」 |
| `ratioOf` 的 `target === null` 改成回 `0` | 「目標是 null 時回 null，不是 0」 |
| `ratioOf` 拿掉 `isZero()` 的分支 | 「目標是 0 時回 null，不是 Infinity」 |
| `ratioOf` 改成 `if (!target) return null`（把 `"0"` 也當成 falsy） | **預期沒有東西變紅** —— `"0"` 是非空字串，在 JS 裡是 truthy。跑跑看確認，如果真的沒紅，那代表這個突變跟原版行為相同，不是測試不夠力 |

- [ ] **Step 7: 加一條守衛，確保 `new Decimal()` 不外流**

Create `frontend/tests/decimal-containment.test.ts`:

```ts
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function collectSourceFiles(dir: string): string[] {
	return readdirSync(dir).flatMap((entry) => {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) return collectSourceFiles(full);
		return /\.tsx?$/.test(entry) ? [full] : [];
	});
}

describe("decimal.js 的使用範圍", () => {
	it("只有 lib/decimal.ts 可以 import decimal.js", () => {
		// 規格決策 5 的延伸：型別檔讓「寫 parseFloat」變成編譯錯誤，
		// 這條測試讓「繞過 lib/decimal.ts 自己 new Decimal()」變成紅燈。
		//
		// 沒有這條的話，約束只存在於 decimal.ts 的 docstring 裡——
		// 而這個專案的教訓是：文件擋不住重蹈覆轍，程式碼可以。
		const offenders = collectSourceFiles("src")
			.filter((file) => /decimal\.js/.test(readFileSync(file, "utf8")))
			.map((file) => file.replace(/\\/g, "/"))
			.filter((file) => file !== "src/lib/decimal.ts");

		expect(offenders).toEqual([]);
	});
});
```

- [ ] **Step 8: 驗證這條守衛真的會紅**

在 `src/screens/Today.tsx`（或任何一個 `src/` 底下的檔案）暫時加一行
`import Decimal from "decimal.js";`，跑 `npm run test`，**確認變紅**，然後拿掉。

> **不要跳過。** 一條掃描檔案系統的測試很容易寫成永遠通過的樣子
> （路徑錯、正規表達式不匹配、`collectSourceFiles` 回空陣列）。
> **沒有親眼看到紅燈的守衛不算數。**

- [ ] **Step 9: Commit**

```bash
git add frontend/
git commit -m "feat: lib/decimal.ts——唯一碰數值的地方

後端所有數值都是字串（Decimal 序列化成字串避免浮點誤差）。這個模組對外
只暴露「字串進、字串或 number 出」的函式，不回傳 Decimal 實例——回傳的話
呼叫端就能在模組外做運算，約束等於沒有。

ratioOf 對「目標是 null / 0」回 null 而不是 0 或 Infinity：「沒有標準可比」
跟「0%」是兩件不同的事。而實際值是 0 時要回 0，那是一個真實的「還沒吃」。

加一條掃描 src/ 的守衛測試，讓「繞過這個模組自己 new Decimal()」變成紅燈
——約束只寫在 docstring 裡擋不住任何人。"
```

---

### Task 4：今日總覽

**Files:**
- Create: `frontend/src/lib/dates.ts`
- Create: `frontend/src/components/MacroBar.tsx`
- Create: `frontend/src/screens/Today.tsx`
- Modify: `frontend/src/api/queries.ts`
- Create: `frontend/tests/today.test.tsx`

#### 這個畫面要處理的三個後端事實

**1. 不要傳 `date` 參數。** 後端省略 `?date=` 時用 `today_in_timezone(user.timezone)`，跟 `/api/meals?date=` 與 `/api/supplements/today` 是同一個函式（`app/days.py` 是唯一來源）。**前端自己算「今天是哪一天」就是建立第二個事實來源**，而且在使用者時區與瀏覽器時區不同時會靜默算錯 —— 大部分時候對，只在午夜前後錯。

**2. `target` / `ratio` 的 `null` 有兩層**（規格 §5.7）：

```
target: null              ← 這一天完全沒有生效的目標
target.protein_g: null    ← 有目標，但蛋白質這一項沒設
```

UI 必須分開處理：第一種顯示「尚未設定目標」，第二種那一項顯示「未設定」而其他三項照常顯示比例。**混為一談會讓使用者以為自己沒設目標。**

**3. `plan_id: null` 代表臨時記錄，這種項目一定 `done: true`**（規格 §5.8）。UI 上它不該有「打卡」按鈕，只該有「取消」。

- [ ] **Step 1: 寫失敗的測試**

Create `frontend/tests/today.test.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Today } from "../src/screens/Today";
import { resetRefreshStateForTests } from "../src/auth/refresh";
import { clearTokens, setTokens } from "../src/auth/store";

function wrap(children: ReactNode) {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

/** 依 URL 分派的 fetch mock。**一律先驗 Authorization** ——
 *  沒帶就回 401 信封。這是規格 §9.2 第 2 條：mock 不檢查 header 的話，
 *  「所有請求都要帶 token」這個保證零鑑別力。 */
function mockApi(routes: Record<string, () => Response>) {
	return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
		const url = typeof input === "string" ? input : String(input);
		if (!new Headers(init?.headers).has("authorization")) {
			return new Response(
				JSON.stringify({ error: { code: "NOT_AUTHENTICATED", message: "需要登入", details: {} } }),
				{ status: 401, headers: { "content-type": "application/json" } },
			);
		}
		const match = Object.keys(routes).find((path) => url.includes(path));
		if (match === undefined) throw new Error(`測試沒有為這個路徑準備回應：${url}`);
		return routes[match]!();
	});
}

function json(body: unknown) {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

const STATS_WITH_TARGET = {
	date: "2026-09-15",
	actual: { kcal: "1800.00", protein_g: "90.50", fat_g: "60.00", carb_g: "200.00" },
	target: { kcal: "2000.00", protein_g: "150.00", fat_g: null, carb_g: "250.00" },
	ratio: { kcal: "0.90", protein_g: "0.60", fat_g: null, carb_g: "0.80" },
	breakdown: {
		food: { kcal: "1700.00", protein_g: "80.50", fat_g: "55.00", carb_g: "190.00" },
		supplement: { kcal: "100.00", protein_g: "10.00", fat_g: "5.00", carb_g: "10.00" },
	},
};

beforeEach(() => {
	localStorage.clear();
	clearTokens();
	resetRefreshStateForTests();
	vi.restoreAllMocks();
	setTokens({ access_token: "a", refresh_token: "r" });
});

describe("今日總覽", () => {
	it("不傳 date 參數——日界線由伺服器決定", async () => {
		// 規格 §5.3 與後端 app/days.py：省略 ?date= 時後端用
		// today_in_timezone(user.timezone)。前端自己算「今天」就是建立
		// 第二個事實來源，而且在使用者時區跟瀏覽器時區不同時會靜默算錯
		// ——大部分時候對，只在午夜前後錯。
		const fetchMock = mockApi({
			"/api/stats/daily": () => json(STATS_WITH_TARGET),
			"/api/supplements/today": () => json([]),
		});

		render(wrap(<Today />));
		await screen.findByText(/1800/);

		const statsCall = fetchMock.mock.calls.find(([input]) =>
			String(input).includes("/api/stats/daily"),
		);
		expect(String(statsCall?.[0])).toBe("/api/stats/daily");
	});

	it("顯示攝取與目標的比例", async () => {
		mockApi({
			"/api/stats/daily": () => json(STATS_WITH_TARGET),
			"/api/supplements/today": () => json([]),
		});

		render(wrap(<Today />));

		expect(await screen.findByText(/1800/)).toBeInTheDocument();
		expect(screen.getByText(/2000/)).toBeInTheDocument();
	});

	it("某一項沒設目標時只有那一項顯示未設定，其他照常", async () => {
		// 規格 §5.7 的第二層 null：target 存在、但 fat_g 是 null。
		// 把兩層混為一談的話，這個畫面會整個顯示成「尚未設定目標」。
		mockApi({
			"/api/stats/daily": () => json(STATS_WITH_TARGET),
			"/api/supplements/today": () => json([]),
		});

		render(wrap(<Today />));

		const fatRow = await screen.findByTestId("macro-fat_g");
		expect(fatRow).toHaveTextContent("未設定");
		expect(screen.getByTestId("macro-protein_g")).not.toHaveTextContent("未設定");
	});

	it("整天沒有目標時顯示的是「尚未設定目標」，不是四個未設定", async () => {
		// 第一層 null：target 整個是 null。
		mockApi({
			"/api/stats/daily": () => json({ ...STATS_WITH_TARGET, target: null, ratio: null }),
			"/api/supplements/today": () => json([]),
		});

		render(wrap(<Today />));

		expect(await screen.findByText("尚未設定目標")).toBeInTheDocument();
	});

	it("有計畫但還沒打卡的補劑可以打卡", async () => {
		const fetchMock = mockApi({
			"/api/stats/daily": () => json(STATS_WITH_TARGET),
			"/api/supplements/today": () =>
				json([
					{
						plan_id: 1,
						supplement_id: 7,
						supplement_name: "魚油",
						dose: "1.00",
						time_of_day: "morning",
						done: false,
						intake_id: null,
					},
				]),
			"/api/supplement-intakes": () => json({ id: 99 }),
		});

		render(wrap(<Today />));
		await userEvent.click(await screen.findByRole("button", { name: /打卡/ }));

		await waitFor(() => {
			expect(
				fetchMock.mock.calls.some(
					([input, init]) =>
						String(input).includes("/api/supplement-intakes") && init?.method === "POST",
				),
			).toBe(true);
		});
	});

	it("臨時記錄沒有打卡按鈕——它一定已經完成了", async () => {
		// 規格 §5.8：plan_id 為 null 代表這是一筆臨時記錄（沒有對應的固定
		// 計畫），這種項目一定 done: true。給它一個「打卡」按鈕是沒有意義的。
		mockApi({
			"/api/stats/daily": () => json(STATS_WITH_TARGET),
			"/api/supplements/today": () =>
				json([
					{
						plan_id: null,
						supplement_id: 7,
						supplement_name: "臨時吃的",
						dose: "1.00",
						time_of_day: null,
						done: true,
						intake_id: 55,
					},
				]),
		});

		render(wrap(<Today />));
		await screen.findByText("臨時吃的");

		expect(screen.queryByRole("button", { name: /打卡/ })).not.toBeInTheDocument();
		expect(screen.getByRole("button", { name: /取消/ })).toBeInTheDocument();
	});
});
```

- [ ] **Step 2: 跑測試確認它失敗**

Run: `cd frontend && npm run test`
Expected: FAIL — 找不到 `../src/screens/Today`

- [ ] **Step 3: 實作 `dates.ts`**

Create `frontend/src/lib/dates.ts`:

```ts
/** **這個模組只做顯示格式化，不做任何日界線計算。**
 *
 *  「今天是哪一天」由伺服器決定：後端的 `app/days.py` 的
 *  `today_in_timezone(user.timezone)` 是唯一的事實來源，而
 *  `/api/stats/daily`、`/api/meals?date=`、`/api/supplements/today`
 *  三個端點共用它（後端有專門的跨端點一致性測試守著）。
 *
 *  **前端算一次就是第二個事實來源**，而且錯的方式很惡劣：使用者時區
 *  跟瀏覽器時區相同時完全正確，不同時只在午夜前後錯 —— 一個大部分時候
 *  看起來沒問題的 bug。
 *
 *  所以這裡沒有 `today()`、沒有 `startOfDay()`，將來也不該有。
 *  需要「今天」的時候，**不要傳 `date` 參數，讓後端決定**。
 */

/** 把後端回的 ISO 8601 timestamptz 格式化成給人看的時間。 */
export function formatTime(isoString: string): string {
	return new Date(isoString).toLocaleTimeString(undefined, {
		hour: "2-digit",
		minute: "2-digit",
	});
}
```

- [ ] **Step 4: 實作畫面**

Create `frontend/src/components/MacroBar.tsx` 與 `frontend/src/screens/Today.tsx`。

**行為要求**（實作方式自由，讓上面六條測試通過）：

- 用 `useQuery` 取 `/api/stats/daily`（**不帶任何參數**）與 `/api/supplements/today`
- 四個營養素各一列，`data-testid="macro-<欄位名>"`
- `target` 整個是 `null` → 顯示「尚未設定目標」
- `target` 存在但某一項是 `null` → 那一列顯示「未設定」，其他列照常算比例
- 比例一律走 `ratioOf()`，**不要在元件裡做任何算術**
- 補劑清單：`plan_id !== null && !done` → 顯示「打卡」按鈕（`POST /api/supplement-intakes`）；`done` → 顯示「取消」按鈕（`DELETE /api/supplement-intakes/{intake_id}`）
- 打卡/取消成功後 invalidate `queryKeys.supplementsToday` **與** `queryKeys.dailyStats`（補劑有熱量，會影響總計）

> **打卡建議做樂觀更新**（規格 §7.2）：使用者預期「按下去就變了」，而失敗
> 時 rollback 的成本很低。**但如果樂觀更新讓測試變得難寫，先不要做** ——
> 這份計畫的驗收標準裡沒有它，YAGNI。

- [ ] **Step 5: 加一條跨使用者快取的守衛**

Append to `frontend/tests/today.test.tsx`:

```tsx
it("強制登出會清掉 query 快取", async () => {
	// 規格 §6.5：不清的話，下一個登入的人會先看到上一個人的今日總覽，
	// 然後才被重新 fetch 覆蓋掉——**那是使用者會親眼看到的跨使用者
	// 資料外洩**，不是理論上的。
	const { clearQueryCacheOnForcedLogout } = await import("../src/api/queries");
	const client = new QueryClient();
	client.setQueryData(queryKeys.dailyStats, { marker: "前一個使用者的資料" });

	clearQueryCacheOnForcedLogout(client);

	expect(client.getQueryData(queryKeys.dailyStats)).toBeUndefined();
});
```

（`import { queryKeys } from "../src/api/queries";`）

實作 `clearQueryCacheOnForcedLogout(client)` 為 `client.clear()`，並接到 `logout()` 與 `refreshTokens()` 失敗那兩條路徑上。

- [ ] **Step 6: 驗證**

```bash
cd frontend
npm run lint && npm run typecheck && npm run test && npm run build
```

- [ ] **Step 7: 突變驗證**

| 突變 | 預期變紅 |
|---|---|
| 給 `/api/stats/daily` 加上 `?date=${new Date().toISOString().slice(0, 10)}` | 「不傳 date 參數」 |
| 把 `target === null` 與 `target.fat_g === null` 兩層合併成一層 | 「某一項沒設目標」與「整天沒有目標」至少一條 |
| `plan_id === null` 也顯示打卡按鈕 | 「臨時記錄沒有打卡按鈕」 |
| `clearQueryCacheOnForcedLogout` 改成空函式 | 「強制登出會清掉 query 快取」 |
| `mockApi` 拿掉 Authorization 檢查 | **預期沒有東西變紅** —— 那個檢查是在防「實作忘記帶 token」，而目前的實作有帶。它守的是未來，不是現在。跑跑看確認，如實回報 |

- [ ] **Step 8: 手動驗證**

`npm run dev`，登入後看今日總覽。dev 資料庫有 20+ 筆餐點與 2 段目標期間，所以應該看得到真實數字。**確認四個營養素的數字跟 `curl http://localhost:8000/api/stats/daily -H "Authorization: Bearer <token>"` 回的一致。**

- [ ] **Step 9: Commit**

```bash
git add frontend/
git commit -m "feat: 今日總覽

不傳 date 參數：後端省略 ?date= 時用 today_in_timezone(user.timezone)，
跟 /api/meals?date= 與 /api/supplements/today 是同一個函式。前端自己算
「今天」就是建立第二個事實來源，而且在使用者時區跟瀏覽器時區不同時會
靜默算錯——大部分時候對，只在午夜前後錯。

target / ratio 的 null 分兩層處理：整個 null 是「這一天沒有生效的目標」，
單一欄位 null 是「有目標但這一項沒設」。混為一談會讓使用者以為自己沒設目標。

plan_id 為 null 的臨時記錄不給打卡按鈕——那種項目一定 done。

強制登出清 query 快取：不清的話下一個登入的人會先看到上一個人的今日總覽，
那是使用者會親眼看到的跨使用者資料外洩。"
```

---

### Task 5：記一餐

規格 §7.1：**這是每天走最多次的路徑**，P1 規格第 11 節就為它把 `/api/foods/frequent` 與 `/recent` 的索引顧好了。

**Files:**
- Create: `frontend/src/screens/LogMeal.tsx`
- Modify: `frontend/src/api/queries.ts`
- Create: `frontend/tests/log-meal.test.tsx`

#### 這個畫面要處理的三個後端事實

**1. `FoodResponse.nutrition` 可以是 `null`。** 註解寫「沒有生效版本時為 None —— 全域食物的初版被駁回就會是這個狀態」。**UI 不能假設它有值**，否則那種食物會讓畫面炸掉。

**2. 前端不做份量換算。** `POST /api/meals` 收 `quantity` 與可選的 `portion_id`，`quantity_g` 由伺服器在寫入當下算好並**凍結**（交接文件 §4.3）。前端算一次就是把「凍結歷史」這個保證從另一頭破壞掉。

**3. `items` 允許空清單**（P2 的流程是先拍照、之後才落項目），但這個畫面一律至少帶一項。

- [ ] **Step 1: 寫失敗的測試**

Create `frontend/tests/log-meal.test.tsx`（`wrap` / `mockApi` / `json` 三個 helper 從 `today.test.tsx` 複製一份過來 —— **不要抽成共用模組**，兩個檔案的 mock 路由表差很多，共用會長出一堆參數）：

```tsx
const FREQUENT_FOODS = [
	{
		id: 1,
		name: "滷肉飯",
		brand: null,
		is_global: true,
		nutrition: { base_unit: "g", kcal: "180.00", protein_g: "6.50", fat_g: "7.00", carb_g: "22.00" },
	},
	{
		// 全域食物的初版被駁回 —— nutrition 是 null。
		// 這不是假設情境，是 FoodResponse 明寫的狀態。
		id: 2,
		name: "沒有營養素的食物",
		brand: null,
		is_global: true,
		nutrition: null,
	},
];

describe("記一餐", () => {
	it("列出常吃的食物", async () => {
		mockApi({
			"/api/foods/frequent": () => json(FREQUENT_FOODS),
			"/api/foods/recent": () => json([]),
		});

		render(wrap(<LogMeal onSaved={vi.fn()} />));

		expect(await screen.findByText("滷肉飯")).toBeInTheDocument();
	});

	it("nutrition 是 null 的食物不會讓畫面炸掉", async () => {
		// FoodResponse.nutrition 的註解：「沒有生效版本時為 None ——
		// 全域食物的初版被駁回就會是這個狀態」。
		mockApi({
			"/api/foods/frequent": () => json(FREQUENT_FOODS),
			"/api/foods/recent": () => json([]),
		});

		render(wrap(<LogMeal onSaved={vi.fn()} />));

		expect(await screen.findByText("沒有營養素的食物")).toBeInTheDocument();
	});

	it("送出時只帶 food_id 與 quantity，不帶自己算的公克數", async () => {
		// 交接文件 §4.3：quantity_g 由伺服器在寫入當下算好並凍結。
		// 前端算一次就是把「凍結歷史」這個保證從另一頭破壞掉。
		const fetchMock = mockApi({
			"/api/foods/frequent": () => json(FREQUENT_FOODS),
			"/api/foods/recent": () => json([]),
			"/api/foods/1/portions": () => json([]),
			"/api/meals": () => json({ id: 1, items: [] }),
		});

		render(wrap(<LogMeal onSaved={vi.fn()} />));
		await userEvent.click(await screen.findByText("滷肉飯"));
		await userEvent.clear(screen.getByLabelText("份量"));
		await userEvent.type(screen.getByLabelText("份量"), "200");
		await userEvent.click(screen.getByRole("button", { name: "記錄" }));

		const mealCall = fetchMock.mock.calls.find(
			([input, init]) => String(input).includes("/api/meals") && init?.method === "POST",
		);
		const body = JSON.parse(String(mealCall?.[1]?.body));
		expect(body.items[0]).toMatchObject({ food_id: 1, quantity: "200" });
		expect(body.items[0]).not.toHaveProperty("quantity_g");
	});

	it("送出成功後呼叫 onSaved", async () => {
		mockApi({
			"/api/foods/frequent": () => json(FREQUENT_FOODS),
			"/api/foods/recent": () => json([]),
			"/api/foods/1/portions": () => json([]),
			"/api/meals": () => json({ id: 1, items: [] }),
		});
		const onSaved = vi.fn();

		render(wrap(<LogMeal onSaved={onSaved} />));
		await userEvent.click(await screen.findByText("滷肉飯"));
		await userEvent.click(screen.getByRole("button", { name: "記錄" }));

		await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
	});
});
```

- [ ] **Step 2: 跑測試確認它失敗**

- [ ] **Step 3: 實作**

Create `frontend/src/screens/LogMeal.tsx`。**行為要求**：

- `useQuery` 取 `/api/foods/frequent` 與 `/api/foods/recent`
- 點一個食物 → 取它的 `/api/foods/{id}/portions`，讓使用者選「1 碗」之類的，或直接輸入數量
- 送出 `POST /api/meals`：`{ eaten_at, meal_type, items: [{ food_id, quantity, portion_id? }] }`
- `eaten_at` 用 `new Date().toISOString()`（**這是一個時刻，不是日期** —— 規格 §5.3 說 `eaten_at` 是 `timestamptz`，收發都用 ISO 8601 含時區。這跟「不要自己算日界線」不衝突：送一個時刻是對的，算一個日期才是錯的）
- **數值一律以字串送出**，不要 `Number()`
- `nutrition === null` 的食物：仍然列出、仍然可選，只是不顯示營養素預覽

- [ ] **Step 4: 送出成功後讓今日總覽失效**

```ts
onSuccess: () => {
    // 這一行是這份計畫的核心。少了它，記完一餐回到總覽會看到舊數字，
    // 使用者會以為沒記進去——然後再記一次。
    queryClient.invalidateQueries({ queryKey: queryKeys.dailyStats });
    // 常吃/最近吃的排序也變了。
    queryClient.invalidateQueries({ queryKey: queryKeys.frequentFoods });
    queryClient.invalidateQueries({ queryKey: queryKeys.recentFoods });
},
```

- [ ] **Step 5: 驗證與突變**

| 突變 | 預期變紅 |
|---|---|
| 送出時多算一個 `quantity_g` 欄位 | 「只帶 food_id 與 quantity」 |
| `quantity` 用 `Number(input)` 而不是字串 | 「只帶 food_id 與 quantity」的 `toMatchObject` |
| `nutrition!.kcal` 直接取值 | 「nutrition 是 null 的食物不會讓畫面炸掉」 |
| 拿掉 `invalidateQueries(dailyStats)` | **預期沒有單元測試會紅** —— 那條路徑需要兩個畫面同時存在，只有 Task 6 的 E2E 守得到。如實回報 |

- [ ] **Step 6: 手動驗證 —— 這個 task 真正的驗收**

`npm run dev`，登入 → 記一餐 → **回到今日總覽，確認數字真的變了**。

> 這一步不能只看測試綠。上表最後一個突變說明了為什麼：**失效那條路徑
> 沒有任何單元測試守得到。**

- [ ] **Step 7: Commit**

```bash
git add frontend/
git commit -m "feat: 記一餐

只送 food_id 與 quantity，不送自己算的公克數：quantity_g 由伺服器在寫入
當下算好並凍結（交接文件 §4.3）。前端算一次就是把「凍結歷史」這個保證
從另一頭破壞掉。

數值一律以字串送出。nutrition 為 null 的食物（全域食物初版被駁回的狀態）
仍然可選，只是不顯示營養素預覽。

送出成功後讓 dailyStats 失效——少了那一行，記完一餐回到總覽會看到舊數字，
使用者會以為沒記進去然後再記一次。那條路徑沒有單元測試守得到，
只有 E2E（見下一個 task）。"
```

---

### Task 6：兩條契約 E2E

規格 §9.1：**凡是「後端保證 X」的斷言都必須有一條 E2E。** MSW（或這裡的 fetch mock）是自己寫的，它證明不了後端的行為。

計畫一已經有兩條（登入、401→refresh→重送）。這一份加兩條，剩下兩條留給計畫三。

**Files:**
- Create: `frontend/e2e/daily-loop.spec.ts`

- [ ] **Step 1: 寫 E2E**

Create `frontend/e2e/daily-loop.spec.ts`:

```ts
import { expect, test } from "@playwright/test";

const EMAIL = "kenny.demo@example.com";
const PASSWORD = "demo-pass-12345";

async function login(page: import("@playwright/test").Page) {
	await page.goto("/");
	await page.getByLabel("Email").fill(EMAIL);
	await page.getByLabel("密碼").fill(PASSWORD);
	await page.getByRole("button", { name: "登入" }).click();
}

test("記一餐之後，今日總覽的數字真的變了", async ({ page }) => {
	// **這條守的是兩件單元測試看不到的事：**
	//   1. invalidateQueries 那條失效路徑（需要兩個畫面同時存在）
	//   2. 數值是字串（規格 §5.1）——後端回 "180.50"，前端的 decimal 處理
	//      如果退化成 parseFloat，小數會在這裡露出馬腳
	await login(page);

	const before = await page.getByTestId("macro-kcal").textContent();

	await page.getByRole("link", { name: "記一餐" }).click();
	await page.getByText("滷肉飯").first().click();
	await page.getByRole("button", { name: "記錄" }).click();

	await expect(page.getByTestId("macro-kcal")).not.toHaveText(before ?? "");
});

test("今日總覽不帶 date 參數——日界線由伺服器決定", async ({ page }) => {
	// 規格 §5.3。Playwright 的 timezoneId 設成 Asia/Taipei（見
	// playwright.config.ts），跟 CI runner 的 UTC 不同——所以
	// 「前端自己用瀏覽器時區算日期」在這裡會算出跟後端不同的答案。
	//
	// 這條測試**攔的是請求本身**，不是結果：只要 URL 帶了 date，就紅。
	// 為什麼不驗結果：大部分時候兩種算法會得到同一天，驗結果的鑑別力
	// 只在午夜前後那幾小時存在——那是規格 §9.2 第 5 條講的
	// 「兩個視窗沒有重疊」。
	const statsRequests: string[] = [];
	page.on("request", (request) => {
		if (request.url().includes("/api/stats/daily")) statsRequests.push(request.url());
	});

	await login(page);
	await expect(page.getByTestId("macro-kcal")).toBeVisible();

	expect(statsRequests.length).toBeGreaterThan(0);
	for (const url of statsRequests) {
		expect(url).not.toContain("date=");
	}
});
```

- [ ] **Step 2: 跑 E2E**

```bash
cd F:/wallet && docker compose up -d
cd frontend && npx playwright test
```

Expected: 4 passed（計畫一的 2 條 + 這裡的 2 條）

> **第一條 E2E 會真的寫進 dev 資料庫。** 那是刻意的 —— 這條測試存在的
> 理由就是「打真的後端」。副作用是每跑一次就多一筆餐點，dev 資料庫會慢慢
> 長胖。可以接受（它是 dev 資料庫），但**不要為了「乾淨」把它改成 mock** ——
> 那就退化成單元測試了。

- [ ] **Step 3: 突變驗證**

| 突變 | 預期變紅 |
|---|---|
| 拿掉 `invalidateQueries(dailyStats)` | 第一條 E2E |
| 給 `/api/stats/daily` 加上 `?date=...` | 第二條 E2E |

**第一個突變特別重要** —— 它是那條失效路徑**唯一**的守衛（Task 5 Step 5 已經確認過沒有單元測試抓得到）。

- [ ] **Step 4: Commit 並推上去看 CI**

```bash
git add frontend/
git commit -m "feat: 兩條契約 E2E——失效路徑與日界線

第一條守的是 invalidateQueries：記一餐之後今日總覽的數字要真的變。
那條路徑需要兩個畫面同時存在，沒有任何單元測試抓得到（已用突變確認）。

第二條攔的是請求本身，不是結果：只要 /api/stats/daily 帶了 date 參數就紅。
不驗結果是因為大部分時候兩種算法會得到同一天，驗結果的鑑別力只在午夜
前後那幾小時存在——那正是規格 §9.2 第 5 條講的「兩個視窗沒有重疊」。"
git push
```

**CI 的 `e2e` job 會在 Linux 上跑這四條。** 那是這一份唯一本機驗證不了的東西。

---

## 完成標準

- [ ] `frontend/` 的 `lint` / `typecheck` / `test` / `build` 全綠
- [ ] 四條契約 E2E 綠（計畫一 2 條 + 這份 2 條），CI 五個 job 全綠
- [ ] `lib/decimal.ts` 的圍堵守衛**實測驗證過會紅**（在別的檔案 import `decimal.js`）
- [ ] 今日總覽的兩層 `null` 分開處理，兩條測試各自守一層
- [ ] 記一餐送出的 body **不含** `quantity_g`，數值是字串
- [ ] **手動驗證過：記一餐 → 回到總覽 → 數字真的變了**
- [ ] 各 task 的突變全部實際跑過，結果寫回這份文件
- [ ] 後端 503 個測試不因這份計畫而變動

---

## 留給計畫三

- **拍照上傳與顯示** —— `photo_path` 不是 URL（規格 §5.2），要帶 token 取 blob，而且卸載時要 `revokeObjectURL`
- **離線 L2** —— 讀取快取 + **「離線資料，最後更新於 X」的標示**。先快取了資料卻沒有標示，比不快取更糟
- **其餘兩條契約 E2E** —— 照片 blob、429 倒數
- **Task 1 的 HTTPS 與兩個真機驗證**（PWA 安裝、手機登入）—— 等得到 NAS
