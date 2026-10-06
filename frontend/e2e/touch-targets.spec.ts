import { expect, test } from "@playwright/test";
import { expectTouchTargets, login } from "./touch-targets.ts";

// 介面改版第二階段：舊畫面在手機上的點擊目標都 ≥ 44px。
test.use({ viewport: { width: 390, height: 844 } });

test("食物庫：「新增食物」連結、搜尋結果與範圍選項都 ≥ 44px", async ({
	page,
}) => {
	await login(page);
	// 建一個唯一名稱的私人食物，讓搜尋一定有結果可以量。
	const name = `E2E 搜尋 ${Date.now()}`;
	await page.goto("/foods/new");
	await page.getByLabel("名稱", { exact: true }).fill(name);
	await page.getByLabel("熱量（每 100 單位 kcal）").fill("100");
	await page.getByLabel("蛋白質（g）", { exact: true }).fill("1");
	await page.getByLabel("脂肪（g）", { exact: true }).fill("1");
	await page.getByLabel("碳水化合物（g）", { exact: true }).fill("1");
	await page.getByRole("button", { name: "建立食物" }).click();
	await expect(page.getByRole("heading", { name })).toBeVisible();

	await page.goto("/foods");
	await page.getByLabel("搜尋食物").fill(name);
	await expect(page.getByRole("link", { name, exact: true })).toBeVisible();
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

test("報表：支出清單的按鈕都 ≥ 44px", async ({ page }) => {
	await login(page);
	// 先記一筆，清單才一定有東西（同 money-loop.spec.ts 的步驟）。
	await page.getByRole("button", { name: "新增紀錄" }).click();
	await page.getByRole("link", { name: "記帳" }).click();
	await expect(
		page.getByRole("heading", { name: "記帳", exact: true }),
	).toBeVisible();
	for (const key of ["4", "2"]) {
		await page.getByRole("button", { name: key, exact: true }).click();
	}
	await page.getByRole("button", { name: "交通" }).click();
	const note = `e2e-touch-${Date.now()}`;
	await page.getByLabel("備註").fill(note);
	await page.getByRole("button", { name: "記一筆" }).click();
	await expect(page.getByRole("heading", { name: "總覽" })).toBeVisible();

	await page.goto("/reports");
	const row = page
		.locator('main li[data-testid^="expense-"]')
		.filter({ hasText: note });
	await expect(row).toHaveCount(1);
	await expectTouchTargets(row.locator("button:visible"), "報表清單");

	// 打開修改與刪除確認，裡面的按鈕也量。
	await row.getByRole("button", { name: "修改", exact: true }).click();
	await expectTouchTargets(row.locator("button:visible"), "報表清單（修改中）");
	await row.getByRole("button", { name: "放棄", exact: true }).click();
	await row.getByRole("button", { name: "刪除", exact: true }).click();
	await expectTouchTargets(
		row.locator("button:visible"),
		"報表清單（確認刪除）",
	);
});
