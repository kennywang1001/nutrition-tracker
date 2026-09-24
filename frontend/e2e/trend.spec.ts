import { expect, test } from "@playwright/test";
import { ADMIN } from "./accounts.ts";

test("記一餐之後，趨勢圖上今天那根柱子跟著變", async ({ page, request }) => {
	// **這條守的是 LogMeal.tsx 那一行 invalidateQueries(rangeStatsAll)。**
	//
	// ⚠️ 跟 daily-loop.spec.ts 一樣，這條測試的鑑別力依賴
	// src/api/queries.ts 的 staleTime（60 秒）。staleTime 是 0 的話，
	// 切換路由讓 Trend unmount／remount，remount 時資料「過期」就會自動
	// 重取——跟有沒有 invalidateQueries 完全無關，這條測試會因為錯誤的
	// 理由變綠。改那個值之前，先把那一行拿掉跑一次確認這條仍然會紅。
	//
	// 記一餐畫面只讀 /api/foods/frequent 與 /api/foods/recent，兩者都只回
	// 「這個使用者記錄過的食物」（app/api/routes/foods.py 的
	// _my_recorded_foods_stmt）。CI 的 e2e job 只用 create-admin 建帳號、
	// 沒有任何餐點資料，所以這裡先用 API 建一個食物、記一筆歷史餐點，
	// 讓它進「最近吃」清單——真正要驗的那次 invalidateQueries 仍然是
	// 透過 UI 觸發的。
	const loginResponse = await request.post("/api/auth/login", {
		data: { email: ADMIN.email, password: ADMIN.password },
	});
	const { access_token: accessToken } = (await loginResponse.json()) as {
		access_token: string;
	};
	const authHeaders = {
		Authorization: `Bearer ${accessToken}`,
		"content-type": "application/json",
	};

	const foodName = `趨勢 E2E 食物 ${Date.now()}`;
	const foodResponse = await request.post("/api/foods", {
		headers: authHeaders,
		data: {
			name: foodName,
			brand: null,
			nutrition: {
				base_unit: "g",
				kcal: "200.00",
				protein_g: "10.00",
				fat_g: "5.00",
				carb_g: "30.00",
			},
		},
	});
	expect(foodResponse.status()).toBe(201);
	const { id: foodId } = (await foodResponse.json()) as { id: number };

	// 先記一筆，讓這個食物進「最近吃」清單，UI 上才點得到。
	//
	// **注意欄位是 `quantity`，不是 `grams`。** `grams` 是
	// `PortionCreateRequest`（食物的份量定義）的欄位；建立一筆餐點項目
	// 用的是 `MealItemCreateRequest`（app/schemas/meal.py），欄位是
	// `food_id` / `quantity` / `portion_id`，沒有 `grams`。沒有
	// `portion_id` 時 `quantity` 直接當成公克數（app/api/routes/meals.py：
	// 「quantity_g = portion.grams * quantity，或直接等於 quantity」）。
	const seedResponse = await request.post("/api/meals", {
		headers: authHeaders,
		data: {
			eaten_at: new Date().toISOString(),
			meal_type: "snack",
			note: null,
			items: [{ food_id: foodId, quantity: "100.00" }],
		},
	});
	expect(seedResponse.status()).toBe(201);

	await page.goto("/");
	await page.getByLabel("Email").fill(ADMIN.email);
	await page.getByLabel("密碼").fill(ADMIN.password);
	await page.getByRole("button", { name: "登入" }).click();

	// 趨勢畫面：讀「今天」那根柱子的 aria-label。期間的最後一天就是今天，
	// 所以是最後一根。
	await page.getByRole("link", { name: "趨勢" }).click();
	await page.getByTestId("trend-chart").waitFor();
	const todayBar = page.getByTestId("trend-chart").locator("rect").last();
	const before = await todayBar.getAttribute("aria-label");
	expect(before).not.toBeNull();

	// 透過 UI 記一餐。
	//
	// **選擇器對照 `src/screens/LogMeal.tsx` 的實際文字（計畫寫的
	// 「公克」「送出」跟實際不同）：**
	// - 份量欄位的 label 是「份量」（`<label htmlFor="quantity">份量</label>`），
	//   不是「公克」。
	// - 送出按鈕文字是「記錄」（`<button type="submit">記錄</button>`），
	//   不是「送出」。
	// 食物清單是 `<li><button>{food.name}</button>…</li>`，`getByText`
	// 找得到按鈕裡的文字節點並點擊——跟 daily-loop.spec.ts 同一招。
	await page.getByRole("link", { name: "記一餐" }).click();
	await page.getByText(foodName).first().click();
	await page.getByLabel("份量").fill("250");
	await page.getByRole("button", { name: "記錄" }).click();

	// 回到趨勢，同一根柱子的數字必須變了。
	await page.getByRole("link", { name: "趨勢" }).click();
	await page.getByTestId("trend-chart").waitFor();
	await expect(
		page.getByTestId("trend-chart").locator("rect").last(),
	).not.toHaveAttribute("aria-label", before ?? "");
});
