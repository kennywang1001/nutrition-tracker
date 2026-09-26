import { expect, test } from "@playwright/test";
import { ADMIN } from "./accounts.ts";

async function login(page: import("@playwright/test").Page) {
	await page.goto("/");
	await page.getByLabel("Email").fill(ADMIN.email);
	await page.getByLabel("密碼").fill(ADMIN.password);
	await page.getByRole("button", { name: "登入" }).click();
}

test("記一餐之後，今日總覽的數字真的變了", async ({ page, request }) => {
	// **這條守的是兩件單元測試看不到的事：**
	//   1. invalidateQueries 那條失效路徑（需要兩個畫面同時存在）
	//   2. 數值是字串（規格 §5.1）——後端回 "180.50"，前端的 decimal 處理
	//      如果退化成 parseFloat，小數會在這裡露出馬腳
	//
	// ⚠️ **這條測試的鑑別力依賴 src/api/queries.ts 的 staleTime。**
	//
	// staleTime 是 0（TanStack Query 的預設值）時，這條測試會【因為錯誤的
	// 理由】變綠：React Router 切換路由會讓 Today 整個 unmount／remount，
	// 而 remount 時只要資料「過期」就會自動重取——跟有沒有呼叫
	// invalidateQueries 完全無關。實測過：把 LogMeal 的
	// invalidateQueries(dailyStats) 整行刪掉，這條測試依然綠。
	//
	// 現在 staleTime 是 60 秒，而這條測試跑完約 4 秒——remount 時資料還
	// 新鮮，不會自動重取，所以「數字變了」只可能來自 invalidateQueries。
	//
	// **如果有人把 staleTime 調到接近或低於這條測試的執行時間，這條測試
	// 會靜默地退回「因為 remount 而綠」，而不會有任何東西提醒你。**
	// 改那個值之前，先把 invalidateQueries 那一行拿掉跑一次，
	// 確認這條測試仍然會紅。
	//
	// 「記一餐」畫面只讀 /api/foods/frequent 與 /api/foods/recent
	// （見 app/api/routes/foods.py `_my_recorded_foods_stmt`）——兩者都是
	// 「這個使用者記錄過的食物」的衍生查詢，沒有任何一般搜尋入口。CI 的
	// e2e job 只用 `python -m app.cli create-admin` 建帳號，沒有任何餐點
	// 資料，兩份清單都是空的，畫面上沒有任何食物可以點。
	//
	// 所以這條 E2E 自己先用 API 建一個食物、記一筆「歷史」餐點，讓它先
	// 進「最近吃」清單，再由瀏覽器實際點選、送出——真正要驗的那一次
	// invalidateQueries 仍然是透過 UI 觸發的，只是「食物存在」這個前提
	// 不再依賴外部種子資料（本機的 dev 資料庫已經有資料，這段對它只是
	// 多開一個不相干的食物，不影響既有資料）。
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

	const foodName = `E2E 契約測試食物 ${Date.now()}`;
	const foodResponse = await request.post("/api/foods", {
		headers: authHeaders,
		data: {
			name: foodName,
			nutrition: {
				base_unit: "g",
				kcal: "100.00",
				protein_g: "10.00",
				fat_g: "5.00",
				carb_g: "5.00",
			},
		},
	});
	const food = (await foodResponse.json()) as { id: number };

	await request.post("/api/meals", {
		headers: authHeaders,
		data: {
			eaten_at: new Date().toISOString(),
			meal_type: "snack",
			items: [{ food_id: food.id, quantity: "1" }],
		},
	});

	await login(page);

	// P3-C Task 3：首頁從今日總覽換成記一餐——登入後落地的是記一餐畫面，
	// 要先切到今日總覽才讀得到基準值。
	await page.getByRole("link", { name: "今日總覽" }).click();
	const before = await page.getByTestId("macro-kcal").textContent();

	await page.getByRole("link", { name: "記一餐" }).click();
	await page.getByText(foodName).click();
	await page.getByRole("button", { name: "記錄" }).click();

	// 記錄成功後 LogMealRoute 的 onSaved 導去 /today（Task 3：記完一餐要
	// 讓使用者看到數字變了，不是導回記一餐自己）。這裡沒有另外顯式等
	// 「今日總覽」標題出現——跟原本一樣，靠下面這個斷言本身的自動重試
	// 隱含地等到導頁完成：`macro-kcal` 這個 testid 只存在於 /today，
	// 在導頁完成之前 Playwright 找不到它、會一直重試，直到 onSaved
	// 導頁完成、元素出現、文字真的變了為止。
	await expect(page.getByTestId("macro-kcal")).not.toHaveText(before ?? "");
});

test("今日總覽不帶 date 參數——日界線由伺服器決定", async ({ page }) => {
	// 規格 §5.3。Playwright 的 timezoneId 設成 Asia/Taipei（見
	// playwright.config.ts），跟 CI runner 的 UTC 不同——所以
	// 「前端自己用瀏覽器時區算日期」在這裡會算出跟後端不同的答案。
	//
	// 這條測試**攔的是請求本身**，不是結果：只要 URL 帶了 date，就紅。
	// 為什麼不驗結果：大部分時候兩種算法會得到同一天，驗結果的鑑別力
	// 只在午夜前後那幾小時存在——那是規格 §9.2 第 5 條講的
	// 「兩個視窗沒有重疊」。
	const statsRequests: string[] = [];
	page.on("request", (req) => {
		if (req.url().includes("/api/stats/daily")) statsRequests.push(req.url());
	});

	await login(page);
	// P3-C Task 3：首頁換成記一餐，/api/stats/daily 只在 /today 掛載時才打，
	// 要先切過去。
	await page.getByRole("link", { name: "今日總覽" }).click();
	await expect(page.getByTestId("macro-kcal")).toBeVisible();

	expect(statsRequests.length).toBeGreaterThan(0);
	for (const url of statsRequests) {
		expect(url).not.toContain("date=");
	}
});
