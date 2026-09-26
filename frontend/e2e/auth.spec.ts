import { expect, test } from "@playwright/test";
import { ADMIN } from "./accounts.ts";

test("登入之後看得到記一餐", async ({ page }) => {
	// 計畫二（Task 1）把登入後的畫面從一個扁平的「已登入」佔位頁換成
	// React Router 的路由——這裡的斷言跟著換，斷言的意圖不變：登入成功後
	// 不再停在登入畫面。
	//
	// P3-C Task 3：首頁從今日總覽換成記一餐（使用者原話「記一餐應該放在
	// 首頁」）——這條測試原本斷言「今日總覽」，那不再是登入後的落地頁，
	// 改斷言「記一餐」正是這個 task 要驗的行為，不是遷就實作。
	await page.goto("/");
	await page.getByLabel("Email").fill(ADMIN.email);
	await page.getByLabel("密碼").fill(ADMIN.password);
	await page.getByRole("button", { name: "登入" }).click();

	await expect(page.getByRole("heading", { name: "記一餐" })).toBeVisible();
});

test("access token 過期時會自動換票並重送，使用者不會被踢出去", async ({
	page,
}) => {
	// 規格 §9.1：這條守的是「401 → refresh → 重送」這個跟後端的約定。
	// MSW 證明不了它——MSW 的 401 是我們自己寫的。
	await page.goto("/");
	await page.getByLabel("Email").fill(ADMIN.email);
	await page.getByLabel("密碼").fill(ADMIN.password);
	await page.getByRole("button", { name: "登入" }).click();
	// P3-C Task 3：首頁換成記一餐之後，這裡斷言的落地頁跟著換（見上面
	// 那條測試的說明）。這條測試全程停在首頁，不涉及導頁，只是換個標題。
	await expect(page.getByRole("heading", { name: "記一餐" })).toBeVisible();

	// 把記憶體裡的 access token 換成一張無效的，模擬它過期。
	// refresh token 留著——這正是「票過期但 session 還活著」的狀態。
	await page.evaluate(() => {
		// biome-ignore lint/suspicious/noExplicitAny: 測試刻意戳進模組狀態
		(window as any).__forceExpireAccessToken?.();
	});

	// 觸發一次需要認證的請求：點「重新整理」打 /api/me。
	// 不能用登出——/api/auth/logout 不需要 access token，換票邏輯不會被觸發。
	// 這個按鈕從 main.tsx 搬到了 App.tsx 的導覽列（計畫二 Task 1），
	// 但行為沒變。
	const meResponse = page.waitForResponse(
		(response) =>
			response.url().includes("/api/me") && response.status() === 200,
	);
	await page.getByRole("button", { name: "重新整理" }).click();
	await meResponse;

	await expect(page.getByRole("heading", { name: "記一餐" })).toBeVisible();
});
