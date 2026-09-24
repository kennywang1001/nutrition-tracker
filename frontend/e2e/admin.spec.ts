import { expect, test } from "@playwright/test";
import { ADMIN, MEMBER } from "./accounts.ts";

async function login(
	page: import("@playwright/test").Page,
	account: { email: string; password: string },
) {
	await page.goto("/");
	await page.getByLabel("Email").fill(account.email);
	await page.getByLabel("密碼").fill(account.password);
	await page.getByRole("button", { name: "登入" }).click();
}

/** 在不整頁重新載入的情況下換路由。
 *
 *  **為什麼不能用 `page.goto()`：** access token 只放在記憶體（規格 §6.1，
 *  `frontend/src/auth/store.ts`）——整頁重新載入會把它重置回 `null`。
 *  這支函式主要給 E2E 4 用：那條測試要單獨隔離「403 會不會多換一次票」
 *  這件事，如果用 `page.goto()` 直接輸入網址，第一個打出去的請求會因為
 *  記憶體裡沒有 token 而先天然地 401 → 換票一次（這是「整頁重新整理後
 *  第一次打 API」的正常行為，任何角色都一樣，見 e2e/auth.spec.ts 的
 *  「access token 過期時會自動換票」那條），這個換票**跟這條測試要驗的
 *  「403 不該觸發換票」完全無關，卻會污染同一個 request 計數器。
 *
 *  用 `history.pushState` + 手動觸發 `popstate` 讓 react-router（`history`
 *  套件 v5）在原本那個已經登入、記憶體裡 token 還活著的頁面裡換路由——
 *  這樣打到 `/admin/revisions` 的唯一一次請求就是乾淨的「有效 token 打一個
 *  只有管理員能打的端點」，不會混進任何 bootstrap 換票。 */
async function navigateWithoutReload(
	page: import("@playwright/test").Page,
	path: string,
) {
	await page.evaluate((target) => {
		window.history.pushState({}, "", target);
		window.dispatchEvent(new PopStateEvent("popstate"));
	}, path);
}

async function getAccessToken(
	request: import("@playwright/test").APIRequestContext,
	account: { email: string; password: string },
): Promise<string> {
	const response = await request.post("/api/auth/login", {
		data: { email: account.email, password: account.password },
	});
	const body = (await response.json()) as { access_token: string };
	return body.access_token;
}

/** 建一個全域食物，供 E2E 2、3 送審用。
 *
 *  **為什麼要自己建，不能靠種子：** `POST /api/foods` 一律建立
 *  `owner_id = 自己` 的私人食物，而私人食物的編輯直接生效、不送審
 *  （`propose_revision` 的 `is_own_private_food` 分支）——E2E 2、3 要測的
 *  「送審」流程只有全域食物（`owner_id IS NULL`）會走到。Task 8 的
 *  Step 1b 幫 `POST /api/foods` 加了 `is_global`（管理員限定），這裡就是
 *  那個新端點的第一個呼叫端。
 *
 *  **唯一約束對全域食物也有效**（`uq_foods_owner_id_name_brand` 帶
 *  `postgresql_nulls_not_distinct=True`，開工前查證過），所以食物名要帶
 *  `Date.now()`，不能寫死。 */
async function createGlobalFood(
	request: import("@playwright/test").APIRequestContext,
	name: string,
): Promise<{ id: number }> {
	const token = await getAccessToken(request, ADMIN);
	const response = await request.post("/api/foods", {
		headers: {
			Authorization: `Bearer ${token}`,
			"content-type": "application/json",
		},
		data: {
			name,
			is_global: true,
			nutrition: {
				base_unit: "g",
				kcal: "100.00",
				protein_g: "10.00",
				fat_g: "5.00",
				carb_g: "5.00",
			},
		},
	});
	return (await response.json()) as { id: number };
}

test("送審編輯 → 管理員登入 → 佇列看到新舊並排 → 通過 → 食物庫看到新數值", async ({
	browser,
	request,
}) => {
	// 這條天生需要兩個身分同時活著：MEMBER 送審、ADMIN 審核佇列——佇列裡
	// 「看到新舊並排」這件事本身就是要在 MEMBER 送出之後、ADMIN 審核
	// 之前的那個時間點觀察。
	//
	// 用兩個獨立的 `browser.newContext()`，不是同一個 `page` 先登出再登入：
	// 這裡要模擬的本來就是「兩個人」（提案者與審核者），兩個 context
	// 更貼近真實情境；也避免同一個 page 在兩個身分之間切換時，
	// TanStack Query 的記憶體快取（`queryClient` 是模組層單例）把上一個
	// 身分看到的資料帶到下一個身分的畫面上——`clearQueryCacheOnForcedLogout`
	// 只在 `logout()` 的路徑上被呼叫，用兩個獨立 context 連這個變數都不用
	// 考慮。
	const foodName = `E2E 全域食物 ${Date.now()}`;
	const food = await createGlobalFood(request, foodName);

	const memberContext = await browser.newContext();
	const memberPage = await memberContext.newPage();
	await login(memberPage, MEMBER);
	await memberPage.getByRole("link", { name: "食物庫" }).click();
	await memberPage.getByLabel("搜尋食物").fill(foodName);
	await memberPage.getByRole("link", { name: foodName }).click();

	// is_global === true 時，送出前的說明是「送審」（食物詳情 Task 5 的
	// 行為，跟 tests/food-detail.test.tsx 守的是同一件事，這裡用真的後端
	// 資料再驗一次）。
	await expect(memberPage.getByText(/送審/)).toBeVisible();

	await memberPage.getByLabel("熱量（每 100 單位 kcal）").fill("250");
	await memberPage.getByLabel("蛋白質（g）").fill("12");
	await memberPage.getByLabel("脂肪（g）").fill("8");
	await memberPage.getByLabel("碳水化合物（g）").fill("30");
	await memberPage.getByRole("button", { name: "送出" }).click();
	await expect(
		memberPage.getByText(/已送出，正在等待管理員審核/),
	).toBeVisible();

	const adminContext = await browser.newContext();
	const adminPage = await adminContext.newPage();
	await login(adminPage, ADMIN);
	await adminPage.getByRole("link", { name: "審核" }).click();

	const row = adminPage.getByRole("listitem").filter({ hasText: foodName });
	await expect(row).toBeVisible();
	// 新舊並排：目前生效的 100 跟提案的 250 要同時看得到，不是只顯示其中一個。
	await expect(row.getByText("100", { exact: true })).toBeVisible();
	await expect(row.getByText("250", { exact: true })).toBeVisible();

	await row.getByRole("button", { name: "通過" }).click();
	// 通過成功後 pendingRevisions 失效重取，這一筆從佇列消失。
	await expect(row).not.toBeVisible();

	await adminPage.getByRole("link", { name: "食物庫" }).click();
	await adminPage.getByLabel("搜尋食物").fill(foodName);
	await expect(adminPage.getByText("250 kcal / 100g")).toBeVisible();

	await memberContext.close();
	await adminContext.close();
	void food; // 只用來確認建立成功；後續全部靠畫面上的食物名稱找路徑。
});

test("駁回 → 提案者在食物庫的編輯歷史看得到駁回理由", async ({
	browser,
	request,
}) => {
	const foodName = `E2E 全域食物駁回 ${Date.now()}`;
	const rejectReason = `數值跟包裝標示不符 ${Date.now()}`;
	await createGlobalFood(request, foodName);

	const memberContext = await browser.newContext();
	const memberPage = await memberContext.newPage();
	await login(memberPage, MEMBER);
	await memberPage.getByRole("link", { name: "食物庫" }).click();
	await memberPage.getByLabel("搜尋食物").fill(foodName);
	await memberPage.getByRole("link", { name: foodName }).click();

	await memberPage.getByLabel("熱量（每 100 單位 kcal）").fill("999");
	await memberPage.getByLabel("蛋白質（g）").fill("1");
	await memberPage.getByLabel("脂肪（g）").fill("1");
	await memberPage.getByLabel("碳水化合物（g）").fill("1");
	await memberPage.getByRole("button", { name: "送出" }).click();
	await expect(
		memberPage.getByText(/已送出，正在等待管理員審核/),
	).toBeVisible();

	const adminContext = await browser.newContext();
	const adminPage = await adminContext.newPage();
	await login(adminPage, ADMIN);
	await adminPage.getByRole("link", { name: "審核" }).click();

	const row = adminPage.getByRole("listitem").filter({ hasText: foodName });
	await expect(row).toBeVisible();
	await row.getByLabel("駁回理由").fill(rejectReason);
	await row.getByRole("button", { name: "駁回" }).click();
	await expect(row).not.toBeVisible();

	// 提案者（同一個 memberPage，session 還活著）回食物庫的編輯歷史看駁回理由。
	// 用 reload 而不是 navigateWithoutReload：這裡不是在驗換票次數，
	// 要驗的是「駁回理由真的被寫回去了、且下一次讀取看得到」，
	// reload 更貼近「使用者晚點回來看」的真實情境，且更保證拿到最新資料
	// （不依賴 TanStack Query 的 invalidate 有沒有在對的時間點打到這個
	// 完全獨立的 browser context——那本來就打不到，兩個 context 的
	// queryClient 是各自獨立的模組實例）。
	//
	// **實測發現、清 localStorage 是必要的：** 第一次寫這條測試時沒清，
	// reload 之後畫面只看得到最原始那一筆「已通過」，駁回那一筆完全不見——
	// 不是後端沒寫進去（直接打 API 重現過：propose → reject 之後
	// `GET /api/foods/{id}/revisions` 確實回兩筆，駁回的那筆帶著
	// reject_reason），是 `PersistQueryClientProvider`（`api/persist.ts`）
	// 把 member 自己在 propose 之前那次瀏覽（只有 1 筆）持久化到
	// localStorage 過，`queryClient` 的 `staleTime` 是 60 秒（`api/queries.ts`），
	// reload restore 回來的那份快照在 60 秒視窗內被當成「還新鮮」，不會
	// 自動重打 API——member 自己的 propose 雖然有 invalidate，但那次的新狀態
	// 有沒有趕在 reload 前被節流寫回 localStorage 純粹是時間賽跑，不可靠。
	// 清掉這個 key，reload 之後就沒有快照可以 restore，保證是一次真的
	// 打 API 拿最新資料。
	//
	// **不能整個 `localStorage.clear()`：** refresh token 也放在
	// localStorage（`auth/store.ts` 的 `REFRESH_TOKEN_KEY`），清掉它會讓
	// reload 之後掉回登入畫面，這條測試就整個垮了。只清這一個 key。
	//
	// 字面值 `"nutrition-tracker-offline-cache"` 抄自
	// `frontend/src/api/persist.ts` 的 `OFFLINE_CACHE_STORAGE_KEY`——
	// `page.evaluate()` 在瀏覽器 context 裡執行，沒有簡單的路可以直接
	// import 那個模組（它會一路帶進 `@tanstack/query-async-storage-persister`
	// 等瀏覽器 API 依賴），兩邊改了其中一個要記得改另一個。
	await memberPage.evaluate(() => {
		localStorage.removeItem("nutrition-tracker-offline-cache");
	});
	await memberPage.reload();
	await expect(memberPage.getByText("已駁回", { exact: true })).toBeVisible();
	await expect(memberPage.getByText(rejectReason)).toBeVisible();

	await memberContext.close();
	await adminContext.close();
});

test("非管理員打 admin 端點 → 403 且沒有多打一次 /api/auth/refresh", async ({
	page,
}) => {
	// `client.ts` 的 `fetchWithAuthRetry` 只在 `response.status === 401` 才
	// 換票，403 直接落到 `!response.ok` 拋 `ApiError`——這是對的，不需要改。
	// 但如果有人把條件改寬成 `>= 401`：403 會先觸發換票，換票會成功
	// （refresh token 本身是好的，只是這個人不是管理員），重送之後還是同一個
	// 403、同一句訊息——**畫面上的結果一模一樣**。一條只斷言「看到『需要
	// 管理員權限』」的測試依然會綠，唯一抓得到這個錯誤的方式是數請求。
	const refreshCalls: string[] = [];
	page.on("request", (req) => {
		if (req.url().includes("/api/auth/refresh")) refreshCalls.push(req.url());
	});

	await login(page, MEMBER);
	await expect(page.getByRole("heading", { name: "今日總覽" })).toBeVisible();

	// MEMBER 看不到「審核」那個 tab（TabBar 的第五格是管理員限定），
	// 所以沒有連結可以點——這裡模擬的是「直接輸入網址」，但刻意不用
	// `page.goto()`（見 `navigateWithoutReload` 的註解：那會製造一次
	// 跟這條測試無關的 bootstrap 換票，污染這裡要驗的計數）。
	await navigateWithoutReload(page, "/admin/revisions");

	// **實測發現（跟計畫的示意碼不一樣的地方）：** `queryClient` 沒有覆寫
	// `retry`，TanStack Query v5 的預設是失敗重試 3 次（指數退避，
	// 1s／2s／4s），而且**不分狀態碼**——403 一樣會被當成「失敗，重試」。
	// 用 debug 腳本量過：`/api/admin/food-revisions` 在拿到「需要管理員
	// 權限」的錯誤畫面之前，實際被打了不只一次 403（重試期間
	// `revisionsQuery.isLoading` 一直是 true，畫面停在「載入中…」），
	// 用預設的 5 秒斷言逾時等不到錯誤畫面出現。這是既有行為（4xx 一律
	// 重試，不是這個 task 的範圍），這裡只是把逾時放寬到蓋過重試的總時間，
	// 不是去改 `queryClient` 的 retry 設定。
	//
	// **重試次數不影響這條測試要驗的事：** 每一次重試都是同一支
	// `apiFetch` 呼叫，`client.ts` 對每一次 403 的判斷都一樣——
	// 只要 `=== 401` 沒被改寬，不管重試幾次，`refreshCalls` 永遠是 0。
	await expect(page.getByText("需要管理員權限")).toBeVisible({
		timeout: 15_000,
	});
	expect(refreshCalls).toHaveLength(0);
});
