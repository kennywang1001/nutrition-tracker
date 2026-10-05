import { expect, type Page, test } from "@playwright/test";
import { ADMIN } from "./accounts.ts";

async function login(page: Page) {
	await page.goto("/");
	await page.getByLabel("Email").fill(ADMIN.email);
	await page.getByLabel("密碼").fill(ADMIN.password);
	await page.getByRole("button", { name: "登入" }).click();
	await expect(page.getByRole("heading", { name: "總覽" })).toBeVisible();
}

test("記一餐（有金額）→ 從總覽進編輯 → 改數量 → 刪掉這一餐，餐費也不見了", async ({
	page,
}) => {
	// 編輯餐點規格 §5.2。同一個帳號的其他 e2e 平行在記餐、記帳：
	// 一律用唯一的食物名稱與金額斷言，不看總數。
	await login(page);

	const stamp = Date.now();
	const foodName = `E2E 編輯 ${stamp}`;
	// 唯一的金額：時間線與報表都用它找那一筆。
	const cost = `${(stamp % 90000) + 10000}.37`;

	// 建一個私人食物（只用公克，不設份量）。
	await page.getByRole("link", { name: "飲食" }).click();
	await page.getByRole("link", { name: "食物庫" }).click();
	await page.getByRole("link", { name: "新增食物" }).click();
	await page.getByLabel("名稱", { exact: true }).fill(foodName);
	await page.getByLabel("熱量（每 100 單位 kcal）").fill("100");
	await page.getByLabel("蛋白質（g）").fill("10");
	await page.getByLabel("脂肪（g）").fill("5");
	await page.getByLabel("碳水化合物（g）").fill("5");
	await page.getByRole("button", { name: "建立食物" }).click();
	await expect(page.getByRole("heading", { name: foodName })).toBeVisible();

	// 記一餐：100 g，有金額。
	await page.getByRole("button", { name: "新增紀錄" }).click();
	await page.getByRole("link", { name: "記一餐" }).click();
	await page.getByLabel("搜尋食物").fill(foodName);
	await page.getByRole("button", { name: foodName }).click();
	await page.getByLabel("份量", { exact: true }).fill("100");
	await page.getByLabel("金額（選填）").fill(cost);
	await page.getByRole("button", { name: "記錄" }).click();
	await expect(page.getByRole("heading", { name: "總覽" })).toBeVisible();

	// 從總覽時間線點那一列進編輯。
	const row = page.getByTestId("timeline-row").filter({ hasText: foodName });
	await expect(row).toHaveCount(1);
	await expect(row).toContainText(`$${cost}`);
	await row.getByRole("link").click();
	await expect(page.getByRole("heading", { name: "編輯這一餐" })).toBeVisible();
	await expect(page.getByLabel("金額（選填）")).toHaveValue(cost);

	// 改數量：100 → 250。
	await page.getByRole("button", { name: `修改${foodName}` }).click();
	const editor = page.getByRole("form", { name: `修改${foodName}` });
	await editor.getByLabel("份量", { exact: true }).fill("250");
	await editor.getByRole("button", { name: "儲存" }).click();
	await expect(editor).toHaveCount(0);
	await expect(page.getByTestId(/^meal-item-/)).toContainText("250 g");

	// 飲食頁那一項的公克數也變了。
	await page.getByRole("button", { name: "關閉" }).click();
	await expect(page.getByRole("heading", { name: "總覽" })).toBeVisible();
	await page.getByRole("link", { name: "飲食" }).click();
	// 餐點卡片是 <li>，裡面每個食物又是一個 <li>——取最後一個（內層那一項）。
	await expect(
		page.getByRole("listitem").filter({ hasText: foodName }).last(),
	).toContainText("250 g");

	// 從飲食頁卡片的「編輯」進去，刪掉這一餐。
	await page
		.getByRole("listitem")
		.filter({ hasText: foodName })
		.first()
		.getByRole("link", { name: /^編輯/ })
		.click();
	await page.getByRole("button", { name: "刪除這一餐" }).click();
	const dialog = page.getByRole("alertdialog", { name: "確認刪除這一餐" });
	await expect(dialog).toContainText(`這一餐的餐費 $${cost} 也會一起刪除`);
	await dialog.getByRole("button", { name: "確定刪除" }).click();

	// 回到飲食頁，那一餐不見了。
	await expect(page.getByRole("heading", { name: "今日餐點" })).toBeVisible();
	await expect(
		page.getByRole("listitem").filter({ hasText: foodName }),
	).toHaveCount(0);

	// 報表裡那筆餐費也不見了（SET NULL 的話它會留下來，只是少了「（餐費）」）。
	await page.getByRole("link", { name: "報表" }).click();
	await expect(page.getByTestId(/^expense-/).first()).toBeVisible();
	await expect(
		page.getByTestId(/^expense-/).filter({ hasText: cost }),
	).toHaveCount(0);
});
