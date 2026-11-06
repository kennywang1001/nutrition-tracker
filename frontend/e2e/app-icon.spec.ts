import { expect, test } from "@playwright/test";

// 改名「吃什麼」與新圖示（改名規格 D10–D12）。不用登入：標題與圖示在登入頁就有。
test("標題是「吃什麼」；iPhone 主畫面與分頁的圖示拿得到", async ({
	page,
	request,
}) => {
	await page.goto("/");
	await expect(page).toHaveTitle("吃什麼");
	await expect(
		page.locator('meta[name="apple-mobile-web-app-title"]'),
	).toHaveAttribute("content", "吃什麼");
	const icons = [
		['link[rel="apple-touch-icon"]', "image/png"],
		['link[rel="icon"]', "image/svg+xml"],
	] as const;
	for (const [selector, type] of icons) {
		const href = await page.locator(selector).getAttribute("href");
		expect(href, selector).not.toBeNull();
		const response = await request.get(href ?? "");
		expect(response.status(), selector).toBe(200);
		expect(response.headers()["content-type"], selector).toContain(type);
	}
});
