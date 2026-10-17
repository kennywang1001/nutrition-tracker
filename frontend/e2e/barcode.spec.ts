import { expect, type Page, test } from "@playwright/test";
import type { components } from "../src/api/schema.d.ts";
import { generateJpegBuffer } from "./jpeg.ts";
import { loginAs, newAccount } from "./new-account.ts";
import { expectTouchTargets } from "./touch-targets.ts";

type BarcodeLookupResponse = components["schemas"]["BarcodeLookupResponse"];
type LabelReadResponse = components["schemas"]["LabelReadResponse"];

// 掃條碼規格 §13.3。CI 沒有 AI 金鑰、`OFF_ENABLED=false`（不打 Open Food Facts）：
// 1. 全部是真的（手動輸入條碼）；2. 只假造 `GET /api/foods/by-barcode/…`（OFF 有預填）；
// 3. 只假造 `POST /api/ai/read-label`（真的後端說沒有預填）。
// 相機那條路不做 e2e：headless Chromium 的假影像源掃不出條碼、權限行為因版本而異——
// 由單元測試的假 `getUserMedia` 守。所以這裡也**不斷言相機的狀態文字**。

// 手機尺寸：掃描層是全螢幕的、44px 的點擊目標在這個寬度才有意義。
test.use({ viewport: { width: 390, height: 844 } });

/** 新帳號一定沒有、而且是合格的 EAN-13（規格 §3.2 的例子）。 */
const CODE = "4710088432094";

async function openLogMeal(page: Page) {
	await page.getByRole("button", { name: "新增紀錄", exact: true }).click();
	await page.getByRole("link", { name: "記一餐", exact: true }).click();
	await expect(
		page.getByRole("heading", { name: "記一餐", exact: true }),
	).toBeVisible();
}

async function openDiet(page: Page) {
	await page.getByRole("link", { name: "飲食", exact: true }).click();
	// 只有飲食頁才有的標題（換頁後的第一個斷言）。
	await expect(
		page.getByRole("heading", { name: "今日餐點", exact: true }),
	).toBeVisible();
}

/** 「掃條碼」→ 掃描層 →「手動輸入條碼」→ 輸入 →「查詢」→ 掃描層關掉。 */
async function scanByHand(page: Page, code: string) {
	await page.getByRole("button", { name: "掃條碼", exact: true }).click();
	const dialog = page.getByRole("dialog", { name: "掃條碼", exact: true });
	await expect(dialog).toBeVisible();
	await dialog
		.getByRole("button", { name: "手動輸入條碼", exact: true })
		.click();
	const form = dialog.getByRole("form", { name: "手動輸入條碼", exact: true });
	await form.getByLabel("條碼", { exact: true }).fill(code);
	await form.getByRole("button", { name: "查詢", exact: true }).click();
	await expect(dialog).toHaveCount(0);
}

/** 記一餐的「記錄」→ 總覽。 */
async function saveMeal(page: Page) {
	await page.getByRole("button", { name: "記錄", exact: true }).click();
	await expect(
		page.getByRole("heading", { name: "總覽", exact: true }),
	).toBeVisible();
}

/** 飲食頁裡那個食物的那一項（餐點卡片是 <li>，裡面每個食物又是一個 <li>——取內層那一項）。 */
function dietItem(page: Page, name: string) {
	return page.getByRole("listitem").filter({ hasText: name }).last();
}

test("手動輸入條碼，全部是真的：新增食物帶條碼 → 詳情頁改條碼 → 記一餐掃到它 → 飲食頁", async ({
	page,
	request,
}) => {
	const account = await newAccount(request, "barcode");
	const foodName = `E2E 條碼 ${Date.now()}`;
	await loginAs(page, account);

	// 1. 食物庫 → 新增食物，帶條碼建立。
	await page.getByRole("link", { name: "飲食", exact: true }).click();
	await page.getByRole("link", { name: "食物庫", exact: true }).click();
	await page.getByRole("link", { name: "新增食物", exact: true }).click();
	await expect(
		page.getByRole("heading", { name: "新增食物", exact: true }),
	).toBeVisible();
	await page.getByLabel("名稱", { exact: true }).fill(foodName);
	await page.getByLabel("條碼（選填）", { exact: true }).fill(CODE);
	await page
		.getByLabel("熱量（每 100 單位 kcal）", { exact: true })
		.fill("500");
	await page.getByLabel("蛋白質（g）", { exact: true }).fill("6");
	await page.getByLabel("脂肪（g）", { exact: true }).fill("28");
	await page.getByLabel("碳水化合物（g）", { exact: true }).fill("60");
	const created = page.waitForResponse(
		(response) =>
			new URL(response.url()).pathname === "/api/foods" &&
			response.request().method() === "POST",
	);
	await page.getByRole("button", { name: "建立食物", exact: true }).click();
	const createdResponse = await created;
	expect(createdResponse.status()).toBe(201);
	expect(((await createdResponse.json()) as { barcode: string }).barcode).toBe(
		CODE,
	);

	// 2. 詳情頁的「條碼」一節：看得到；移除再用有空白的寫法存回去（後端存標準形式）。
	await expect(
		page.getByRole("heading", { name: foodName, exact: true }),
	).toBeVisible();
	const section = page.getByRole("region", { name: "條碼", exact: true });
	await expect(section).toContainText(CODE);
	await section.getByRole("button", { name: "移除條碼", exact: true }).click();
	await expect(section.getByRole("status")).toHaveText("已移除條碼");
	await expect(section).toContainText("沒有條碼");
	const editForm = section.getByRole("form", { name: "修改條碼", exact: true });
	await editForm.getByLabel("條碼", { exact: true }).fill("4 710088 43209 4");
	const patched = page.waitForResponse(
		(response) =>
			/^\/api\/foods\/\d+$/.test(new URL(response.url()).pathname) &&
			response.request().method() === "PATCH",
	);
	await editForm.getByRole("button", { name: "儲存條碼", exact: true }).click();
	// 看伺服器的回應，不只看畫面上的「已儲存條碼」。
	expect(((await (await patched).json()) as { barcode: string }).barcode).toBe(
		CODE,
	);
	await expect(section.getByRole("status")).toHaveText("已儲存條碼");
	await expect(editForm.getByLabel("條碼", { exact: true })).toHaveValue(CODE);
	await expect(
		section.getByRole("button", { name: "移除條碼", exact: true }),
	).toBeVisible();

	// 3. 記一餐 → 掃條碼：掃描層的按鈕量觸控高度（有界的一組）。
	await openLogMeal(page);
	await expect(
		page.getByText("查不到時，條碼可能會送到 Open Food Facts 查詢", {
			exact: true,
		}),
	).toBeVisible();
	await page.getByRole("button", { name: "掃條碼", exact: true }).click();
	const dialog = page.getByRole("dialog", { name: "掃條碼", exact: true });
	await expect(
		dialog.getByRole("heading", { name: "掃條碼", exact: true }),
	).toBeVisible();
	// 開著就有（相機能不能用都一樣）：手動輸入、取消。
	await expect(
		dialog.getByRole("button", { name: "取消", exact: true }),
	).toBeFocused();
	// 用 locator("button")：Playwright 把 1px 的 input[type=file] 也算成 button 角色，
	// getByRole("button") 會量到它。照片那顆的點擊目標是它的標籤，另外量。
	await expectTouchTargets(dialog.locator("button"), "掃描層：按鈕");
	const photo = dialog.locator('label[for="barcode-photo"]');
	if ((await photo.count()) > 0) {
		await expectTouchTargets(photo, "掃描層：從照片讀條碼");
	}
	const manualToggle = dialog.getByRole("button", {
		name: "手動輸入條碼",
		exact: true,
	});
	await expect(manualToggle).toHaveAttribute("aria-expanded", "false");
	await manualToggle.click();
	await expect(manualToggle).toHaveAttribute("aria-expanded", "true");
	const manual = dialog.getByRole("form", {
		name: "手動輸入條碼",
		exact: true,
	});
	const manualInput = manual.getByLabel("條碼", { exact: true });
	await expect(manualInput).toBeFocused();
	await expectTouchTargets(manual.locator("input, button"), "掃描層：手動輸入");
	// 位數不對：留在掃描層、說明要幾位，不送查詢。
	await manualInput.fill("123");
	await manual.getByRole("button", { name: "查詢", exact: true }).click();
	await expect(dialog.getByRole("alert")).toHaveText(
		"條碼要是 8、12 或 13 位數字",
	);
	const looked = page.waitForResponse((response) =>
		new URL(response.url()).pathname.startsWith("/api/foods/by-barcode/"),
	);
	// 帶分隔符號也收（掃描層整理過才查）。
	await manualInput.fill("4710088-432094");
	await manual.getByRole("button", { name: "查詢", exact: true }).click();
	const lookup = await looked;
	expect(new URL(lookup.url()).pathname).toBe(`/api/foods/by-barcode/${CODE}`);
	expect(lookup.status()).toBe(200);
	await expect(dialog).toHaveCount(0);

	// 4. 命中自己的食物：跟從搜尋結果選一樣。
	await expect(
		page.getByText(`已選擇：${foodName}`, { exact: true }),
	).toBeVisible();
	await page.getByLabel("份量", { exact: true }).fill("100");
	await saveMeal(page);

	await openDiet(page);
	await expect(dietItem(page, foodName)).toContainText("100 g");
});

test("Open Food Facts 有預填（只假造條碼查詢）：卡片＋出處 → 新增食物已預填 → 建立 → 回到記一餐已選好 → 記錄", async ({
	page,
	request,
}) => {
	const account = await newAccount(request, "barcode-off");
	const offCode = "5449000000996";
	const productName = `E2E 可樂 ${Date.now()}`;
	const lookupResponse = {
		code: offCode,
		food: null,
		prefill: {
			name: productName,
			brand: "E2E 品牌",
			base_unit: "ml",
			per100: {
				kcal: "42.00",
				protein_g: "0.00",
				fat_g: "0.00",
				carb_g: "10.60",
			},
			serving: { amount: "330.00", unit: "ml" },
			source: "openfoodfacts",
		},
	} satisfies BarcodeLookupResponse;
	const asked: string[] = [];
	await page.route("**/api/foods/by-barcode/**", async (route) => {
		asked.push(new URL(route.request().url()).pathname);
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify(lookupResponse),
		});
	});

	await loginAs(page, account);
	await openLogMeal(page);
	await scanByHand(page, offCode);

	// 1. 沒命中的卡片：OFF 的商品名與出處。
	const card = page.getByRole("region", {
		name: "找不到這個條碼",
		exact: true,
	});
	await expect(card).toContainText(`找不到這個條碼（${offCode}）`);
	await expect(
		card.getByText(`Open Food Facts 有這個商品：${productName}`, {
			exact: true,
		}),
	).toBeVisible();
	await expect(
		card.getByText("資料來源：Open Food Facts（ODbL）", { exact: true }),
	).toBeVisible();
	await expect(
		card.getByRole("link", { name: "Open Food Facts", exact: true }),
	).toHaveAttribute("href", "https://world.openfoodfacts.org");
	expect(asked).toEqual([`/api/foods/by-barcode/${offCode}`]);
	await card
		.getByRole("button", { name: "用這個條碼建立食物", exact: true })
		.click();

	// 2. 新增食物：預填好了、出處在。
	await expect(
		page.getByRole("heading", { name: "新增食物", exact: true }),
	).toBeVisible();
	await expect(
		page.getByText("已從 Open Food Facts 帶入，請對照包裝確認", {
			exact: true,
		}),
	).toBeVisible();
	await expect(
		page.getByRole("link", { name: "Open Food Facts", exact: true }),
	).toBeVisible();
	await expect(page.getByLabel("名稱", { exact: true })).toHaveValue(
		productName,
	);
	await expect(page.getByLabel("品牌（選填）", { exact: true })).toHaveValue(
		"E2E 品牌",
	);
	await expect(page.getByLabel("條碼（選填）", { exact: true })).toHaveValue(
		offCode,
	);
	await expect(page.getByLabel("單位", { exact: true })).toHaveValue("ml");
	await expect(
		page.getByLabel("熱量（每 100 單位 kcal）", { exact: true }),
	).toHaveValue("42.00");
	await expect(page.getByLabel("碳水化合物（g）", { exact: true })).toHaveValue(
		"10.60",
	);
	await expect(page.getByLabel("份量名稱", { exact: true })).toHaveValue("份");
	await expect(page.getByLabel("每份重量（ml）", { exact: true })).toHaveValue(
		"330.00",
	);
	await expect(
		page.getByRole("button", { name: "取消，回到記一餐", exact: true }),
	).toBeVisible();

	// 3. 建立（真的 POST，帶條碼）→ 回到記一餐、已選好、預設份量「份」。
	const created = page.waitForResponse(
		(response) =>
			new URL(response.url()).pathname === "/api/foods" &&
			response.request().method() === "POST",
	);
	await page.getByRole("button", { name: "建立食物", exact: true }).click();
	const createdResponse = await created;
	expect(createdResponse.status()).toBe(201);
	const createdFood = (await createdResponse.json()) as {
		barcode: string;
		name: string;
	};
	expect(createdFood.barcode).toBe(offCode);
	expect(createdFood.name).toBe(productName);
	await expect(
		page.getByRole("heading", { name: "記一餐", exact: true }),
	).toBeVisible();
	await expect(
		page.getByText(`已選擇：${productName}`, { exact: true }),
	).toBeVisible();
	await expect(page.locator("#portion option:checked")).toHaveText("份");
	await expect(page.getByLabel("份量", { exact: true })).toHaveValue("1");
	await saveMeal(page);

	await openDiet(page);
	await expect(dietItem(page, productName)).toContainText("330 ml");
	// 預填只查了一次（回到記一餐沒有再查）。
	expect(asked).toHaveLength(1);
});

test("沒有預填＋拍營養標示（只假造讀標示）：真的後端說找不到 → 新增食物只有條碼 → AI 填好數字 → 建立 → 記一餐已選好", async ({
	page,
	request,
}) => {
	const account = await newAccount(request, "barcode-label");
	const productName = `E2E 海苔洋芋片 ${Date.now()}`;
	const labelResponse = {
		analysis_id: 31,
		name: productName,
		nutrition: {
			base_unit: "g",
			kcal: "514.29",
			protein_g: "6.00",
			fat_g: "28.00",
			carb_g: "60.86",
		},
		serving: { amount: "35.00", unit: "g" },
		servings_per_package: "4.00",
		basis: "per_serving",
		confidence: "0.80",
		consistency: { atwater_kcal: "519.44", deviation: "5.15", flagged: false },
		remaining_today: 17,
	} satisfies LabelReadResponse;
	// 記下送了什麼，在測試本體斷言（route 的 callback 裡丟的例外不會讓測試在那一行紅）。
	const sent: unknown[] = [];
	await page.route("**/api/ai/read-label", async (route) => {
		sent.push(route.request().postDataJSON());
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify(labelResponse),
		});
	});

	await loginAs(page, account);
	await openLogMeal(page);
	const looked = page.waitForResponse((response) =>
		new URL(response.url()).pathname.startsWith("/api/foods/by-barcode/"),
	);
	await scanByHand(page, CODE);

	// 1. 真的後端：這個帳號沒有、OFF 關著 → 沒有預填。
	const lookup = await looked;
	expect(lookup.status()).toBe(200);
	expect(await lookup.json()).toEqual({
		code: CODE,
		food: null,
		prefill: null,
	});
	const card = page.getByRole("region", {
		name: "找不到這個條碼",
		exact: true,
	});
	await expect(
		card.getByText(`找不到這個條碼（${CODE}）`, { exact: true }),
	).toBeVisible();
	await expect(card).not.toContainText("Open Food Facts");
	await card
		.getByRole("button", { name: "用這個條碼建立食物", exact: true })
		.click();

	// 2. 新增食物：只有條碼＋提示。
	await expect(
		page.getByRole("heading", { name: "新增食物", exact: true }),
	).toBeVisible();
	await expect(
		page.getByText("找不到這個條碼的資料。拍營養標示讓 AI 讀數字，或自己填。", {
			exact: true,
		}),
	).toBeVisible();
	await expect(page.getByLabel("條碼（選填）", { exact: true })).toHaveValue(
		CODE,
	);
	await expect(page.getByLabel("名稱", { exact: true })).toHaveValue("");

	// 3. 拍營養標示 → 數字、一份填好；條碼不動。
	await page.getByLabel("拍營養標示", { exact: true }).setInputFiles({
		name: "label.jpg",
		mimeType: "image/jpeg",
		buffer: await generateJpegBuffer(page),
	});
	await expect(
		page.getByText("AI 讀的數字，請對照包裝確認", { exact: true }),
	).toBeVisible();
	await expect(page.getByText("本包裝含 4 份", { exact: true })).toBeVisible();
	await expect(
		page.getByText("今天還能用 17 次", { exact: true }),
	).toBeVisible();
	expect(sent).toHaveLength(1);
	const body = sent[0] as Record<string, unknown>;
	expect(Object.keys(body)).toEqual(["image_base64"]);
	expect(String(body.image_base64).length).toBeGreaterThan(100);
	await expect(page.getByLabel("名稱", { exact: true })).toHaveValue(
		productName,
	);
	await expect(page.getByLabel("單位", { exact: true })).toHaveValue("g");
	await expect(
		page.getByLabel("熱量（每 100 單位 kcal）", { exact: true }),
	).toHaveValue("514.29");
	await expect(page.getByLabel("蛋白質（g）", { exact: true })).toHaveValue(
		"6.00",
	);
	await expect(page.getByLabel("脂肪（g）", { exact: true })).toHaveValue(
		"28.00",
	);
	await expect(page.getByLabel("碳水化合物（g）", { exact: true })).toHaveValue(
		"60.86",
	);
	await expect(page.getByLabel("份量名稱", { exact: true })).toHaveValue("份");
	await expect(page.getByLabel("每份重量（g）", { exact: true })).toHaveValue(
		"35.00",
	);
	await expect(page.getByLabel("條碼（選填）", { exact: true })).toHaveValue(
		CODE,
	);

	// 4. 建立 → 回到記一餐、已選好 → 記錄 → 飲食頁是一份 35 g。
	await page.getByRole("button", { name: "建立食物", exact: true }).click();
	await expect(
		page.getByRole("heading", { name: "記一餐", exact: true }),
	).toBeVisible();
	await expect(
		page.getByText(`已選擇：${productName}`, { exact: true }),
	).toBeVisible();
	// 份量是另外載入的。以前選上「份」之前按「記錄」會記成直接輸入的 1 g（6 個 worker 時真的
	// 發生過）；審查 I2 之後畫面在載入時不送（按鈕 aria-disabled、送出直接 return），但 Playwright
	// 照樣點得到 aria-disabled 的按鈕——那一下是空的，`saveMeal` 會等不到存好。所以這個等待
	// 留著：它同時確認預設份量選上了。
	await expect(page.locator("#portion option:checked")).toHaveText("份");
	await expect(page.getByLabel("份量", { exact: true })).toHaveValue("1");
	await saveMeal(page);

	await openDiet(page);
	await expect(dietItem(page, productName)).toContainText("35 g");
});
