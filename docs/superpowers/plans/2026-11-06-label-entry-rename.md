# 拍營養標示的入口、改名「吃什麼」與新圖示、掃條碼重試 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 記一餐／編輯這一餐／食物庫多一顆「拍營養標示」（拍完到新增食物、一進去就手機辨識）；app 改名「吃什麼」、換新圖示；掃條碼的 ponyfill 載入失敗後下一次會重新載。

**Architecture:** 照片沿用總覽「拍照記」的一格暫存（抽成 `lib/photo-stash.ts`），router state 只帶號碼；新增食物的交接（`lib/new-food-handoff.ts`）多認「有照片」的那一種，`LabelReader` 多一個掛載時讀的 `initialPhoto`。圖示從 `public/icon.svg` 用 Playwright Chromium 產生 PNG（進 git）。重試靠 zxing 公開的 `purgeZXingModule()`。

**Tech Stack:** React 19、react-router 8、TanStack Query、Vitest＋Testing Library、Playwright、vite-plugin-pwa、Biome（tab 縮排）。

**規格：** `docs/superpowers/specs/2026-11-06-label-entry-rename-design.md`（決定編號 D1–D16，註解裡引用寫「改名規格 Dn」）。

**共通規矩（每個 task 都適用）：**
- 工作目錄 `F:\wallet`（git repo）；前端指令在 `F:\wallet\frontend` 跑。分支 `feat/label-entry-rename`（已經開好）。
- **絕對不要 `git add` repo 根目錄的 `lunch.jpg`**（使用者的檔案）。只 add 你改的檔案，不要 `git add -A`／`git add .`。
- commit 訊息用中文、`feat(frontend): …`／`fix(frontend): …`／`docs: …`，最後一行空一行接 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`。
- 註解與測試名稱用中文，風格照周圍的檔案（說「為什麼」，引用規格編號）。
- 每個 task 結束前：`cd frontend && npm run lint && npm run typecheck && npx vitest run <這個 task 碰到的測試檔>` 都要過。
- e2e 需要 dev 伺服器與後端（`docker compose` 的開發環境）；`npx playwright test <檔案>` 會自己起 Vite（見 `playwright.config.ts`）。後端沒起來的話先 `cd F:\wallet && docker compose up -d`（**不要** `down -v`）。

---

## File Structure

| 檔案 | 動作 | 責任 |
|---|---|---|
| `frontend/src/lib/barcode-ponyfill.ts` | 改 | 失敗時 `purgeZXingModule()`；每次載入清 `loadLog` |
| `frontend/tests/barcode-ponyfill.test.ts` | 改 | 重試的單元測試 |
| `frontend/e2e/barcode.spec.ts` | 改 | wasm 失敗 → 放行 → 再開一次會重新載 |
| `frontend/src/lib/photo-stash.ts` | 新 | 一格的照片暫存（號碼換檔案） |
| `frontend/src/lib/quick-actions.ts` | 改 | 照片的三個函式改用 `photo-stash` |
| `frontend/src/lib/new-food-handoff.ts` | 改 | `labelPhotoState`；交接多 `labelPhoto` |
| `frontend/tests/photo-stash.test.ts` | 新 | |
| `frontend/tests/new-food-handoff.test.ts` | 改 | |
| `frontend/src/components/LabelReader.tsx` | 改 | `initialPhoto`（掛載時辨識） |
| `frontend/src/screens/NewFood.tsx` | 改 | 把照片交給 `LabelReader`；條碼提示只給條碼來的 |
| `frontend/src/App.tsx` | 改 | `NewFoodRoute` 放掉暫存；`LogMealRoute` 的 `onLabelPhoto` |
| `frontend/tests/label-reader.test.tsx`、`frontend/tests/new-food-barcode.test.tsx` | 改 | |
| `frontend/src/components/PhotoPickerButton.tsx` | 改 | 選填的 `describedBy` |
| `frontend/src/components/LabelPhotoEntry.tsx`＋`.module.css` | 新 | 「拍營養標示」入口（按鈕＋說明） |
| `frontend/src/components/FoodPicker.tsx` | 改 | `onLabelPhoto` |
| `frontend/src/screens/LogMeal.tsx`、`EditMealItems.tsx`、`FoodLibrary.tsx` | 改 | 接上入口 |
| `frontend/tests/food-picker.test.tsx`、`log-meal-barcode.test.tsx`、`food-library.test.tsx`、`edit-meal.test.tsx` | 改 | |
| `frontend/e2e/label-ocr.spec.ts` | 改 | 記一餐 → 拍營養標示 → 新增食物 → 回來 |
| `frontend/public/icon.svg` | 新 | 圖示原稿 |
| `frontend/scripts/render-icons.mjs` | 新 | SVG → 四個 PNG |
| `frontend/public/apple-touch-icon.png`、`icon-192.png`、`icon-512.png`、`icon-maskable-512.png` | 新／換 | 產生的 |
| `frontend/index.html`、`frontend/vite.config.ts`、`frontend/package.json` | 改 | 名稱、圖示、`npm run icons` |
| `frontend/e2e/app-icon.spec.ts` | 新 | 標題與圖示 |
| `docs/handover.md`、`docs/deployment.md`、`README.md` | 改 | |

---

### Task 1: 掃條碼載入失敗後重試（規格 D15、D16）

**Files:**
- Modify: `frontend/src/lib/barcode-ponyfill.ts`
- Modify: `frontend/tests/barcode-ponyfill.test.ts`
- Modify: `frontend/e2e/barcode.spec.ts`（「偵測器的 wasm 抓不到」那一條，約 468–517 行）

背景：zxing-wasm 的 `prepareZXingModule` 把 `[overrides, promise]` 存在模組層的 WeakMap，`fireImmediately: true` 時 overrides 淺比較相等就**直接回同一個 promise——被拒絕的也一樣**。`purgeZXingModule()`（`barcode-detector/ponyfill` 有匯出、有型別）刪掉那一筆，下一次呼叫就重新 instantiate。`useBarcodeScanner` 每次掃描層掛載都重新 `loadDetector()`，所以清掉之後「下一次按掃條碼」就是重新載。

- [ ] **Step 1: 改單元測試（先失敗）**

`frontend/tests/barcode-ponyfill.test.ts`：

1. hoisted 物件多一個 `purgeZXingModule: vi.fn()`，`vi.mock("barcode-detector/ponyfill", …)` 回傳裡加 `purgeZXingModule: zxing.purgeZXingModule`，`beforeEach` 裡 `zxing.purgeZXingModule.mockReset();`。
2. 第一條（成功）最後加：`expect(zxing.purgeZXingModule).not.toHaveBeenCalled();`
3. 「wasm 載不起來：丟出去…」那一條最後加：`expect(zxing.purgeZXingModule).toHaveBeenCalledTimes(1);`
4. **整條換掉**「zxing 記住了失敗、第二次沒有再印：第二次的錯誤照樣帶著第一次印的那幾行」（行為換了），換成：

```ts
	it("載不起來：清掉 zxing 記住的模組，下一次真的重新載；第二次的錯誤只帶第二次印的（改名規格 D15）", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		let attempt = 0;
		zxing.prepareZXingModule.mockImplementation(
			async (options: { overrides: { printErr: (text: string) => void } }) => {
				attempt += 1;
				options.overrides.printErr(`attempt ${attempt} printed`);
				throw new Error(`Aborted(attempt ${attempt})`);
			},
		);
		const { createPonyfillDetector } = await realPonyfill();

		await createPonyfillDetector(["ean_13"]).catch(() => {});
		const second = await createPonyfillDetector(["ean_13"]).catch(
			(caught: unknown) => caught as Error,
		);

		expect(zxing.prepareZXingModule).toHaveBeenCalledTimes(2);
		expect(zxing.purgeZXingModule).toHaveBeenCalledTimes(2);
		expect(second.message).toContain("Aborted(attempt 2)");
		expect(second.message).toContain("attempt 2 printed");
		expect(second.message).not.toContain("attempt 1 printed");
		vi.mocked(console.warn).mockRestore();
	});

	it("失敗之後再載成功：建得出偵測器", async () => {
		zxing.prepareZXingModule
			.mockRejectedValueOnce(new Error("Aborted(network)"))
			.mockResolvedValueOnce({});
		const { createPonyfillDetector } = await realPonyfill();

		await expect(createPonyfillDetector(["ean_13"])).rejects.toThrow(
			"Aborted(network)",
		);
		await expect(createPonyfillDetector(["ean_13"])).resolves.toBeDefined();
		expect(zxing.constructed).toEqual([["ean_13"]]);
	});
```

注意：`realPonyfill()` 用 `vi.importActual`，同一個測試檔裡模組是同一份（`loadLog` 是模組層的）——新的實作每次載入前清 `loadLog`，所以測試之間互不影響。

- [ ] **Step 2: 跑，確認失敗**

Run: `cd frontend && npx vitest run tests/barcode-ponyfill.test.ts`
Expected: 新的兩條與「wasm 載不起來」那條 FAIL（`purgeZXingModule` 沒被叫、第二次的訊息帶著 attempt 1）。

- [ ] **Step 3: 實作**

`frontend/src/lib/barcode-ponyfill.ts`：

```ts
import {
	BarcodeDetector,
	type BarcodeFormat,
	prepareZXingModule,
	purgeZXingModule,
} from "barcode-detector/ponyfill";
```

`loadLog` 上面的註解最後一句「不在每次載入前清掉：zxing 記住失敗的那次，之後再載直接拿同一個失敗、不再印。」改成：

```ts
 *  每一次載入前清掉：失敗時會清掉 zxing 記住的模組（`createPonyfillDetector`），下一次是重新載、重新印。 */
```

`createPonyfillDetector`：

```ts
export async function createPonyfillDetector(
	formats: readonly BarcodeFormat[],
): Promise<Detector> {
	loadLog.length = 0;
	try {
		await prepareZXingModule({ overrides: OVERRIDES, fireImmediately: true });
	} catch (error) {
		// zxing 把被拒絕的 promise 留在快取裡：之後每一次（包括 detect()）都拿同一個失敗，暫時的失敗
		// （網路剛好斷一下）變成要整個關掉 app 才好。清掉它，下一次打開掃描層就是重新載（改名規格 D15）。
		purgeZXingModule();
		const message = error instanceof Error ? error.message : String(error);
		const wrapped = new Error([message, ...loadLog].join("\n"), {
			cause: error,
		});
		if (error instanceof Error) wrapped.name = error.name;
		throw wrapped;
	}
	return new BarcodeDetector({ formats: [...formats] });
}
```

函式上面的 doc 註解最後加一句：「失敗時清掉 zxing 記住的模組（改名規格 D15）：下一次打開掃描層重新載，不是一直拿同一個失敗。」

- [ ] **Step 4: 跑，確認通過**

Run: `cd frontend && npx vitest run tests/barcode-ponyfill.test.ts tests/barcode-detector.test.ts tests/barcode-scanner.test.tsx`
Expected: 全過。

- [ ] **Step 5: e2e——放行之後再開一次會重新載**

`frontend/e2e/barcode.spec.ts` 的「偵測器的 wasm 抓不到」那一條：

1. 測試名稱改成 `"偵測器的 wasm 抓不到：只剩手動輸入，「技術細節」帶著 zxing 印的原因；放行之後再開一次會重新載"`。
2. 把 route 的判斷抽成常數（`unroute` 要同一個函式），放在 `page.route` 前面：

```ts
	// 只擋抓 wasm 本身的那一個：dev 的 `?url` 匯入（`zxing_reader.wasm?import&url`）是模組，
	// 擋了它是整個 ponyfill 載不起來，不是 zxing 抓不到 wasm。
	const isWasm = (url: URL) =>
		url.search === "" && /zxing_reader[^/]*\.wasm$/.test(url.pathname);
	const blockWasm = (route: Route) => route.fulfill({ status: 404, body: "" });
	await page.route(isWasm, blockWasm);
```

（`Route` 從 `@playwright/test` import：`import { expect, type Page, type Route, test } from "@playwright/test";`）

3. 測試最後（「手動輸入條碼」那個斷言之後）加：

```ts
	// 重試（改名規格 D15、D16）：關掉、放行 wasm、再按「掃條碼」→ 真的重新抓 wasm、這次載得起來。
	// 相機在這個測試裡是「沒有」，所以是那一句，「從照片讀」也回來了。以前 zxing 記住了失敗：
	// 不會再抓、一直是「不能用相機掃條碼」，要整個關掉 app 才好。
	await dialog.getByRole("button", { name: "取消", exact: true }).click();
	await expect(dialog).toHaveCount(0);
	await page.unroute(isWasm, blockWasm);
	const wasmLoaded = page.waitForResponse(
		(response) => isWasm(new URL(response.url())) && response.status() === 200,
	);
	await page.getByRole("button", { name: "掃條碼", exact: true }).click();
	await wasmLoaded;
	await expect(dialog.getByRole("status")).toHaveText(
		"找不到可以用的相機。可以手動輸入條碼，或從照片讀。",
	);
	await expect(dialog.locator('label[for="barcode-photo"]')).toHaveCount(1);
	await expect(dialog.getByText("技術細節", { exact: true })).toHaveCount(0);
```

如果「取消」之後焦點／掃描層的名字跟這裡寫的不同，以 `src/components/BarcodeScanner.tsx` 為準調整選擇器（不要改元件）。

- [ ] **Step 6: 跑 e2e（含先拿掉修正、確認它會失敗）**

先暫時把 `purgeZXingModule();` 那一行註解掉，跑：
`cd frontend && npx playwright test e2e/barcode.spec.ts -g "wasm 抓不到"`
Expected: FAIL（`waitForResponse` 逾時——沒有再抓 wasm）。
還原那一行，再跑同一個指令 → PASS。整個檔案也跑一次：`npx playwright test e2e/barcode.spec.ts` → 全過。

- [ ] **Step 7: Commit**

```bash
git add frontend/src/lib/barcode-ponyfill.ts frontend/tests/barcode-ponyfill.test.ts frontend/e2e/barcode.spec.ts
git commit -m "fix(frontend): 掃條碼的偵測器載入失敗後，下一次打開會重新載（清掉 zxing 記住的失敗）

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: 照片暫存抽出來、新增食物的交接認「拍營養標示」的照片（規格 D3、D4）

**Files:**
- Create: `frontend/src/lib/photo-stash.ts`
- Create: `frontend/tests/photo-stash.test.ts`
- Modify: `frontend/src/lib/quick-actions.ts`（照片那三個函式，約 25–55 行）
- Modify: `frontend/src/lib/new-food-handoff.ts`
- Modify: `frontend/tests/new-food-handoff.test.ts`
- Modify: `frontend/tests/new-food-barcode.test.tsx`（`handoff()` 輔助函式加 `labelPhoto: null`）

- [ ] **Step 1: 寫 `photo-stash` 的測試（先失敗）**

`frontend/tests/photo-stash.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import {
	releaseStashedPhoto,
	stashedPhoto,
	stashPhoto,
} from "../src/lib/photo-stash";

function photo(name: string) {
	return new File(["x"], name, { type: "image/jpeg" });
}

describe("照片暫存（改名規格 D3；同總覽「拍照記」）", () => {
	it("號碼換回同一個 File；讀了不清掉（StrictMode 的初值函式跑兩次）", () => {
		const file = photo("a.jpg");
		const id = stashPhoto(file);
		expect(stashedPhoto(id)).toBe(file);
		expect(stashedPhoto(id)).toBe(file);
	});

	it("一次只留一張：舊的號碼換不到新的照片", () => {
		const first = stashPhoto(photo("a.jpg"));
		const second = photo("b.jpg");
		const secondId = stashPhoto(second);
		expect(secondId).not.toBe(first);
		expect(stashedPhoto(first)).toBeNull();
		expect(stashedPhoto(secondId)).toBe(second);
	});

	it("放掉之後換不到；號碼不是數字就是 null", () => {
		const id = stashPhoto(photo("a.jpg"));
		releaseStashedPhoto();
		expect(stashedPhoto(id)).toBeNull();
		const next = stashPhoto(photo("b.jpg"));
		for (const bad of [null, undefined, String(next), {}, Number.NaN]) {
			expect(stashedPhoto(bad)).toBeNull();
		}
	});
});
```

- [ ] **Step 2: 跑，確認失敗**

Run: `cd frontend && npx vitest run tests/photo-stash.test.ts`
Expected: FAIL（找不到模組）。

- [ ] **Step 3: 建 `photo-stash.ts`、`quick-actions.ts` 改用它**

`frontend/src/lib/photo-stash.ts`：

```ts
/** 一張照片從一頁帶到下一頁：總覽的「拍照記」→ 記一餐（首頁改版規格 D8）、「拍營養標示」→ 新增食物
 *  （改名規格 D3）。**`File` 不放進 history**：`history.state` 會被結構化複製（Firefox 有大小上限），
 *  重新整理還會把舊照片帶回來。state 只帶號碼，檔案留在這個模組的記憶體裡、一次只留一張——重新整理
 *  （模組重新載入）就沒有了，刻意。一格就夠：一次只會有一張照片在路上。 */
let stash: { id: number; file: File } | null = null;
let nextId = 1;

export function stashPhoto(file: File): number {
	const id = nextId;
	nextId += 1;
	stash = { id, file };
	return id;
}

/** 號碼對得上才回檔案：舊的 history（上一頁回到更早的那一頁）帶著舊號碼，換不到後來那一張。
 *  **讀了不清掉**：`useState` 的初值函式在 StrictMode 會被呼叫兩次，清掉的話其中一次拿到 null。
 *  清的時機是接手的那一頁清 history 的 state 那一刻（`releaseStashedPhoto`）。 */
export function stashedPhoto(id: unknown): File | null {
	return typeof id === "number" && stash !== null && stash.id === id
		? stash.file
		: null;
}

/** 放掉暫存的照片（已經交給下一頁自己的 state）：不留著一張可能好幾 MB 的檔案。 */
export function releaseStashedPhoto(): void {
	stash = null;
}
```

`frontend/src/lib/quick-actions.ts`：刪掉模組層的 `stash`、`nextId` 與照片那三個函式的本體，改成（doc 註解縮短成指向 `photo-stash`）：

```ts
import { releaseStashedPhoto, stashedPhoto, stashPhoto } from "./photo-stash";

/** 拍照記的照片（D8）：檔案在 `lib/photo-stash` 的暫存裡，state 只帶號碼。 */
export function stashQuickPhoto(file: File): { quickPhoto: number } {
	return { quickPhoto: stashPhoto(file) };
}

/** 號碼對得上才回檔案（見 `stashedPhoto`）。 */
export function quickPhotoFrom(state: unknown): File | null {
	return isRecord(state) ? stashedPhoto(state.quickPhoto) : null;
}

/** 放掉暫存的照片（照片已經交給記一餐自己的 state）。 */
export function releaseQuickPhoto(): void {
	releaseStashedPhoto();
}
```

（`import` 放在檔案最上面；`isRecord` 照舊。）

- [ ] **Step 4: 跑，確認通過（含既有的 quick-actions 測試）**

Run: `cd frontend && npx vitest run tests/photo-stash.test.ts tests/quick-actions.test.ts`
Expected: 全過。

- [ ] **Step 5: 交接的測試（先失敗）**

`frontend/tests/new-food-handoff.test.ts`：

1. import 多 `labelPhotoState`，以及 `import { releaseStashedPhoto } from "../src/lib/photo-stash";`。
2. 既有的 `toEqual({ barcode…, prefill…, returnTo… })` 全部加 `labelPhoto: null`。
3. 加一個 describe：

```ts
describe("newFoodHandoffFrom：拍營養標示帶來的照片（改名規格 D4）", () => {
	const photo = () => new File(["x"], "label.jpg", { type: "image/jpeg" });

	it("照片＋回去的地方：沒有條碼、沒有預填", () => {
		const file = photo();
		expect(newFoodHandoffFrom(labelPhotoState(file, "/meals/new"))).toEqual({
			barcode: null,
			prefill: null,
			labelPhoto: file,
			returnTo: "/meals/new",
		});
	});

	it("食物庫來的：沒有 returnTo；returnTo 照樣走白名單", () => {
		const file = photo();
		expect(newFoodHandoffFrom(labelPhotoState(file, null))?.returnTo).toBeNull();
		expect(
			newFoodHandoffFrom(labelPhotoState(file, "/foods/1"))?.returnTo,
		).toBeNull();
	});

	it("號碼換不到照片（重新整理、舊的 history）→ 沒有交接", () => {
		const state = labelPhotoState(photo(), "/meals/new");
		releaseStashedPhoto();
		expect(newFoodHandoffFrom(state)).toBeNull();
		expect(newFoodHandoffFrom({ labelPhoto: "1", returnTo: "/meals/new" })).toBeNull();
	});

	it("state 只帶號碼，不帶 File", () => {
		const state = labelPhotoState(photo(), null);
		expect(Object.keys(state).sort()).toEqual(["labelPhoto", "returnTo"]);
		expect(typeof state.labelPhoto).toBe("number");
	});
});
```

`frontend/tests/new-food-barcode.test.tsx` 的 `handoff()`：回傳物件加 `labelPhoto: null,`（在 `returnTo` 前面）。

- [ ] **Step 6: 跑，確認失敗**

Run: `cd frontend && npx vitest run tests/new-food-handoff.test.ts`
Expected: FAIL（`labelPhotoState` 不存在、少了 `labelPhoto`）。

- [ ] **Step 7: 實作交接**

`frontend/src/lib/new-food-handoff.ts`：

```ts
import { stashedPhoto, stashPhoto } from "./photo-stash";

export type NewFoodHandoff = {
	barcode: string | null;
	prefill: BarcodePrefill | null;
	/** 「拍營養標示」選好的照片（改名規格 D4）：新增食物一進去就在手機上辨識它。 */
	labelPhoto: File | null;
	returnTo: string | null;
};

/** 「拍營養標示」帶給 `/foods/new` 的 router state（改名規格 D3、D4）：照片進暫存，state 只帶號碼。 */
export function labelPhotoState(file: File, returnTo: string | null) {
	return { labelPhoto: stashPhoto(file), returnTo };
}
```

`newFoodHandoffFrom` 改成（doc 註解補一句「或『拍營養標示』的照片（號碼換不到就整個不要）」）：

```ts
export function newFoodHandoffFrom(state: unknown): NewFoodHandoff | null {
	if (typeof state !== "object" || state === null) return null;
	const s = state as Record<string, unknown>;
	const returnTo = returnToFrom(s.returnTo);
	if (
		typeof s.barcodeCode === "string" &&
		/^(\d{8}|\d{13})$/.test(s.barcodeCode)
	) {
		return {
			barcode: s.barcodeCode,
			prefill: isPrefill(s.barcodePrefill) ? s.barcodePrefill : null,
			labelPhoto: null,
			returnTo,
		};
	}
	const labelPhoto = stashedPhoto(s.labelPhoto);
	return labelPhoto === null
		? null
		: { barcode: null, prefill: null, labelPhoto, returnTo };
}
```

- [ ] **Step 8: 跑**

Run: `cd frontend && npx vitest run tests/new-food-handoff.test.ts tests/new-food-barcode.test.tsx tests/quick-actions.test.ts tests/photo-stash.test.ts && npm run typecheck`
Expected: 全過（`typecheck` 會抓到其他地方手寫的 `NewFoodHandoff` 物件——有的話補 `labelPhoto: null`）。

- [ ] **Step 9: Commit**

```bash
git add frontend/src/lib/photo-stash.ts frontend/src/lib/quick-actions.ts frontend/src/lib/new-food-handoff.ts frontend/tests/photo-stash.test.ts frontend/tests/new-food-handoff.test.ts frontend/tests/new-food-barcode.test.tsx
git commit -m "feat(frontend): 新增食物的交接認「拍營養標示」的照片（照片暫存抽成 photo-stash）

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: 新增食物一進去就辨識帶來的照片（規格 D6、D7、D8、D9）

**Files:**
- Modify: `frontend/src/components/LabelReader.tsx`
- Modify: `frontend/src/screens/NewFood.tsx`（`<LabelReader …>` 約 353 行；條碼提示約 329 行）
- Modify: `frontend/src/App.tsx`（`NewFoodRoute`）
- Modify: `frontend/tests/label-reader.test.tsx`
- Modify: `frontend/tests/new-food-barcode.test.tsx`

- [ ] **Step 1: `LabelReader` 的測試（先失敗）**

`frontend/tests/label-reader.test.tsx`：`renderReader` 改成收一個選填的照片：

```tsx
function renderReader(initialPhoto?: File) {
	const onFill = vi.fn();
	const client = new QueryClient({
		defaultOptions: { mutations: { retry: false } },
	});
	const view = render(
		<QueryClientProvider client={client}>
			<LabelReader onFill={onFill} initialPhoto={initialPhoto} />
		</QueryClientProvider>,
	);
	return { onFill, ...view };
}
```

在「LabelReader：拍營養標示」describe 的最後加：

```tsx
	it("initialPhoto（記一餐、食物庫的「拍營養標示」帶來的）：掛上就在手機上辨識；讀完整交給表單（改名規格 D7）", async () => {
		vi.mocked(recognizeLabel).mockResolvedValue("營養標示\n熱量 514 大卡");
		mockApi([
			{ method: "POST", path: PARSE, handler: () => json(COMPLETE_PARSE) },
		]);
		const photo = JPEG();
		const { onFill } = renderReader(photo);

		expect(await screen.findByText("手機辨識的數字，請對照包裝確認")).toBeInTheDocument();
		expect(recognizeLabel).toHaveBeenCalledTimes(1);
		expect(vi.mocked(recognizeLabel).mock.calls[0]?.[0]).toBe(photo);
		expect(onFill).toHaveBeenCalledExactlyOnceWith(COMPLETE_FILL);
	});

	it("initialPhoto 辨識中：跟選了照片一樣是卡片＋「手機辨識中…」，焦點在卡片", async () => {
		const pending = deferred<string>();
		vi.mocked(recognizeLabel).mockReturnValue(pending.promise);
		mockApi([]);
		renderReader(JPEG());

		await waitFor(() => expect(card()).toHaveFocus());
		expect(within(card()).getByText("手機辨識中…")).toBeInTheDocument();
		expect(picker()).toBeDisabled();
		pending.resolve("");
	});

	it("initialPhoto 太大：照舊在按鈕下面說，不出卡片、不辨識", async () => {
		mockApi([]);
		const big = JPEG();
		Object.defineProperty(big, "size", { value: MAX_PHOTO_BYTES + 1 });
		renderReader(big);

		expect(await screen.findByRole("alert")).toHaveTextContent("照片超過");
		expect(
			screen.queryByRole("region", { name: "確認照片" }),
		).not.toBeInTheDocument();
		expect(recognizeLabel).not.toHaveBeenCalled();
	});
```

（「手機辨識中…」的文字以元件現在的寫法為準——看既有的「辨識中」那一條怎麼找它，照抄那個查法。）

- [ ] **Step 2: 跑，確認失敗**

Run: `cd frontend && npx vitest run tests/label-reader.test.tsx`
Expected: 新的三條 FAIL（沒有 `initialPhoto`）。

- [ ] **Step 3: 實作 `initialPhoto`**

`frontend/src/components/LabelReader.tsx`：

1. `Props` 加：

```ts
	/** 一進來就辨識的照片：記一餐、食物庫的「拍營養標示」帶來的（改名規格 D7）。**只在掛載時讀**——
	 *  跟在這裡選了一張照片走同一段（太大就擋、否則出卡片、自動手機辨識）。 */
	initialPhoto?: File;
```

元件簽名 `export function LabelReader({ onFill, initialPhoto }: Props)`。

2. 把 `handlePick` 裡「拿到檔案之後」的那段抽成 `startPhoto(file: File)`，`handlePick` 只負責從 input 拿檔案、清值：

```ts
	function startPhoto(file: File) {
		// 太大在選的當下就擋（照片說明規格 D9）；卡片開著時不動它，只說這一張太大（審查 M2）。
		if (file.size > MAX_PHOTO_BYTES) {
			setPickError(new PhotoTooLargeError().message);
			return;
		}
		setPickError(null);
		readLabelMutation.reset();
		setApplied(null);
		// 換一張照片：說明留著（多半是同一個包裝、只是拍糊了）。
		const photo = { file, hint: pending?.hint ?? "" };
		setPending(photo);
		focusNextRef.current = "step";
		void runOcr(photo);
	}

	function handlePick(event: ChangeEvent<HTMLInputElement>) {
		const file = event.target.files?.[0] ?? null;
		// 清掉：同一張照片再選一次也要觸發 change。
		event.target.value = "";
		if (file !== null) startPhoto(file);
	}
```

3. 掛載時（放在 `startPhoto` 定義之後、`return` 之前）：

```ts
	// 帶來的照片（改名規格 D7、D8）：掛上就走「選了一張照片」那一段。StrictMode 的「掛、卸、再掛」：
	// 卸載時上面那個 effect 中止辨識，再掛時這裡重新開始（`runOcr` 一開始也會中止前一次），只有最後
	// 那一次的結果會用。ref：只在掛載時讀，之後 prop 變了也不重跑。
	const initialPhotoRef = useRef(initialPhoto);
	// biome-ignore lint/correctness/useExhaustiveDependencies: 只在掛載時讀帶來的照片（startPhoto 每次 render 都是新的函式）
	useEffect(() => {
		const file = initialPhotoRef.current;
		if (file !== undefined) startPhoto(file);
	}, []);
```

如果 Biome 對這個 suppression 說「沒有要壓的診斷」（`suppressions/unused`），就把那行 `biome-ignore` 拿掉；以 `npm run lint` 為準。

4. 元件的 doc 註解（「新增食物的『拍營養標示』與…」那段）最後加一句：「記一餐、食物庫的『拍營養標示』選好的照片從 `initialPhoto` 進來，掛上就辨識（改名規格 D7）。」

- [ ] **Step 4: 跑**

Run: `cd frontend && npx vitest run tests/label-reader.test.tsx`
Expected: 全過（既有的全部照過）。

- [ ] **Step 5: `NewFood` 的測試（先失敗）**

`frontend/tests/new-food-barcode.test.tsx` 加一個 describe（用檔案裡既有的 `wrap`、`handoff`、`JPEG`、`COMPLETE_PARSE`、`mockApi`、`json`、`recognizeLabel`）：

```tsx
describe("新增食物：「拍營養標示」帶來的照片（改名規格 D4、D7、D9）", () => {
	it("一進來就在手機上辨識那張照片、數字填好；沒有「找不到這個條碼」那句", async () => {
		vi.mocked(recognizeLabel).mockResolvedValue("營養標示\n熱量 514 大卡");
		mockApi([
			{
				method: "POST",
				path: "/api/foods/parse-label-text",
				handler: () => json(COMPLETE_PARSE),
			},
		]);
		const photo = JPEG();
		render(
			wrap(
				<NewFood
					handoff={handoff({
						barcode: null,
						labelPhoto: photo,
						returnTo: "/meals/new",
					})}
				/>,
			),
		);

		expect(
			await screen.findByText("手機辨識的數字，請對照包裝確認"),
		).toBeInTheDocument();
		expect(vi.mocked(recognizeLabel).mock.calls[0]?.[0]).toBe(photo);
		expect(screen.getByLabelText("熱量（每 100 單位 kcal）")).toHaveValue("514.00");
		expect(
			screen.queryByText("找不到這個條碼的資料。拍營養標示讀數字，或自己填。"),
		).not.toBeInTheDocument();
		expect(screen.getByLabelText("條碼")).toHaveValue("");
		expect(
			screen.getByRole("button", { name: "取消，回到記一餐" }),
		).toBeInTheDocument();
	});
});
```

（`handoff()` 的預設 `barcode` 是條碼——這裡明確傳 `barcode: null`。「條碼」欄位、「取消，回到記一餐」的實際可及名稱照 `NewFood.tsx` 與檔案裡既有的測試；名稱不同就照實際的改。`recognizeLabel` 的 mock 每個測試前要 reset 的話，照檔案裡既有的 `beforeEach` 做。）

- [ ] **Step 6: 跑，確認失敗**

Run: `cd frontend && npx vitest run tests/new-food-barcode.test.tsx`
Expected: 新的那條 FAIL（沒有辨識、出現了「找不到這個條碼」）。

- [ ] **Step 7: 實作 `NewFood` 與 `NewFoodRoute`**

`frontend/src/screens/NewFood.tsx`：

條碼提示（約 329 行）：

```tsx
			{/* 掃到的條碼查不到任何資料（掃條碼規格 §11）：放在「用 AI 填」上面，指出下一步。
			    「拍營養標示」帶照片來的不說（沒有條碼，改名規格 D9）。 */}
			{handoff !== null && handoff.barcode !== null && prefill === null && (
```

`LabelReader`（約 353 行）：

```tsx
				<LabelReader
					onFill={applyLabelFill}
					initialPhoto={handoff?.labelPhoto ?? undefined}
				/>
```

上面那段 JSX 註解補一句：「記一餐、食物庫的『拍營養標示』帶來的照片一進來就辨識（改名規格 D7）。」`Props.handoff` 的 doc 註解改成「掃條碼沒命中（掃條碼規格 D20）或『拍營養標示』（改名規格 D4）帶來的交接：…」。

`frontend/src/App.tsx` 的 `NewFoodRoute`：

```tsx
import { releaseStashedPhoto } from "./lib/photo-stash";
…
	useEffect(() => {
		if (location.state == null) return;
		// 「拍營養標示」的照片已經在新增食物自己的 state 裡（改名規格 D6）：不留著一張可能好幾 MB 的檔案。
		releaseStashedPhoto();
		navigate(`${location.pathname}${location.search}`, {
			replace: true,
			state: null,
		});
	}, [location.state, location.pathname, location.search, navigate]);
```

`NewFoodRoute` 的 doc 註解第一行改成「`/foods/new`：掃條碼沒命中、或『拍營養標示』帶來的交接（…）」。

- [ ] **Step 8: 跑**

Run: `cd frontend && npx vitest run tests/new-food-barcode.test.tsx tests/new-food.test.tsx tests/label-reader.test.tsx && npm run lint && npm run typecheck`
Expected: 全過。

- [ ] **Step 9: Commit**

```bash
git add frontend/src/components/LabelReader.tsx frontend/src/screens/NewFood.tsx frontend/src/App.tsx frontend/tests/label-reader.test.tsx frontend/tests/new-food-barcode.test.tsx
git commit -m "feat(frontend): 新增食物一進去就在手機上辨識「拍營養標示」帶來的照片

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: 記一餐、編輯這一餐、食物庫的「拍營養標示」入口（規格 D1、D2、D5）

**Files:**
- Modify: `frontend/src/components/PhotoPickerButton.tsx`（選填 `describedBy`）
- Create: `frontend/src/components/LabelPhotoEntry.tsx`、`frontend/src/components/LabelPhotoEntry.module.css`
- Modify: `frontend/src/components/FoodPicker.tsx`
- Modify: `frontend/src/screens/LogMeal.tsx`、`frontend/src/App.tsx`（`LogMealRoute`）
- Modify: `frontend/src/screens/EditMealItems.tsx`（`<FoodPicker …>` 約 329 行）
- Modify: `frontend/src/screens/FoodLibrary.tsx`
- Test: `frontend/tests/food-picker.test.tsx`、`frontend/tests/log-meal-barcode.test.tsx`、`frontend/tests/food-library.test.tsx`、`frontend/tests/edit-meal.test.tsx`
- E2E: `frontend/e2e/label-ocr.spec.ts`

- [ ] **Step 1: `FoodPicker` 的測試（先失敗）**

`frontend/tests/food-picker.test.tsx` 加：

```tsx
describe("FoodPicker：拍營養標示（改名規格 D1、D2）", () => {
	const routes = () =>
		mockApi({
			"/api/foods/frequent": () => json([]),
			"/api/foods/recent": () => json([]),
		});

	it("有 onLabelPhoto：「拍營養標示」開後鏡頭、說不用 AI 額度；選好交給 onLabelPhoto", async () => {
		routes();
		const onLabelPhoto = vi.fn();
		render(wrap(<FoodPicker onSelect={vi.fn()} onLabelPhoto={onLabelPhoto} />));

		const input = screen.getByLabelText("拍營養標示");
		expect(input).toHaveAttribute("capture", "environment");
		expect(input).toHaveAttribute("accept", "image/*");
		expect(input).toHaveAccessibleDescription("在手機上讀數字，不用 AI 額度");
		const file = new File(["x"], "label.jpg", { type: "image/jpeg" });
		await userEvent.upload(input, file);

		expect(onLabelPhoto).toHaveBeenCalledExactlyOnceWith(file);
	});

	it("沒有 onLabelPhoto：沒有這顆", () => {
		routes();
		render(wrap(<FoodPicker onSelect={vi.fn()} />));

		expect(screen.queryByLabelText("拍營養標示")).not.toBeInTheDocument();
	});
});
```

- [ ] **Step 2: 跑，確認失敗**

Run: `cd frontend && npx vitest run tests/food-picker.test.tsx`
Expected: FAIL（沒有 `onLabelPhoto`）。

- [ ] **Step 3: `PhotoPickerButton` 的 `describedBy`、`LabelPhotoEntry`、`FoodPicker`**

`frontend/src/components/PhotoPickerButton.tsx`：`Props` 加

```ts
	/** 說明這顆按鈕的那一段字的 id（接在 input 的 `aria-describedby`）。 */
	describedBy?: string;
```

解構多 `describedBy`，`<input>` 加 `aria-describedby={describedBy}`。

`frontend/src/components/LabelPhotoEntry.tsx`：

```tsx
import { type ChangeEvent, useId } from "react";
import styles from "./LabelPhotoEntry.module.css";
import { PhotoPickerButton } from "./PhotoPickerButton";

type Props = {
	/** 選好了一張照片。太大不在這裡擋：新增食物的 `LabelReader` 一進去就擋，跟在那裡選照片同一個地方說
	 *  （改名規格 D7）。 */
	onPhoto: (file: File) => void;
};

/** 「拍營養標示」的入口（改名規格 D1、D2）：記一餐與編輯這一餐的「加一項」（`FoodPicker`）、食物庫。
 *  選好就交給呼叫端帶到新增食物（`labelPhotoState`），那裡一進去就在手機上辨識——不用 AI 額度。
 *
 *  **是檔案選擇的標籤，不是連到新增食物再自動打開相機**：iOS 只在使用者手勢裡開檔案選擇器，導頁之後
 *  程式化 `click()` 會被擋（同總覽的「拍照記」）。說明那一行讓人分得出這條路跟「拍照估算」（AI）不一樣。 */
export function LabelPhotoEntry({ onPhoto }: Props) {
	const id = useId();
	const noteId = `${id}-note`;

	function handleChange(event: ChangeEvent<HTMLInputElement>) {
		const file = event.target.files?.[0];
		// 清掉：同一張再選一次（例如從新增食物取消回來）也要觸發 change。
		event.target.value = "";
		if (file !== undefined) onPhoto(file);
	}

	return (
		<div className={styles.row}>
			<PhotoPickerButton
				id={id}
				label="拍營養標示"
				accept="image/*"
				capture="environment"
				describedBy={noteId}
				onChange={handleChange}
			/>
			<p id={noteId} className={styles.note}>
				在手機上讀數字，不用 AI 額度
			</p>
		</div>
	);
}
```

`frontend/src/components/LabelPhotoEntry.module.css`（同 `BarcodeScanEntry.module.css` 的 `.row`／`.note`）：

```css
/* 「拍營養標示」的入口（LabelPhotoEntry.tsx）。版面同「掃條碼」那一列（BarcodeScanEntry.module.css）：
 * 按鈕＋一行灰色的說明，窄的時候說明換到下一行。 */

.row {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	column-gap: var(--space-3);
	row-gap: var(--space-1);
}

.note {
	flex: 1 1 12em;
	margin: 0;
	font-size: 13px;
	color: var(--color-text-muted);
}
```

`frontend/src/components/FoodPicker.tsx`：`Props` 加

```ts
	/** 「拍營養標示」選好的照片（改名規格 D2）：呼叫端帶到新增食物。不給就沒有這顆。 */
	onLabelPhoto?: (file: File) => void;
```

解構多 `onLabelPhoto`；`<BarcodeScanEntry …/>` 後面：

```tsx
			{onLabelPhoto !== undefined && <LabelPhotoEntry onPhoto={onLabelPhoto} />}
```

（import `LabelPhotoEntry`。）

- [ ] **Step 4: 跑**

Run: `cd frontend && npx vitest run tests/food-picker.test.tsx`
Expected: 全過。

- [ ] **Step 5: 記一餐、編輯這一餐、食物庫的測試（先失敗）**

`frontend/tests/log-meal-barcode.test.tsx`（用檔案裡的 `routes`、`wrap`）：

```tsx
describe("記一餐：拍營養標示（改名規格 D2）", () => {
	it("入口在掃條碼下面；選好照片交給 onLabelPhoto", async () => {
		routes();
		const onLabelPhoto = vi.fn();
		render(wrap(<LogMeal onSaved={vi.fn()} onLabelPhoto={onLabelPhoto} />));

		const scan = screen.getByRole("button", { name: "掃條碼" });
		const input = screen.getByLabelText("拍營養標示");
		expect(
			scan.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
		const file = new File(["x"], "label.jpg", { type: "image/jpeg" });
		await userEvent.upload(input, file);
		expect(onLabelPhoto).toHaveBeenCalledExactlyOnceWith(file);
	});
});
```

`frontend/tests/food-library.test.tsx`：照檔案裡既有「掃條碼沒命中 → 新增食物」那一條的寫法（`MemoryRouter`＋一個看 `location.state` 的假 `/foods/new` 頁），加一條：選好照片 → 到 `/foods/new`、`newFoodHandoffFrom(location.state)` 的 `labelPhoto` 是那個檔案、`returnTo` 是 `null`、是 push（假頁面上「返回」回到食物庫）。斷言 state 的方式：

```tsx
import { newFoodHandoffFrom } from "../src/lib/new-food-handoff";
…
		expect(newFoodHandoffFrom(seenState)?.labelPhoto).toBe(file);
		expect(newFoodHandoffFrom(seenState)?.returnTo).toBeNull();
```

（`seenState` 由假頁面記下：`const location = useLocation(); seen.state = location.state;`——照該檔案已有的探針寫法。）

`frontend/tests/edit-meal.test.tsx` 的「編輯這一餐：掃條碼建立食物再回來」describe 加一條（用那裡的 `renderWith`、`NewFoodProbe`、`routes`）：打開「＋ 加一項」→ 在「加一項」表單裡 `userEvent.upload(within(form).getByLabelText("拍營養標示"), file)` → 看到「新增食物頁」、`data-testid="state"` 的 JSON 有 `"returnTo":"/meals/5/edit"` 與數字的 `labelPhoto`；按「返回」→ 回到「飲食頁」（replace：這一餐那一筆被換掉了）。

- [ ] **Step 6: 跑，確認失敗**

Run: `cd frontend && npx vitest run tests/log-meal-barcode.test.tsx tests/food-library.test.tsx tests/edit-meal.test.tsx`
Expected: 新的三條 FAIL。

- [ ] **Step 7: 接上入口**

`frontend/src/screens/LogMeal.tsx`：`Props` 加

```ts
	/** 「拍營養標示」選好的照片（改名規格 D2）。導頁由 `LogMealRoute` 做（`replace`、帶 `returnTo`，
	 *  同 `onCreateFromBarcode`）：這個元件不碰 router。 */
	onLabelPhoto?: (file: File) => void;
```

解構多 `onLabelPhoto`，`<FoodPicker … onLabelPhoto={onLabelPhoto} …>`。

`frontend/src/App.tsx` 的 `LogMealRoute`（import `labelPhotoState`）：

```tsx
			// 「拍營養標示」（改名規格 D5）：同「用這個條碼建立食物」，去與回都 `replace`。
			onLabelPhoto={(file) =>
				navigate("/foods/new", {
					replace: true,
					state: labelPhotoState(file, "/meals/new"),
				})
			}
```

`frontend/src/screens/EditMealItems.tsx` 的 `<FoodPicker>`（import `labelPhotoState`）：

```tsx
				onLabelPhoto={(file) =>
					navigate("/foods/new", {
						replace: true,
						state: labelPhotoState(file, `/meals/${mealId}/edit`),
					})
				}
```

`frontend/src/screens/FoodLibrary.tsx`：`<BarcodeScanEntry …/>` 後面（import `LabelPhotoEntry`、`labelPhotoState`）：

```tsx
			{/* 拍營養標示（改名規格 D2、D5）：一般的 push、沒有 returnTo——存好照舊到詳情頁。 */}
			<LabelPhotoEntry
				onPhoto={(file) =>
					navigate("/foods/new", { state: labelPhotoState(file, null) })
				}
			/>
```

- [ ] **Step 8: 跑**

Run: `cd frontend && npx vitest run tests/log-meal-barcode.test.tsx tests/food-library.test.tsx tests/edit-meal.test.tsx tests/food-picker.test.tsx tests/log-meal.test.tsx && npm run lint && npm run typecheck`
Expected: 全過。

- [ ] **Step 9: e2e——記一餐 → 拍營養標示 → 新增食物 → 回來**

`frontend/e2e/label-ocr.spec.ts` 加（檔案裡已有 `LABEL_PHOTO`、`expectValues`、`loginAs`、`newAccount`）：

```ts
async function openLogMeal(page: Page) {
	await page.getByRole("button", { name: "新增紀錄", exact: true }).click();
	await page.getByRole("link", { name: "記一餐", exact: true }).click();
	await expect(
		page.getByRole("heading", { name: "記一餐", exact: true }),
	).toBeVisible();
}

test("記一餐的「拍營養標示」：拍完到新增食物、一進去就手機辨識 → 建立 → 回到記一餐、選好那個食物（改名規格 §2.1 A）", async ({
	page,
	request,
}) => {
	test.setTimeout(60_000);
	const account = await newAccount(request, "label-entry");
	const ai: string[] = [];
	await page.route("**/api/ai/**", async (route) => {
		ai.push(route.request().url());
		await route.abort();
	});
	await loginAs(page, account);
	await openLogMeal(page);

	const entry = page.getByLabel("拍營養標示", { exact: true });
	await expect(entry).toHaveAttribute("capture", "environment");
	await expectTouchTargets(
		page.locator("label").filter({ hasText: "拍營養標示" }),
		"記一餐：拍營養標示",
	);
	await entry.setInputFiles(LABEL_PHOTO);

	await expect(
		page.getByRole("heading", { name: "新增食物", exact: true }),
	).toBeVisible();
	await expect(
		page.getByText("手機辨識的數字，請對照包裝確認", { exact: true }),
	).toBeVisible({ timeout: 30_000 });
	await expectValues(page, ["514.00", "6.00", "28.00", "60.90"]);
	await expect(
		page.getByText("找不到這個條碼的資料。拍營養標示讀數字，或自己填。"),
	).toHaveCount(0);

	const name = `E2E 記一餐拍標示 ${Date.now()}`;
	await page.getByLabel("名稱", { exact: true }).fill(name);
	await page.getByRole("button", { name: "建立食物", exact: true }).click();

	await expect(
		page.getByRole("heading", { name: "記一餐", exact: true }),
	).toBeVisible();
	await expect(page.getByText(`已選擇：${name}`, { exact: true })).toBeVisible();
	expect(ai).toEqual([]);
});
```

（`expectTouchTargets` 要從 `./touch-targets.ts` import——檔案已經 import 了就沿用。「已選擇：…」的實際文字以 `LogMeal.tsx` 為準。）

Run: `cd frontend && npx playwright test e2e/label-ocr.spec.ts`
Expected: 全過。

- [ ] **Step 10: Commit**

```bash
git add frontend/src/components/PhotoPickerButton.tsx frontend/src/components/LabelPhotoEntry.tsx frontend/src/components/LabelPhotoEntry.module.css frontend/src/components/FoodPicker.tsx frontend/src/screens/LogMeal.tsx frontend/src/screens/EditMealItems.tsx frontend/src/screens/FoodLibrary.tsx frontend/src/App.tsx frontend/tests/food-picker.test.tsx frontend/tests/log-meal-barcode.test.tsx frontend/tests/food-library.test.tsx frontend/tests/edit-meal.test.tsx frontend/e2e/label-ocr.spec.ts
git commit -m "feat(frontend): 記一餐、編輯這一餐、食物庫多一顆「拍營養標示」（拍完到新增食物、手機辨識、不用 AI）

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: 改名「吃什麼」與新圖示（規格 D10–D13）

**Files:**
- Create: `frontend/public/icon.svg`
- Create: `frontend/scripts/render-icons.mjs`
- Create／Replace（產生的）: `frontend/public/apple-touch-icon.png`、`frontend/public/icon-192.png`、`frontend/public/icon-512.png`、`frontend/public/icon-maskable-512.png`
- Modify: `frontend/index.html`、`frontend/vite.config.ts`（manifest，約 63–73 行）、`frontend/package.json`（scripts）
- Create: `frontend/e2e/app-icon.spec.ts`

- [ ] **Step 1: e2e（先失敗）**

`frontend/e2e/app-icon.spec.ts`：

```ts
import { expect, test } from "@playwright/test";

// 改名「吃什麼」與新圖示（改名規格 D10–D12）。不用登入：標題與圖示在登入頁就有。
test("標題是「吃什麼」；iPhone 主畫面與分頁的圖示拿得到", async ({
	page,
	request,
}) => {
	await page.goto("/");
	await expect(page).toHaveTitle("吃什麼");
	await expect(
		page.locator('meta[name="apple-mobile-web-app-title"]'),
	).toHaveAttribute("content", "吃什麼");
	const icons = [
		['link[rel="apple-touch-icon"]', "image/png"],
		['link[rel="icon"]', "image/svg+xml"],
	] as const;
	for (const [selector, type] of icons) {
		const href = await page.locator(selector).getAttribute("href");
		expect(href, selector).not.toBeNull();
		const response = await request.get(href ?? "");
		expect(response.status(), selector).toBe(200);
		expect(response.headers()["content-type"], selector).toContain(type);
	}
});
```

Run: `cd frontend && npx playwright test e2e/app-icon.spec.ts`
Expected: FAIL（標題是「飲食紀錄」）。

- [ ] **Step 2: 圖示原稿**

`frontend/public/icon.svg`（**不透明、不靠字型**：問號是路徑；顏色 = `--color-accent`／`--color-action`，規格 D13）：

```svg
<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
	<rect width="512" height="512" fill="#fff4ef"/>
	<circle cx="256" cy="256" r="148" fill="#ff7a59"/>
	<circle cx="256" cy="256" r="108" fill="#ffffff"/>
	<path d="M216 222 A40 40 0 1 1 272 258 C262 264 256 272 256 286 V292" fill="none" stroke="#b8432a" stroke-width="26" stroke-linecap="round" stroke-linejoin="round"/>
	<circle cx="256" cy="328" r="15" fill="#b8432a"/>
	<g fill="#b8432a">
		<rect x="58" y="150" width="12" height="70" rx="6"/>
		<rect x="76" y="150" width="12" height="70" rx="6"/>
		<rect x="94" y="150" width="12" height="70" rx="6"/>
		<path d="M58 212 H106 V236 C106 252 94 260 82 260 C70 260 58 252 58 236 Z"/>
		<rect x="72" y="250" width="20" height="120" rx="10"/>
		<ellipse cx="432" cy="196" rx="26" ry="44"/>
		<rect x="422" y="226" width="20" height="144" rx="10"/>
	</g>
</svg>
```

（左邊是叉子、中間盤子裡一個問號、右邊是湯匙。）

- [ ] **Step 3: 產生 PNG 的腳本**

`frontend/scripts/render-icons.mjs`：

```js
// 從 public/icon.svg 產生 app 的 PNG 圖示（改名規格 D11）。改了 SVG 之後跑 `npm run icons`，
// 產生的 PNG 一起 commit——build 與 CI 不用跑 Chromium。用 e2e 已經有的 Playwright Chromium。
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const publicDir = fileURLToPath(new URL("../public/", import.meta.url));
// 同 icon.svg 的底色：maskable 縮小之後，外圈要鋪同一個顏色（不能透明，iOS 會把透明的地方填黑）。
const BACKGROUND = "#fff4ef";
const OUTPUTS = [
	{ file: "apple-touch-icon.png", size: 180, scale: 1 },
	{ file: "icon-192.png", size: 192, scale: 1 },
	{ file: "icon-512.png", size: 512, scale: 1 },
	// Android 會把圖示裁成圓形或圓角：內容縮到 80% 置中才在 maskable 的安全圓裡（叉子、湯匙不會被切掉）。
	{ file: "icon-maskable-512.png", size: 512, scale: 0.8 },
];

const svg = await readFile(`${publicDir}icon.svg`, "utf8");
const browser = await chromium.launch();
try {
	for (const { file, size, scale } of OUTPUTS) {
		const page = await browser.newPage({
			viewport: { width: size, height: size },
			deviceScaleFactor: 1,
		});
		const inner = size * scale;
		const inset = (size - inner) / 2;
		await page.setContent(
			`<!doctype html><style>html,body{margin:0;background:${BACKGROUND}}` +
				`svg{position:absolute;left:${inset}px;top:${inset}px;width:${inner}px;height:${inner}px}</style>${svg}`,
		);
		await page.screenshot({ path: `${publicDir}${file}` });
		await page.close();
		console.log(`${file}（${size}×${size}）`);
	}
} finally {
	await browser.close();
}
```

`frontend/package.json` 的 `scripts` 加 `"icons": "node scripts/render-icons.mjs",`（放在 `"e2e"` 前面）。

Run: `cd frontend && npm run icons`
Expected: 印出四行，`public/` 多了 `apple-touch-icon.png`、`icon-maskable-512.png`，`icon-192.png`、`icon-512.png` 換成新的。用 Read 工具打開 `public/icon-512.png` 與 `public/icon-maskable-512.png` 看一眼：淺色底、珊瑚橘的盤子、盤心白色、深橘的問號、左叉右匙；maskable 那張內容比較小、四周是同一個底色。

- [ ] **Step 4: 名稱與圖示接上**

`frontend/index.html` 的 `<head>`：

```html
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="apple-mobile-web-app-title" content="吃什麼" />
    <link rel="icon" href="/icon.svg" type="image/svg+xml" />
    <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
    <title>吃什麼</title>
```

`frontend/vite.config.ts` 的 manifest：

```ts
			manifest: {
				// 改名規格 D10：三個字主畫面放得下，短名稱跟名稱一樣。
				name: "吃什麼",
				short_name: "吃什麼",
				start_url: "/",
				display: "standalone",
				background_color: "#ffffff",
				theme_color: "#ffffff",
				// 圖示從 public/icon.svg 產生（`npm run icons`，改名規格 D11、D12）。maskable 另一張：
				// 內容縮到安全圓裡，Android 裁成圓形時叉子與湯匙不會被切掉。
				icons: [
					{ src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
					{ src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
					{
						src: "/icon-maskable-512.png",
						sizes: "512x512",
						type: "image/png",
						purpose: "maskable",
					},
				],
			},
```

（照 Biome 的格式排版：`npm run format` 之後再看 diff。）

- [ ] **Step 5: 跑 e2e 與 build**

Run: `cd frontend && npx playwright test e2e/app-icon.spec.ts`
Expected: PASS。

Run: `cd frontend && npm run build && node -e "const m=JSON.parse(require('fs').readFileSync('dist/manifest.webmanifest','utf8'));console.log(m.name,m.short_name,JSON.stringify(m.icons))" && ls dist/*.png dist/icon.svg`
Expected: `吃什麼 吃什麼` 加三個圖示（最後一個 `purpose: maskable`）；`dist/` 有 `apple-touch-icon.png`、`icon-192.png`、`icon-512.png`、`icon-maskable-512.png`、`icon.svg`。也看一下 `dist/index.html` 的 `<head>` 有 apple-touch-icon 與 icon 兩個 link。

- [ ] **Step 6: Commit**

```bash
git add frontend/public/icon.svg frontend/public/apple-touch-icon.png frontend/public/icon-192.png frontend/public/icon-512.png frontend/public/icon-maskable-512.png frontend/scripts/render-icons.mjs frontend/package.json frontend/index.html frontend/vite.config.ts frontend/e2e/app-icon.spec.ts
git commit -m "feat(frontend): app 改名「吃什麼」、換新圖示（盤子＋問號；iPhone 主畫面、maskable、分頁）

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: 文件（規格 §6、D14）

**Files:**
- Modify: `docs/handover.md`、`docs/deployment.md`、`README.md`
- Modify: `docs/superpowers/specs/2026-11-06-label-entry-rename-design.md`（狀態行）

- [ ] **Step 1: 跑完整驗證，記下數字**

Run（在 `frontend/`）：`npm run lint && npm run typecheck && npm run build && npx vitest run`
記下 vitest 的「Test Files N passed」與「Tests M passed」。
Run：`npx playwright test` 跑**兩次**，記下兩次的 passed 數（有 flaky 的話單獨重跑那幾條，結果照實記）。

- [ ] **Step 2: `docs/deployment.md`**

「各版本的升級備註」（約 532 行）最上面加一節（照那一節既有的格式）：

```markdown
#### 改名「吃什麼」與新圖示（`feat/label-entry-rename`）

- 沒有 migration、沒有新的環境變數。
- **iPhone 主畫面上的 app 不會自己換名稱與圖示**：部署之後在主畫面上刪掉舊的圖示，用 Safari 打開網址、
  分享 →「加入主畫面」再加一次。主畫面 app 的儲存跟 Safari 分開，刪掉就清了，所以**要重新登入一次**；
  資料都在伺服器上，不會不見。Android 的 Chrome 會在幾天內自己更新圖示與名稱。
```

- [ ] **Step 3: `docs/handover.md`**

先讀第 1、2 節（「這是什麼」「目前狀態」與「階段進度」），然後：
1. 第 3 行「**專案：** nutrition-tracker —— 飲食紀錄系統」改成「**專案：** nutrition-tracker —— 飲食紀錄系統（app 名稱「吃什麼」）」。
2. 「階段進度」的表格照既有的格式加一列：拍營養標示的入口（記一餐、編輯這一餐、食物庫 → 新增食物一進去就手機辨識）、改名「吃什麼」與新圖示（`npm run icons` 從 `public/icon.svg` 產生）、掃條碼載入失敗後下一次重新載（`purgeZXingModule`）；規格與計畫的路徑。
3. 測試數字那一格（找「測試」那一列，開頭現在是 `fix/barcode-detector-detail` 的數字）換成 Step 1 量到的：`feat/label-entry-rename` 的 vitest 檔數／測試數、e2e 數、兩次完整跑的結果。
4. 掃條碼的限制第 3 項（2026-11-06 iPhone 那一段）最後補：「部署帶『技術細節』的版本、重開 app 之後就好了，原因沒抓到；之後載入失敗會清掉 zxing 記住的模組，下一次按『掃條碼』重新載（`feat/label-entry-rename`）。」
5. 改名之後 iPhone 主畫面要重新加入（指到 `docs/deployment.md` 的升級備註）。

- [ ] **Step 4: `README.md`**

第 1 行 `# 飲食紀錄系統` 改成 `# 吃什麼 —— 飲食紀錄系統`。

- [ ] **Step 5: 規格的狀態行**

`docs/superpowers/specs/2026-11-06-label-entry-rename-design.md` 的「**狀態：**」改成「已實作（2026-11-06，`feat/label-entry-rename`）」；實作時跟規格不一樣的地方（如果有）在文末加「## 與規格的差異」一節列出。

- [ ] **Step 6: Commit**

```bash
git add docs/handover.md docs/deployment.md README.md docs/superpowers/specs/2026-11-06-label-entry-rename-design.md
git commit -m "docs: 拍營養標示的入口、改名「吃什麼」——交接、部署（iPhone 要重新加入主畫面）、量到的數字

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Self-Review（寫計畫的人自己對過）

- 規格 §2.1 A → Task 2–4；B → Task 5；C → Task 1；§6 → Task 6。D1–D16 都有落點（D14 → Task 6 Step 2–3）。
- 型別一致：`labelPhotoState(file, returnTo)`、`NewFoodHandoff.labelPhoto`、`stashPhoto`／`stashedPhoto`／`releaseStashedPhoto`、`LabelReader.initialPhoto`、`FoodPicker.onLabelPhoto`、`LogMeal.onLabelPhoto`、`LabelPhotoEntry.onPhoto`、`PhotoPickerButton.describedBy`。
- 沒有後端改動、沒有 migration。
