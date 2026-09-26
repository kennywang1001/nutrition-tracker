import { expect, type Page, test } from "@playwright/test";
import { ADMIN } from "./accounts.ts";

// iOS Safari 在使用者點進 computed font-size < 16px 的輸入框時，會自動把
// 整頁放大——放大之後版面比視窗寬，使用者得往旁邊滑才看得到其他東西。
//
// **這條測試斷言的是規則（≥16px），不是症狀（頁面被放大）。**
// Chromium 不做那個自動放大，所以「頁面有沒有變寬」在這裡永遠是「沒有」，
// 拿它當斷言就是一個永遠綠的測試。
//
// 實測（2026-09-26，對已部署的正式站量的）：登入畫面兩個輸入框、
// 記一餐與食物庫的搜尋框、食物庫的三個 scope radio，全部都是 13.3333px。
// 而同一次量測確認橫向溢出【不存在】——320/360/390px 三種寬度下
// scrollWidth 都等於 clientWidth。所以這不是 layout 問題，不要去改版面。

// 手機視窗——跟正式站量測用的三種寬度（320/360/390）取中間偏大那個，
// 對齊「開工前已經查證過的事實」那次量測。字級規則本身不是靠
// media query 開的，所以理論上任何視窗寬度都測得到；用手機尺寸單純是
// 讓這條測試的意圖（模擬 iOS Safari 的情境）跟畫面本身一致。
test.use({ viewport: { width: 390, height: 844 } });

async function login(page: Page) {
	await page.goto("/");
	await page.getByLabel("Email").fill(ADMIN.email);
	await page.getByLabel("密碼").fill(ADMIN.password);
	await page.getByRole("button", { name: "登入" }).click();
	await expect(page.getByRole("heading", { name: "今日總覽" })).toBeVisible();
}

/** 走過目前畫面上「這一刻」存在的每一個 input / select / textarea，斷言
 *  computed font-size ≥ 16px。
 *
 *  **`button` 刻意不在此限**——iOS Safari 只對可打字／可選值的欄位
 *  （input、select、textarea）做自動縮放，按鈕本身不會觸發那個行為
 *  （計畫 Task 1 說明）。如果之後想更嚴格，把 button 一起納入沒問題，
 *  但目前只驗證真的會觸發症狀的三種元素，斷言才會精準對應到「為什麼
 *  要修」。
 *
 *  用 `count()` 迭代而不是 `evaluateAll`：出錯時要能講出「哪一個」控制項
 *  幾 px，`evaluateAll` 回傳的是陣列，錯誤訊息會失去這個資訊
 *  （突變驗證特別要求「訊息要指出是哪一個控制項、實際幾 px」）。 */
async function expectFormControlsAtLeast16px(page: Page, screenName: string) {
	const controls = page.locator("input, select, textarea");
	const count = await controls.count();
	expect(
		count,
		`${screenName}：這個斷言的前提是畫面上有表單控制項`,
	).toBeGreaterThan(0);

	for (let i = 0; i < count; i++) {
		const control = controls.nth(i);
		const [fontSize, description] = await control.evaluate((node) => [
			window.getComputedStyle(node).fontSize,
			// 錯誤訊息裡要看得出是哪一個欄位——id 或 name 通常就夠指認。
			`<${node.tagName.toLowerCase()} id="${node.id}" name="${(node as HTMLInputElement).name ?? ""}" type="${(node as HTMLInputElement).type ?? ""}">`,
		]);
		const px = Number.parseFloat(fontSize);
		expect(
			px,
			`${screenName} 的 ${description} computed font-size 是 ${fontSize}，` +
				"低於 iOS Safari 的 16px 門檻——會觸發自動放大。",
		).toBeGreaterThanOrEqual(16);
	}
}

test("登入畫面的表單控制項字級 ≥16px（iOS 縮放門檻）", async ({ page }) => {
	await page.goto("/");
	await expectFormControlsAtLeast16px(page, "登入畫面");
});

test("登入後的食物庫／新增食物／記一餐畫面，表單控制項字級 ≥16px", async ({
	page,
}) => {
	await login(page);

	await page.getByRole("link", { name: "食物庫" }).click();
	// react-router 是 client-side 換頁，`click()` resolve 不代表換頁完成。
	// 先等這個畫面獨有的 heading 出現，確保接下來數的是「換頁後」的
	// DOM——「今日總覽」的餐點清單裡有一個一直可見的照片上傳
	// `<input type="file">`（MealList.tsx 的 MealPhotoUpload），如果在
	// 換頁完成前就去數控制項，會數到舊畫面那個 input，跟這個畫面
	// 要驗的東西無關。
	await expect(page.getByRole("heading", { name: "食物庫" })).toBeVisible();
	// 搜尋框 + 三個 scope radio（全部／公開食物／我建立的）。
	await expectFormControlsAtLeast16px(page, "食物庫畫面");

	await page.getByRole("link", { name: "新增食物" }).click();
	await expect(page.getByRole("heading", { name: "新增食物" })).toBeVisible();
	// 名稱、品牌、單位 select、熱量／蛋白質／脂肪／碳水四個數值欄位。
	await expectFormControlsAtLeast16px(page, "新增食物畫面");

	// 建一筆食物，讓後面的「記一餐」畫面能選到它、展開份量與餐別欄位——
	// 那兩個欄位只有選了食物之後才會渲染，不建一筆真的選不到。
	const foodName = `E2E 縮放守衛食物 ${Date.now()}`;
	await page.getByLabel("名稱").fill(foodName);
	await page.getByLabel("熱量（每 100 單位 kcal）").fill("100");
	await page.getByLabel("蛋白質（g）").fill("10");
	await page.getByLabel("脂肪（g）").fill("5");
	await page.getByLabel("碳水化合物（g）").fill("5");
	await page.getByRole("button", { name: "建立食物" }).click();
	await expect(page.getByRole("heading", { name: foodName })).toBeVisible();

	await page.getByRole("link", { name: "記一餐" }).click();
	await expect(page.getByRole("heading", { name: "記一餐" })).toBeVisible();
	// 尚未選擇食物：畫面上只有搜尋框。
	await expectFormControlsAtLeast16px(page, "記一餐畫面（尚未選擇食物）");

	await page.getByLabel("搜尋食物").fill(foodName);
	await page.getByRole("button", { name: foodName }).click();
	// 選了食物之後：份量 input 與餐別 select 會出現（這個食物沒有
	// portion，份量 select 不會渲染——見 LogMeal.tsx 的條件）。等表單裡
	// 「已選擇：」那行文字出現，確保這次量到的是選好食物之後展開的欄位。
	await expect(page.getByText(`已選擇：${foodName}`)).toBeVisible();
	await expectFormControlsAtLeast16px(
		page,
		"記一餐畫面（已選擇食物，含份量與餐別欄位）",
	);
});
