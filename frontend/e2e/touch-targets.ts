import { expect, type Locator, type Page } from "@playwright/test";
import { ADMIN } from "./accounts.ts";

/** 登入（手機尺寸由呼叫端的 `test.use` 決定）。 */
export async function login(page: Page) {
	await page.goto("/");
	await page.getByLabel("Email").fill(ADMIN.email);
	await page.getByLabel("密碼").fill(ADMIN.password);
	await page.getByRole("button", { name: "登入" }).click();
	await expect(page.getByRole("heading", { name: "總覽" })).toBeVisible();
}

/** 斷言每一個點擊目標的高度 ≥ 44px（介面改版規格的觸控目標）。
 *
 *  **量的是真的瀏覽器版面**（`boundingBox()`）——單元測試的 jsdom 不做版面
 *  計算，高度永遠是 0，測不到這件事。瀏覽器預設的按鈕大約 21px、單選鈕的
 *  標籤大約 18px，所以樣式沒生效時這裡一定紅。
 *
 *  **至少要有一個**：選擇器寫錯、一個都沒找到時，迴圈不會跑、斷言不會執行，
 *  測試就空轉綠了（handover §6 一再出現的那種）。 */
export async function expectTouchTargets(targets: Locator, where: string) {
	const count = await targets.count();
	expect(count, `${where}：至少要有一個點擊目標`).toBeGreaterThan(0);
	for (let index = 0; index < count; index += 1) {
		const target = targets.nth(index);
		const box = await target.boundingBox();
		const name =
			(await target.textContent())?.trim() ||
			(await target.getAttribute("aria-label")) ||
			`第 ${index + 1} 個`;
		expect(
			box?.height ?? 0,
			`${where}：「${name}」的高度`,
		).toBeGreaterThanOrEqual(44);
	}
}
