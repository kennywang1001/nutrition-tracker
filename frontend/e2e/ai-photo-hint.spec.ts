import { expect, type Page, test } from "@playwright/test";
import type { components } from "../src/api/schema.d.ts";
import { generateJpegBuffer } from "./jpeg.ts";
import { loginAs, newAccount } from "./new-account.ts";
import { expectTouchTargets } from "./touch-targets.ts";

type AnalyzeResponse = components["schemas"]["AnalyzeResponse"];
type AnalyzeMealResponse = components["schemas"]["AnalyzeMealResponse"];
type LabelReadResponse = components["schemas"]["LabelReadResponse"];

// 照片＋補充說明（照片說明規格 §6、§10.3）：三個拍照入口都先出「確認照片」卡片，按了才送，
// 說明帶在 body 的 hint。**只假造 AI 端點**（page.route）：登入、記一餐、新增食物都打真的後端。
test.use({ viewport: { width: 390, height: 844 } });

/** 送出的 body，在測試本體斷言（route 的 callback 裡丟的例外不會讓測試在那一行紅）。 */
type Sent = Array<Record<string, unknown>>;

async function photo(page: Page, name: string) {
	return {
		name,
		mimeType: "image/jpeg",
		buffer: await generateJpegBuffer(page),
	};
}

async function openNewFood(page: Page) {
	await page.getByRole("link", { name: "飲食", exact: true }).click();
	await page.getByRole("link", { name: "食物庫", exact: true }).click();
	await expect(
		page.getByRole("heading", { name: "食物庫", exact: true }),
	).toBeVisible();
	await page.getByRole("link", { name: "新增食物", exact: true }).click();
	await expect(
		page.getByRole("heading", { name: "新增食物", exact: true }),
	).toBeVisible();
}

test("整餐：選照片 → 確認照片打說明 → 開始估算（送出說明、看得到秒數）→ 清單", async ({
	page,
	request,
}) => {
	const account = await newAccount(request, "hint-meal");
	const stamp = Date.now();
	const estimate = {
		analysis_id: 41,
		description: `E2E 半碗飯的便當 ${stamp}`,
		remaining_today: 19,
		items: [
			{
				name: `E2E 滷雞腿去皮 ${stamp}`,
				brand: null,
				nutrition: {
					base_unit: "g",
					serving_grams: "150.00",
					kcal: "160.00",
					protein_g: "20.00",
					fat_g: "8.00",
					carb_g: "1.00",
					serving_kcal: "240.00",
					serving_protein_g: "30.00",
					serving_fat_g: "12.00",
					serving_carb_g: "1.50",
				},
				confidence: "0.60",
				consistency: {
					atwater_kcal: "234.00",
					deviation: "6.00",
					flagged: false,
				},
				library_food: null,
			},
		],
	} satisfies AnalyzeMealResponse;
	const sent: Sent = [];
	// 請求先卡住：等畫面上的秒數到 1 以上再放行——斷言的是真的在數，不是一閃而過。
	// 用正規式、不比「1 秒」：expect 的輪詢間隔可能跳過 1～2 秒那一格。
	let release: () => void = () => {};
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	await page.route("**/api/ai/analyze-meal", async (route) => {
		sent.push(route.request().postDataJSON());
		await gate;
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify(estimate),
		});
	});

	await loginAs(page, account);
	await page.getByRole("button", { name: "新增紀錄", exact: true }).click();
	await page.getByRole("link", { name: "記一餐", exact: true }).click();
	await expect(
		page.getByRole("heading", { name: "記一餐", exact: true }),
	).toBeVisible();

	await page
		.getByLabel("拍照估算", { exact: true })
		.setInputFiles(await photo(page, "bento.jpg"));
	const step = page.getByRole("region", { name: "確認照片", exact: true });
	await expect(
		step.getByRole("img", { name: "要送給 AI 的照片", exact: true }),
	).toBeVisible();
	// 焦點在卡片本身，不在說明欄（手機會跳鍵盤蓋住按鈕）。
	await expect(step).toBeFocused();
	const hint = step.getByLabel("補充說明（選填）", { exact: true });
	await expect(hint).toHaveAttribute(
		"placeholder",
		"例：飯半碗、雞皮沒吃、7-11 的",
	);
	// 16px（iOS 聚焦放大）、44px 的按鈕；說明欄本身也是點擊目標。
	expect(await hint.evaluate((el) => getComputedStyle(el).fontSize)).toBe(
		"16px",
	);
	await expectTouchTargets(step.locator("button, textarea"), "確認照片");
	await hint.fill("飯半碗、雞皮沒吃");
	// 選照片不會送。
	expect(sent).toHaveLength(0);
	await step.getByRole("button", { name: "開始估算", exact: true }).click();

	await expect(page.getByText(/^[1-9]\d* 秒$/)).toBeVisible();
	// 送出中：開始估算停用（Playwright 的 toBeDisabled 認 aria-disabled）。
	await expect(
		step.getByRole("button", { name: "開始估算", exact: true }),
	).toBeDisabled();
	release();
	const card = page.getByRole("region", { name: "AI 估算結果", exact: true });
	await expect(card).toContainText(estimate.description);
	await expect(step).toHaveCount(0);
	await expect(page.getByText(/^\d+ 秒$/)).toHaveCount(0);
	// 卡片收起，焦點回到照片按鈕（真的瀏覽器裡 input 恢復可用之後才對得到）。
	await expect(page.getByLabel("拍照估算", { exact: true })).toBeFocused();
	expect(sent).toHaveLength(1);
	expect(sent[0]?.kind).toBe("image");
	expect(sent[0]?.hint).toBe("飯半碗、雞皮沒吃");
	expect(String(sent[0]?.image_base64).length).toBeGreaterThan(100);
});

test("單樣（新增食物的「用 AI 填」）：說明送到 /api/ai/analyze", async ({
	page,
	request,
}) => {
	const account = await newAccount(request, "hint-single");
	const estimate = {
		analysis_id: 12,
		food_id: null,
		name: `E2E 7-11 飯糰 ${Date.now()}`,
		brand: "7-ELEVEN",
		nutrition: {
			base_unit: "g",
			serving_grams: "110.00",
			kcal: "181.82",
			protein_g: "4.55",
			fat_g: "3.64",
			carb_g: "32.73",
			serving_kcal: "200.00",
			serving_protein_g: "5.00",
			serving_fat_g: "4.00",
			serving_carb_g: "36.00",
		},
		confidence: "0.70",
		consistency: { atwater_kcal: "200.00", deviation: "0.00", flagged: false },
		remaining_today: 19,
	} satisfies AnalyzeResponse;
	const sent: Sent = [];
	// 只對整段路徑：`**/api/ai/analyze` 不會吃到 analyze-meal。
	await page.route("**/api/ai/analyze", async (route) => {
		sent.push(route.request().postDataJSON());
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify(estimate),
		});
	});

	await loginAs(page, account);
	await openNewFood(page);
	// 新增食物裡叫「拍照估算」的只有 AI 面板這一顆（營養標示是「拍營養標示」）。
	await page
		.getByLabel("拍照估算", { exact: true })
		.setInputFiles(await photo(page, "onigiri.jpg"));
	const step = page.getByRole("region", { name: "確認照片", exact: true });
	await step.getByLabel("補充說明（選填）", { exact: true }).fill("7-11 的");
	await step.getByRole("button", { name: "開始估算", exact: true }).click();

	const card = page.getByRole("region", { name: "AI 估算結果", exact: true });
	await expect(card).toContainText(estimate.name);
	await expect(step).toHaveCount(0);
	expect(sent).toHaveLength(1);
	expect(sent[0]?.kind).toBe("image");
	expect(sent[0]?.hint).toBe("7-11 的");
});

test("營養標示：說明送到 /api/ai/read-label；取消不送", async ({
	page,
	request,
}) => {
	const account = await newAccount(request, "hint-label");
	const label = {
		analysis_id: 31,
		name: `E2E 無糖豆漿 ${Date.now()}`,
		nutrition: {
			base_unit: "ml",
			kcal: "35.00",
			protein_g: "3.60",
			fat_g: "1.90",
			carb_g: "0.80",
		},
		serving: null,
		servings_per_package: null,
		basis: "per_100",
		confidence: "0.80",
		consistency: { atwater_kcal: "34.70", deviation: "0.30", flagged: false },
		remaining_today: 18,
	} satisfies LabelReadResponse;
	const sent: Sent = [];
	await page.route("**/api/ai/read-label", async (route) => {
		sent.push(route.request().postDataJSON());
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify(label),
		});
	});

	await loginAs(page, account);
	await openNewFood(page);
	const picker = page.getByLabel("拍營養標示", { exact: true });
	const step = page.getByRole("region", { name: "確認照片", exact: true });

	// 1. 選了又取消：卡片收起、沒有送、焦點回到照片按鈕。
	await picker.setInputFiles(await photo(page, "wrong.jpg"));
	await step.getByRole("button", { name: "取消", exact: true }).click();
	await expect(step).toHaveCount(0);
	await expect(picker).toBeFocused();
	expect(sent).toHaveLength(0);

	// 2. 再選一張、打說明、開始讀取。
	await picker.setInputFiles(await photo(page, "label.jpg"));
	const hint = step.getByLabel("補充說明（選填）", { exact: true });
	await expect(hint).toHaveAttribute(
		"placeholder",
		"例：這是每 100 ml、一包 2 份",
	);
	await hint.fill("這是每 100 ml");
	await step.getByRole("button", { name: "開始讀取", exact: true }).click();

	await expect(
		page.getByText("AI 讀的數字，請對照包裝確認", { exact: true }),
	).toBeVisible();
	await expect(step).toHaveCount(0);
	await expect(page.getByLabel("單位", { exact: true })).toHaveValue("ml");
	expect(sent).toHaveLength(1);
	expect(Object.keys(sent[0] ?? {})).toEqual(["image_base64", "hint"]);
	expect(sent[0]?.hint).toBe("這是每 100 ml");
});
