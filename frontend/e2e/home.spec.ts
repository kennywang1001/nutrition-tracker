import {
	type APIRequestContext,
	expect,
	type Locator,
	type Page,
	test,
} from "@playwright/test";
import type { components } from "../src/api/schema.d.ts";
import { generateJpegBuffer } from "./jpeg.ts";
import { loginAs, type NewAccount, newAccount } from "./new-account.ts";
import { expectTouchTargets } from "./touch-targets.ts";

type AnalyzeMealResponse = components["schemas"]["AnalyzeMealResponse"];

// 首頁改版（規格 §9.3）。設定資料用 API，要驗的行為用畫面；登入之後只用點擊換頁。只假造 AI 端點。
// 小工具照 planner.spec.ts 的寫法**複製**一份（不 import 別的 spec：Playwright 會把那個檔案的測試一起註冊）。
const PHONE = { width: 390, height: 844 };

async function tokenOf(request: APIRequestContext, account: NewAccount) {
	const login = await request.post("/api/auth/login", {
		data: { email: account.email, password: account.password },
	});
	expect(login.ok()).toBe(true);
	return ((await login.json()) as { access_token: string }).access_token;
}

function auth(token: string) {
	return { authorization: `Bearer ${token}` };
}

/** 熱量 2000、蛋白質 120、脂肪不設、碳水 250（`TargetTodayRequest` 四個鍵都必填）。 */
async function setTargets(request: APIRequestContext, token: string) {
	const response = await request.put("/api/targets/today", {
		headers: auth(token),
		data: { kcal: "2000", protein_g: "120", fat_g: null, carb_g: "250" },
	});
	expect(response.ok()).toBe(true);
}

/** 每 100 g：500 kcal／蛋白質 20／脂肪 15／碳水 60。回 id。 */
async function createBento(
	request: APIRequestContext,
	token: string,
	name: string,
) {
	const response = await request.post("/api/foods", {
		headers: auth(token),
		data: {
			name,
			nutrition: {
				base_unit: "g",
				kcal: "500",
				protein_g: "20",
				fat_g: "15",
				carb_g: "60",
			},
		},
	});
	expect(response.status()).toBe(201);
	return ((await response.json()) as { id: number }).id;
}

/** 「YYYY-MM-DD」加減幾天（UTC，同 body-targets.spec 的 `shiftDays`）。起點是後端給的今天。 */
function shiftDays(date: string, days: number): string {
	const [y, m, d] = date.split("-").map(Number);
	return new Date(Date.UTC(y ?? 0, (m ?? 1) - 1, (d ?? 1) + days))
		.toISOString()
		.slice(0, 10);
}

/** 記幾天體重（`PUT /api/weights/{day}`）。日期從 `GET /api/weights` 的 `today` 往回算——使用者的今天，不是這台機器的。 */
async function logWeights(
	request: APIRequestContext,
	token: string,
	byDaysAgo: ReadonlyArray<readonly [number, string]>,
) {
	const list = await request.get("/api/weights", { headers: auth(token) });
	expect(list.ok()).toBe(true);
	const { today } = (await list.json()) as { today: string };
	for (const [daysAgo, kg] of byDaysAgo) {
		const response = await request.put(
			`/api/weights/${shiftDays(today, -daysAgo)}`,
			{ headers: auth(token), data: { weight_kg: kg } },
		);
		expect(response.ok()).toBe(true);
	}
}

/** 一分鐘前：不是「未來」。跨午夜的風險同 exercise.spec 的已知限制。 */
function aMinuteAgo() {
	return new Date(Date.now() - 60_000).toISOString();
}

async function logMeal(
	request: APIRequestContext,
	token: string,
	foodId: number,
	grams: string,
) {
	const response = await request.post("/api/meals", {
		headers: auth(token),
		data: {
			eaten_at: aMinuteAgo(),
			meal_type: "lunch",
			items: [{ food_id: foodId, quantity: grams }],
		},
	});
	expect(response.status()).toBe(201);
}

/** 手動的 343 kcal（不用體重）。 */
async function logRun(request: APIRequestContext, token: string) {
	const response = await request.post("/api/exercises", {
		headers: auth(token),
		data: {
			activity: "running",
			minutes: 30,
			performed_at: aMinuteAgo(),
			kcal: "343",
		},
	});
	expect(response.status()).toBe(201);
}

async function openOverview(page: Page) {
	await page.getByRole("link", { name: "總覽", exact: true }).click();
	await expect(
		page.getByRole("heading", { name: "總覽", exact: true, level: 1 }),
	).toBeVisible();
}

/** 先等看得到再量（handover §7）：boundingBox 在元素不在畫面上時回 null，直接當失敗。 */
async function box(locator: Locator) {
	await expect(locator).toBeVisible();
	const value = await locator.boundingBox();
	if (value === null) throw new Error("量不到");
	return value;
}

/** polyline 的 points（「x,y x,y …」）→ 數字。 */
function pairsOf(points: string | null): Array<[number, number]> {
	return (points ?? "").split(" ").map((pair) => {
		const [x, y] = pair.split(",").map(Number);
		return [x ?? Number.NaN, y ?? Number.NaN];
	});
}

test.describe("手機 390×844", () => {
	test.use({ viewport: PHONE });

	test("圓環：還能吃、已吃・預算（含運動）、營養素；再吃一餐就超過；體重的迷你折線與 /weight 的折線", async ({
		page,
		request,
	}) => {
		const account = await newAccount(request, "home-ring");
		const token = await tokenOf(request, account);
		const bento = `E2E 便當 ${Date.now()}`;
		await setTargets(request, token);
		const foodId = await createBento(request, token, bento);
		await logRun(request, token);
		await logMeal(request, token, foodId, "300");
		// 兩天體重（8 天前 80.3、今天 79.4）：迷你折線兩點（規格 D22）、「比 7 天前 -0.9 公斤」（D12）。
		await logWeights(request, token, [
			[8, "80.3"],
			[0, "79.4"],
		]);
		await loginAs(page, account);

		// 規格 §3.3：額度 2000 + 343 = 2343、吃了 1500。
		const card = page.getByTestId("today-kcal");
		await expect(card).toContainText("還能吃 843 kcal");
		await expect(card).toContainText("已吃 1500・預算 2343（含運動 +343）");
		await expect(card.getByTestId("macro-protein_g")).toContainText("60 / 120");
		await expect(card.getByTestId("macro-fat_g")).toContainText("45");
		await expect(card.getByTestId("macro-fat_g")).toContainText("未設定");
		await expect(card.getByTestId("macro-carb_g")).toContainText("180 / 250");
		const arc = card.getByTestId("calorie-ring-arc");
		await expect(arc).toHaveAttribute("data-tone", "normal");
		await expect(arc).toHaveAttribute("stroke-dasharray", "221.24 345.58");
		await expect(
			page.getByRole("region", { name: "今天熱量", exact: true }),
		).toBeVisible();

		// 體重小卡片：字照樣在（連結的名稱含標籤，迷你折線是 aria-hidden 不進名稱），下面一條兩點的迷你折線，
		// 是裝飾、放得進 390 寬的小卡片。
		const glance = page.getByTestId("weight-glance");
		const glanceLink = glance.getByRole("link");
		await expect(glanceLink).toHaveAccessibleName(
			"體重 79.4 公斤 比 7 天前 -0.9 公斤",
		);
		const spark = glance.getByTestId("weight-sparkline");
		await expect(spark).toHaveAttribute("aria-hidden", "true");
		const sparkLine = spark.getByTestId("weight-sparkline-line");
		await expect(sparkLine).toHaveAttribute("points", /^\S+ \S+$/);
		// 由舊到新、x 照日期往右；8 天前比較重，畫得比較高（y 小）。
		const [older, newer] = pairsOf(await sparkLine.getAttribute("points"));
		expect(older?.[0]).toBeLessThan(newer?.[0] ?? Number.NaN);
		expect(older?.[1]).toBeLessThan(newer?.[1] ?? Number.NaN);
		const [sparkBox, glanceBox] = [await box(spark), await box(glance)];
		expect(sparkBox.width).toBeGreaterThan(50);
		expect(sparkBox.x).toBeGreaterThanOrEqual(glanceBox.x);
		expect(sparkBox.x + sparkBox.width).toBeLessThanOrEqual(
			glanceBox.x + glanceBox.width,
		);
		expect(Math.round(sparkBox.height)).toBe(32);

		// 再記 200 g（今天記過，在常吃的清單裡）：1500 + 1000 = 2500 → 超過 157。
		await page.getByRole("button", { name: "新增紀錄", exact: true }).click();
		await page
			.getByRole("dialog", { name: "新增紀錄", exact: true })
			.getByRole("link", { name: "記一餐", exact: true })
			.click();
		await expect(
			page.getByRole("heading", { name: "記一餐", exact: true, level: 1 }),
		).toBeVisible();
		await page.getByRole("button", { name: bento, exact: true }).click();
		await page.getByLabel("份量", { exact: true }).fill("200");
		await page.getByRole("button", { name: "記錄", exact: true }).click();
		await expect(
			page.getByRole("heading", { name: "總覽", exact: true, level: 1 }),
		).toBeVisible();
		await expect(card).toContainText("超過 157 kcal");
		await expect(card).toContainText("已吃 2500・預算 2343（含運動 +343）");
		await expect(arc).toHaveAttribute("data-tone", "over");
		await expect(arc).toHaveAttribute("stroke-dasharray", "345.58 345.58");

		// 點體重小卡片 → /weight 的折線圖（規格 D24）：實線的組數＝點數，7 天平均是虛線。
		await glanceLink.click();
		await expect(
			page.getByRole("heading", { name: "體重", exact: true, level: 1 }),
		).toBeVisible();
		const chart = page.getByRole("group", { name: "體重", exact: true });
		const points = chart.getByRole("img");
		await expect(points).toHaveCount(2);
		const daily = chart.getByTestId("weight-line");
		await expect(daily).toHaveCount(1);
		expect(pairsOf(await daily.getAttribute("points"))).toHaveLength(
			await points.count(),
		);
		const dash = await chart
			.getByTestId("weight-average")
			.evaluate((node) => getComputedStyle(node).strokeDasharray);
		expect(dash).not.toBe("none");
		expect(
			await daily.evaluate((node) => getComputedStyle(node).strokeDasharray),
		).toBe("none");
	});

	test("沒有目標：已吃 0、還沒有每日目標，連到每日目標頁", async ({
		page,
		request,
	}) => {
		const account = await newAccount(request, "home-empty");
		await loginAs(page, account);
		const card = page.getByTestId("today-kcal");
		await expect(card).toContainText("已吃 0 kcal");
		await expect(card).toContainText("還沒有每日目標");
		await expect(card).not.toContainText("還能吃");
		await expect(card.getByTestId("calorie-ring-arc")).toHaveCount(0);
		// 沒有體重：「記錄體重」，沒有迷你折線（規格 D22）。
		const glance = page.getByTestId("weight-glance");
		await expect(glance.getByRole("link")).toHaveAccessibleName(
			"體重 記錄體重",
		);
		await expect(page.getByTestId("weight-sparkline")).toHaveCount(0);
		const setTarget = card.getByRole("link", {
			name: "設定每日目標",
			exact: true,
		});
		await expectTouchTargets(setTarget, "設定每日目標");
		await setTarget.click();
		await expect(
			page.getByRole("heading", { name: "每日目標", exact: true, level: 1 }),
		).toBeVisible();
	});

	test("快速記錄：拍照記到確認照片、掃條碼開掃描層、記運動、記體重；「＋」四個入口", async ({
		page,
		request,
	}) => {
		const account = await newAccount(request, "home-quick");
		const stamp = Date.now();
		// 形狀照 ai-photo-hint.spec.ts 第一條的 `estimate`（一樣、`library_food: null`），名稱與描述帶 stamp。
		const estimate = {
			analysis_id: 41,
			description: `E2E 首頁拍照 ${stamp}`,
			remaining_today: 19,
			items: [
				{
					name: `E2E 首頁拍照的雞腿 ${stamp}`,
					brand: null,
					nutrition: {
						base_unit: "g",
						serving_grams: "150.00",
						kcal: "160.00",
						protein_g: "20.00",
						fat_g: "8.00",
						carb_g: "1.00",
						serving_kcal: "240.00",
						serving_protein_g: "30.00",
						serving_fat_g: "12.00",
						serving_carb_g: "1.50",
					},
					confidence: "0.60",
					consistency: {
						atwater_kcal: "234.00",
						deviation: "6.00",
						flagged: false,
					},
					library_food: null,
				},
			],
		} satisfies AnalyzeMealResponse;
		const sent: Array<Record<string, unknown>> = [];
		await page.route("**/api/ai/analyze-meal", async (route) => {
			sent.push(route.request().postDataJSON() as Record<string, unknown>);
			await route.fulfill({ json: estimate });
		});
		await loginAs(page, account);

		const actions = page.getByRole("list", { name: "快速記錄", exact: true });
		await expect(actions.getByRole("listitem")).toHaveCount(4);
		// 拍照記的點擊目標是 <label>（隱藏的檔案輸入 Playwright 算成 1px 的 button），量標籤。
		await expectTouchTargets(actions.locator("a, label"), "快速記錄");
		await expect(actions.locator("a, label")).toHaveText([
			"拍照記",
			"掃條碼",
			"記運動",
			"記體重",
		]);

		// 拍照記：一按就是檔案輸入（iOS 開相機，規格 D8）→ 記一餐的確認照片卡片、焦點在卡片 → 開始估算。
		const photo = page.getByLabel("拍照記", { exact: true });
		await expect(photo).toHaveAttribute("capture", "environment");
		await expect(photo).toHaveAttribute("id", "quick-photo");
		await photo.setInputFiles({
			name: "lunch.jpg",
			mimeType: "image/jpeg",
			buffer: await generateJpegBuffer(page),
		});
		await expect(
			page.getByRole("heading", { name: "記一餐", exact: true, level: 1 }),
		).toBeVisible();
		const step = page.getByRole("region", { name: "確認照片", exact: true });
		await expect(step).toBeFocused();
		await expect(
			step.getByRole("button", { name: "取消", exact: true }),
		).toBeVisible();
		// 不自動送出（D8）：看照片、選填說明、按「開始估算」才送。
		expect(sent).toHaveLength(0);
		await step.getByRole("button", { name: "開始估算", exact: true }).click();
		await expect(
			page.getByRole("region", { name: "AI 估算結果", exact: true }),
		).toContainText(estimate.description);
		expect(sent).toHaveLength(1);
		expect(sent[0]?.kind).toBe("image");
		expect(String(sent[0]?.image_base64).length).toBeGreaterThan(100);
		expect(sent[0]).not.toHaveProperty("hint");

		// 掃條碼：記一餐一打開就是掃描層，焦點在「取消」（headless 沒有相機：錯誤狀態，手動輸入照樣在）
		// →「取消」→ 焦點在記一餐的「掃條碼」（總覽的是連結、記一餐的是按鈕）。
		await openOverview(page);
		await actions.getByRole("link", { name: "掃條碼", exact: true }).click();
		const scanner = page.getByRole("dialog", { name: "掃條碼", exact: true });
		await expect(scanner).toBeVisible();
		const cancelScan = scanner.getByRole("button", {
			name: "取消",
			exact: true,
		});
		await expect(cancelScan).toBeFocused();
		await expect(
			scanner.getByRole("button", { name: "手動輸入條碼", exact: true }),
		).toBeVisible();
		await cancelScan.click();
		await expect(scanner).toHaveCount(0);
		await expect(
			page.getByRole("button", { name: "掃條碼", exact: true }),
		).toBeFocused();

		// 記運動：表單。
		await openOverview(page);
		await actions.getByRole("link", { name: "記運動", exact: true }).click();
		await expect(
			page.getByRole("heading", { name: "記運動", exact: true, level: 1 }),
		).toBeVisible();

		// 記體重：/weight、焦點在體重欄位 → 存 70 → 總覽的小卡片。
		await openOverview(page);
		await actions.getByRole("link", { name: "記體重", exact: true }).click();
		await expect(
			page.getByRole("heading", { name: "體重", exact: true, level: 1 }),
		).toBeVisible();
		const kg = page.getByLabel("體重（公斤）", { exact: true });
		await expect(kg).toBeFocused();
		await kg.fill("70");
		await page
			.getByTestId("weight-form")
			.getByRole("button", { name: "儲存", exact: true })
			.click();
		await expect(
			page
				.getByRole("list", { name: "體重紀錄", exact: true })
				.getByRole("listitem"),
		).toHaveCount(1);
		await openOverview(page);
		await expect(page.getByTestId("weight-glance")).toContainText("70 公斤");
		// 只有一筆：沒有迷你折線，只有字（規格 D22）。
		await expect(page.getByTestId("weight-sparkline")).toHaveCount(0);

		// 「＋」：四個入口、2×2（第三個在第一個下面、第二個在第一個右邊）、記體重同一個去處。
		await page.getByRole("button", { name: "新增紀錄", exact: true }).click();
		const sheet = page.getByRole("dialog", { name: "新增紀錄", exact: true });
		const links = sheet.getByRole("link");
		await expect(links).toHaveText(["記帳", "記一餐", "記運動", "記體重"]);
		await expectTouchTargets(links, "新增選單");
		const [first, second, third] = [
			await box(links.nth(0)),
			await box(links.nth(1)),
			await box(links.nth(2)),
		];
		expect(third.y).toBeGreaterThan(first.y + first.height - 1);
		expect(Math.abs(third.x - first.x)).toBeLessThan(2);
		expect(second.x).toBeGreaterThan(first.x + first.width - 1);
		expect(Math.abs(second.y - first.y)).toBeLessThan(2);
		await sheet.getByRole("link", { name: "記體重", exact: true }).click();
		await expect(
			page.getByRole("heading", { name: "體重", exact: true, level: 1 }),
		).toBeVisible();
		await expect(
			page.getByLabel("體重（公斤）", { exact: true }),
		).toBeFocused();
	});

	test("「我的」（手機）：入口卡片、長 email 換行不撐出水平捲動", async ({
		page,
		request,
	}) => {
		// label 刻意長、**不帶連字號**：email 約 50 個字，沒有空白也沒有連字號（「-」後面可以換行），
		// 390 寬的帳號卡片一行放不下，瀏覽器也找不到換行的地方。
		const account = await newAccount(request, "homemelongemailwraps");
		await loginAs(page, account);
		await page.getByRole("link", { name: "我的", exact: true }).click();
		await expect(
			page.getByRole("heading", { name: "我的", exact: true, level: 1 }),
		).toBeVisible();
		const email = page.getByText(account.email, { exact: true });
		await expect(email).toBeVisible();
		const entry = page.getByTestId("body-hub-entry");
		await expect(entry).toContainText("還沒設定");
		await expectTouchTargets(
			entry.getByRole("link", { name: "身體與目標", exact: true }),
			"身體與目標的入口",
		);
		// <p> 是區塊：外框永遠是卡片的寬，字溢出去量外框看不到——量它自己的 scrollWidth。
		expect(
			await email.evaluate((node) => node.scrollWidth - node.clientWidth),
			"email 溢出帳號卡片",
		).toBeLessThanOrEqual(0);
		const overflow = await page.evaluate(
			() =>
				document.documentElement.scrollWidth -
				document.documentElement.clientWidth,
		);
		expect(overflow, "「我的」有橫向捲軸").toBeLessThanOrEqual(0);
	});
});

test("身體與目標與精簡的「我的」（電腦版）", async ({ page, request }) => {
	// 預設 1280×720＝電腦版（SideNav 的連結名稱跟 TabBar 一樣）。
	const account = await newAccount(request, "home-hub");
	await loginAs(page, account);
	const nav = page.getByRole("navigation", { name: "主要導覽", exact: true });

	await nav.getByRole("link", { name: "我的", exact: true }).click();
	await expect(
		page.getByRole("heading", { name: "我的", exact: true, level: 1 }),
	).toBeVisible();
	const entry = page.getByTestId("body-hub-entry");
	await expect(entry).toContainText("還沒設定");
	for (const id of ["targets-card", "weight-card", "body-profile-card"]) {
		await expect(page.getByTestId(id)).toHaveCount(0);
	}
	const hubLink = entry.getByRole("link", { name: "身體與目標", exact: true });
	await expect(hubLink).toHaveAttribute("href", "/me/health");
	await expect(hubLink).toHaveAccessibleDescription("還沒設定");

	await hubLink.click();
	await expect(
		page.getByRole("heading", { name: "身體與目標", exact: true, level: 1 }),
	).toBeVisible();
	// 在 /me 底下：「我的」照樣是目前的分頁（規格 D1）。
	await expect(
		nav.getByRole("link", { name: "我的", exact: true }),
	).toHaveAttribute("aria-current", "page");
	const cards = page.locator(
		'main [data-testid="targets-card"], main [data-testid="weight-card"], main [data-testid="body-profile-card"]',
	);
	await expect(cards).toHaveCount(3);
	const order = await cards.evaluateAll((nodes) =>
		nodes.map((node) => node.getAttribute("data-testid")),
	);
	expect(order).toEqual(["targets-card", "weight-card", "body-profile-card"]);

	// 體重卡片記 79（同 body-targets.spec 的 recordWeightOnHub 的步驟）。
	const weightCard = page.getByTestId("weight-card");
	await weightCard
		.getByRole("button", { name: "記錄體重", exact: true })
		.click();
	await weightCard.getByLabel("體重（公斤）", { exact: true }).fill("79");
	await weightCard.getByRole("button", { name: "儲存", exact: true }).click();
	await expect(weightCard).toContainText("79 公斤");

	// 手動存目標 2110 → 回到身體與目標（D2）。
	await page.getByRole("link", { name: "修改每日目標", exact: true }).click();
	const manual = page.getByRole("region", { name: "自己設定", exact: true });
	await manual.getByLabel("熱量（kcal）", { exact: true }).fill("2110");
	await manual.getByRole("button", { name: "儲存", exact: true }).click();
	await expect(
		page.getByRole("heading", { name: "身體與目標", exact: true, level: 1 }),
	).toBeVisible();
	await expect(page.getByTestId("targets-card")).toContainText("2110 kcal");

	await nav.getByRole("link", { name: "我的", exact: true }).click();
	await expect(
		page.getByRole("heading", { name: "我的", exact: true, level: 1 }),
	).toBeVisible();
	await expect(entry).toContainText("2110 kcal・79 公斤");
	await expect(hubLink).toHaveAccessibleDescription("2110 kcal・79 公斤");
});

test.describe("電腦版 1280×800", () => {
	test.use({ viewport: { width: 1280, height: 800 } });

	test("總覽：圓環、快速記錄、小卡片在時間線左邊；兩張小卡片並排", async ({
		page,
		request,
	}) => {
		const account = await newAccount(request, "home-desktop");
		await loginAs(page, account);
		// 數字畫出來了版面才定（載入中的卡片比較矮）。
		await expect(page.getByTestId("today-kcal")).toContainText("已吃 0 kcal");
		await expect(page.getByTestId("weight-glance")).toContainText("記錄體重");
		const ring = await box(page.getByTestId("today-kcal"));
		const actions = await box(
			page.getByRole("list", { name: "快速記錄", exact: true }),
		);
		const spend = await box(page.getByTestId("month-spend"));
		const weight = await box(page.getByTestId("weight-glance"));
		const timeline = await box(
			page.getByRole("heading", { name: "今天", exact: true }),
		);
		for (const left of [ring, actions, spend, weight]) {
			expect(timeline.x).toBeGreaterThan(left.x + left.width);
		}
		expect(weight.x).toBeGreaterThan(spend.x + spend.width - 1);
		expect(Math.abs(weight.y - spend.y)).toBeLessThan(2);
		expect(actions.y).toBeGreaterThan(ring.y + ring.height - 1);
		expect(spend.y).toBeGreaterThan(actions.y + actions.height - 1);
	});
});
