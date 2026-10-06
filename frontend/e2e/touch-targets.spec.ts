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
		page.locator(
			"main button:visible, main label:has(input[type=radio]):visible",
		),
		"新增食物",
	);
});
