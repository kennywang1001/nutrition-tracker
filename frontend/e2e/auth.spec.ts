import { expect, test } from "@playwright/test";

const EMAIL = "kenny.demo@example.com";
const PASSWORD = "demo-pass-12345";

test("登入之後看得到已登入的畫面", async ({ page }) => {
	await page.goto("/");
	await page.getByLabel("Email").fill(EMAIL);
	await page.getByLabel("密碼").fill(PASSWORD);
	await page.getByRole("button", { name: "登入" }).click();

	await expect(page.getByRole("heading", { name: "已登入" })).toBeVisible();
});

test("access token 過期時會自動換票並重送，使用者不會被踢出去", async ({
	page,
}) => {
	// 規格 §9.1：這條守的是「401 → refresh → 重送」這個跟後端的約定。
	// MSW 證明不了它——MSW 的 401 是我們自己寫的。
	await page.goto("/");
	await page.getByLabel("Email").fill(EMAIL);
	await page.getByLabel("密碼").fill(PASSWORD);
	await page.getByRole("button", { name: "登入" }).click();
	await expect(page.getByRole("heading", { name: "已登入" })).toBeVisible();

	// 把記憶體裡的 access token 換成一張無效的，模擬它過期。
	// refresh token 留著——這正是「票過期但 session 還活著」的狀態。
	await page.evaluate(() => {
		// biome-ignore lint/suspicious/noExplicitAny: 測試刻意戳進模組狀態
		(window as any).__forceExpireAccessToken?.();
	});

	// 觸發一次需要認證的請求：點「重新整理」打 /api/me。
	// 不能用登出——/api/auth/logout 不需要 access token，換票邏輯不會被觸發。
	const meResponse = page.waitForResponse(
		(response) =>
			response.url().includes("/api/me") && response.status() === 200,
	);
	await page.getByRole("button", { name: "重新整理" }).click();
	await meResponse;

	await expect(page.getByRole("heading", { name: "已登入" })).toBeVisible();
});
