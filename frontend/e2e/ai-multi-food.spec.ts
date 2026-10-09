import { readFile } from "node:fs/promises";
import {
	type APIRequestContext,
	expect,
	type Page,
	test,
} from "@playwright/test";
import type { components } from "../src/api/schema.d.ts";
import { generateJpegBuffer } from "./jpeg.ts";
import { loginAs, type NewAccount, newAccount } from "./new-account.ts";
import { expectTouchTargets } from "./touch-targets.ts";

type AnalyzeMealResponse = components["schemas"]["AnalyzeMealResponse"];

// 手機尺寸：44px 的點擊目標與「沒有橫向捲軸」在這個寬度才有意義；流程本身兩種寬度一樣。
test.use({ viewport: { width: 390, height: 844 } });

/** 用 API 替這個帳號建一個私人食物（每 100 g 130 kcal）。回食物的 id。
 *  設定資料用 API、要驗的行為用畫面（同 `friends.spec.ts` 的 `seedFood`）。 */
async function createFood(
	request: APIRequestContext,
	account: NewAccount,
	name: string,
): Promise<number> {
	const login = await request.post("/api/auth/login", {
		data: { email: account.email, password: account.password },
	});
	expect(login.ok()).toBe(true);
	const { access_token } = (await login.json()) as { access_token: string };
	const food = await request.post("/api/foods", {
		headers: { authorization: `Bearer ${access_token}` },
		data: {
			name,
			nutrition: {
				base_unit: "g",
				kcal: "130.00",
				protein_g: "2.50",
				fat_g: "0.30",
				carb_g: "28.00",
			},
		},
	});
	expect(food.status()).toBe(201);
	return ((await food.json()) as { id: number }).id;
}

async function openLogMeal(page: Page) {
	await page.getByRole("button", { name: "新增紀錄", exact: true }).click();
	await page.getByRole("link", { name: "記一餐", exact: true }).click();
	await expect(
		page.getByRole("heading", { name: "記一餐", exact: true }),
	).toBeVisible();
}

async function openDiet(page: Page) {
	await page.getByRole("link", { name: "飲食", exact: true }).click();
	// 只有飲食頁才有的標題（換頁後的第一個斷言，handover §6 第 53 種）。
	await expect(
		page.getByRole("heading", { name: "今日餐點", exact: true }),
	).toBeVisible();
}

test("描述：記一餐手打 → 飲食頁的卡片 → 編輯畫面改掉 → 匯出的 CSV 有「描述」欄", async ({
	page,
	request,
}) => {
	const account = await newAccount(request, "describe");
	const stamp = Date.now();
	const foodName = `E2E 描述的食物 ${stamp}`;
	const first = `E2E 第一版描述 ${stamp}`;
	// 改過的描述故意用 = 開頭：一路走到 CSV 裡要被加上單引號（不會被試算表當公式）。
	const second = `=E2E 第二版描述 ${stamp}`;
	await createFood(request, account, foodName);
	await loginAs(page, account);

	// 1. 記一餐，手打描述（不靠 AI）。
	await openLogMeal(page);
	await page.getByLabel("搜尋食物", { exact: true }).fill(foodName);
	await page.getByRole("button", { name: foodName, exact: true }).click();
	await page.getByLabel("份量", { exact: true }).fill("100");
	const field = page.getByLabel("描述（選填）", { exact: true });
	await expect(field).toHaveAccessibleDescription("好友看得到這段描述");
	await field.fill(first);
	// 表單的輸入框也是點擊目標（勾選框與檔案選擇除外：它們的目標是外面的標籤）。
	await expectTouchTargets(
		page.locator(
			"form input:not([type=checkbox]):not([type=file]):visible, form select:visible",
		),
		"記一餐：輸入框",
	);
	await page.getByRole("button", { name: "記錄", exact: true }).click();
	await expect(
		page.getByRole("heading", { name: "總覽", exact: true }),
	).toBeVisible();

	// 2. 飲食頁的卡片看得到。新帳號今天只有這一餐。
	await openDiet(page);
	const shown = page.getByTestId(/^meal-description-\d+$/);
	await expect(shown).toHaveCount(1);
	await expect(shown).toHaveText(first);

	// 3. 編輯畫面：帶著原本的描述；改掉、儲存。
	// 連結的名稱帶時間，時間的寫法跟瀏覽器的語系走（Playwright 預設 en-US 是
	// 「05:42 PM」，zh-TW 是「下午05:42」）——不假設是哪一種。新帳號只有這一餐。
	await page.getByRole("link", { name: /^編輯 .+ 點心$/ }).click();
	await expect(
		page.getByRole("heading", { name: "編輯這一餐", exact: true }),
	).toBeVisible();
	const details = page.getByRole("form", { name: "這一餐", exact: true });
	const editing = details.getByLabel("描述（選填）", { exact: true });
	await expect(editing).toHaveValue(first);
	await editing.fill(second);
	const saved = page.waitForResponse(
		(response) =>
			/\/api\/meals\/\d+$/.test(new URL(response.url()).pathname) &&
			response.request().method() === "PATCH",
	);
	await details.getByRole("button", { name: "儲存", exact: true }).click();
	// 看伺服器的回應，不只看畫面上的「已儲存」（handover §6 第 18 種）。
	const patched = (await (await saved).json()) as {
		description: string | null;
	};
	expect(patched.description).toBe(second);
	await expect(details.getByRole("status")).toHaveText("已儲存");

	// 4. 回飲食頁：卡片是新的描述。
	await page.getByRole("button", { name: "關閉", exact: true }).click();
	await expect(
		page.getByRole("heading", { name: "今日餐點", exact: true }),
	).toBeVisible();
	await expect(page.getByTestId(/^meal-description-\d+$/)).toHaveText(second);

	// 5. 匯出餐點：標題列有「描述」，那一列是改過的描述（前面多一個單引號）。
	await page.getByRole("link", { name: "我的", exact: true }).click();
	await expect(
		page.getByRole("heading", { name: "匯出資料", exact: true }),
	).toBeVisible();
	const downloading = page.waitForEvent("download");
	await page
		.getByTestId("export-card")
		.getByRole("button", { name: "餐點", exact: true })
		.click();
	const download = await downloading;
	const bytes = await readFile(await download.path());
	expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
	const lines = bytes.subarray(3).toString("utf8").split("\r\n");
	// 新帳號：標題、那一餐的一個項目、結尾的空字串。
	expect(lines).toHaveLength(3);
	expect(lines[0]).toBe(
		"餐點編號,日期,時間,餐別,食物,品牌,份量,單位,熱量(kcal),蛋白質(g),脂肪(g),碳水(g),描述,備註,只有我看得到",
	);
	expect(lines[1]).toMatch(
		new RegExp(
			`^\\d+,\\d{4}-\\d{2}-\\d{2},\\d{2}:\\d{2},點心,${foodName},,100\\.00,g,130\\.00,2\\.50,0\\.30,28\\.00,'${second},,否$`,
		),
	);
});

test("AI 多樣估算（估算的回應是假的，其餘是真的）：勾選、加入、記錄，飲食頁看到每一樣、描述與照片", async ({
	page,
	request,
}) => {
	const account = await newAccount(request, "multi");
	const stamp = Date.now();
	const riceName = `E2E 白飯 ${stamp}`;
	const chickenName = `E2E 滷雞腿 ${stamp}`;
	const description = `E2E 一碗白飯與一隻滷雞腿 ${stamp}`;
	// 白飯：食物庫裡真的有（這個帳號的私人食物）；滷雞腿：要由畫面建出來。
	const riceId = await createFood(request, account, riceName);

	const estimate = {
		analysis_id: 1,
		description,
		remaining_today: 19,
		items: [
			{
				name: riceName,
				brand: null,
				nutrition: {
					base_unit: "g",
					serving_grams: "200.00",
					kcal: "140.00",
					protein_g: "2.50",
					fat_g: "0.25",
					carb_g: "31.00",
					serving_kcal: "280.00",
					serving_protein_g: "5.00",
					serving_fat_g: "0.50",
					serving_carb_g: "62.00",
				},
				confidence: "0.80",
				consistency: {
					atwater_kcal: "272.50",
					deviation: "7.50",
					flagged: false,
				},
				// 食物庫那一筆每 100 g 130 kcal × 200 g。
				library_food: {
					food_id: riceId,
					name: riceName,
					base_unit: "g",
					serving_kcal: "260.00",
				},
			},
			{
				name: chickenName,
				brand: null,
				nutrition: {
					base_unit: "g",
					serving_grams: "150.00",
					kcal: "200.00",
					protein_g: "18.00",
					fat_g: "13.33",
					carb_g: "2.00",
					serving_kcal: "300.00",
					serving_protein_g: "27.00",
					serving_fat_g: "20.00",
					serving_carb_g: "3.00",
				},
				confidence: "0.60",
				consistency: {
					atwater_kcal: "300.00",
					deviation: "0.00",
					flagged: false,
				},
				library_food: null,
			},
		],
	} satisfies AnalyzeMealResponse;

	// 記下面板實際送了什麼，等一下在測試本體斷言（route 的 callback 裡丟的例外
	// 不會讓測試在那一行紅）。
	const sent: Array<{ kind?: string; image_base64?: string }> = [];
	await page.route("**/api/ai/analyze-meal", async (route) => {
		sent.push(route.request().postDataJSON());
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify(estimate),
		});
	});

	await loginAs(page, account);
	await openLogMeal(page);

	// 1. 拍照估算 → 清單。
	await page.getByLabel("拍照估算", { exact: true }).setInputFiles({
		name: "bento.jpg",
		mimeType: "image/jpeg",
		buffer: await generateJpegBuffer(page),
	});
	const card = page.getByRole("region", { name: "AI 估算結果", exact: true });
	await expect(card).toContainText(description);
	await expect(card).toContainText("今天還能用 19 次");
	// 估算只打了一次，送的是照片（base64，不是空的）。
	expect(sent).toHaveLength(1);
	expect(sent[0]?.kind).toBe("image");
	expect(sent[0]?.image_base64?.length ?? 0).toBeGreaterThan(100);
	const rice = card.getByRole("checkbox", {
		name: `${riceName} 200 g · 260 kcal`,
		exact: true,
	});
	const chicken = card.getByRole("checkbox", {
		name: `${chickenName} 150 g · 300 kcal`,
		exact: true,
	});
	await expect(rice).toBeChecked();
	await expect(chicken).toBeChecked();
	await expect(card.getByText("用食物庫的", { exact: true })).toHaveCount(1);

	// 2. 點擊目標與版面（jsdom 量不到，只有這裡量得到）。
	await expectTouchTargets(
		card.locator("button:visible, label:has(input[type=checkbox]):visible"),
		"AI 估算結果",
	);
	expect(
		await page.evaluate(
			() =>
				document.documentElement.scrollWidth <=
				document.documentElement.clientWidth,
		),
		"清單不能讓頁面橫向捲動",
	).toBe(true);

	// 3. 取消一樣再勾回來：按鈕上的數字跟著變。
	await chicken.uncheck();
	await expect(
		card.getByRole("button", { name: "加入這 1 樣", exact: true }),
	).toBeVisible();
	await chicken.check();

	// 4. 加入：白飯拿食物庫的（不建），滷雞腿真的建一個私人食物。
	const created = page.waitForResponse(
		(response) =>
			new URL(response.url()).pathname === "/api/foods" &&
			response.request().method() === "POST",
	);
	await card.getByRole("button", { name: "加入這 2 樣", exact: true }).click();
	expect((await created).status()).toBe(201);
	await expect(card).toHaveCount(0);

	// 5. 記一餐的表單：兩列、量是估的、描述與照片先帶好。還沒存成餐。
	const items = page.getByRole("region", { name: "AI 估的項目", exact: true });
	await expect(
		page.getByRole("heading", { name: "AI 估的項目", exact: true }),
	).toBeFocused();
	await expect(
		items.getByLabel(`${riceName}（g）`, { exact: true }),
	).toHaveValue("200");
	await expect(
		items.getByLabel(`${chickenName}（g）`, { exact: true }),
	).toHaveValue("150");
	await expect(page.getByLabel("描述（選填）", { exact: true })).toHaveValue(
		description,
	);
	await expect(page.getByRole("img", { name: "選好的照片" })).toBeVisible();
	// 照片預覽旁邊那顆也是點擊目標（記一餐不在 .screen 裡，樣式要自己指定）。
	await expectTouchTargets(
		page.getByRole("button", { name: "移除照片", exact: true }),
		"照片預覽",
	);
	await expectTouchTargets(
		items.locator("input:visible, button:visible"),
		"AI 估的項目",
	);
	// 加入不會再估算一次。
	expect(sent).toHaveLength(1);

	// 6. 記錄 → 飲食頁那一餐有兩樣、描述、照片。
	await page.getByRole("button", { name: "記錄", exact: true }).click();
	await expect(
		page.getByRole("heading", { name: "總覽", exact: true }),
	).toBeVisible();
	await openDiet(page);
	await expect(page.getByTestId(/^meal-description-\d+$/)).toHaveText(
		description,
	);
	// 外層的 <li> 是那一餐的卡片（新帳號只有這一餐），裡面每個食物各一個 <li>。
	const mealCard = page
		.getByRole("listitem")
		.filter({ has: page.getByTestId(/^meal-description-\d+$/) });
	await expect(mealCard).toContainText(riceName);
	await expect(mealCard).toContainText(chickenName);
	await expect(mealCard).toContainText("200 g");
	await expect(mealCard).toContainText("150 g");
	// 白飯用的是食物庫那一筆（130／100 g × 200）＋滷雞腿 AI 的 300 ＝ 560，不是 280＋300。
	await expect(mealCard).toContainText("合計 560 kcal");
	await expect(page.getByTestId(/^meal-photo-\d+$/)).toBeVisible();
});
