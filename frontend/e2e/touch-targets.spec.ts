import { expect, test } from "@playwright/test";
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
		page.locator(
			"main button:visible, main label:has(input[type=radio]):visible",
		),
		"新增食物",
	);
});

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

test("補劑：按鈕都 ≥ 44px", async ({ page }) => {
	await login(page);
	await page.goto("/supplements");
	await expect(
		page.getByRole("heading", { name: "補劑", exact: true }),
	).toBeVisible();
	await expectTouchTargets(page.locator("main button:visible"), "補劑");
});

test("趨勢：營養素切換的選項都 ≥ 44px", async ({ page }) => {
	await login(page);
	await page.goto("/trend");
	await expect(
		page.getByRole("heading", { name: "趨勢", exact: true }),
	).toBeVisible();
	// 標題在載入中就有了，選項要等資料回來才出現。
	await expect(page.getByRole("radio", { name: "熱量" })).toBeAttached();
	await expectTouchTargets(
		page.locator("main label:has(input[type=radio]):visible"),
		"趨勢",
	);
});
