import {
	type APIRequestContext,
	expect,
	type Locator,
	type Page,
	test,
} from "@playwright/test";
import { loginAs, type NewAccount, newAccount } from "./new-account.ts";
import { expectTouchTargets } from "./touch-targets.ts";

// 按讚、留言、通知（社群規格 §8.3）。單元測試看得到的是「送了哪個請求、畫了哪個字」；
// 這裡看的是兩個人各自的瀏覽器之間真的接起來：一邊做的事，另一邊點一下分頁就看得到。
//
// **每條測試自己開帳號**（`newAccount`）、一個人一個 context，不碰示範帳號——
// `friends.spec.ts` 會動管理員的好友關係，並行跑的時候不能跟它共用任何人。
//
// **登入之後只用點擊換頁**（理由在 `desktop-layout.spec.ts`：整頁載入會換一次 refresh
// token，緊接著的下一次載入拿舊的去換會被當成重用）。每個 context 只有一次 `goto`。

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 800 };

type Headers = { authorization: string };

async function apiLogin(
	request: APIRequestContext,
	account: NewAccount,
): Promise<Headers> {
	const login = await request.post("/api/auth/login", {
		data: { email: account.email, password: account.password },
	});
	expect(login.ok()).toBe(true);
	const { access_token } = (await login.json()) as { access_token: string };
	return { authorization: `Bearer ${access_token}` };
}

/** 主人的那一餐用 API 建（這個檔案要測的不是記一餐）：一個只有這條測試有的食物、
 *  一份點心、公開。回餐的 id（陌生人那一條要拿它組網址）。 */
async function seedMeal(
	request: APIRequestContext,
	headers: Headers,
	food: string,
): Promise<number> {
	const created = await request.post("/api/foods", {
		headers,
		data: {
			name: food,
			nutrition: {
				base_unit: "g",
				kcal: "123.00",
				protein_g: "10.00",
				fat_g: "5.00",
				carb_g: "5.00",
			},
		},
	});
	expect(created.ok()).toBe(true);
	const { id: foodId } = (await created.json()) as { id: number };
	const meal = await request.post("/api/meals", {
		headers,
		data: {
			eaten_at: new Date().toISOString(),
			meal_type: "snack",
			items: [{ food_id: foodId, quantity: "1" }],
		},
	});
	expect(meal.ok()).toBe(true);
	const { id } = (await meal.json()) as { id: number };
	return id;
}

/** 用 API 加好友：`inviter` 用 `receiver` 的好友碼送邀請，`receiver` 接受。
 *  （`inviter` 因此多一則「接受了你的好友邀請」。）畫面上的加好友在第一條測試。 */
async function befriend(
	request: APIRequestContext,
	inviter: Headers,
	receiver: Headers,
) {
	const mine = await request.get("/api/friends/me/code", { headers: receiver });
	expect(mine.ok()).toBe(true);
	const { code } = (await mine.json()) as { code: string };
	const sent = await request.post("/api/friends/requests", {
		headers: inviter,
		data: { code },
	});
	expect(sent.ok()).toBe(true);
	const pending = await request.get("/api/friends/requests", {
		headers: receiver,
	});
	expect(pending.ok()).toBe(true);
	const { incoming } = (await pending.json()) as {
		incoming: { id: number }[];
	};
	const invitation = incoming[0];
	if (invitation === undefined) throw new Error("對方沒有收到邀請");
	const accepted = await request.post(
		`/api/friends/requests/${invitation.id}/accept`,
		{ headers: receiver },
	);
	expect(accepted.ok()).toBe(true);
}

async function likeMeal(
	request: APIRequestContext,
	headers: Headers,
	mealId: number,
) {
	const liked = await request.put(`/api/social/meals/${mealId}/like`, {
		headers,
	});
	expect(liked.ok()).toBe(true);
}

/** 分頁列（手機）或左側導覽（電腦）上的連結。先縮到導覽裡：「我的」在飲食頁也是
 *  一個單選鈕的字，餐點頁的標題是「我的點心」。 */
function tab(page: Page, name: "總覽" | "飲食" | "我的"): Locator {
	return page
		.getByRole("navigation", { name: "主要導覽", exact: true })
		.getByRole("link", { name, exact: true });
}

/** 點分頁換頁，等那一頁自己的 h1 出現（換頁後第一個斷言選新頁面才有的東西）。
 *  分頁的連結是 `/diet`（不帶 `?view=`），所以點「飲食」一定回到「我的」那個檢視。 */
async function go(page: Page, name: "總覽" | "飲食" | "我的") {
	await tab(page, name).click();
	await expect(
		page.getByRole("heading", { name, exact: true, level: 1 }),
	).toBeVisible();
}

function h1(page: Page, name: string): Locator {
	return page.getByRole("heading", { name, exact: true, level: 1 });
}

/** 留言區的標題「留言（N）」——全形括號；刪完一則之後焦點在它身上。 */
function commentsHeading(page: Page, count: number): Locator {
	return page.getByRole("heading", {
		name: `留言（${count}）`,
		exact: true,
		level: 2,
	});
}

async function openFriendFeed(page: Page): Promise<Locator> {
	await go(page, "飲食");
	// 切換的單選鈕是藏起來的 input：點它的文字（同 e2e/friends.spec.ts）。
	await page.getByText("好友", { exact: true }).click();
	const feed = page.getByRole("region", { name: "好友動態", exact: true });
	await expect(feed).toBeVisible();
	return feed;
}

async function openNotifications(page: Page): Promise<Locator> {
	await go(page, "我的");
	await page.getByRole("link", { name: "看通知", exact: true }).click();
	await expect(h1(page, "通知")).toBeVisible();
	return page.getByRole("list", { name: "通知", exact: true });
}

/** 還沒登入就直接打開一個網址：畫面是登入表單，登入之後留在那個網址上
 *  （`App.tsx`：登入只是把外框換成有路由的那一個，不導去別的地方）。
 *  這個 context 唯一的一次 `goto`。 */
async function loginAt(page: Page, account: NewAccount, path: string) {
	await page.goto(path);
	await page.getByLabel("Email", { exact: true }).fill(account.email);
	await page.getByLabel("密碼", { exact: true }).fill(account.password);
	await page.getByRole("button", { name: "登入", exact: true }).click();
}

test("社群：按讚、留言、通知、刪留言；解除好友之後讚不算、對方看不到那一餐", async ({
	browser,
	request,
}) => {
	test.setTimeout(120_000);
	const stamp = Date.now();
	const a = await newAccount(request, "social-a");
	const b = await newAccount(request, "social-b");
	const food = `E2E 社群點心 ${stamp}`;
	const comment = `看起來好好吃 ${stamp}`;
	// 好友看到的名稱（讚的按鈕、留言連結、餐點頁的標題都帶它）。
	const meal = `${a.name}的點心`;
	const asA = await apiLogin(request, a);
	const mealId = await seedMeal(request, asA, food);

	const contextA = await browser.newContext({ viewport: PHONE });
	const contextB = await browser.newContext({ viewport: PHONE });
	const pageA = await contextA.newPage();
	const pageB = await contextB.newPage();
	await loginAs(pageA, a);
	await loginAs(pageB, b);
	const mineA = tab(pageA, "我的");
	const mineB = tab(pageB, "我的");

	// ── 加好友：A 用 B 的好友碼送邀請，B 接受 ─────────────────────────────
	await go(pageB, "我的");
	const code =
		(await pageB.getByTestId("friend-code").textContent())?.trim() ?? "";
	expect(code).not.toBe("");
	await go(pageA, "我的");
	await expect(pageA.getByTestId("notifications-card")).toContainText(
		"沒有新通知",
	);
	await pageA.getByLabel("朋友的好友碼").fill(code);
	await pageA.getByRole("button", { name: "送出邀請", exact: true }).click();
	await expect(
		pageA.getByText(`已送出邀請給${b.name}，等對方接受`),
	).toBeVisible();

	// B 換一次頁：未讀數在換頁時重抓（不用等 60 秒的輪詢），分頁上有 A 的邀請那一則。
	await go(pageB, "總覽");
	await expect(mineB).toHaveAccessibleDescription("1 則新通知");
	await go(pageB, "我的");
	await expect(pageB.getByTestId("notifications-card")).toContainText(
		"1 則新通知",
	);
	await pageB
		.getByRole("button", { name: `接受${a.name}的邀請`, exact: true })
		.click();
	await expect(
		pageB.getByRole("button", { name: `解除和${a.name}的好友`, exact: true }),
	).toBeVisible();
	// 接受之後那一則「想加你為好友」不是變成已讀，是不見了：數字跟著歸零。
	await expect(mineB).toHaveAccessibleDescription("");
	await expect(pageB.getByTestId("notifications-card")).toContainText(
		"沒有新通知",
	);

	// A 先看一次自己的飲食頁：一則「B 接受了邀請」；卡片上還沒有讚、留言 0。
	// （這一次抓回來的餐點清單留在快取裡，後面要看它會不會自己換新。）
	await go(pageA, "飲食");
	await expect(mineA).toHaveAccessibleDescription("1 則新通知");
	// 自己卡片的連結名稱開頭是時間（跟瀏覽器語系走），所以只對結尾。
	const ownComments = (count: number) =>
		pageA.getByRole("link", { name: new RegExp(`點心，留言 ${count} 則$`) });
	await expect(ownComments(0)).toBeVisible();
	await expect(pageA.getByText("1 個讚", { exact: true })).toHaveCount(0);
	await expectTouchTargets(ownComments(0), "自己卡片上的「留言 N」");

	// ── B 在好友動態按讚、進餐點頁留言 ───────────────────────────────────
	const feed = await openFriendFeed(pageB);
	// 卡片是外層的 listitem，裡面每一項食物也是一個 listitem：兩個都含食物的名字，
	// 文件順序上卡片在前。先縮到卡片——同一個好友同一天兩餐同一個餐別時，
	// 讚的按鈕名稱是一樣的。
	const card = feed.getByRole("listitem").filter({ hasText: food }).first();
	const cardLike = card.getByRole("button", {
		name: `讚，${meal}`,
		exact: true,
	});
	await expect(cardLike).toHaveAttribute("aria-pressed", "false");
	await expect(cardLike).toHaveAccessibleDescription("0 個讚");
	await expectTouchTargets(cardLike, "好友卡片上的讚");
	// 卡片上的兩個連結：好友的名字、「留言 N」。
	await expect(card.getByRole("link")).toHaveCount(2);
	await expectTouchTargets(card.getByRole("link"), "好友卡片上的連結");
	await cardLike.click();
	await expect(cardLike).toHaveAttribute("aria-pressed", "true");
	await expect(cardLike).toHaveAccessibleDescription("1 個讚");
	await card
		.getByRole("link", { name: `${meal}，留言 0 則`, exact: true })
		.click();
	await expect(h1(pageB, meal)).toBeVisible();

	// 餐點頁：剛才在卡片上按的讚在這裡也是按下去的，名單上是「我」。
	const likeB = pageB.getByRole("button", { name: `讚，${meal}`, exact: true });
	await expect(likeB).toHaveAttribute("aria-pressed", "true");
	await expect(likeB).toHaveAccessibleDescription("1 個讚");
	await expect(pageB.getByText("我 說讚", { exact: true })).toBeVisible();
	await expect(commentsHeading(pageB, 0)).toBeVisible();
	// 留言框的名稱是「寫留言」——「留言」是清單的名稱（`<ol aria-label="留言">`）。
	const box = pageB.getByRole("textbox", { name: "寫留言", exact: true });
	const send = pageB.getByRole("button", { name: "送出", exact: true });
	await expectTouchTargets(likeB, "餐點頁的讚");
	await expectTouchTargets(box, "留言框");
	await expectTouchTargets(send, "送出");
	await expectTouchTargets(
		pageB.getByRole("link", { name: a.name, exact: true }),
		"餐點頁上好友的名字",
	);
	await box.fill(comment);
	await send.click();
	const commentsB = pageB.getByRole("list", { name: "留言", exact: true });
	await expect(
		commentsB.getByRole("listitem").filter({ hasText: comment }),
	).toBeVisible();
	await expect(commentsHeading(pageB, 1)).toBeVisible();
	// 按的是送出鍵，焦點在按鈕上：送完要回到輸入框、清空，可以接著打下一則。
	await expect(box).toBeFocused();
	await expect(box).toHaveValue("");
	await expectTouchTargets(
		pageB.getByRole("button", {
			name: `刪除 ${b.name} 的留言`,
			exact: true,
		}),
		"自己留言的刪除",
	);

	// ── A：分頁上的數字 → 自己的卡片 → 通知 → 餐點頁 → 刪掉 B 的留言 ──────
	await go(pageA, "總覽");
	// 三則：B 接受邀請、B 按讚、B 留言。
	await expect(mineA).toHaveAccessibleDescription("3 則新通知");
	await expectTouchTargets(mineA, "分頁列的「我的」（有未讀數字）");
	// 未讀數變多＝有人對我的餐做了什麼：幾秒前才抓過的餐點清單（還在 60 秒的
	// staleTime 裡）跟著重抓，卡片上的數字不用重新整理。
	await go(pageA, "飲食");
	await expect(ownComments(1)).toBeVisible();
	await expect(pageA.getByText("1 個讚", { exact: true })).toHaveCount(1);

	const noticesA = await openNotifications(pageA);
	const rows = noticesA.getByRole("link");
	await expect(rows).toHaveCount(3);
	// 新的在前；句子自己一個元素（整列的名稱還帶著「未讀」與時間）。
	const commentNotice = noticesA.getByText(
		`${b.name} 在你的點心留言：${comment}`,
		{ exact: true },
	);
	await expect(rows.first()).toContainText("在你的點心留言");
	await expect(commentNotice).toBeVisible();
	await expect(
		noticesA.getByText(`${b.name} 對你的點心按了讚`, { exact: true }),
	).toBeVisible();
	// 好友的通知沒有餐可以去：連到「我的」（好友卡片在那裡）。
	await expect(
		rows.filter({ hasText: `${b.name} 接受了你的好友邀請` }),
	).toHaveAttribute("href", "/me");
	await expectTouchTargets(rows, "通知的每一列");
	// 打開就標成已讀：分頁上的數字不見了……
	await expect(mineA).toHaveAccessibleDescription("");
	// ……但這一次的畫面上，剛看到的三則還標著「未讀」（不重抓清單）。
	await expect(noticesA.getByText("未讀", { exact: true })).toHaveCount(3);

	await commentNotice.click();
	await expect(h1(pageA, "我的點心")).toBeVisible();
	await expect(
		pageA.getByText(`${b.name} 說讚`, { exact: true }),
	).toBeVisible();
	// 主人不能按讚：沒有按鈕，數字是給螢幕閱讀器的一段字。
	await expect(pageA.getByText("1 個讚", { exact: true })).toHaveCount(1);
	await expect(
		pageA.getByRole("button", { name: "讚，我的點心", exact: true }),
	).toHaveCount(0);
	await expect(commentsHeading(pageA, 1)).toBeVisible();
	await expect(
		pageA
			.getByRole("list", { name: "留言", exact: true })
			.getByRole("listitem")
			.filter({ hasText: comment }),
	).toBeVisible();
	await expectTouchTargets(
		pageA.getByRole("link", { name: "編輯", exact: true }),
		"餐點頁的「編輯」",
	);
	const remove = pageA.getByRole("button", {
		name: `刪除 ${b.name} 的留言`,
		exact: true,
	});
	await expectTouchTargets(remove, "主人刪別人的留言");
	await remove.click();
	const confirm = pageA.getByRole("alertdialog", {
		name: "確認刪除留言",
		exact: true,
	});
	// 「確定刪除」與「取消」。
	await expect(confirm.getByRole("button")).toHaveCount(2);
	await expectTouchTargets(confirm.getByRole("button"), "刪留言的確認");
	await confirm.getByRole("button", { name: "確定刪除", exact: true }).click();
	// 那一列連同按鈕都不見了：焦點移到留言區的標題。
	await expect(commentsHeading(pageA, 0)).toBeFocused();
	await expect(pageA.getByText(comment)).toHaveCount(0);
	await expect(pageA.getByText("還沒有留言", { exact: true })).toBeVisible();

	// 再開一次通知：留言那一則跟著留言一起不見了（剩兩列＝這是重抓回來的），
	// 上一次看過的也不再標「未讀」。
	const noticesAgain = await openNotifications(pageA);
	await expect(noticesAgain.getByRole("link")).toHaveCount(2);
	await expect(noticesAgain.getByText("未讀", { exact: true })).toHaveCount(0);
	await expect(noticesAgain.getByText("在你的點心留言")).toHaveCount(0);

	// ── B 回動態：留言數回到 0，讚還在；進去也看不到那一則 ───────────────
	const feedAgain = await openFriendFeed(pageB);
	const cardAgain = feedAgain
		.getByRole("listitem")
		.filter({ hasText: food })
		.first();
	await expect(
		cardAgain.getByRole("button", { name: `讚，${meal}`, exact: true }),
	).toHaveAttribute("aria-pressed", "true");
	await cardAgain
		.getByRole("link", { name: `${meal}，留言 0 則`, exact: true })
		.click();
	await expect(h1(pageB, meal)).toBeVisible();
	await expect(commentsHeading(pageB, 0)).toBeVisible();
	await expect(pageB.getByText(comment)).toHaveCount(0);
	await expect(likeB).toHaveAttribute("aria-pressed", "true");

	// ── 第三個人 C（用 API）：也是 A 的好友、也按了讚 ─────────────────────
	// 為了下面的解除：只有 B 一個讚的話，解除之後主人的頁面因為「0 個讚」整列
	// 不畫——名單有沒有過濾掉 B 根本看不出來。有 C 在，那一列還在，上面只該剩 C。
	const c = await newAccount(request, "social-c");
	const asC = await apiLogin(request, c);
	await befriend(request, asA, asC);
	await likeMeal(request, asC, mealId);

	// ── A 解除好友：B 的讚不算了（資料列還在，讀的時候過濾）───────────────
	// 解除之前先看一次自己的卡片：留言 0、兩個讚（換頁時未讀數變多，清單跟著重抓）。
	// 這一次抓回來的清單留在快取裡（60 秒內算新鮮），下面要看解除會不會讓它重抓。
	await go(pageA, "飲食");
	await expect(ownComments(0)).toBeVisible();
	await expect(pageA.getByText("2 個讚", { exact: true })).toHaveCount(1);
	await go(pageA, "我的");
	await pageA
		.getByRole("button", { name: `解除和${b.name}的好友`, exact: true })
		.click();
	await pageA.getByRole("button", { name: "確定解除", exact: true }).click();
	await expect(
		pageA.getByRole("button", { name: `解除和${b.name}的好友`, exact: true }),
	).toHaveCount(0);
	// 飲食頁的卡片：解除時自己的餐點清單被標成過期，回來就重抓——只剩 C 的讚。
	await go(pageA, "飲食");
	await expect(pageA.getByText("1 個讚", { exact: true })).toHaveCount(1);
	await expect(pageA.getByText("2 個讚", { exact: true })).toHaveCount(0);
	await ownComments(0).click();
	// 解除時餐點頁的快取整個拿掉了：標題出現＝這是剛抓回來的資料。
	// 名單上只有 C——B 的名字不在這一頁的任何地方。
	await expect(h1(pageA, "我的點心")).toBeVisible();
	await expect(commentsHeading(pageA, 0)).toBeVisible();
	await expect(
		pageA.getByText(`${c.name} 說讚`, { exact: true }),
	).toBeVisible();
	await expect(pageA.getByText("1 個讚", { exact: true })).toHaveCount(1);
	await expect(pageA.getByText(b.name)).toHaveCount(0);

	// ── B 還開著那一餐的頁面：一按讚（後端回 404）整頁換成「看不到這一餐」──
	await likeB.click();
	await expect(h1(pageB, "餐點")).toBeVisible();
	const gone = pageB.getByText("看不到這一餐", { exact: true });
	await expect(gone).toBeVisible();
	await expect(gone).toHaveRole("alert");
	await expect(h1(pageB, meal)).toHaveCount(0);
	await expect(pageB.getByText(food)).toHaveCount(0);
	const back = pageB.getByRole("link", { name: "回飲食", exact: true });
	await expectTouchTargets(back, "看不到這一餐的「回飲食」");
	await back.click();
	await expect(h1(pageB, "飲食")).toBeVisible();
	await pageB.getByText("好友", { exact: true }).click();
	await expect(
		pageB.getByText("還沒有好友。到「我的」→「好友」用好友碼加朋友"),
	).toBeVisible();

	await contextA.close();
	await contextB.close();
});

test("社群：陌生人用網址開不了別人的餐", async ({ browser, request }) => {
	const stamp = Date.now();
	const owner = await newAccount(request, "social-owner");
	const stranger = await newAccount(request, "social-stranger");
	const food = `E2E 社群陌生人 ${stamp}`;
	const mealId = await seedMeal(request, await apiLogin(request, owner), food);
	const path = `/meals/${mealId}`;

	// 先確認這個網址真的是那一餐：主人打開看得到。只斷言「看不到」的話，
	// 網址組錯了也會綠。
	const ownerContext = await browser.newContext({ viewport: PHONE });
	const ownerPage = await ownerContext.newPage();
	await loginAt(ownerPage, owner, path);
	await expect(h1(ownerPage, "我的點心")).toBeVisible();
	await expect(
		ownerPage
			.getByRole("list", { name: "這一餐吃了什麼", exact: true })
			.getByText(food),
	).toBeVisible();

	// 陌生人（不是好友、沒有邀請）打開同一個網址：跟不存在的餐同一個畫面。
	const strangerContext = await browser.newContext({ viewport: PHONE });
	const strangerPage = await strangerContext.newPage();
	await loginAt(strangerPage, stranger, path);
	await expect(h1(strangerPage, "餐點")).toBeVisible();
	const gone = strangerPage.getByText("看不到這一餐", { exact: true });
	await expect(gone).toBeVisible();
	await expect(gone).toHaveRole("alert");
	expect(new URL(strangerPage.url()).pathname).toBe(path);
	// 那一餐的任何東西都沒有畫出來：標題、食物、留言框。
	await expect(strangerPage.getByText("點心")).toHaveCount(0);
	await expect(strangerPage.getByText(food)).toHaveCount(0);
	await expect(strangerPage.getByText(owner.name)).toHaveCount(0);
	await expect(
		strangerPage.getByRole("textbox", { name: "寫留言", exact: true }),
	).toHaveCount(0);
	// 這一頁唯一能做的事是回去。
	await strangerPage.getByRole("link", { name: "回飲食", exact: true }).click();
	await expect(h1(strangerPage, "飲食")).toBeVisible();

	await ownerContext.close();
	await strangerContext.close();
});

test("社群（電腦版）：左側導覽的未讀數字；通知頁與餐點頁是窄的那一種寬度", async ({
	browser,
	request,
}) => {
	const stamp = Date.now();
	const a = await newAccount(request, "social-wide-a");
	const b = await newAccount(request, "social-wide-b");
	const food = `E2E 社群電腦版 ${stamp}`;
	const comment = `電腦版也看得到 ${stamp}`;
	const asA = await apiLogin(request, a);
	const asB = await apiLogin(request, b);
	const mealId = await seedMeal(request, asA, food);

	// 這一條要量的是版面，所以好友、讚、留言都直接用 API 做（畫面上的流程在第一條）。
	await befriend(request, asA, asB);
	await likeMeal(request, asB, mealId);
	const commented = await request.post(`/api/social/meals/${mealId}/comments`, {
		headers: asB,
		data: { body: comment },
	});
	expect(commented.status()).toBe(201);

	const context = await browser.newContext({ viewport: DESKTOP });
	const page = await context.newPage();
	await loginAs(page, a);

	// 左側導覽：連結的名稱仍然是「我的」，數字是它的描述；看得到的標記寫著 3。
	const nav = page.getByRole("navigation", { name: "主要導覽", exact: true });
	const navBox = await nav.boundingBox();
	expect(navBox?.x, "導覽在左邊").toBe(0);
	expect(navBox?.height ?? 0, "導覽是直的一整欄").toBeGreaterThan(700);
	const mine = tab(page, "我的");
	await expect(mine).toHaveAccessibleDescription("3 則新通知");
	await expect(mine.getByText("3", { exact: true })).toBeVisible();

	/** 內容區剛好是窄的上限（640）。下限是防量錯元素——一個縮成內容寬度的
	 *  元素也會 ≤ 640（同 `desktop-layout.spec.ts` 的「我的」）。 */
	async function expectNarrow(where: string) {
		const content = await page.locator("main > .app-content").boundingBox();
		expect(content?.width ?? 0, `${where}的內容寬度`).toBeLessThanOrEqual(640);
		expect(content?.width ?? 0, `${where}的內容寬度`).toBeGreaterThan(600);
		const overflow = await page.evaluate(
			() =>
				document.documentElement.scrollWidth -
				document.documentElement.clientWidth,
		);
		expect(overflow, `${where}有橫向捲軸`).toBeLessThanOrEqual(0);
	}

	const notices = await openNotifications(page);
	await expect(notices.getByRole("link")).toHaveCount(3);
	await expectNarrow("通知頁");
	// 已讀之後左側導覽上的數字也不見。
	await expect(mine).toHaveAccessibleDescription("");

	await notices
		.getByText(`${b.name} 在你的點心留言：${comment}`, { exact: true })
		.click();
	await expect(h1(page, "我的點心")).toBeVisible();
	await expect(
		page
			.getByRole("list", { name: "留言", exact: true })
			.getByRole("listitem")
			.filter({ hasText: comment }),
	).toBeVisible();
	await expectNarrow("餐點頁");

	await context.close();
});
