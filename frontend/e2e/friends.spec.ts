import {
	type APIRequestContext,
	type Browser,
	expect,
	type Page,
	test,
} from "@playwright/test";
import { ADMIN } from "./accounts.ts";
import { generateJpegBuffer } from "./jpeg.ts";
import { login } from "./touch-targets.ts";

const PHONE = { width: 390, height: 844 };

test.use({ viewport: PHONE });

async function adminToken(request: APIRequestContext): Promise<string> {
	const response = await request.post("/api/auth/login", {
		data: { email: ADMIN.email, password: ADMIN.password },
	});
	expect(response.ok()).toBe(true);
	return (await response.json()).access_token as string;
}

/** 每次跑都開一個新帳號（規格 §6.3）：不依賴 dev 資料庫裡既有的好友關係。 */
async function newPal(
	browser: Browser,
	request: APIRequestContext,
	name: string,
) {
	const token = await adminToken(request);
	const invite = await request.post("/api/admin/invites", {
		headers: { authorization: `Bearer ${token}` },
		data: { note: "e2e 好友" },
	});
	const inviteToken = (await invite.json()).token as string;
	const context = await browser.newContext({ viewport: PHONE });
	const page = await context.newPage();
	await page.goto(`/join#${inviteToken}`);
	await page.getByLabel("Email").fill(`e2e.pal.${Date.now()}@example.com`);
	await page.getByLabel("名字").fill(name);
	await page.getByLabel("密碼", { exact: true }).fill("pal-pass-12345");
	await page.getByLabel("再輸入一次密碼").fill("pal-pass-12345");
	await page.getByRole("button", { name: "建立帳號" }).click();
	await expect(page.getByRole("heading", { name: "總覽" })).toBeVisible();
	return { context, page };
}

/** 「記一餐」只列出記錄過的食物：先用 API 建食物，再記一筆**私人**的歷史餐
 *  （不然這一筆會出現在夥伴的好友動態裡），讓它進「最近吃」。 */
async function seedFood(
	request: APIRequestContext,
	token: string,
	name: string,
): Promise<void> {
	const headers = {
		Authorization: `Bearer ${token}`,
		"content-type": "application/json",
	};
	const food = await request.post("/api/foods", {
		headers,
		data: {
			name,
			nutrition: {
				base_unit: "g",
				kcal: "123.00",
				protein_g: "10.00",
				fat_g: "5.00",
				carb_g: "5.00",
			},
		},
	});
	expect(food.ok()).toBe(true);
	const { id } = (await food.json()) as { id: number };
	const meal = await request.post("/api/meals", {
		headers,
		data: {
			eaten_at: new Date().toISOString(),
			meal_type: "snack",
			is_private: true,
			items: [{ food_id: id, quantity: "1" }],
		},
	});
	expect(meal.ok()).toBe(true);
}

async function logMeal(
	page: Page,
	foodName: string,
	options: { cost?: string; isPrivate?: boolean; photo?: Buffer },
) {
	await page.goto("/");
	await expect(page.getByRole("heading", { name: "總覽" })).toBeVisible();
	await page.getByRole("button", { name: "新增紀錄" }).click();
	await page.getByRole("link", { name: "記一餐" }).click();
	await page.getByText(foodName, { exact: true }).click();
	if (options.cost !== undefined) {
		await page.getByLabel("金額（選填）").fill(options.cost);
	}
	if (options.photo !== undefined) {
		await page.getByLabel("照片（選填）").setInputFiles({
			name: "meal.jpg",
			mimeType: "image/jpeg",
			buffer: options.photo,
		});
		await expect(page.getByRole("img", { name: "選好的照片" })).toBeVisible();
	}
	if (options.isPrivate === true) {
		await page.getByLabel("只有我看得到（好友看不到這一餐）").check();
	}
	await page.getByRole("button", { name: "記錄", exact: true }).click();
	await expect(page.getByRole("heading", { name: "總覽" })).toBeVisible();
}

test("好友：互加、私人的餐看不到、解除之後看不到", async ({
	page,
	browser,
	request,
}) => {
	const stamp = Date.now();
	const palName = `E2E 夥伴 ${stamp}`;
	const foodX = `E2E 好友公開餐 ${stamp}`;
	const foodY = `E2E 好友私人餐 ${stamp}`;
	const token = await adminToken(request);
	await seedFood(request, token, foodX);
	await seedFood(request, token, foodY);

	// 1. 管理員登入、夥伴開新帳號。
	await login(page);
	const pal = await newPal(browser, request, palName);

	// 2. 夥伴的好友碼。
	await pal.page.goto("/me");
	const code = (
		await pal.page.getByTestId("friend-code").textContent()
	)?.trim();
	expect(code).toBeTruthy();

	// 3. 管理員送出邀請。
	await page.goto("/me");
	await page.getByLabel("朋友的好友碼").fill(code ?? "");
	await page.getByRole("button", { name: "送出邀請" }).click();
	await expect(
		page.getByText(`已送出邀請給${palName}，等對方接受`),
	).toBeVisible();

	// 4. 夥伴接受。
	await pal.page.reload();
	await pal.page.getByRole("button", { name: /^接受.+的邀請$/ }).click();
	await expect(
		pal.page.getByRole("button", { name: /^解除和.+的好友$/ }),
	).toBeVisible();

	// 5. 管理員記兩餐：X 有金額、有照片、公開；Y 私人。
	await logMeal(page, foodX, {
		cost: "180",
		photo: await generateJpegBuffer(page),
	});
	await logMeal(page, foodY, { isPrivate: true });

	// 6. 夥伴看好友動態：看得到 X 與它的照片、看不到 Y。餐費不在白名單裡
	//    ——那由後端的欄位白名單測試守（test_friend_meals.py），畫面上找
	//    「180」找不到什麼：好友卡片本來就沒有顯示金額的地方。
	await pal.page.goto("/diet");
	await pal.page.getByText("好友", { exact: true }).click();
	const feed = pal.page.getByRole("region", { name: "好友動態" });
	await expect(feed.getByText(foodX)).toBeVisible();
	await expect(feed.getByText(foodY)).toHaveCount(0);
	const photo = feed
		.getByRole("listitem")
		.filter({ hasText: foodX })
		.getByRole("img");
	await expect(photo).toBeVisible();
	// 真的解出一張圖，不是破圖的替代文字。
	await expect
		.poll(() => photo.evaluate((img: HTMLImageElement) => img.naturalWidth))
		.toBeGreaterThan(0);

	// 7. 管理員解除好友。
	await page.goto("/me");
	await page.getByRole("button", { name: `解除和${palName}的好友` }).click();
	await page.getByRole("button", { name: "確定解除" }).click();
	await expect(
		page.getByRole("button", { name: `解除和${palName}的好友` }),
	).toHaveCount(0);

	// 8. 夥伴重新整理：動態變成「還沒有好友」。
	await pal.page.reload();
	await pal.page.getByText("好友", { exact: true }).click();
	await expect(
		pal.page.getByText("還沒有好友。到「我的」→「好友」用好友碼加朋友"),
	).toBeVisible();

	// 9.
	await pal.context.close();
});
