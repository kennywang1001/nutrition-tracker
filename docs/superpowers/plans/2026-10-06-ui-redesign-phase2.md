# 介面改版第二階段 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 六個舊畫面換成跟第一階段一致的外觀（卡片、44px、設計變數），報表的分類佔比改成甜甜圈圖，趨勢頁加營養素切換。

**Architecture:** 一個共用的 `ui.module.css` 提供 `.screen`：用**零權重**（`:where()`）的後代選擇器把畫面底下的區塊變卡片、按鈕變 44px、輸入框統一——舊畫面只在最外層加這個 class、補幾個包裝，標籤與順序不動。甜甜圈圖與趨勢圖的幾何一律算成 SVG 屬性（jsdom 不做版面計算）。「樣式真的生效」由 e2e 在手機尺寸量按鈕高度證明。

**Tech Stack:** React 19 · TypeScript strict · CSS Modules · Vitest + Testing Library · Playwright · Biome

**依據規格：** `docs/superpowers/specs/2026-10-06-ui-redesign-phase2-design.md`

---

## 執行環境

- 分支 `feat/ui-phase2`（規格 commit `0043418`）。**這份計畫只動前端。**
- 前端在 `frontend/`：`npx vitest run tests/xxx`、`npm run -s typecheck`、`npm run -s lint`、`npm run -s test`。Vitest 會把每個測試檔再跑一次型別檢查，數量看起來是兩倍。lint 抱怨格式時用 `npx biome check --write <檔案>`。
- e2e 在 `frontend/`：`npx playwright test e2e/xxx.spec.ts`。`playwright.config.ts` 會自己起 `npm run dev`；後端是本機 docker 的 api（`wallet-api-1`，要 healthy——沒開就回報，不要自己開關容器）。
- 基準線（master `a6672ec`）：前端 92 檔 846 passed；e2e 21 passed；後端不動。
- **檔案編輯用 Write/Edit；LF 換行。不要在 repo 裡或 repo 外的任何地方複製備份檔、留暫存腳本。**
- **突變測試的還原：** 檔案有本任務其他未 commit 的改動時，不要用 `git checkout --`，手動改回並重跑測試確認。
- Commit：`git commit -F <scratchpad 裡的檔案>`，中文全形標點，結尾 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`。不要 stage `lunch.jpg`。不要 amend。

---

## 開工前必讀：這份計畫的文字沒有權威性

前六份計畫都被抓到錯誤。

1. 「Expected: FAIL」沒有如預期失敗 → **停下來回報**，不要調整測試讓它變紅。
2. 預測紅 N 條、實際不是 N → 照實回報是哪幾條。
3. 要改的檔案不在清單上 → 回報。
4. 引用的程式碼對不上現況 → 以現況為準並回報。
5. **先寫測試、跑一次看它紅，再寫實作。**
6. **「只換外觀」的證明是既有測試一條都不改**：每個換外觀的任務結束時 `git diff <任務開始的 commit> -- frontend/tests frontend/e2e` 只能看到本任務**新增**的測試，不能看到既有測試被改。
7. testing-library 的 `getByText` 會把 DOM 文字裡的空白（含全形空白）正規化，傳進去的字串不會（handover §7）。Playwright 的 `getByLabel`／`getByRole` 名稱預設是**子字串**比對（第 48 種）。

---

## 開工前已經查證過的事實

| 事實 | 出處 |
|---|---|
| 六個舊畫面（`FoodLibrary`、`FoodDetail`、`NewFood`、`Supplements`、`Trend`、`AdminRevisions`）與 `AddPortionForm` 都沒有樣式檔，根元素是 `<section>` | `frontend/src/screens/*.tsx` |
| `FoodDetail`、`NewFood` 的區塊本來就是根 `<section>` 的**直接子元素**（`<section>`、`<form>`）；`FoodLibrary` 的直接子元素是 `<a>`、搜尋 `<div>`、範圍 `<fieldset>`、結果 `<ul class="food-results">`；`Supplements` 是平的（`h2` 後面直接接內容，沒有分區）；`AdminRevisions` 是 `<ul>` 底下每一筆一個 `<li>` | 同上 |
| `index.css` 的舊色碼：`.trend-bar`（`#4a7`）、`.trend-target`（`#c33`）、`.food-results li`（`#eee`）、`.food-brand`（`#777`）、`.food-tag`（`#2a6`，文字與框）、`.food-no-nutrition`（`#b33`） | `frontend/src/index.css:105-145` |
| `css-tokens.test.ts`：解析 `:root` 與深色區塊的 `--color-*`（必須是 6 位十六進位）、深色要覆寫每一個、`PAIRS` 每一組 ≥ 4.5:1、module CSS 不准有色碼。**`index.css` 本身目前沒有掃描** | `frontend/tests/css-tokens.test.ts` |
| `TrendChart({ days })`：柱子 `data-testid="trend-bar-{date}"`、`role="img"`、`aria-label="9/15，1800 大卡，目標 2000 大卡"`／`"…，沒有目標"`；目標線是每天一段 `<line data-testid="trend-target-{date}">`；`<svg aria-label="最近幾天的熱量">`；全域 class `trend-chart`／`trend-bar`／`trend-target` | `frontend/src/components/TrendChart.tsx` |
| `Trend` 畫面：錨點是 `stats/daily` 的 `date`，查 `stats/range` 7 天；依從率 `<p data-testid="adherence">` | `frontend/src/screens/Trend.tsx` |
| 報表的分類佔比：`MonthSummary` 顯示 `<p>總計 <span>{formatMoney(total)}</span></p>`＋每個分類一個 `CategoryBar`（`data-testid="category-{分類}"`，文字含分類名、金額、`N 筆`、百分比）。**既有測試 `findByText("400.00")` 與空月份的 `findByText("0.00")` 依賴那個 `<span>`** | `frontend/src/screens/Expenses.tsx:194-212`、`frontend/tests/expenses.test.tsx:420-463` |
| `CATEGORY_COLORS`（`api/expenses.ts`）是每個分類固定的色碼，**刻意寫在 TS 不寫在 CSS**（資料不是主題），`IconBadge` 用 inline style 套 | `frontend/src/api/expenses.ts:59-74` |
| `ratioOf(actual, total)` 回 `number \| null`（total 是 0 回 null）；`isPositiveAmount(value)` 判斷 > 0；`formatMoney`、`formatMacro` | `frontend/src/lib/decimal.ts` |
| `RangeStatsResponse.trend[]` 每天有 `actual`（四項）與 `target`（null 或四項各自可 null） | `app/schemas/stats.py:53-66` |
| e2e 手機尺寸的寫法：`test.use({ viewport: { width: 390, height: 844 } })`；登入的寫法見 `e2e/mobile-form-zoom.spec.ts` | 同檔 |
| `<main className="app-main">` 包住所有畫面；tab bar 在 `<main>` 外面 | `frontend/src/App.tsx` |

---

## 與規格的差異（寫計畫時決定）

1. **每個畫面不各寫一個樣式檔**（規格 §3.1 寫「每個畫面一個自己的 `*.module.css`」）：共用的 `ui.module.css` 的 `.screen` 用後代選擇器處理九成的樣式，只有真的需要畫面專屬樣式的才加（趨勢的切換鈕 `Trend.module.css`、甜甜圈 `CategoryDonut.module.css`、分類列 `CategoryBar.module.css`）。
2. **`.screen` 的通用規則全部包在 `:where()` 裡（權重 0）**：畫面裡已經有自己樣式的元件（例如新增食物裡的 AI 估算面板）不會被蓋掉——任何一個 class 都贏過它。
3. **甜甜圈中間不寫總計**（規格 §4.1 寫中間寫「總計」與金額）：上面那行 `總計 <span>…</span>` 要留著（既有測試依賴它），中間再寫一次是重複。甜甜圈是一個空心圈。
4. **管理員審核不加 e2e 的 44px 檢查**：那個畫面只有在有待審提案時才有按鈕，e2e 要先造一筆待審提案，而 `admin.spec.ts` 平行執行時會審掉它——不穩。管理員審核的外觀靠同一個 `.screen` 規則，其他五個畫面的 e2e 證明那組規則有效。
5. **趨勢的「今天」由畫面傳進 `TrendChart`**（`today` prop）：圖表不自己算今天（前端不算日界線）。

---

## 檔案結構

| 檔案 | 負責什麼 |
|---|---|
| `frontend/src/index.css`（改） | `--color-success`（淺色／深色）；舊色碼換成變數 |
| `frontend/tests/css-tokens.test.ts`（改） | `index.css` 掃描；`--color-success` 的對比 |
| `frontend/src/components/ui.module.css`（新） | `.screen`、`.stats`、`.stat`、`.tag` |
| `frontend/e2e/touch-targets.ts`（新）、`frontend/e2e/touch-targets.spec.ts`（新） | 手機尺寸量可點元素的高度 |
| `frontend/src/screens/FoodLibrary.tsx`、`NewFood.tsx`、`FoodDetail.tsx`、`Supplements.tsx`、`AdminRevisions.tsx`（改） | 加 `.screen`、少量包裝 |
| `frontend/src/components/CategoryDonut.tsx`＋`.module.css`（新） | 甜甜圈 |
| `frontend/src/components/CategoryBar.tsx`（改）＋`CategoryBar.module.css`（新） | 色點、新外觀 |
| `frontend/src/screens/Expenses.tsx`（改） | `MonthSummary` 放甜甜圈、空狀態 |
| `frontend/src/components/TrendChart.tsx`（改） | `metric`、`today` |
| `frontend/src/screens/Trend.tsx`（改）＋`Trend.module.css`（新） | 營養素切換、今天的摘要、新外觀 |
| `frontend/tests/category-donut.test.tsx`（新）、`trend-chart.test.tsx`、`trend.test.tsx`、`expenses.test.tsx`（加測試，不改既有的） | |
| `docs/handover.md`（改） | |

---

## Task 1：設計變數、清掉 `index.css` 的舊色碼、共用樣式、e2e 的量測工具

**Files:**
- Modify: `frontend/src/index.css`、`frontend/tests/css-tokens.test.ts`
- Create: `frontend/src/components/ui.module.css`、`frontend/e2e/touch-targets.ts`

- [ ] **Step 1: 寫失敗的測試**

`frontend/tests/css-tokens.test.ts`：

1. `PAIRS` 陣列最後加兩組：

```ts
	// 「公開」標籤（食物清單的 .food-tag）的綠字，壓在畫面底色與卡片上。
	["--color-success", "--color-bg"],
	["--color-success", "--color-surface"],
```

2. `describe("設計變數", …)` 裡最後加：

```ts
	it("index.css 除了設計變數的定義之外沒有色碼", () => {
		// 規格（介面改版第二階段 §3.4）：舊畫面的顏色全部換成變數之後，
		// 色碼只該出現在 :root 與深色模式那兩個區塊裡。
		const outsideTokenBlocks = css
			.replace(/:root\s*\{[^}]*\}/, "")
			.replace(
				/@media\s*\(prefers-color-scheme:\s*dark\)\s*\{\s*:root\s*\{[^}]*\}\s*\}/,
				"",
			);
		// 先證明兩個區塊真的被拿掉了——正規表示式沒對上的話，下面的斷言會
		// 把變數定義也算進去而紅，或（更糟）兩個 replace 都沒作用卻剛好沒有
		// 色碼而綠。
		expect(outsideTokenBlocks).not.toContain("--color-text:");

		expect(
			outsideTokenBlocks.match(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/g) ?? [],
		).toEqual([]);
	});
```

- [ ] **Step 2: 跑測試確認失敗**

```
cd frontend
npx vitest run tests/css-tokens.test.ts
```

Expected：四條 FAIL——兩種模式各兩組 `--color-success`（變數不存在）、「index.css 除了…沒有色碼」（列出 `#4a7`、`#c33`、`#eee`、`#777`、`#2a6`、`#2a6`、`#b33`）。

- [ ] **Step 3: 實作 `index.css`**

`:root` 裡 `--color-danger: #c0392b;` 下面加：

```css
	/* 「公開」標籤之類的正面狀態。淺色 #2e7d32 在白底約 5.1:1、在畫面底色
	   約 4.7:1（css-tokens.test.ts 守著）。 */
	--color-success: #2e7d32;
```

深色區塊 `--color-danger: #ff7675;` 下面加 `--color-success: #66bb6a;`。

舊規則改成：

```css
.trend-bar {
	fill: var(--color-accent);
}

/* 今天還沒結束：同一個顏色、淡一點（介面改版第二階段 §5.2）。
   用透明度不用另一個色票——深色模式下 accent-soft 太暗，在卡片上幾乎看不見。 */
.trend-bar-today {
	fill-opacity: 0.45;
}

.trend-target {
	stroke: var(--color-danger);
	stroke-width: 2;
	stroke-dasharray: 4 3;
}
```

`.food-results li` 的 `border-bottom: 1px solid #eee;` → `var(--color-border)`；`.food-brand` 的 `color: #777;` → `var(--color-text-muted)`；`.food-tag` 的 `color: #2a6;` 與 `border: 1px solid #2a6;` → `var(--color-success)`；`.food-no-nutrition` 的 `color: #b33;` → `var(--color-danger)`。

> `.trend-bar-today` 現在還沒有人用——Task 6 的 `TrendChart` 會用。先放進來，Task 6 不用再動 `index.css`。

- [ ] **Step 4: 共用樣式**

`frontend/src/components/ui.module.css`（新）：

```css
/* 介面改版第二階段的共用樣式：舊畫面只在最外層加 .screen。
 *
 * **通用規則全部包在 :where() 裡（權重 0）**——畫面裡已經有自己樣式的元件
 * （例如新增食物裡的 AI 估算面板）任何一個 class 都贏過這裡，不會被蓋掉。
 * 寫成 `:where(.screen button)`，不是 `.screen button`：後者的權重 (0,1,1)
 * 跟元件的 `.actions button` 一樣，誰贏要看 CSS 載入順序，那是不穩的。
 *
 * 字級不在這裡設 input——index.css 的全域規則保證 input/select/textarea ≥ 16px。 */

.screen {
	display: flex;
	flex-direction: column;
	gap: var(--space-3);
}

:where(.screen h1) {
	margin: var(--space-3) 0 0;
	font-size: 22px;
}

:where(.screen h2) {
	margin: 0 0 var(--space-2);
	font-size: 14px;
	font-weight: 600;
	color: var(--color-text-muted);
}

/* 畫面直接底下的每一個區塊是一張卡片。 */
:where(.screen > section, .screen > form, .screen > fieldset, .screen > div, .screen > ul) {
	margin: 0;
	padding: var(--space-3) var(--space-4);
	border: none;
	border-radius: var(--radius-card);
	background: var(--color-surface);
}

:where(.screen form) {
	display: flex;
	flex-direction: column;
	gap: var(--space-2);
}

:where(.screen label) {
	display: block;
	font-size: 13px;
	color: var(--color-text-muted);
}

/* 單選、勾選的標籤本身就是點擊目標。 */
:where(.screen label:has(> input[type="radio"]), .screen label:has(> input[type="checkbox"])) {
	display: flex;
	align-items: center;
	gap: var(--space-2);
	min-height: 44px;
	font-size: 15px;
	color: var(--color-text);
}

:where(.screen input:not([type="radio"]):not([type="checkbox"]):not([type="file"]), .screen select, .screen textarea) {
	box-sizing: border-box;
	width: 100%;
	min-height: 44px;
	padding: var(--space-2) var(--space-3);
	border: 1px solid var(--color-border);
	border-radius: var(--radius-button);
	background: var(--color-bg);
	color: var(--color-text);
}

:where(.screen fieldset) {
	margin: 0;
	padding: 0;
	border: none;
	display: flex;
	flex-direction: column;
	gap: var(--space-1);
}

:where(.screen legend) {
	padding: 0;
	margin-bottom: var(--space-1);
	font-size: 13px;
	color: var(--color-text-muted);
}

:where(.screen button) {
	min-height: 44px;
	padding: 0 var(--space-4);
	border: 1px solid var(--color-action);
	border-radius: var(--radius-button);
	background: transparent;
	color: var(--color-action);
	font-size: 15px;
	font-weight: 600;
}

/* 送出按鈕是主要按鈕。寫在通用 button 之後：兩者權重都是 0，靠順序。 */
:where(.screen button[type="submit"]) {
	border: none;
	background: var(--color-action);
	color: var(--color-on-action);
}

:where(.screen button:disabled) {
	opacity: 0.4;
}

/* 畫面直接底下、長得像按鈕的連結（食物庫的「新增食物」）。 */
:where(.screen > a) {
	display: inline-flex;
	align-items: center;
	align-self: flex-start;
	min-height: 44px;
	font-weight: 600;
}

:where(.screen ul) {
	list-style: none;
	margin: 0;
	padding: 0;
}

:where(.screen li) {
	padding: var(--space-2) 0;
	border-bottom: 1px solid var(--color-border);
}

:where(.screen li:last-child, .screen ul[role="alert"] li) {
	border-bottom: none;
}

:where(.screen [role="alert"]) {
	color: var(--color-danger);
}

:where(.screen p) {
	margin: 0;
}

:where(.screen table) {
	width: 100%;
	border-collapse: collapse;
	font-variant-numeric: tabular-nums;
}

:where(.screen th, .screen td) {
	padding: var(--space-1) var(--space-2);
	border-bottom: 1px solid var(--color-border);
	text-align: left;
}

/* 營養素的 2×2 小方格（食物詳情）。 */
.stats {
	display: grid;
	grid-template-columns: repeat(2, minmax(0, 1fr));
	gap: var(--space-2);
	margin: 0;
}

.stat {
	padding: var(--space-2) var(--space-3);
	border-radius: var(--radius-button);
	background: var(--color-bg);
}

.stat dt {
	font-size: 12px;
	color: var(--color-text-muted);
}

.stat dd {
	margin: 0;
	font-size: 16px;
	font-weight: 700;
	font-variant-numeric: tabular-nums;
}

/* 狀態標籤（預設、已通過、待審、已駁回）。 */
.tag {
	display: inline-block;
	margin-left: var(--space-1);
	padding: 0 var(--space-2);
	border-radius: 999px;
	background: var(--color-accent-soft);
	color: var(--color-action);
	font-size: 12px;
	font-weight: 700;
}
```

> `--color-action` 壓在 `--color-accent-soft` 上的對比已經在 `PAIRS` 裡（兩種模式都 ≥ 4.5）。如果 Biome 對長選擇器的格式有意見，用 `biome check --write` 讓它排版。

- [ ] **Step 5: e2e 的量測工具**

`frontend/e2e/touch-targets.ts`（新）——**只是工具，還沒有測試**（Task 2–6 各自加）：

```ts
import { expect, type Locator, type Page } from "@playwright/test";
import { ADMIN } from "./accounts.ts";

/** 登入（手機尺寸由呼叫端的 `test.use` 決定）。 */
export async function login(page: Page) {
	await page.goto("/");
	await page.getByLabel("Email").fill(ADMIN.email);
	await page.getByLabel("密碼").fill(ADMIN.password);
	await page.getByRole("button", { name: "登入" }).click();
	await expect(page.getByRole("heading", { name: "總覽" })).toBeVisible();
}

/** 斷言每一個點擊目標的高度 ≥ 44px（介面改版規格的觸控目標）。
 *
 *  **量的是真的瀏覽器版面**（`boundingBox()`）——單元測試的 jsdom 不做版面
 *  計算，高度永遠是 0，測不到這件事。瀏覽器預設的按鈕大約 21px、單選鈕的
 *  標籤大約 18px，所以樣式沒生效時這裡一定紅。
 *
 *  **至少要有一個**：選擇器寫錯、一個都沒找到時，迴圈不會跑、斷言不會執行，
 *  測試就空轉綠了（handover §6 一再出現的那種）。 */
export async function expectTouchTargets(targets: Locator, where: string) {
	const count = await targets.count();
	expect(count, `${where}：至少要有一個點擊目標`).toBeGreaterThan(0);
	for (let index = 0; index < count; index += 1) {
		const target = targets.nth(index);
		const box = await target.boundingBox();
		const name =
			(await target.textContent())?.trim() ||
			(await target.getAttribute("aria-label")) ||
			`第 ${index + 1} 個`;
		expect(box?.height ?? 0, `${where}：「${name}」的高度`).toBeGreaterThanOrEqual(
			44,
		);
	}
}
```

- [ ] **Step 6: 跑測試確認通過**

```
npx vitest run tests/css-tokens.test.ts
npm run -s typecheck
npm run -s lint
npm run -s test
```

Expected：全部綠（`index.css` 的改動只換顏色，畫面測試不受影響）。`tsconfig.e2e.json` 若沒有把 `e2e/touch-targets.ts` 納入型別檢查，回報 `npx tsc -p tsconfig.e2e.json --noEmit` 的結果。

- [ ] **Step 7: 突變測試**

把 `.food-brand` 改回 `color: #777;` → Expected：「index.css 除了…沒有色碼」FAIL。改回。

- [ ] **Step 8: Commit**

```
style(ui): 清掉 index.css 的舊色碼，加共用的舊畫面樣式與 e2e 量測工具

--color-success（淺色／深色）；食物清單與趨勢圖的顏色全部換成變數，
並加一條測試守著 index.css 除了變數定義之外不再有色碼。ui.module.css 的
.screen 用零權重的後代選擇器統一舊畫面的卡片、按鈕與輸入框。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

```bash
git add frontend/src/index.css frontend/tests/css-tokens.test.ts frontend/src/components/ui.module.css frontend/e2e/touch-targets.ts
```

---

## Task 2：食物庫、新增食物

**Files:**
- Modify: `frontend/src/screens/FoodLibrary.tsx`、`frontend/src/screens/NewFood.tsx`
- Create: `frontend/e2e/touch-targets.spec.ts`

- [ ] **Step 1: 寫失敗的 e2e**

`frontend/e2e/touch-targets.spec.ts`（新）：

```ts
import { test } from "@playwright/test";
import { expectTouchTargets, login } from "./touch-targets.ts";

// 介面改版第二階段：舊畫面在手機上的點擊目標都 ≥ 44px。
test.use({ viewport: { width: 390, height: 844 } });

test("食物庫：「新增食物」連結與範圍選項都 ≥ 44px", async ({ page }) => {
	await login(page);
	await page.goto("/foods");
	await expectTouchTargets(
		page.locator("main a:visible, main label:has(input[type=radio]):visible"),
		"食物庫",
	);
});

test("新增食物：按鈕與「營養標示是」的選項都 ≥ 44px", async ({ page }) => {
	await login(page);
	await page.goto("/foods/new");
	await expectTouchTargets(
		page.locator("main button:visible, main label:has(input[type=radio]):visible"),
		"新增食物",
	);
});
```

- [ ] **Step 2: 跑 e2e 確認失敗**

```
cd frontend
npx playwright test e2e/touch-targets.spec.ts
```

Expected：兩條都 FAIL，訊息指出某個連結／標籤／按鈕的高度小於 44（照實回報量到的數字）。

- [ ] **Step 3: 實作**

`frontend/src/screens/FoodLibrary.tsx`：import `ui from "../components/ui.module.css"`；`<section>` 改成 `<section className={ui.screen}>`。**其他都不動**——搜尋的 `<div>`、範圍的 `<fieldset>`、結果的 `<ul class="food-results">` 已經是直接子元素，會自動變成卡片。

`frontend/src/screens/NewFood.tsx`：import `ui`；最外層 `<section>` 改成 `<section className={ui.screen}>`。**其他都不動**——「用 AI 填」的 `<section>` 與 `<form>` 已經是直接子元素，會自動變成卡片；表單裡的 `<fieldset>`、單選鈕、輸入框由 `.screen` 的後代規則處理。

> 不改任何標籤文字、`id`、順序。`<span id="serving-hint">` 的文字跟原本一樣。

- [ ] **Step 4: 跑測試確認通過**

```
npx playwright test e2e/touch-targets.spec.ts
npx vitest run tests/food-library.test.tsx tests/new-food.test.tsx tests/new-food-ai.test.tsx tests/css-tokens.test.ts
git diff HEAD -- tests e2e
```

Expected：兩條 e2e PASS；單元測試全綠；`git diff` 只看到新的 `e2e/touch-targets.spec.ts`（它是新檔，`git diff HEAD` 看不到——用 `git status` 確認既有測試檔沒有被改）。

- [ ] **Step 5: 用眼睛看一次**

`npm run dev` 開 `http://localhost:5173/foods` 與 `/foods/new`（手機寬度 390、淺色與深色各一次——瀏覽器的開發者工具可以切 `prefers-color-scheme`）。確認：卡片有底色、按鈕與輸入框統一、AI 估算面板的樣式沒有被蓋掉（虛線框的「拍照估算」）。有怪的地方照實描述，不要只說「看起來可以」。

- [ ] **Step 6: 全部前端檢查**（typecheck、lint、test）＋全部 e2e（`npx playwright test`）

Expected：e2e = 21 + 2 = 23 passed。

- [ ] **Step 7: Commit**

```
style(ui): 食物庫與新增食物換成新外觀

最外層加 .screen：區塊變卡片、按鈕與輸入框統一、點擊目標 ≥ 44px。標籤、
順序與既有測試都沒動；新的 e2e 在手機尺寸量點擊目標的高度。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

```bash
git add frontend/src/screens/FoodLibrary.tsx frontend/src/screens/NewFood.tsx frontend/e2e/touch-targets.spec.ts
```

---

## Task 3：食物詳情（含新增份量）

**Files:**
- Modify: `frontend/src/screens/FoodDetail.tsx`、`frontend/e2e/touch-targets.spec.ts`

- [ ] **Step 1: 寫失敗的 e2e**

`frontend/e2e/touch-targets.spec.ts` 檔尾加（`expect` 加進 import：`import { expect, test } from "@playwright/test";`）：

```ts
test("食物詳情：按鈕與「預設」勾選框都 ≥ 44px", async ({ page }) => {
	await login(page);
	// 建一個唯一名稱的私人食物，建好會導到它的詳情頁。
	const name = `E2E 觸控 ${Date.now()}`;
	await page.goto("/foods/new");
	await page.getByLabel("名稱", { exact: true }).fill(name);
	await page.getByLabel("熱量（每 100 單位 kcal）").fill("100");
	await page.getByLabel("蛋白質（g）", { exact: true }).fill("1");
	await page.getByLabel("脂肪（g）", { exact: true }).fill("1");
	await page.getByLabel("碳水化合物（g）", { exact: true }).fill("1");
	await page.getByRole("button", { name: "建立食物" }).click();
	await expect(page.getByRole("heading", { name })).toBeVisible();

	await expectTouchTargets(
		page.locator(
			"main button:visible, main label:has(input[type=checkbox]):visible",
		),
		"食物詳情",
	);
});
```

- [ ] **Step 2: 跑 e2e 確認失敗**

```
cd frontend
npx playwright test e2e/touch-targets.spec.ts -g 食物詳情
```

Expected：FAIL（「新增份量」「送出」按鈕或勾選框的高度小於 44——照實回報數字）。

- [ ] **Step 3: 實作**

`frontend/src/screens/FoodDetail.tsx`：

1. import `ui from "../components/ui.module.css"`。
2. 最外層 `<section>` 改成 `<section className={ui.screen}>`。四個區塊的 `<section>` 已經是直接子元素（在 fragment 裡），會自動變成卡片。
3. 「目前生效的營養素」的 `<dl>` 改成 2×2 小方格——**每一組 `<dt>`／`<dd>` 包一個 `<div>`**（HTML 允許 `<dl>` 底下用 `<div>` 分組），文字不變：

```tsx
							<dl className={ui.stats}>
								<div className={ui.stat}>
									<dt>熱量</dt>
									<dd>
										{formatMacro(food.nutrition.kcal)} kcal / 100
										{food.nutrition.base_unit}
									</dd>
								</div>
								<div className={ui.stat}>
									<dt>蛋白質</dt>
									<dd>{formatMacro(food.nutrition.protein_g)} g</dd>
								</div>
								<div className={ui.stat}>
									<dt>脂肪</dt>
									<dd>{formatMacro(food.nutrition.fat_g)} g</dd>
								</div>
								<div className={ui.stat}>
									<dt>碳水化合物</dt>
									<dd>{formatMacro(food.nutrition.carb_g)} g</dd>
								</div>
							</dl>
```

4. 份量清單的 `{portion.is_default && "・預設"}` 改成（`<li>` 的 textContent 仍然是「碗（150 g）・預設」——`e2e/portions.spec.ts` 用 `/碗（150 g）/` 找它）：

```tsx
										{portion.is_default && (
											<>
												・<span className={ui.tag}>預設</span>
											</>
										)}
```

5. 編輯歷史的 `<span>{STATUS_LABEL[revision.status]}</span>` 加 `className={ui.tag}`（文字不變；那段長註解說的「各自包一層 `<span>`」照舊成立）。

> `AddPortionForm` 不用改：它在「份量」區塊裡，表單、勾選框、送出按鈕都由 `.screen` 的後代規則處理。

- [ ] **Step 4: 跑測試確認通過**

```
npx playwright test e2e/touch-targets.spec.ts
npx vitest run tests/food-detail.test.tsx tests/css-tokens.test.ts
git status --short tests e2e
```

Expected：三條 e2e PASS；`food-detail.test.tsx` 全綠；`git status` 只看到 `e2e/touch-targets.spec.ts` 被改。

- [ ] **Step 5: 用眼睛看一次**（手機寬度、淺色與深色；營養素是 2×2 小方格、「預設」與「已通過」是小圓角標籤、新增份量的表單在份量卡片裡）。

- [ ] **Step 6: 全部前端檢查**＋全部 e2e（Expected：24 passed）

- [ ] **Step 7: Commit**

```
style(ui): 食物詳情換成新外觀

營養素改成 2×2 小方格，「預設」與審核狀態改成小圓角標籤；文字與順序不變。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

```bash
git add frontend/src/screens/FoodDetail.tsx frontend/e2e/touch-targets.spec.ts
```

---

## Task 4：補劑、管理員審核

**Files:**
- Modify: `frontend/src/screens/Supplements.tsx`、`frontend/src/screens/AdminRevisions.tsx`、`frontend/src/components/ui.module.css`、`frontend/e2e/touch-targets.spec.ts`

- [ ] **Step 1: 寫失敗的 e2e**

`frontend/e2e/touch-targets.spec.ts` 檔尾加：

```ts
test("補劑：按鈕都 ≥ 44px", async ({ page }) => {
	await login(page);
	await page.goto("/supplements");
	await expect(page.getByRole("heading", { name: "補劑" })).toBeVisible();
	await expectTouchTargets(page.locator("main button:visible"), "補劑");
});
```

> 管理員審核不加（計畫「與規格的差異」第 4 點）。

- [ ] **Step 2: 跑 e2e 確認失敗**

```
npx playwright test e2e/touch-targets.spec.ts -g 補劑
```

Expected：FAIL（「新增補劑」的高度小於 44）。

- [ ] **Step 3: 實作**

`frontend/src/components/ui.module.css` 檔尾加（**不包 `:where()`**——它們要贏過 `.screen` 的通用按鈕規則）：

```css
/* 明確指定的按鈕樣式：管理員審核的「通過」是主要動作、「駁回」是危險動作，
   不能照「type=submit 就是主要」的通用規則（駁回的按鈕剛好是 submit）。 */
.primary {
	border: none;
	background: var(--color-action);
	color: var(--color-on-action);
}

.danger {
	border: 1px solid var(--color-danger);
	background: transparent;
	color: var(--color-danger);
}
```

`frontend/src/screens/Supplements.tsx`：import `ui`；把平的結構分成三個區塊（**文字、順序、`id` 不變，只是包起來**）：

```tsx
		<section className={ui.screen}>
			<h1>補劑</h1>

			<section>
				<h2>今日狀態</h2>
				{/* 原本 h2 之後到下一個 h2 之前的內容，原樣搬進來 */}
			</section>

			<section>
				<h2>新增補劑</h2>
				{/* 原本的 <form>…</form>，原樣搬進來 */}
			</section>

			<section>
				<h2>找補劑，今天吃了就點一份</h2>
				{/* 原本的 label、input、{hasQuery && (…)}，原樣搬進來 */}
			</section>
		</section>
```

> 上面的 `{/* … */}` 是**指示**，不是要寫進檔案的內容——把原本那幾段 JSX 原封不動搬進去。今日狀態每一列的 `<span>{statusLabel(item)}</span>` 加 `className={ui.tag}`。

`frontend/src/screens/AdminRevisions.tsx`：import `ui`；三個 `return` 的最外層 `<section>` 都改成 `<section className={ui.screen}>`；`RevisionRow` 的「通過」按鈕加 `className={ui.primary}`、「駁回」按鈕加 `className={ui.danger}`。

- [ ] **Step 4: 跑測試確認通過**

```
npx playwright test e2e/touch-targets.spec.ts
npx vitest run tests/supplements.test.tsx tests/admin-revisions.test.tsx tests/css-tokens.test.ts
git status --short tests e2e
```

Expected：四條 e2e PASS；單元測試全綠；`git status` 只看到 `e2e/touch-targets.spec.ts`。

- [ ] **Step 5: 用眼睛看一次**（補劑三張卡片；管理員審核——用管理員帳號、需要的話先在某個公開食物提議修改造一筆待審——表格可讀、「通過」是實心、「駁回」是紅框）。

- [ ] **Step 6: 全部前端檢查**＋全部 e2e（Expected：25 passed）

- [ ] **Step 7: Commit**

```
style(ui): 補劑與管理員審核換成新外觀

補劑分成三張卡片；審核的「通過」是主要按鈕、「駁回」是危險按鈕。
文字、順序與既有測試都沒動。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

```bash
git add frontend/src/screens/Supplements.tsx frontend/src/screens/AdminRevisions.tsx frontend/src/components/ui.module.css frontend/e2e/touch-targets.spec.ts
```

---

## Task 5：報表的甜甜圈圖

**Files:**
- Create: `frontend/src/components/CategoryDonut.tsx`、`CategoryDonut.module.css`、`frontend/src/components/CategoryBar.module.css`、`frontend/tests/category-donut.test.tsx`
- Modify: `frontend/src/components/CategoryBar.tsx`、`frontend/src/screens/Expenses.tsx`、`frontend/src/screens/Expenses.module.css`
- Test: `frontend/tests/expenses.test.tsx`（加兩條，不改既有的）

- [ ] **Step 1: 寫失敗的測試**

`frontend/tests/category-donut.test.tsx`（新）：

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CATEGORY_COLORS } from "../src/api/expenses";
import { CategoryDonut } from "../src/components/CategoryDonut";

// 半徑 45 的圓周——跟 CategoryDonut 裡的常數同一個數字。測試自己算一次，
// 不 import 元件的常數：import 的話，元件把半徑改錯，測試跟著錯。
const CIRCUMFERENCE = 2 * Math.PI * 45;

function arc(category: string) {
	return screen.getByTestId(`donut-${category}`);
}

function lengthOf(category: string): number {
	return Number(arc(category).getAttribute("stroke-dasharray")?.split(" ")[0]);
}

function offsetOf(category: string): number {
	return Number(arc(category).getAttribute("stroke-dashoffset"));
}

describe("CategoryDonut", () => {
	it("每一段的長度比例等於金額比例", () => {
		render(
			<CategoryDonut
				rows={[
					{ category: "food", total: "300.00", count: 3 },
					{ category: "transport", total: "100.00", count: 1 },
				]}
				total="400.00"
			/>,
		);

		expect(lengthOf("food")).toBeCloseTo(CIRCUMFERENCE * 0.75, 5);
		expect(lengthOf("transport")).toBeCloseTo(CIRCUMFERENCE * 0.25, 5);
	});

	it("換一組金額比例也對——寫死比例的實作過不了", () => {
		render(
			<CategoryDonut
				rows={[
					{ category: "food", total: "50.00", count: 1 },
					{ category: "daily", total: "150.00", count: 2 },
				]}
				total="200.00"
			/>,
		);

		expect(lengthOf("food")).toBeCloseTo(CIRCUMFERENCE * 0.25, 5);
		expect(lengthOf("daily")).toBeCloseTo(CIRCUMFERENCE * 0.75, 5);
	});

	it("每一段接在前一段後面", () => {
		render(
			<CategoryDonut
				rows={[
					{ category: "food", total: "300.00", count: 3 },
					{ category: "transport", total: "100.00", count: 1 },
				]}
				total="400.00"
			/>,
		);

		expect(offsetOf("food")).toBeCloseTo(0, 5);
		expect(offsetOf("transport")).toBeCloseTo(-CIRCUMFERENCE * 0.75, 5);
	});

	it("只有一個分類時畫成整圈", () => {
		render(
			<CategoryDonut
				rows={[{ category: "food", total: "120.00", count: 1 }]}
				total="120.00"
			/>,
		);

		expect(lengthOf("food")).toBeCloseTo(CIRCUMFERENCE, 5);
	});

	it("每一段是那個分類的顏色", () => {
		render(
			<CategoryDonut
				rows={[{ category: "transport", total: "10.00", count: 1 }]}
				total="10.00"
			/>,
		);

		expect(arc("transport")).toHaveAttribute("stroke", CATEGORY_COLORS.transport);
	});

	it("圖是裝飾：清單已經有全部的數字，螢幕閱讀器不唸第二次", () => {
		render(
			<CategoryDonut
				rows={[{ category: "food", total: "10.00", count: 1 }]}
				total="10.00"
			/>,
		);

		expect(screen.getByTestId("category-donut")).toHaveAttribute(
			"aria-hidden",
			"true",
		);
	});
});
```

`frontend/tests/expenses.test.tsx`：在「空月份的總額是 0.00…」那條之後加（`mockApi`、`json`、`wrap`、`Expenses` 都已經 import）：

```tsx
	it("這個月有支出：畫甜甜圈，每個分類一段", async () => {
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

		expect(await screen.findByTestId("category-donut")).toBeInTheDocument();
		expect(screen.getByTestId("donut-food")).toBeInTheDocument();
		expect(screen.getByTestId("donut-transport")).toBeInTheDocument();
	});

	it("這個月沒有支出：不畫甜甜圈，說還沒有支出（總額仍然是 0.00）", async () => {
		mockApi([
			{
				method: "GET",
				path: "/api/expenses/summary",
				handler: () =>
					json({ month: "2026-12", total: "0.00", by_category: [] }),
			},
			{ method: "GET", path: "/api/expenses", handler: () => json([]) },
		]);

		render(wrap(<Expenses />));

		expect(await screen.findByText("這個月還沒有支出")).toBeInTheDocument();
		expect(screen.getByText("0.00")).toBeInTheDocument();
		expect(screen.queryByTestId("category-donut")).not.toBeInTheDocument();
	});
```

> 「沒有支出」那條先等「這個月還沒有支出」出現（證明報表已經載入）才斷言甜甜圈不在——不然在載入中就會空轉通過（handover §6 第 41 種）。

- [ ] **Step 2: 跑測試確認失敗**

```
cd frontend
npx vitest run tests/category-donut.test.tsx tests/expenses.test.tsx
```

Expected：`category-donut.test.tsx` 整個 FAIL（模組不存在）；`expenses.test.tsx` 新的兩條 FAIL，既有的全綠。

- [ ] **Step 3: 實作**

`frontend/src/components/CategoryDonut.module.css`（新）：

```css
.donut {
	display: block;
	width: 160px;
	height: 160px;
	margin: var(--space-2) auto;
}

/* 底圈：分類的弧畫在它上面。只有一個分類時被整圈蓋住。 */
.track {
	fill: none;
	stroke: var(--color-border);
}
```

`frontend/src/components/CategoryDonut.tsx`（新）：

```tsx
import { CATEGORY_COLORS, type CategoryTotal } from "../api/expenses";
import { ratioOf } from "../lib/decimal";
import styles from "./CategoryDonut.module.css";

const SIZE = 120;
const CENTER = SIZE / 2;
const RADIUS = 45;
const STROKE_WIDTH = 20;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

type Props = {
	rows: readonly CategoryTotal[];
	/** 這個月的總額。呼叫端保證它 > 0（沒有支出時不畫這張圖）。 */
	total: string;
};

/** 報表的分類甜甜圈（介面改版第二階段 §4.1）。
 *
 *  **每一段的長度與起點算成 SVG 屬性**（`stroke-dasharray`／
 *  `stroke-dashoffset`），不交給 CSS——jsdom 不做版面計算，交給 CSS 的話
 *  「弧長比例等於金額比例」就測不到（同 `TrendChart` 的作法）。
 *
 *  佔比用 `ratioOf()`（`lib/decimal.ts`），不做浮點除法。弧從 12 點鐘方向
 *  順時針排（`rotate(-90)`），順序跟清單一樣。
 *
 *  **整張圖是裝飾**（`aria-hidden`）：下面的清單已經有每個分類的金額與
 *  百分比，螢幕閱讀器不需要再唸一次。 */
export function CategoryDonut({ rows, total }: Props) {
	const lengths = rows.map((row) => (ratioOf(row.total, total) ?? 0) * CIRCUMFERENCE);
	const starts = lengths.map((_, index) =>
		lengths.slice(0, index).reduce((sum, length) => sum + length, 0),
	);

	return (
		<svg
			viewBox={`0 0 ${SIZE} ${SIZE}`}
			className={styles.donut}
			aria-hidden="true"
			data-testid="category-donut"
		>
			<circle
				className={styles.track}
				cx={CENTER}
				cy={CENTER}
				r={RADIUS}
				strokeWidth={STROKE_WIDTH}
			/>
			{rows.map((row, index) => (
				<circle
					key={row.category}
					data-testid={`donut-${row.category}`}
					cx={CENTER}
					cy={CENTER}
					r={RADIUS}
					fill="none"
					stroke={CATEGORY_COLORS[row.category]}
					strokeWidth={STROKE_WIDTH}
					strokeDasharray={`${lengths[index]} ${CIRCUMFERENCE}`}
					strokeDashoffset={-(starts[index] ?? 0)}
					transform={`rotate(-90 ${CENTER} ${CENTER})`}
				/>
			))}
		</svg>
	);
}
```

> 顏色用 SVG 的 `stroke` 屬性（不是 CSS）：`CATEGORY_COLORS` 是資料不是主題（`api/expenses.ts` 的註解），`IconBadge` 也是用 inline 的方式套——css-tokens 的「module CSS 不寫色碼」不受影響。

`frontend/src/components/CategoryBar.module.css`（新）：

```css
.row {
	display: flex;
	align-items: center;
	gap: var(--space-2);
	padding: var(--space-1) 0;
}

.dot {
	flex: none;
	width: 12px;
	height: 12px;
	border-radius: 50%;
}

.label {
	flex: 1;
}

.meta {
	font-size: 12px;
	color: var(--color-text-muted);
}

.amount {
	font-weight: 600;
	font-variant-numeric: tabular-nums;
}
```

`frontend/src/components/CategoryBar.tsx`：import `CATEGORY_COLORS`（同一行 `CATEGORY_LABELS` 那邊）與 `styles from "./CategoryBar.module.css"`；`return` 換成（**內容不變**：分類名、金額、`N 筆`、百分比都還在同一個 `data-testid` 裡，只多一個色點、換了排列）：

```tsx
	return (
		<div data-testid={`category-${row.category}`} className={styles.row}>
			<span
				className={styles.dot}
				style={{ background: CATEGORY_COLORS[row.category] }}
				aria-hidden="true"
			/>
			<span className={styles.label}>{CATEGORY_LABELS[row.category]}</span>
			{/* share 為 null 代表總額是 0（ratioOf 對 0 回 null，不是
			    Infinity 也不是 NaN）——那時候沒有佔比可言，不畫。 */}
			{share !== null && (
				<span className={styles.meta}>
					{share.toLocaleString(undefined, {
						style: "percent",
						maximumFractionDigits: 0,
					})}
				</span>
			)}
			<span className={styles.meta}>{row.count} 筆</span>
			<span className={styles.amount}>{formatMoney(row.total)}</span>
		</div>
	);
```

`frontend/src/screens/Expenses.tsx`：import `CategoryDonut`（`../components/CategoryDonut`）與 `isPositiveAmount`（加進 `../lib/decimal` 那行）；`MonthSummary` 的 `return` 換成：

```tsx
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
						<CategoryBar key={row.category} row={row} monthTotal={summary.total} />
					))}
				</>
			) : (
				<p>這個月還沒有支出</p>
			)}
		</div>
	);
```

`frontend/src/screens/Expenses.module.css` 檔尾加：

```css
.monthTotal {
	margin: 0;
	font-size: var(--font-size-total);
	font-weight: 700;
	font-variant-numeric: tabular-nums;
}
```

> 「總計 <span>…</span>」那一行**不能拿掉**：既有測試 `findByText("400.00")` 與空月份的 `findByText("0.00")` 找的就是那個 `<span>`（計畫「與規格的差異」第 3 點）。

- [ ] **Step 4: 跑測試確認通過**

```
npx vitest run tests/category-donut.test.tsx tests/expenses.test.tsx tests/css-tokens.test.ts
git diff HEAD -- tests/expenses.test.tsx
```

Expected：全部 PASS；`expenses.test.tsx` 的 diff 只有新增的兩條。

- [ ] **Step 5: 突變測試**

1. `CategoryDonut` 的長度改成每一段都是 `CIRCUMFERENCE / rows.length`（平均分）→ Expected：兩條比例測試 FAIL、「只有一個分類」照樣綠。
2. `starts` 改成全部 0 → Expected：「每一段接在前一段後面」FAIL。
3. `MonthSummary` 的條件拿掉 `isPositiveAmount(...) &&` → Expected：「沒有支出」那條……照實回報（`by_category` 是空的時候條件仍然是 false，這個突變**可能不會紅**——如果沒紅，說明為什麼，並提出一個會紅的測試資料，例如 `total: "0.00"` 但 `by_category` 有一筆 0 元的分類；**不要**自己硬加）。

- [ ] **Step 6: 用眼睛看一次**（報表頁、手機寬度、淺色與深色；圈的大小、清單的色點跟弧的顏色一致）。

- [ ] **Step 7: 全部前端檢查**＋全部 e2e（Expected：25 passed）

- [ ] **Step 8: Commit**

```
feat(ui): 報表的分類佔比改成甜甜圈圖

每一段的長度與起點算成 SVG 屬性（測得到弧長比例）；清單多了色點。
這個月沒有支出時不畫圖，說「這個月還沒有支出」。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

```bash
git add frontend/src/components/CategoryDonut.tsx frontend/src/components/CategoryDonut.module.css frontend/src/components/CategoryBar.tsx frontend/src/components/CategoryBar.module.css frontend/src/screens/Expenses.tsx frontend/src/screens/Expenses.module.css frontend/tests/category-donut.test.tsx frontend/tests/expenses.test.tsx
```

---

## Task 6：趨勢——營養素切換、今天、新外觀

**Files:**
- Modify: `frontend/src/components/TrendChart.tsx`、`frontend/src/screens/Trend.tsx`、`frontend/e2e/touch-targets.spec.ts`
- Create: `frontend/src/screens/Trend.module.css`
- Test: `frontend/tests/trend-chart.test.tsx`、`frontend/tests/trend.test.tsx`（加測試，不改既有的）

- [ ] **Step 1: 寫失敗的測試**

`frontend/tests/trend-chart.test.tsx` 檔尾加（`TrendDay`、`TrendChart` 已經 import；`bars()`、`heightOf()` 是檔案裡既有的 helper）：

```tsx
type Macros = { kcal: string; protein_g: string; fat_g: string; carb_g: string };
type Target = {
	kcal: string | null;
	protein_g: string | null;
	fat_g: string | null;
	carb_g: string | null;
};

function fullDay(date: string, actual: Partial<Macros>, target: Partial<Target> | null): TrendDay {
	return {
		date,
		actual: { kcal: "0.00", protein_g: "0.00", fat_g: "0.00", carb_g: "0.00", ...actual },
		target:
			target === null
				? null
				: { kcal: null, protein_g: null, fat_g: null, carb_g: null, ...target },
		ratio: null,
	};
}

describe("TrendChart：營養素", () => {
	it("切到蛋白質：柱子高度比例是蛋白質的比例，不是熱量的", () => {
		// 熱量的比例是 2:1，蛋白質是 1:2——畫錯哪一項一定看得出來。
		render(
			<TrendChart
				metric="protein_g"
				days={[
					fullDay("2026-09-15", { kcal: "2000.00", protein_g: "50.00" }, null),
					fullDay("2026-09-16", { kcal: "1000.00", protein_g: "100.00" }, null),
				]}
			/>,
		);

		expect(heightOf(0) / heightOf(1)).toBeCloseTo(0.5, 5);
	});

	it("蛋白質的 label 說蛋白質與克", () => {
		render(
			<TrendChart
				metric="protein_g"
				days={[
					fullDay(
						"2026-09-15",
						{ protein_g: "50.00" },
						{ kcal: "2000.00", protein_g: "80.00" },
					),
				]}
			/>,
		);

		expect(screen.getByTestId("trend-bar-2026-09-15")).toHaveAttribute(
			"aria-label",
			"9/15，蛋白質 50 克，目標 80 克",
		);
		expect(screen.getByRole("group", { name: "最近幾天的蛋白質" })).toBeInTheDocument();
	});

	it("蛋白質沒設目標、熱量有：畫蛋白質時不畫目標線，畫熱量時畫", () => {
		const days = [
			fullDay(
				"2026-09-15",
				{ kcal: "1800.00", protein_g: "50.00" },
				{ kcal: "2000.00", protein_g: null },
			),
		];
		const { rerender } = render(<TrendChart metric="protein_g" days={days} />);
		expect(screen.queryByTestId("trend-target-2026-09-15")).not.toBeInTheDocument();

		rerender(<TrendChart metric="kcal" days={days} />);
		expect(screen.getByTestId("trend-target-2026-09-15")).toBeInTheDocument();
	});

	it("今天那一根是淡色，其他天不是", () => {
		render(
			<TrendChart
				today="2026-09-16"
				days={[
					fullDay("2026-09-15", { kcal: "1800.00" }, null),
					fullDay("2026-09-16", { kcal: "900.00" }, null),
				]}
			/>,
		);

		expect(screen.getByTestId("trend-bar-2026-09-16")).toHaveClass("trend-bar-today");
		expect(screen.getByTestId("trend-bar-2026-09-15")).not.toHaveClass("trend-bar-today");
	});
});
```

`frontend/tests/trend.test.tsx` 檔尾加（`userEvent` 要 import：`import userEvent from "@testing-library/user-event";`）：

```tsx
/** 今天（最後一天）有熱量與蛋白質的目標、脂肪與碳水沒設。整個換掉最後一天，
 *  不去改 rangeBody 回傳的物件（它的 target 型別是 null）。 */
function rangeWithTodayTargets() {
	const body = rangeBody(null);
	return {
		...body,
		trend: [
			...body.trend.slice(0, -1),
			{
				date: "2019-07-04",
				actual: { kcal: "1240.00", protein_g: "60.00", fat_g: "0.00", carb_g: "0.00" },
				target: { kcal: "2000.00", protein_g: "80.00", fat_g: null, carb_g: null },
				ratio: null,
			},
		],
	};
}

function mockTrend() {
	return mockApi([
		{ path: "/api/stats/daily", handler: () => json(DAILY) },
		{ path: "/api/stats/range", handler: () => json(rangeWithTodayTargets()) },
	]);
}

describe("趨勢：營養素切換", () => {
	it("預設是熱量，今天的摘要寫實際 / 目標", async () => {
		mockTrend();
		render(wrap(<Trend />));

		expect(await screen.findByRole("radio", { name: "熱量" })).toBeChecked();
		expect(screen.getByTestId("today-summary")).toHaveTextContent(
			"今天 1240 / 2000 kcal",
		);
	});

	it("切到蛋白質：圖與今天的摘要都換成蛋白質", async () => {
		mockTrend();
		render(wrap(<Trend />));

		await userEvent.click(await screen.findByRole("radio", { name: "蛋白質" }));

		expect(
			screen.getByRole("group", { name: "最近幾天的蛋白質" }),
		).toBeInTheDocument();
		expect(screen.getByTestId("today-summary")).toHaveTextContent(
			"今天 60 / 80 g",
		);
	});

	it("那一項沒有目標：摘要只寫實際值", async () => {
		mockTrend();
		render(wrap(<Trend />));

		await userEvent.click(await screen.findByRole("radio", { name: "脂肪" }));

		expect(screen.getByTestId("today-summary")).toHaveTextContent("今天 0 g");
		expect(screen.getByTestId("today-summary")).not.toHaveTextContent("/");
	});
});
```

> `DAILY`、`rangeBody`、`json`、`mockApi`（陣列形式）都是檔案裡既有的。**不要**動既有的測試。

`frontend/e2e/touch-targets.spec.ts` 檔尾加：

```ts
test("趨勢：營養素切換的選項都 ≥ 44px", async ({ page }) => {
	await login(page);
	await page.goto("/trend");
	await expect(page.getByRole("heading", { name: "趨勢" })).toBeVisible();
	await expectTouchTargets(
		page.locator("main label:has(input[type=radio]):visible"),
		"趨勢",
	);
});
```

- [ ] **Step 2: 跑測試確認失敗**

```
cd frontend
npx vitest run tests/trend-chart.test.tsx tests/trend.test.tsx
npx playwright test e2e/touch-targets.spec.ts -g 趨勢
```

Expected：`trend-chart` 新的四條 FAIL（`metric`／`today` 不存在：高度比例是熱量的 2.0、label 是大卡、目標線照畫、沒有 today class）；`trend` 新的三條 FAIL（找不到 radio）；e2e FAIL（一個 radio 都沒有，「至少要有一個點擊目標」）。既有的全綠。

- [ ] **Step 3: 實作 `TrendChart`**

`frontend/src/components/TrendChart.tsx`：

1. `export type TrendDay = …` 之後加：

```tsx
/** 趨勢圖可以畫的四項（介面改版第二階段 §5）。跟 `MacrosResponse` 的欄位同名。 */
export type TrendMetric = "kcal" | "protein_g" | "fat_g" | "carb_g";

/** 每一項的名稱與單位。`spokenUnit` 是 aria-label 用的（螢幕閱讀器念「大卡」
 *  「克」比念「kcal」「g」自然）；熱量的 label 刻意維持原本的格式
 *  （「9/15，1800 大卡，…」，既有測試釘著）。 */
export const TREND_METRICS: Record<
	TrendMetric,
	{ label: string; unit: string; spokenUnit: string }
> = {
	kcal: { label: "熱量", unit: "kcal", spokenUnit: "大卡" },
	protein_g: { label: "蛋白質", unit: "g", spokenUnit: "克" },
	fat_g: { label: "脂肪", unit: "g", spokenUnit: "克" },
	carb_g: { label: "碳水", unit: "g", spokenUnit: "克" },
};

export const TREND_METRIC_ORDER: readonly TrendMetric[] = [
	"kcal",
	"protein_g",
	"fat_g",
	"carb_g",
];
```

2. 函式簽章改成：

```tsx
type Props = {
	days: readonly TrendDay[];
	/** 要畫哪一項。預設熱量——既有的呼叫端與測試都是熱量。 */
	metric?: TrendMetric;
	/** 今天的日期（`stats/daily` 回的 `date`）。那一根畫淡色——今天還沒結束。
	 *  **圖表不自己算今天**（前端不算日界線），由畫面傳進來。 */
	today?: string | null;
};

export function TrendChart({ days, metric = "kcal", today = null }: Props) {
```

3. 函式本體裡所有 `.kcal` 換成 `[metric]`（`day.actual.kcal` → `day.actual[metric]`、`day.target?.kcal` → `day.target?.[metric]`、`day.target.kcal` → `day.target[metric]`），變數 `targetKcal` 改名 `targetValue`。

4. label 改成：

```tsx
				const { spokenUnit } = TREND_METRICS[metric];
				// 熱量維持原本的格式（「9/15，1800 大卡，…」）；其他項目前面多寫
				// 項目名稱——「50 克」單獨念出來聽不出是哪一項。
				const what = metric === "kcal" ? "" : `${TREND_METRICS[metric].label} `;
				const value = `${what}${formatMacro(day.actual[metric])} ${spokenUnit}`;
				const label =
					targetValue === null
						? `${formatCivilDate(day.date)}，${value}，沒有目標`
						: `${formatCivilDate(day.date)}，${value}，目標 ${formatMacro(targetValue)} ${spokenUnit}`;
```

5. `<svg>` 的 `aria-label="最近幾天的熱量"` 改成 ``aria-label={`最近幾天的${TREND_METRICS[metric].label}`}``。
6. `<rect>` 加 `rx={3}`，`className="trend-bar"` 改成 ``className={day.date === today ? "trend-bar trend-bar-today" : "trend-bar"}``。

> 檔頭那段「兩層 null」的說明照舊成立——只是「kcal 那一項」變成「這一項」，順手把文字改成「這一項」。

- [ ] **Step 4: 實作 `Trend` 畫面**

`frontend/src/screens/Trend.module.css`（新）：

```css
/* 營養素切換：一排分段按鈕。底下是原生的單選鈕（鍵盤與螢幕閱讀器照常
   用），視覺上藏起來，標籤本身是點擊目標。 */
.metrics {
	display: flex;
	gap: var(--space-1);
	margin: 0;
	padding: var(--space-1);
	border: none;
	border-radius: var(--radius-button);
	background: var(--color-surface);
}

/* legend 給螢幕閱讀器（這組單選鈕叫「營養素」），畫面上不需要。 */
.legend {
	position: absolute;
	width: 1px;
	height: 1px;
	overflow: hidden;
	clip-path: inset(50%);
	white-space: nowrap;
}

.metric {
	position: relative;
	flex: 1;
	display: flex;
	align-items: center;
	justify-content: center;
	min-height: 44px;
	border-radius: var(--radius-button);
	color: var(--color-text-muted);
	font-size: 14px;
	font-weight: 600;
}

.metric:has(input:checked) {
	background: var(--color-accent-soft);
	color: var(--color-action);
}

.metric:has(input:focus-visible) {
	outline: 2px solid var(--color-action);
	outline-offset: 2px;
}

.metricInput {
	position: absolute;
	width: 1px;
	height: 1px;
	opacity: 0;
}

.summary {
	margin-top: var(--space-2);
	font-size: 13px;
	color: var(--color-text-muted);
}
```

`frontend/src/screens/Trend.tsx`：

1. imports：`import { useState } from "react";`、`import { formatMacro } from "../lib/decimal";`、`import ui from "../components/ui.module.css";`、`import styles from "./Trend.module.css";`；`TrendChart` 那行改成 `import { TREND_METRIC_ORDER, TREND_METRICS, TrendChart, type TrendDay, type TrendMetric } from "../components/TrendChart";`。
2. 在 `Trend` 函式之前加：

```tsx
/** 今天那一項的摘要：「今天 1240 / 2000 kcal」；那一項沒有目標（整天沒有
 *  目標，或有目標但這一項沒設）時只寫實際值。 */
function todaySummary(day: TrendDay, metric: TrendMetric): string {
	const { unit } = TREND_METRICS[metric];
	const actual = formatMacro(day.actual[metric]);
	const target = day.target === null ? null : day.target[metric];
	return target === null
		? `今天 ${actual} ${unit}`
		: `今天 ${actual} / ${formatMacro(target)} ${unit}`;
}
```

3. 元件裡加 `const [metric, setMetric] = useState<TrendMetric>("kcal");`，以及（在 `range` 之後）`const todayDay = range?.trend.find((day) => day.date === today) ?? null;`。
4. JSX 換成：

```tsx
		<section className={ui.screen}>
			<h1>趨勢</h1>

			{anchorQuery.isError && <p>無法載入趨勢</p>}
			{!range && !anchorQuery.isError && <p>載入中…</p>}

			{range && (
				<>
					<fieldset className={styles.metrics}>
						<legend className={styles.legend}>營養素</legend>
						{TREND_METRIC_ORDER.map((option) => (
							<label key={option} className={styles.metric}>
								<input
									type="radio"
									name="trend-metric"
									value={option}
									checked={metric === option}
									onChange={() => setMetric(option)}
									className={styles.metricInput}
								/>
								{TREND_METRICS[option].label}
							</label>
						))}
					</fieldset>

					<div>
						<TrendChart days={range.trend} metric={metric} today={today} />
						{todayDay !== null && (
							<p data-testid="today-summary" className={styles.summary}>
								{todaySummary(todayDay, metric)}
							</p>
						)}
					</div>

					<div>
						{/* 依從率的 <p data-testid="adherence"> 與它上面的註解，原樣搬進來 */}
					</div>
				</>
			)}
		</section>
```

> 最後那個 `{/* … */}` 是**指示**——把原本那個 `<p data-testid="adherence">…</p>`（含上面規格 §4.7 的註解）原封不動搬進那個 `<div>`。

- [ ] **Step 5: 跑測試確認通過**

```
npx vitest run tests/trend-chart.test.tsx tests/trend.test.tsx tests/css-tokens.test.ts
npx playwright test e2e/touch-targets.spec.ts
git diff HEAD -- tests/trend-chart.test.tsx tests/trend.test.tsx
```

Expected：全部 PASS（既有的 trend 測試照樣綠——預設熱量）；diff 只有新增的測試與 import。

- [ ] **Step 6: 突變測試**

1. `TrendChart` 的 `heightOf(day.actual[metric])` 改回 `heightOf(day.actual.kcal)` → Expected：「切到蛋白質：柱子高度比例…」FAIL。
2. `todaySummary` 永遠用 `"kcal"` → Expected：「切到蛋白質：圖與今天的摘要…」FAIL。

- [ ] **Step 7: 用眼睛看一次**（手機寬度、淺色與深色；切換鈕是一排、選中的那個有底色；今天那根是淡色；虛線目標線；依從率卡片）。

- [ ] **Step 8: 全部前端檢查**＋全部 e2e（Expected：26 passed）

- [ ] **Step 9: Commit**

```
feat(ui): 趨勢可以切換熱量、蛋白質、脂肪、碳水

TrendChart 多了要畫哪一項與今天的日期（今天那根是淡色）；畫面下方寫今天的
實際值與目標。熱量的 label 維持原本的格式。換成新外觀。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

```bash
git add frontend/src/components/TrendChart.tsx frontend/src/screens/Trend.tsx frontend/src/screens/Trend.module.css frontend/tests/trend-chart.test.tsx frontend/tests/trend.test.tsx frontend/e2e/touch-targets.spec.ts
```

---

## Task 7：交接文件

**Files:** Modify `docs/handover.md`

- [ ] **Step 1:**
  - §2 階段進度的「UI 改版 第二階段」那一列改成已實作，寫上範圍（六個舊畫面換外觀、報表甜甜圈、趨勢營養素切換）與規格、計畫的路徑。
  - 「介面改版：下一步與已知待辦」那一節：把「第二階段」那一條改成已完成；**其中「`.food-no-nutrition` 的 `#b33`…對比只有約 3:1」那句刪掉**（已經換成 `--color-danger`）；留下第三階段。
  - 這次實作過程中新發現的「綠燈說謊」寫進 §6（沒有就不寫）；技術坑寫進 §7。
- [ ] **Step 2: Commit**

```
docs: 交接文件——介面改版第二階段

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

---

## 收尾

- [ ] 全部測試：前端 `typecheck`、`lint`、`test`；e2e（Expected：26 passed）；後端沒動，但跑一次 `pytest -q` 確認。
- [ ] `git status` 乾淨（`lunch.jpg` 除外）。

---

## 自我檢查（寫計畫時做的）

**規格涵蓋：**

| 規格 | 任務 |
|---|---|
| §3.1 六個畫面 | Task 2（食物庫、新增食物）、Task 3（食物詳情、新增份量）、Task 4（補劑、管理員審核）、Task 6（趨勢） |
| §3.2 共用樣式積木 | Task 1（`ui.module.css`）、Task 4（`.primary`、`.danger`） |
| §3.3 卡片、2×2、標籤、44px、文字不變 | Task 1–4、6；「既有測試不改」在每個任務的 Step 4 檢查 |
| §3.4 `index.css` 舊顏色、`--color-success`、掃描測試 | Task 1 |
| §4 甜甜圈、清單、空狀態 | Task 5（中間不寫總計：與規格的差異第 3 點） |
| §5 趨勢切換、`TrendChart` 的 metric、今天、摘要、外觀 | Task 6 |
| §6 測試 | Task 1–6（管理員審核的 e2e：與規格的差異第 4 點） |
| §7 交付 | Task 1–7 |

**名稱一致：** `ui.screen`／`ui.stats`／`ui.stat`／`ui.tag`（Task 1 定義，Task 2–4、6 使用）、`ui.primary`／`ui.danger`（Task 4 定義與使用）；`expectTouchTargets`、`login`（Task 1 定義，Task 2–6 使用）；`CategoryDonut`（Task 5）；`TrendMetric`、`TREND_METRICS`、`TREND_METRIC_ORDER`、`TrendChart` 的 `metric`／`today`（Task 6 定義與使用）；`.trend-bar-today`（Task 1 定義，Task 6 使用）。
