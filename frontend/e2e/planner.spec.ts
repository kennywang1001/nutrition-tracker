import {
	type APIRequestContext,
	expect,
	type Page,
	test,
} from "@playwright/test";
import type { components } from "../src/api/schema.d.ts";
import { loginAs, type NewAccount, newAccount } from "./new-account.ts";
import { expectTouchTargets } from "./touch-targets.ts";

type AnalyzeMealResponse = components["schemas"]["AnalyzeMealResponse"];
type EstimatedItem = AnalyzeMealResponse["items"][number];

// 手機尺寸：44px 的點擊目標在這個寬度才有意義；流程本身兩種寬度一樣。
test.use({ viewport: { width: 390, height: 844 } });

// 小工具照 ai-multi-food.spec.ts 的寫法**複製**一份（不 import 別的 spec：Playwright 會把那個檔案的測試一起註冊）。
// 設定資料用 API，要驗的行為用畫面。

async function tokenOf(
	request: APIRequestContext,
	account: NewAccount,
): Promise<string> {
	const login = await request.post("/api/auth/login", {
		data: { email: account.email, password: account.password },
	});
	expect(login.ok()).toBe(true);
	return ((await login.json()) as { access_token: string }).access_token;
}

/** 每 100 g 的四個數字；`portion` 是預設份量。回食物的 id。 */
async function createFood(
	request: APIRequestContext,
	token: string,
	name: string,
	[kcal, protein_g, fat_g, carb_g]: [string, string, string, string],
	portion?: { label: string; grams: string },
): Promise<number> {
	const food = await request.post("/api/foods", {
		headers: { authorization: `Bearer ${token}` },
		data: {
			name,
			nutrition: { base_unit: "g", kcal, protein_g, fat_g, carb_g },
			...(portion === undefined ? {} : { default_portion: portion }),
		},
	});
	expect(food.status()).toBe(201);
	return ((await food.json()) as { id: number }).id;
}

/** 今天的目標：熱量 700、蛋白質 50，脂肪與碳水不設（＝不考慮）。`TargetTodayRequest` 四個鍵都必填。 */
async function setTargets(request: APIRequestContext, token: string) {
	const target = await request.put("/api/targets/today", {
		headers: { authorization: `Bearer ${token}` },
		data: { kcal: "700", protein_g: "50", fat_g: null, carb_g: null },
	});
	expect(target.ok()).toBe(true);
}

async function openDiet(page: Page) {
	await page.getByRole("link", { name: "飲食", exact: true }).click();
	// 只有飲食頁才有的標題（換頁後的第一個斷言）。
	await expect(
		page.getByRole("heading", { name: "今日餐點", exact: true }),
	).toBeVisible();
}

function plannerCard(page: Page) {
	return page.getByTestId("planner-card");
}

async function openPlanner(page: Page) {
	await openDiet(page);
	await plannerCard(page)
		.getByRole("link", { name: "從食物庫配", exact: true })
		.click();
	await expect(
		page.getByRole("heading", {
			name: "今天還能吃什麼",
			exact: true,
			level: 1,
		}),
	).toBeVisible();
}

async function expectOverview(page: Page) {
	await expect(
		page.getByRole("heading", { name: "總覽", exact: true, level: 1 }),
	).toBeVisible();
}

/** 新帳號只有今天這一餐：餐別是 `mealType` 的那一張卡片。 */
function mealCardOf(page: Page, mealType: string) {
	return page.getByRole("listitem").filter({
		has: page.getByRole("heading", {
			level: 3,
			name: new RegExp(` · ${mealType}$`),
		}),
	});
}

test("從食物庫配（全部是真的）：卡片 → 組合 → 記成一餐 → 記一餐的「配餐的項目」→ 記錄 → 額度用完", async ({
	page,
	request,
}) => {
	const account = await newAccount(request, "planner-library");
	const token = await tokenOf(request, account);
	const stamp = Date.now();
	const chicken = `E2E 雞胸 ${stamp}`;
	const rice = `E2E 白飯 ${stamp}`;
	await setTargets(request, token);
	const chickenId = await createFood(request, token, chicken, [
		"110",
		"23",
		"1.5",
		"0",
	]);
	const riceId = await createFood(
		request,
		token,
		rice,
		["180", "3", "0.5", "40"],
		{ label: "1 碗", grams: "200" },
	);
	// 兩天前吃過（變成常吃的食物，又不佔今天的額度）。白飯直接用 g、不帶 portion_id。
	const meal = await request.post("/api/meals", {
		headers: { authorization: `Bearer ${token}` },
		data: {
			eaten_at: new Date(Date.now() - 2 * 86_400_000).toISOString(),
			meal_type: "lunch",
			items: [
				{ food_id: chickenId, quantity: "100" },
				{ food_id: riceId, quantity: "100" },
			],
		},
	});
	expect(meal.status()).toBe(201);

	// 期望值是解題器算的（規格 §4.5、tests/test_planner_solver.py::test_the_e2e_pair）：
	// 雞胸 175 g（192.5 kcal）＋白飯 1.5 碗＝300 g（540 kcal）＝732.5 kcal；第二、三組是雞胸 250 g、白飯 2 碗。
	// /planner 與總覽的熱量顯示到整數（half-up）：192.5 → 193、732.5 → 733；飲食頁的熱量列照舊印 732.5。
	await loginAs(page, account);
	await openPlanner(page);

	// 1. 還能吃：熱量與蛋白質（脂肪、碳水沒設目標，不列）。
	const remaining = page.getByRole("region", { name: "還能吃", exact: true });
	await expect(remaining.getByRole("definition")).toHaveText([
		"700 kcal",
		"50 g",
	]);

	// 2. 組合：三組（直接子層的 listitem；每一樣也是 listitem）。
	const combos = page.getByRole("list", {
		name: "從食物庫配的組合",
		exact: true,
	});
	await expect(combos.locator(":scope > li")).toHaveCount(3);
	const first = combos.locator(":scope > li").first();
	await expect(
		first.getByRole("heading", { level: 3, name: "組合 1", exact: true }),
	).toBeVisible();
	await expect(first.getByRole("listitem")).toHaveText([
		`${chicken} 175 g・193 kcal`,
		`${rice} 1.5 份（1 碗）・540 kcal`,
	]);
	await expect(first.getByText(/^合計 /).locator("xpath=..")).toHaveText(
		"合計 733 kcal・蛋白質 49.3 g・脂肪 4.1 g・碳水 120 g",
	);
	await expect(
		first.getByText("佔剩下的熱量 105%", { exact: true }),
	).toBeVisible();
	// 有界的一組：三顆「記成一餐」。
	await expectTouchTargets(combos.getByRole("button"), "今天還能吃什麼：組合");

	// 3. 記成一餐 → 記一餐的「配餐的項目」：量是組合的（白飯是份數）。
	await page
		.getByRole("button", { name: "把組合 1 記成一餐", exact: true })
		.click();
	await expect(
		page.getByRole("heading", { name: "記一餐", exact: true, level: 1 }),
	).toBeVisible();
	const planned = page.getByRole("region", { name: "配餐的項目", exact: true });
	await expect(
		planned.getByRole("heading", { name: "配餐的項目", exact: true }),
	).toBeVisible();
	await expect(
		planned.getByLabel(`${chicken}（g）`, { exact: true }),
	).toHaveValue("175");
	await expect(
		planned.getByLabel(`${rice}（份，1 份＝1 碗）`, { exact: true }),
	).toHaveValue("1.5");

	// 4. 選晚餐、記錄 → 總覽：今天 733（732.5；白飯照份量算 300 g，不帶 portion_id 的話會是 1.5 g）。
	await page
		.getByLabel("餐別", { exact: true })
		.selectOption({ label: "晚餐" });
	await page.getByRole("button", { name: "記錄", exact: true }).click();
	await expectOverview(page);
	// 總覽顯示到整數（首頁改版規格 D19）：已吃 733、超過 33。「白飯照份量算 300 g」的精度改在飲食頁的熱量列守（732.5）。
	const todayKcal = page.getByTestId("today-kcal");
	await expect(todayKcal).toContainText("已吃 733・預算 700");
	await expect(todayKcal).toContainText("超過 33 kcal");

	// 5. 再看一次：剩 0，沒有東西可以配。
	await openPlanner(page);
	await expect(
		page.getByText("今天的熱量差不多用完了", { exact: true }),
	).toBeVisible();
	await expect(
		page.getByRole("region", { name: "還能吃", exact: true }),
	).toContainText("0 kcal");

	// 6. 飲食頁的「今日餐點」：那一餐（晚餐）兩樣，白飯是 300 g。
	await openDiet(page);
	// 精度：飲食頁的熱量列照舊印到小數（732.5；白飯不照份量算的話是 192.5 + 1.5 g 的熱量）。
	await expect(page.getByTestId("macro-kcal")).toContainText("732.5 / 700");
	const dinner = mealCardOf(page, "晚餐");
	await expect(dinner).toHaveCount(1);
	await expect(dinner.getByRole("listitem")).toHaveText([
		`${chicken} · 175 g`,
		`${rice} · 300 g`,
	]);
	await expect(dinner).toContainText("合計 732.5 kcal");
});

/** 假的 AI 估算的一樣：每 100 g 的數字由一份的換算回去（兩位小數）。 */
function estimatedItem(
	name: string,
	servingGrams: string,
	servingKcal: string,
	per100Kcal: string,
): Omit<EstimatedItem, "library_food"> {
	return {
		name,
		brand: null,
		nutrition: {
			base_unit: "g",
			serving_grams: servingGrams,
			kcal: per100Kcal,
			protein_g: "5.00",
			fat_g: "3.00",
			carb_g: "10.00",
			serving_kcal: servingKcal,
			serving_protein_g: "5.00",
			serving_fat_g: "3.00",
			serving_carb_g: "10.00",
		},
		confidence: "0.70",
		consistency: {
			atwater_kcal: servingKcal,
			deviation: "0.00",
			flagged: false,
		},
	};
}

test("讓 AI 配一餐（只假造 suggest-meal，其餘是真的）：卡片 → 偏好 → 建議 → 加入 → 記錄", async ({
	page,
	request,
}) => {
	const account = await newAccount(request, "planner-ai");
	const token = await tokenOf(request, account);
	const stamp = Date.now();
	const salad = `E2E 沙拉 ${stamp}`;
	const egg = `E2E 茶葉蛋 ${stamp}`;
	const description = `便利商店：${salad}、${egg}`;
	await setTargets(request, token);
	// 茶葉蛋：食物庫裡真的有（每 100 g 140 kcal）；沙拉：要由畫面建出來。
	const eggId = await createFood(request, token, egg, [
		"140",
		"12.5",
		"9.5",
		"1",
	]);

	let sentBody: unknown = null;
	let calls = 0;
	await page.route("**/api/ai/suggest-meal", async (route) => {
		calls += 1;
		sentBody = route.request().postDataJSON();
		const body = {
			analysis_id: 1,
			description,
			items: [
				// 沙拉 250 g、230 kcal（每 100 g 92）。
				{
					...estimatedItem(salad, "250.00", "230.00", "92.00"),
					library_food: null,
				},
				// 茶葉蛋 110 g：AI 估 150，食物庫那一筆 140 × 1.1 ＝ 154。
				{
					...estimatedItem(egg, "110.00", "150.00", "136.36"),
					library_food: {
						food_id: eggId,
						name: egg,
						base_unit: "g",
						serving_kcal: "154.00",
					},
				},
			],
			remaining_today: 19,
		} satisfies AnalyzeMealResponse;
		await route.fulfill({ json: body });
	});

	await loginAs(page, account);
	await openDiet(page);
	// 卡片等統計回來才畫：先等兩個連結都出現再量（`count()` 不會等）。
	const cardLinks = plannerCard(page).getByRole("link");
	await expect(cardLinks).toHaveText(["從食物庫配", "讓 AI 配一餐"]);
	await expectTouchTargets(cardLinks, "飲食頁：今天還能吃什麼的卡片");

	// 1. 卡片的「讓 AI 配一餐」→ 記一餐，表單已經打開、焦點在偏好。
	await plannerCard(page)
		.getByRole("link", { name: "讓 AI 配一餐", exact: true })
		.click();
	await expect(
		page.getByRole("heading", { name: "記一餐", exact: true, level: 1 }),
	).toBeVisible();
	const form = page.getByRole("form", { name: "讓 AI 配一餐", exact: true });
	await expect(form).toBeVisible();
	const preference = form.getByLabel("偏好（選填）", { exact: true });
	await expect(preference).toBeFocused();
	await expectTouchTargets(preference, "讓 AI 配一餐：偏好");

	// 2. 偏好 → 讓 AI 建議：送出的就是打的字；結果是兩樣。
	await preference.fill("不吃牛");
	await form.getByRole("button", { name: "讓 AI 建議", exact: true }).click();
	await expect.poll(() => sentBody).toEqual({ preference: "不吃牛" });
	const card = page.getByRole("region", { name: "AI 建議的一餐", exact: true });
	await expect(card).toContainText(description);
	await expect(card).toContainText("今天還能用 19 次");
	await expect(
		card.getByRole("checkbox", {
			name: `${salad} 250 g · 230 kcal`,
			exact: true,
		}),
	).toBeChecked();
	await expect(
		card.getByRole("checkbox", {
			name: `${egg} 110 g · 154 kcal`,
			exact: true,
		}),
	).toBeChecked();

	// 3. 加入：沙拉真的建一個私人食物，茶葉蛋用食物庫那一筆（不建）。
	const created = page.waitForResponse(
		(response) =>
			new URL(response.url()).pathname === "/api/foods" &&
			response.request().method() === "POST",
	);
	await card.getByRole("button", { name: "加入這 2 樣", exact: true }).click();
	expect((await created).status()).toBe(201);
	await expect(card).toHaveCount(0);
	const items = page.getByRole("region", { name: "AI 估的項目", exact: true });
	await expect(
		page.getByRole("heading", { name: "AI 估的項目", exact: true }),
	).toBeVisible();
	await expect(items.getByLabel(`${salad}（g）`, { exact: true })).toHaveValue(
		"250",
	);
	await expect(items.getByLabel(`${egg}（g）`, { exact: true })).toHaveValue(
		"110",
	);
	await expect(page.getByLabel("描述（選填）", { exact: true })).toHaveValue(
		description,
	);
	// 建議只打了一次。
	expect(calls).toBe(1);

	// 4. 記錄 → 總覽 → 飲食頁：那一餐兩樣；茶葉蛋是食物庫那一筆（154），沙拉 230 ＝ 384。
	await page
		.getByLabel("餐別", { exact: true })
		.selectOption({ label: "午餐" });
	await page.getByRole("button", { name: "記錄", exact: true }).click();
	await expectOverview(page);
	await openDiet(page);
	const lunch = mealCardOf(page, "午餐");
	await expect(lunch).toHaveCount(1);
	await expect(lunch.getByRole("listitem")).toHaveText([
		`${salad} · 250 g`,
		`${egg} · 110 g`,
	]);
	await expect(lunch).toContainText(description);
	await expect(lunch).toContainText("合計 384 kcal");
});
