import { expect, type Page, test } from "@playwright/test";
import { ADMIN } from "./accounts.ts";

async function login(page: Page) {
	await page.goto("/");
	await page.getByLabel("Email").fill(ADMIN.email);
	await page.getByLabel("密碼").fill(ADMIN.password);
	await page.getByRole("button", { name: "登入" }).click();
	await expect(page.getByRole("heading", { name: "總覽" })).toBeVisible();
}

async function openLogMeal(page: Page) {
	await page.getByRole("button", { name: "新增紀錄" }).click();
	await page.getByRole("link", { name: "記一餐" }).click();
	await expect(page.getByRole("heading", { name: "記一餐" })).toBeVisible();
}

// CI 沒有 AI 金鑰，而且 e2e 不該花錢——只走不需要呼叫 AI 的路
// （AI 估算前端規格 §6.2）。真的呼叫 AI 的路由元件測試與後端測試守著。
//
// 記一餐的 AI 入口現在是 `AiMealPanel`、打的是 `/api/ai/analyze-meal`
// （AI 多樣估算規格 D16）。這兩條走的是那支端點在**真的後端**上不花錢的兩條路：
// 文字的食物庫短路（D6）與 `503 AI_NOT_CONFIGURED`。面板的文字沒有變，所以只看畫面
// 分不出打的是新端點還是舊的——兩條都另外斷言回應的網址與內容。
// 多樣的勾選清單在 `ai-multi-food.spec.ts`（那裡的估算回應是假的）。

/** 記一餐的 AI 入口打出去的那個請求的回應。**在按按鈕之前**就要開始等。 */
function analyzeMealResponse(page: Page) {
	return page.waitForResponse(
		(response) =>
			new URL(response.url()).pathname === "/api/ai/analyze-meal" &&
			response.request().method() === "POST",
	);
}

test("AI 估算命中食物庫：「用這個」→ 記錄 → 飲食頁看到那個食物", async ({
	page,
}) => {
	await login(page);
	const foodName = `E2E AI ${Date.now()}`;

	// 先建一個唯一名稱的食物（食物庫的比對是精確比對名稱）。
	await page.getByRole("link", { name: "飲食" }).click();
	await page.getByRole("link", { name: "食物庫" }).click();
	await page.getByRole("link", { name: "新增食物" }).click();
	await page.getByLabel("名稱", { exact: true }).fill(foodName);
	await page.getByLabel("熱量（每 100 單位 kcal）").fill("100");
	await page.getByLabel("蛋白質（g）", { exact: true }).fill("10");
	await page.getByLabel("脂肪（g）", { exact: true }).fill("5");
	await page.getByLabel("碳水化合物（g）", { exact: true }).fill("5");
	await page.getByRole("button", { name: "建立食物" }).click();
	await expect(page.getByRole("heading", { name: foodName })).toBeVisible();

	await openLogMeal(page);
	await page.getByLabel("搜尋食物").fill(foodName);
	const analyzed = analyzeMealResponse(page);
	await page.getByRole("button", { name: `用 AI 估算「${foodName}」` }).click();
	const response = await analyzed;
	expect(response.status()).toBe(200);
	// 沒有呼叫 AI：整段文字就是食物庫裡的食物。
	expect(
		((await response.json()) as { analysis_id: number | null }).analysis_id,
	).toBeNull();
	const hit = page.getByRole("region", { name: "食物庫裡的食物" });
	await expect(hit).toContainText(`食物庫裡已經有「${foodName}」`);
	await hit.getByRole("button", { name: "用這個" }).click();

	await expect(page.getByText(`已選擇：${foodName}`)).toBeVisible();
	await page.getByLabel("份量", { exact: true }).fill("100");
	await page.getByRole("button", { name: "記錄", exact: true }).click();
	await expect(page.getByRole("heading", { name: "總覽" })).toBeVisible();

	await page.getByRole("link", { name: "飲食" }).click();
	// 餐點卡片是 <li>，裡面每個食物又是一個 <li>——取最後一個（內層那一項）。
	await expect(
		page.getByRole("listitem").filter({ hasText: foodName }).last(),
	).toContainText("100 g");
});

test("AI 沒設定：估算一個食物庫沒有的東西，說「AI 分析未設定」", async ({
	page,
}) => {
	await login(page);
	await openLogMeal(page);
	const text = `E2E 食物庫沒有這個 ${Date.now()}`;

	await page.getByLabel("搜尋食物").fill(text);
	const analyzed = analyzeMealResponse(page);
	await page.getByRole("button", { name: `用 AI 估算「${text}」` }).click();
	// 是真的後端說「沒設定」，不是面板自己猜的。
	expect((await analyzed).status()).toBe(503);

	// 這個畫面還沒選食物、沒有其他錯誤，所以只有面板的那一個 alert。
	await expect(page.getByRole("alert")).toHaveText("AI 分析未設定");
});
