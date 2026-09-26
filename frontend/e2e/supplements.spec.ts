import { expect, test } from "@playwright/test";
import { ADMIN } from "./accounts.ts";

async function login(page: import("@playwright/test").Page) {
	await page.goto("/");
	await page.getByLabel("Email").fill(ADMIN.email);
	await page.getByLabel("密碼").fill(ADMIN.password);
	await page.getByRole("button", { name: "登入" }).click();
}

test("新增補劑 → 今天吃了 → 今日總覽看得到它", async ({ page }) => {
	// 規格來源：使用者原話（2026-09-26）「補劑類 我想要能新增我有在使用的
	// 當天有吃就點一份進去就好」。這條契約 E2E 走完整條路徑：
	// POST /api/supplements（新增）→ POST /api/supplement-intakes
	// （plan_id: null 的臨時記錄）→ 今日總覽讀得到。
	await login(page);
	await expect(page.getByRole("heading", { name: "今日總覽" })).toBeVisible();

	// 入口是「今日補劑」區塊的連結，不是第六個 tab（計畫 Task 2 的說明）。
	await page.getByRole("link", { name: "新增補劑" }).click();
	await expect(page.getByRole("heading", { name: "補劑" })).toBeVisible();

	// 名稱帶 Date.now()——POST /api/supplements 有唯一約束
	// （uq_supplements_owner_id_name_brand，app/models/supplement.py），
	// 已實測確認：重複的 (owner_id, name, brand) 會被 409 SUPPLEMENT_EXISTS
	// 擋下來，這條測試不能每次都用同一個名字。
	const supplementName = `E2E 補劑 ${Date.now()}`;
	await page.getByLabel("名稱").fill(supplementName);
	await page.getByLabel("單位（例如：顆、粒、g）").fill("顆");
	await page.getByLabel("每份份量").fill("1");

	const [createResponse] = await Promise.all([
		page.waitForResponse(
			(response) =>
				response.url().includes("/api/supplements") &&
				!response.url().includes("/today") &&
				response.request().method() === "POST",
		),
		page.getByRole("button", { name: "新增補劑" }).click(),
	]);
	expect(createResponse.ok()).toBe(true);

	// 新增成功後 Supplements.tsx 把搜尋框設成新補劑的名字（見該檔案的
	// 說明：「新增」跟「今天吃了」在使用者原話裡是同一個動作的兩個步驟），
	// 搜尋結果應該立刻出現、帶著「今天吃了」按鈕。
	await expect(page.getByRole("button", { name: "今天吃了" })).toBeVisible();

	// **等存檔完成再導頁。** e2e/trend.spec.ts 踩過的坑：按下送出就立刻
	// 點下一個連結，請求還在飛的時候元件被卸載——單獨跑永遠綠、平行跑
	// 才會露出機率性的紅，而且紅的訊息會指向錯誤的地方。這裡直接等
	// POST /api/supplement-intakes 的回應，而不是猜測某個 UI 訊號多快出現。
	const [intakeResponse] = await Promise.all([
		page.waitForResponse(
			(response) =>
				response.url().includes("/api/supplement-intakes") &&
				response.request().method() === "POST",
		),
		page.getByRole("button", { name: "今天吃了" }).click(),
	]);
	expect(intakeResponse.ok()).toBe(true);

	// 「今日狀態」清單裡這一筆要顯示「已記錄」——plan_id 是 null 的臨時記錄
	// 一定已經完成，不是「待打卡」（跟 Today.tsx 的規則相同）。
	const statusRow = page
		.getByRole("listitem")
		.filter({ hasText: supplementName })
		.filter({ hasText: "已記錄" });
	await expect(statusRow).toBeVisible();

	// 回今日總覽，同一筆補劑要看得到。
	await page.getByRole("link", { name: "今日總覽" }).click();
	await expect(page.getByRole("heading", { name: "今日總覽" })).toBeVisible();
	await expect(page.getByText(supplementName)).toBeVisible();
});
