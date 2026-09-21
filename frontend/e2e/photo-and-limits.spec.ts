import { expect, test } from "@playwright/test";

const EMAIL = "kenny.demo@example.com";
const PASSWORD = "demo-pass-12345";

// 規格 §9.1 最後兩條契約 E2E（前四條在 auth.spec.ts 與 daily-loop.spec.ts）。
// 這兩條各自守一個 fetch mock 證明不了的後端保證：
//   1. 照片端點需要認證——mock 的 401 是我們自己寫的，不是後端真的因為
//      缺 Authorization 標頭而拒絕。
//   2. 登入端點真的會限速、真的回可讀的 Retry-After——mock 沒有計數器。

/** 用瀏覽器自己的 canvas 產生一張最小的合法 JPEG。
 *
 *  Chromium 的 `canvas.toBlob(..., "image/jpeg")` 輸出標準 baseline
 *  JPEG，後端用 Pillow 解碼一定吃得下（跟 `tests/test_meals_photo.py`
 *  的 `_jpeg_bytes` 做的是同一件事，只是編碼器換成瀏覽器內建的，不必在
 *  Node 端手刻位元組或另外存一份 base64 常數）。8x8 是刻意選的最小值：
 *  遠低於後端 `MAX_PHOTO_BYTES`（10MB），不會被前端或後端的大小檢查攔下，
 *  後端的圖片模組也沒有最小尺寸限制（`app/storage/photos.py`）。 */
async function generateJpegBuffer(
	page: import("@playwright/test").Page,
): Promise<Buffer> {
	const base64 = await page.evaluate(async () => {
		const canvas = document.createElement("canvas");
		canvas.width = 8;
		canvas.height = 8;
		const ctx = canvas.getContext("2d");
		if (ctx === null) throw new Error("canvas 2d context 不存在");
		ctx.fillStyle = "#ff8800";
		ctx.fillRect(0, 0, canvas.width, canvas.height);

		const blob = await new Promise<Blob>((resolve, reject) => {
			canvas.toBlob((result) => {
				if (result === null) reject(new Error("toBlob 回傳 null"));
				else resolve(result);
			}, "image/jpeg");
		});

		const bytes = new Uint8Array(await blob.arrayBuffer());
		let binary = "";
		for (const byte of bytes) binary += String.fromCharCode(byte);
		return btoa(binary);
	});

	return Buffer.from(base64, "base64");
}

test("照片上傳之後，取回來的是圖不是 404", async ({ page, request }) => {
	// 跟 daily-loop.spec.ts 第一條同樣自給自足——CI 的 e2e job 只用
	// `python -m app.cli create-admin` 建帳號，沒有任何食物或餐點資料，
	// 這裡自己用 API 建一個食物、記一筆餐，讓照片有地方掛。
	const loginResponse = await request.post("/api/auth/login", {
		data: { email: EMAIL, password: PASSWORD },
	});
	const { access_token: accessToken } = (await loginResponse.json()) as {
		access_token: string;
	};
	const authHeaders = { Authorization: `Bearer ${accessToken}` };

	const foodName = `E2E 照片測試食物 ${Date.now()}`;
	const foodResponse = await request.post("/api/foods", {
		headers: { ...authHeaders, "content-type": "application/json" },
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

	const mealResponse = await request.post("/api/meals", {
		headers: { ...authHeaders, "content-type": "application/json" },
		data: {
			eaten_at: new Date().toISOString(),
			meal_type: "snack",
			items: [{ food_id: food.id, quantity: "1" }],
		},
	});
	const meal = (await mealResponse.json()) as { id: number };

	const jpegBuffer = await generateJpegBuffer(page);

	// 上傳本身直接打 API（跟建食物、記餐一樣自給自足）——這條測試要驗的
	// 認證邊界在「讀」那一端，不在「寫」。先確認上傳成功（不是
	// 422 INVALID_PHOTO），後面的斷言才不會誤判成認證問題。
	const uploadResponse = await request.post(`/api/meals/${meal.id}/photo`, {
		headers: authHeaders,
		multipart: {
			file: {
				name: "photo.jpg",
				mimeType: "image/jpeg",
				buffer: jpegBuffer,
			},
		},
	});
	expect(uploadResponse.ok(), await uploadResponse.text()).toBe(true);

	// 後端契約（規格 §9.1）：帶 token 拿得到、不帶 token 拿不到。
	const withToken = await request.get(`/api/meals/${meal.id}/photo`, {
		headers: authHeaders,
	});
	expect(withToken.ok()).toBe(true);
	expect(withToken.headers()["content-type"]).toBe("image/jpeg");

	const withoutToken = await request.get(`/api/meals/${meal.id}/photo`);
	expect(withoutToken.status()).toBe(401);

	// 前端契約：`fetchPhotoBlob`（src/api/client.ts）真的帶了
	// Authorization——上面兩個直接打 API 的斷言只驗後端行為，不會經過
	// 前端那支程式碼。這裡實際登入、讓 MealList 掛載、讓 `useMealPhoto`
	// 真的跑一次：圖顯示得出來，才代表那個標頭真的被加上去了；如果
	// `fetchPhotoBlob` 漏帶標頭，後端會回 401，`MealPhoto` 就會改顯示
	// 「照片無法顯示」而不是 `<img>`（見 src/screens/MealList.tsx）。
	await page.goto("/");
	await page.getByLabel("Email").fill(EMAIL);
	await page.getByLabel("密碼").fill(PASSWORD);
	await page.getByRole("button", { name: "登入" }).click();

	const photoContainer = page.getByTestId(`meal-photo-${meal.id}`);
	await expect(photoContainer.locator("img")).toBeVisible();
	const src = await photoContainer.locator("img").getAttribute("src");
	expect(src).toMatch(/^blob:/);
});

test("連續登入失敗 6 次會看到倒數，而且倒數是真的", async ({ page }) => {
	// 後端 PER_EMAIL_LIMIT = 5 / 60 秒，回 429 帶 Retry-After
	// （app/ratelimit.py）。
	//
	// ⚠️ 用一個不存在的 email，不要用 demo 帳號。後端的限速鍵是「送進來
	// 的 email 字串本身」，帳號存不存在完全不影響行為（P4 決定 2，為了
	// 不讓限速被拿來問「這個 email 有沒有註冊」）。所以任何不存在的
	// email 都能觸發限速，同時**不會**把 demo 帳號鎖住 60 秒——
	// Playwright 預設兩個 worker 並行，鎖住 demo 帳號會讓其他 E2E
	// 隨機失敗。
	//
	// email 帶時間戳而不是寫死的字串：這條測試本機重跑（驗證並行穩定性
	// 需要連跑三次）時，同一個 email 60 秒內的限速視窗還沒過期，寫死的
	// email 會讓第二次執行從第 1 次就撞到 429，斷言的「前 5 次 401、
	// 第 6 次才 429」會直接不成立。CI 每次都是全新容器，這個問題不存在，
	// 但本機重跑會，所以兩邊都用同一個寫法。
	//
	// ⚠️ **這個時間戳只解得掉每帳號那一層，解不掉全域那一層**——這 5 次
	// 失敗一定也會計入 `GLOBAL_LIMIT`（20 次／60 秒，鍵是所有失敗登入
	// 共用一個計數器，不分 email）。本機在 60 秒內連續整套重跑超過三次
	// （例如手動重跑好幾輪除錯），全域計數會被這條測試餵到頂，接著連
	// 其他測試的正常登入都會被一起 429——那不是這條測試本身不穩，是
	// 同一個長駐的 dev 後端容器在 60 秒內被問了太多次。實測驗證過：
	// `docker compose restart api`（或等超過 60 秒）重置記憶體計數器後，
	// 立刻恢復穩定。CI 每個 job 都是全新容器，不會累積到這裡。
	const email = `nonexistent-429-${Date.now()}@example.com`;

	await page.goto("/");
	await page.getByLabel("Email").fill(email);
	await page.getByLabel("密碼").fill("wrong-password-does-not-matter");

	const button = page.getByRole("button", { name: "登入" });

	for (let attempt = 1; attempt <= 6; attempt++) {
		const responsePromise = page.waitForResponse((response) =>
			response.url().includes("/api/auth/login"),
		);
		await button.click();
		const response = await responsePromise;

		if (attempt < 6) {
			expect(response.status(), `第 ${attempt} 次應該是 401`).toBe(401);
		} else {
			expect(response.status(), "第 6 次應該撞到限速").toBe(429);
		}
	}

	await expect(page.getByRole("alert")).toContainText("秒後可再試");
	await expect(button).toBeDisabled();
});
