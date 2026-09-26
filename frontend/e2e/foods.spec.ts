import { expect, test } from "@playwright/test";
import { ADMIN } from "./accounts.ts";

async function login(page: import("@playwright/test").Page) {
	await page.goto("/");
	await page.getByLabel("Email").fill(ADMIN.email);
	await page.getByLabel("密碼").fill(ADMIN.password);
	await page.getByRole("button", { name: "登入" }).click();
}

test("建立食物 → 在記一餐搜尋得到 → 記一筆 → 今日總覽數字變", async ({
	page,
}) => {
	// 規格 §10.2 第 1 條。跟 daily-loop.spec.ts 的「記一餐」測試不一樣的地方：
	// 那條測試用 API 直接建食物、記一筆「歷史」餐點，讓食物先出現在
	// 「常吃/最近吃」清單，再從那份清單裡點選。這裡刻意整段都走畫面
	// （/foods/new 建立、/log 的搜尋框找到），因為要驗的正是「新增食物」
	// 這個入口本身的契約：剛建出來、從沒被吃過的食物（不在常吃/最近吃
	// 清單裡）要能立刻被全庫搜尋找到——這是 Task 2–6 兜起來才有的行為，
	// 沒有任何一支既有的單元測試或 E2E 覆蓋過「建立」到「搜尋得到」這一段。
	await login(page);

	// P3-C Task 3：首頁從今日總覽換成記一餐，要先切過去才讀得到基準值。
	await page.getByRole("link", { name: "今日總覽" }).click();
	await expect(page.getByRole("heading", { name: "今日總覽" })).toBeVisible();
	const before = await page.getByTestId("macro-kcal").textContent();

	const foodName = `E2E 契約食物 ${Date.now()}`;
	await page.getByRole("link", { name: "食物庫" }).click();
	await page.getByRole("link", { name: "新增食物" }).click();

	await page.getByLabel("名稱").fill(foodName);
	await page.getByLabel("熱量（每 100 單位 kcal）").fill("100");
	await page.getByLabel("蛋白質（g）").fill("10");
	await page.getByLabel("脂肪（g）").fill("5");
	await page.getByLabel("碳水化合物（g）").fill("5");
	await page.getByRole("button", { name: "建立食物" }).click();

	// 成功後導到 /foods/:id——用標題出現食物名稱確認導航真的完成了，
	// 不斷言網址字串本身（跟 tests/new-food.test.tsx 的作法一致）。
	await expect(page.getByRole("heading", { name: foodName })).toBeVisible();

	await page.getByRole("link", { name: "記一餐" }).click();
	await page.getByLabel("搜尋食物").fill(foodName);
	// 不填「份量」——LogMeal 的 quantity 預設就是 "1"，跟
	// daily-loop.spec.ts 同一個作法：這條測試要驗的是「搜尋得到、記得進去、
	// 總覽會變」，不是份量計算本身，用預設值最少互動就能觸發要驗的行為。
	await page.getByRole("button", { name: foodName }).click();
	await page.getByRole("button", { name: "記錄" }).click();

	// 記錄成功後 LogMealRoute 的 onSaved 導去「/today」（P3-C Task 3：首頁
	// 換成記一餐之後，記完一餐要導去今日總覽，不是導回自己）。
	await expect(page.getByRole("heading", { name: "今日總覽" })).toBeVisible();
	await expect(page.getByTestId("macro-kcal")).not.toHaveText(before ?? "");
});
