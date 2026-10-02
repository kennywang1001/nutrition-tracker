import { expect, test } from "@playwright/test";
import { ADMIN } from "./accounts.ts";

async function login(page: import("@playwright/test").Page) {
	await page.goto("/");
	await page.getByLabel("Email").fill(ADMIN.email);
	await page.getByLabel("密碼").fill(ADMIN.password);
	await page.getByRole("button", { name: "登入" }).click();
}

test("記一筆錢之後，總覽的本月支出與今天的時間線跟著變", async ({ page }) => {
	// 這條路徑原本只有單元測試各自守一段（AddExpense 發出失效、前綴測試、
	// 總覽用後端的日期查），沒有一條真的走過「＋ → 記帳 → 總覽」並打到
	// 真的後端的 `?date=`。
	//
	// 只用點擊導航（token 在記憶體裡，page.goto 會登出）。
	// 其他 worker 可能同時對同一個帳號記帳，所以不對總額做算術——
	// 主要斷言是這條測試自己的唯一備註出現在今天的時間線，
	// 「本月支出的字樣變了」只是輔助（我們自己加了 123.45，不會相等）。
	await login(page);

	const monthSpend = page.getByTestId("month-spend");
	await expect(monthSpend).toHaveText(/\$\d/);
	const before = await monthSpend.textContent();

	await page.getByRole("button", { name: "新增紀錄" }).click();
	await page.getByRole("link", { name: "記帳" }).click();
	await expect(page.getByRole("heading", { name: "記帳" })).toBeVisible();

	for (const key of ["1", "2", "3", "小數點", "4", "5"]) {
		await page.getByRole("button", { name: key, exact: true }).click();
	}
	await expect(page.getByLabel("金額")).toHaveText(/123\.45/);

	await page.getByRole("button", { name: "交通" }).click();
	const note = `e2e-${Date.now()}`;
	await page.getByLabel("備註").fill(note);
	await page.getByRole("button", { name: "記一筆" }).click();

	await expect(page.getByRole("heading", { name: "總覽" })).toBeVisible();

	const row = page
		.getByTestId("timeline-row")
		.filter({ hasText: note })
		.filter({ hasText: "$123.45" });
	await expect(row).toHaveCount(1);
	await expect(monthSpend).not.toHaveText(before ?? "");
});
