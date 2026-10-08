import { expect, test } from "@playwright/test";
import { loginAs, newAccount } from "./new-account.ts";
import { expectTouchTargets, login } from "./touch-targets.ts";

const PHONE = { width: 390, height: 844 };

// 名稱一律 exact：「新密碼」是「再輸入一次新密碼」的子字串、「密碼」是「目前的密碼」的、
// 「重設密碼」是「重設密碼連結」的；「重設密碼連結」又是每一顆「產生重設密碼連結：…」的。

test("每日目標從今天起生效：總覽的分母跟著變，同一天再改一次也行", async ({
	page,
	request,
}) => {
	// 預設 1280×720＝電腦版（SideNav 的連結名稱跟 TabBar 一樣）。
	const account = await newAccount(request, "targets");
	await loginAs(page, account);
	const kcal = page.getByTestId("today-kcal");
	await expect(kcal).toContainText("kcal");
	await expect(kcal).not.toContainText("/");

	for (const value of ["1800", "1900"]) {
		await page.getByRole("link", { name: "我的", exact: true }).click();
		await expect(
			page.getByRole("heading", { name: "我的", exact: true }),
		).toBeVisible();
		await page.getByRole("link", { name: "修改每日目標", exact: true }).click();
		// 只有目標頁有這個欄位。
		await expect(
			page.getByLabel("熱量（kcal）", { exact: true }),
		).toBeVisible();
		await page.getByLabel("熱量（kcal）", { exact: true }).fill(value);
		await page.getByLabel("蛋白質（g）", { exact: true }).fill("120");
		await page.getByRole("button", { name: "儲存", exact: true }).click();
		// 回到「我的」：卡片上是新的值（第二圈走的是「今天才開始→原地改」）。
		await expect(
			page.getByRole("heading", { name: "我的", exact: true }),
		).toBeVisible();
		await expect(page.getByTestId("targets-card")).toContainText(
			`${value} kcal`,
		);
		await page.getByRole("link", { name: "總覽", exact: true }).click();
		await expect(
			page.getByRole("heading", { name: "總覽", exact: true }),
		).toBeVisible();
		await expect(kcal).toContainText(`/ ${value} kcal`);
	}
});

test.describe("手機尺寸", () => {
	test.use({ viewport: PHONE });

	test("改密碼：其他裝置登出、這台繼續用；之後只認新密碼", async ({
		browser,
		request,
	}) => {
		const account = await newAccount(request, "password");
		const newPassword = "second-pass-12345";
		const deviceA = await browser.newContext({ viewport: PHONE });
		const pageA = await deviceA.newPage();
		await loginAs(pageA, account);
		const deviceB = await browser.newContext({ viewport: PHONE });
		const pageB = await deviceB.newPage();
		await loginAs(pageB, account);
		const refreshB = await pageB.evaluate(() =>
			localStorage.getItem("refresh_token"),
		);
		expect(refreshB).toBeTruthy();

		await pageA.getByRole("link", { name: "我的", exact: true }).click();
		await expect(
			pageA.getByRole("heading", { name: "我的", exact: true }),
		).toBeVisible();
		await pageA.getByRole("link", { name: "修改密碼", exact: true }).click();
		await expect(pageA.getByLabel("目前的密碼", { exact: true })).toBeVisible();
		await expectTouchTargets(pageA.locator("main button:visible"), "修改密碼");
		await pageA
			.getByLabel("目前的密碼", { exact: true })
			.fill(account.password);
		await pageA.getByLabel("新密碼", { exact: true }).fill(newPassword);
		await pageA
			.getByLabel("再輸入一次新密碼", { exact: true })
			.fill(newPassword);
		await pageA.getByRole("button", { name: "更新密碼", exact: true }).click();
		await expect(
			pageA.getByText("密碼已更新。其他裝置都已登出，這台不用重新登入。", {
				exact: true,
			}),
		).toBeVisible();

		// B：那張 refresh token 被撤銷了。B 手上的 access token 最多還能用 15 分鐘（刻意的缺口），
		// 所以不看 B 的畫面，看伺服器。
		const replay = await request.post("/api/auth/refresh", {
			data: { refresh_token: refreshB },
		});
		expect(replay.status()).toBe(401);
		await deviceB.close();

		// A：新的那張是活的。**刻意整頁重新載入**——access token 只在記憶體，重新載入之後第一個
		// 要認證的請求 401，用 localStorage 的 refresh token 換票。新票沒存好（還是被撤銷的舊票）、
		// 或新票自己也被撤銷了，換票就是 401。只載入這一次，不會跟別的換票撞在一起。
		//
		// **看換票的回應，不看畫面**：換票失敗時 app 不會跳回登入畫面（`loggedIn` 只在開頁時讀
		// localStorage 一次），「修改密碼」「我的」的標題照樣畫得出來；「我的」的資料又可能來自
		// 離線快取、根本不發請求。實測：把後端的 start_session 搬到撤銷之前，只看畫面的版本是綠的。
		const refreshed = pageA.waitForResponse(
			(response) => new URL(response.url()).pathname === "/api/auth/refresh",
		);
		await pageA.reload();
		await expect(
			pageA.getByRole("heading", { name: "修改密碼", exact: true }),
		).toBeVisible();

		await pageA.getByRole("link", { name: "我的", exact: true }).click();
		await expect(
			pageA.getByRole("heading", { name: "我的", exact: true }),
		).toBeVisible();
		// 「重新整理」直接打 /api/me、不經過快取：記憶體裡沒有 access token → 401 → 換票。
		await pageA.getByRole("button", { name: "重新整理", exact: true }).click();
		expect((await refreshed).status()).toBe(200);
		await pageA.getByRole("button", { name: "登出", exact: true }).click();
		await expect(
			pageA.getByRole("button", { name: "登入", exact: true }),
		).toBeVisible();
		await pageA.getByLabel("Email", { exact: true }).fill(account.email);
		await pageA.getByLabel("密碼", { exact: true }).fill(account.password);
		await pageA.getByRole("button", { name: "登入", exact: true }).click();
		await expect(
			pageA.getByText("email 或密碼不正確", { exact: true }),
		).toBeVisible();
		await pageA.getByLabel("密碼", { exact: true }).fill(newPassword);
		await pageA.getByRole("button", { name: "登入", exact: true }).click();
		// 登出不換網址：登入之後回到原本的 /me，不是總覽。
		await expect(
			pageA.getByRole("heading", { name: "我的", exact: true }),
		).toBeVisible();
		await expect(pageA.getByText(account.email, { exact: true })).toBeVisible();
		await deviceA.close();
	});

	test("管理員產生重設密碼連結，朋友用它設新密碼；連結只能用一次", async ({
		page,
		browser,
		request,
	}) => {
		const account = await newAccount(request, "reset");
		const newPassword = "reset-pass-12345";
		// 朋友在別的裝置上本來是登入的：重設之後那張票要失效。
		const before = await request.post("/api/auth/login", {
			data: { email: account.email, password: account.password },
		});
		expect(before.ok()).toBe(true);
		const oldRefresh = (await before.json()).refresh_token as string;

		await login(page); // ADMIN：只產生連結，不動它自己的密碼。
		await page.getByRole("link", { name: "我的", exact: true }).click();
		await expect(
			page.getByRole("heading", { name: "所有帳號", exact: true }),
		).toBeVisible();
		// 用完整的可及名稱點那個人自己的按鈕（dev 資料庫有上百個帳號）。
		await page
			.getByRole("button", {
				name: `產生重設密碼連結：${account.name}（${account.email}）`,
				exact: true,
			})
			.click();
		await expect(
			page.getByText(`給 ${account.name} 的重設密碼連結`, { exact: true }),
		).toBeVisible();
		const link = await page
			.getByLabel("重設密碼連結", { exact: true })
			.inputValue();
		expect(link).toContain("/reset-password#");
		await expectTouchTargets(
			page.locator("main button:visible"),
			"我的：所有帳號",
		);

		// 朋友：一個完全沒登入過的瀏覽器（新的 context——同一頁只換 hash 不會重新載入 app）。
		const friend = await browser.newContext({ viewport: PHONE });
		const friendPage = await friend.newPage();
		await friendPage.goto(link);
		await expect(
			friendPage.getByLabel("再輸入一次新密碼", { exact: true }),
		).toBeVisible();
		await expectTouchTargets(friendPage.locator("button:visible"), "重設密碼");
		await friendPage.getByLabel("新密碼", { exact: true }).fill(newPassword);
		await friendPage
			.getByLabel("再輸入一次新密碼", { exact: true })
			.fill(newPassword);
		await friendPage
			.getByRole("button", { name: "重設密碼", exact: true })
			.click();
		await expect(
			friendPage.getByText("密碼已重設，請登入", { exact: true }),
		).toBeVisible();
		expect(new URL(friendPage.url()).hash).toBe("");

		const replay = await request.post("/api/auth/refresh", {
			data: { refresh_token: oldRefresh },
		});
		expect(replay.status()).toBe(401);

		await friendPage.getByRole("link", { name: "去登入", exact: true }).click();
		await expect(
			friendPage.getByRole("button", { name: "登入", exact: true }),
		).toBeVisible();
		await loginAs(friendPage, { email: account.email, password: newPassword });
		await friend.close();

		// 同一條連結：另一個沒登入的瀏覽器打開 → 失效。
		const stranger = await browser.newContext({ viewport: PHONE });
		const strangerPage = await stranger.newPage();
		await strangerPage.goto(link);
		await expect(
			strangerPage.getByText("這個重設密碼連結已經失效，請跟管理員要一個新的", {
				exact: true,
			}),
		).toBeVisible();
		await expect(
			strangerPage.getByRole("button", { name: "重設密碼", exact: true }),
		).toHaveCount(0);
		await stranger.close();
	});
});
