import { expect, test } from "@playwright/test";
import { ADMIN } from "./accounts.ts";

async function login(page: import("@playwright/test").Page) {
	await page.goto("/");
	await page.getByLabel("Email").fill(ADMIN.email);
	await page.getByLabel("密碼").fill(ADMIN.password);
	await page.getByRole("button", { name: "登入" }).click();
	await expect(page.getByRole("heading", { name: "總覽" })).toBeVisible();
}

test("新增食物時設一份 → 記一餐自動選上那一份 → 記下的是那一份的重量", async ({
	page,
}) => {
	// 食物份量規格 §7.2。斷言用「餐點清單裡那個食物顯示 150 g」而不是
	// 熱量差——同一個帳號的其他 e2e 平行在記餐，熱量總數會一起變。
	await login(page);

	const foodName = `E2E 份量 ${Date.now()}`;
	await page.getByRole("link", { name: "飲食" }).click();
	await page.getByRole("link", { name: "食物庫" }).click();
	await page.getByRole("link", { name: "新增食物" }).click();
	await expect(page.getByRole("heading", { name: "新增食物" })).toBeVisible();

	await page.getByLabel("名稱", { exact: true }).fill(foodName);
	await page.getByLabel("份量名稱").fill("碗");
	await page.getByLabel("每份重量（g）").fill("150");
	await page.getByLabel("熱量（每 100 單位 kcal）").fill("100");
	await page.getByLabel("蛋白質（g）").fill("10");
	await page.getByLabel("脂肪（g）").fill("5");
	await page.getByLabel("碳水化合物（g）").fill("5");
	await page.getByRole("button", { name: "建立食物" }).click();

	// 導到詳情頁，份量清單裡有剛建的那一份。
	await expect(page.getByRole("heading", { name: foodName })).toBeVisible();
	// 那一列的完整文字是「碗（150 g）・預設」——用正規表示式，不是精確比對。
	await expect(page.getByText(/碗（150 g）/)).toBeVisible();

	await page.getByRole("button", { name: "新增紀錄" }).click();
	await page.getByRole("link", { name: "記一餐" }).click();
	await page.getByLabel("搜尋食物").fill(foodName);
	await page.getByRole("button", { name: foodName }).click();

	// 預設份量自動選上，數量 1。
	await expect(page.locator("#portion option:checked")).toHaveText("碗");
	await expect(page.getByLabel("份量", { exact: true })).toHaveValue("1");
	await page.getByRole("button", { name: "記錄" }).click();

	await expect(page.getByRole("heading", { name: "總覽" })).toBeVisible();
	await page.getByRole("link", { name: "飲食" }).click();
	// 餐點卡片本身是 <li>，裡面每個食物又是一個 <li>（MealList）——用食物
	// 名稱篩會同時抓到外層與內層，strict mode 會報錯。取最後一個（內層那一項）。
	await expect(
		page.getByRole("listitem").filter({ hasText: foodName }).last(),
	).toContainText("150 g");
});
