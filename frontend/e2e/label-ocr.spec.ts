import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import type { components } from "../src/api/schema.d.ts";
import { generateJpegBuffer } from "./jpeg.ts";
import { loginAs, newAccount } from "./new-account.ts";
import { expectTouchTargets } from "./touch-targets.ts";

type LabelReadResponse = components["schemas"]["LabelReadResponse"];

// 營養標示先用手機辨識（標示 OCR 規格 §8）：**真的** Tesseract.js（Chromium、dev 伺服器）讀
// `fixtures/nutrition-label.jpg`，文字送**真的**後端解析。只假造 AI 的 read-label。
test.use({ viewport: { width: 390, height: 844 } });

const LABEL_PHOTO = fileURLToPath(
	new URL("./fixtures/nutrition-label.jpg", import.meta.url),
);

/** 規格 §4.5 第二個算例：只有每份（每日參考值那一欄的 `%` 都在）。 */
const SERVING_ONLY = [
	"每一份量 250 毫升",
	"本包裝含1份",
	"每份     每日參考值百分比",
	"熱量         135 大卡           7%",
	"蛋白質        8.0 公克           13%",
	"脂肪                      7.5 公克                         13%",
	"碳水化合物      9.0 公克           3%",
].join("\n");

/** 只有每 100 的三項（沒有碳水化合物）。 */
const THREE_OF_FOUR = [
	"每100公克",
	"熱量 514 大卡",
	"蛋白質 6.0 公克",
	"脂肪 28.0 公克",
].join("\n");

/** 這一頁送出去的 `parse-label-text` 的 body（在測試本體斷言）。 */
function recordParses(page: Page): unknown[] {
	const parsed: unknown[] = [];
	page.on("request", (sent) => {
		if (new URL(sent.url()).pathname === "/api/foods/parse-label-text") {
			parsed.push(sent.postDataJSON());
		}
	});
	return parsed;
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

/** 新增食物的四個數字。 */
async function expectValues(page: Page, values: readonly string[]) {
	const labels = [
		"熱量（每 100 單位 kcal）",
		"蛋白質（g）",
		"脂肪（g）",
		"碳水化合物（g）",
	];
	for (const [index, label] of labels.entries()) {
		await expect(page.getByLabel(label, { exact: true })).toHaveValue(
			values[index] ?? "",
		);
	}
}

test("拍營養標示：手機真的讀固定的照片 → 表單填好 → 建立；不打 AI、照片不送出去", async ({
	page,
	request,
}) => {
	test.setTimeout(60_000);
	const account = await newAccount(request, "label-ocr");
	const ai: string[] = [];
	await page.route("**/api/ai/read-label", async (route) => {
		ai.push(route.request().url());
		await route.abort();
	});
	const parsed: unknown[] = [];
	const foreign: string[] = [];
	page.on("request", (sent) => {
		const url = sent.url();
		if (new URL(url).pathname === "/api/foods/parse-label-text") {
			parsed.push(sent.postDataJSON());
		}
		if (!/^(http:\/\/localhost:5173\/|data:|blob:)/.test(url))
			foreign.push(url);
	});

	await loginAs(page, account);
	await openNewFood(page);
	const started = Date.now();
	await page
		.getByLabel("拍營養標示", { exact: true })
		.setInputFiles(LABEL_PHOTO);
	await expect(page.getByText("手機辨識中…", { exact: true })).toBeVisible();
	await expect(
		page.getByText("手機辨識的數字，請對照包裝確認", { exact: true }),
	).toBeVisible({ timeout: 30_000 });
	console.log(
		`手機辨識（含第一次下載，dev 伺服器）：${Date.now() - started} ms`,
	);

	await expectValues(page, ["514.00", "6.00", "28.00", "60.90"]);
	await expect(page.getByLabel("單位", { exact: true })).toHaveValue("g");
	await expect(page.getByLabel("份量名稱", { exact: true })).toHaveValue("份");
	await expect(page.getByLabel("每份重量（g）", { exact: true })).toHaveValue(
		"35.00",
	);
	await expect(page.getByText("本包裝含 4 份", { exact: true })).toBeVisible();
	await expect(
		page.getByRole("region", { name: "確認照片", exact: true }),
	).toHaveCount(0);
	await expect(
		page.getByRole("button", {
			name: "數字不對？改用 AI 讀（用 1 次額度）",
			exact: true,
		}),
	).toBeVisible();
	expect(ai).toHaveLength(0);
	expect(parsed).toHaveLength(1);
	expect(Object.keys(parsed[0] as object)).toEqual(["text"]);
	expect(foreign).toEqual([]);

	const name = `E2E 手機辨識 ${Date.now()}`;
	await page.getByLabel("名稱", { exact: true }).fill(name);
	await page.getByRole("button", { name: "建立食物", exact: true }).click();
	await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
});

test("讀不出來 → 改用 AI 讀（只假造 read-label）；卡片 44px、說明欄 16px", async ({
	page,
	request,
}) => {
	test.setTimeout(60_000);
	const account = await newAccount(request, "label-ocr-ai");
	const label = {
		analysis_id: 52,
		name: null,
		nutrition: {
			base_unit: "ml",
			kcal: "42.00",
			protein_g: "0.00",
			fat_g: "0.00",
			carb_g: "10.60",
		},
		serving: null,
		servings_per_package: null,
		basis: "per_100",
		confidence: "0.80",
		consistency: { atwater_kcal: "42.40", deviation: "0.40", flagged: false },
		remaining_today: 18,
	} satisfies LabelReadResponse;
	// 記下送了什麼，在測試本體斷言（route 的 callback 裡丟的例外不會讓測試在那一行紅）。
	const sent: Array<Record<string, unknown>> = [];
	await page.route("**/api/ai/read-label", async (route) => {
		sent.push(route.request().postDataJSON());
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify(label),
		});
	});
	const parsed = recordParses(page);

	await loginAs(page, account);
	await openNewFood(page);
	// 8×8 的橘色 JPEG：Tesseract 回空字串（Task 6 在 dev 上實測），不打後端。
	await page.getByLabel("拍營養標示", { exact: true }).setInputFiles({
		name: "blank.jpg",
		mimeType: "image/jpeg",
		buffer: await generateJpegBuffer(page),
	});
	const step = page.getByRole("region", { name: "確認照片", exact: true });
	await expect(step.getByRole("status")).toHaveText("手機讀不出這張營養標示", {
		timeout: 30_000,
	});
	await expect(
		step.getByRole("img", { name: "營養標示的照片", exact: true }),
	).toBeVisible();
	await expect(
		step.getByRole("button", { name: "填入讀到的", exact: true }),
	).toHaveCount(0);
	expect(parsed).toHaveLength(0);

	// 16px（iOS 聚焦放大）、44px 的按鈕；說明欄本身也是點擊目標。
	const hint = step.getByLabel("補充說明（選填）", { exact: true });
	expect(await hint.evaluate((el) => getComputedStyle(el).fontSize)).toBe(
		"16px",
	);
	const targets = step.locator("button, textarea");
	// 改用 AI 讀、取消、說明欄：數得對才知道量到的是卡片裡的那幾個。
	await expect(targets).toHaveCount(3);
	await expectTouchTargets(targets, "確認照片");

	await step
		.getByRole("button", { name: "改用 AI 讀（用 1 次額度）", exact: true })
		.click();
	await expect(
		page.getByText("AI 讀的數字，請對照包裝確認", { exact: true }),
	).toBeVisible();
	await expect(step).toHaveCount(0);
	await expect(page.getByLabel("單位", { exact: true })).toHaveValue("ml");
	await expectValues(page, ["42.00", "0.00", "0.00", "10.60"]);
	await expect(
		page.getByText("今天還能用 18 次", { exact: true }),
	).toBeVisible();
	expect(sent).toHaveLength(1);
	// 沒打說明就沒有 hint；照片只送給 AI 這一次。
	expect(Object.keys(sent[0] ?? {})).toEqual(["image_base64"]);
	expect(String(sent[0]?.image_base64).length).toBeGreaterThan(100);
	expect(parsed).toHaveLength(0);
});

test("貼上營養標示文字：只有每份 → 每 100 ml；不完整 → 填入讀到的", async ({
	page,
	request,
}) => {
	const account = await newAccount(request, "label-paste");
	const ai: string[] = [];
	await page.route("**/api/ai/read-label", async (route) => {
		ai.push(route.request().url());
		await route.abort();
	});
	const parsed = recordParses(page);

	await loginAs(page, account);
	await openNewFood(page);
	const toggle = page.getByRole("button", {
		name: "貼上營養標示文字",
		exact: true,
	});
	const paste = page.getByRole("region", {
		name: "貼上營養標示文字",
		exact: true,
	});
	// 一定要 exact：不帶的話 region 的 aria-label「貼上營養標示文字」也算。
	const text = paste.getByLabel("營養標示文字", { exact: true });
	const read = paste.getByRole("button", { name: "讀取文字", exact: true });

	await expect(toggle).toHaveAttribute("aria-expanded", "false");
	await expect(paste).toHaveCount(0);
	await toggle.click();
	await expect(toggle).toHaveAttribute("aria-expanded", "true");
	await expect(paste).toBeVisible();
	await expect(read).toHaveAttribute("aria-disabled", "true");
	expect(await text.evaluate((el) => getComputedStyle(el).fontSize)).toBe(
		"16px",
	);
	const targets = paste.locator("button, textarea");
	// 讀取文字、取消、文字欄。
	await expect(targets).toHaveCount(3);
	await expectTouchTargets(targets, "貼上營養標示文字");

	// ① 只有每份：後端換算成每 100 ml，表單切到 ml、一份 250 ml。
	await text.fill(SERVING_ONLY);
	await expect(read).toHaveAttribute("aria-disabled", "false");
	await read.click();
	await expect(
		page.getByText("從貼上的文字讀的數字，請對照包裝確認", { exact: true }),
	).toBeVisible();
	await expect(paste).toHaveCount(0);
	await expect(toggle).toHaveAttribute("aria-expanded", "false");
	await expect(page.getByLabel("單位", { exact: true })).toHaveValue("ml");
	await expectValues(page, ["54.00", "3.20", "3.00", "3.60"]);
	await expect(page.getByLabel("份量名稱", { exact: true })).toHaveValue("份");
	await expect(page.getByLabel("每份重量（ml）", { exact: true })).toHaveValue(
		"250.00",
	);
	await expect(page.getByText("本包裝含 1 份", { exact: true })).toBeVisible();
	// 貼上的沒有照片，結果那一段沒有改用 AI 的按鈕。
	await expect(
		page.getByRole("button", {
			name: "數字不對？改用 AI 讀（用 1 次額度）",
			exact: true,
		}),
	).toHaveCount(0);
	await expect(
		page.getByRole("button", {
			name: "改用 AI 讀（用 1 次額度）",
			exact: true,
		}),
	).toHaveCount(0);

	// ② 再打開、貼三項：說讀到什麼、缺什麼，表單先不動；「填入讀到的」才填，缺的是空的。
	await toggle.click();
	await expect(paste).toBeVisible();
	await expect(text).toHaveValue("");
	await text.fill(THREE_OF_FOUR);
	await read.click();
	await expect(paste.getByRole("status")).toHaveText(
		"讀到：熱量 514 kcal、蛋白質 6 g、脂肪 28 g（每 100 g）；讀不到：碳水化合物",
	);
	await expectValues(page, ["54.00", "3.20", "3.00", "3.60"]);
	await paste.getByRole("button", { name: "填入讀到的", exact: true }).click();
	await expect(
		page.getByText("填入了讀到的數字，其餘請自己填", { exact: true }),
	).toBeVisible();
	await expect(paste).toHaveCount(0);
	await expectValues(page, ["514.00", "6.00", "28.00", ""]);
	await expect(page.getByLabel("單位", { exact: true })).toHaveValue("g");

	// 兩次都是真的後端；body 只有 text。沒有打 AI。
	expect(parsed).toEqual([{ text: SERVING_ONLY }, { text: THREE_OF_FOUR }]);
	expect(ai).toHaveLength(0);
});
