import { readFile } from "node:fs/promises";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { loginAs, newAccount } from "./new-account.ts";
import { expectTouchTargets, login } from "./touch-targets.ts";

// 兩條會記帳的測試各自開一個新帳號：總額與 CSV 的列數才是確定的（示範帳號同時有
// 別的 worker 在記帳）。登入之後只用點擊換頁；唯一的 `page.reload()` 用的是自己的帳號、
// 只有這一頁，不會跟別的 worker 搶同一張 refresh token。
//
// 名稱一律 exact：「這個月」是「這個月花了多少」的子字串，「2026年9月」是
// 「2026年9月花了多少」的子字串，「花費」「餐點」「補劑」在別的頁面是標題的一部分。

const PHONE = { width: 390, height: 844 };

/** ＋ → 記帳 → 123.45、交通、備註 → 回到總覽（同 money-loop.spec.ts 的點法）。 */
async function addExpense(page: Page, note: string) {
	await page.getByRole("button", { name: "新增紀錄", exact: true }).click();
	await page.getByRole("link", { name: "記帳", exact: true }).click();
	await expect(
		page.getByRole("heading", { name: "記帳", exact: true }),
	).toBeVisible();
	for (const key of ["1", "2", "3", "小數點", "4", "5"]) {
		await page.getByRole("button", { name: key, exact: true }).click();
	}
	await page.getByRole("button", { name: "交通", exact: true }).click();
	await page.getByLabel("備註", { exact: true }).fill(note);
	await page.getByRole("button", { name: "記一筆", exact: true }).click();
	await expect(
		page.getByRole("heading", { name: "總覽", exact: true }),
	).toBeVisible();
}

test("報表看其他月份：上個月沒有剛記的那一筆，網址記得月份，重新整理不會跳回這個月", async ({
	page,
	request,
}) => {
	const account = await newAccount(request, "months");
	await loginAs(page, account);
	const note = `e2e-month-${Date.now()}`;
	await addExpense(page, note);

	await page.getByRole("link", { name: "報表", exact: true }).click();
	await expect(
		page.getByRole("heading", { name: "這個月花了多少", exact: true }),
	).toBeVisible();
	const summary = page.getByTestId("expense-summary");
	const list = page.getByTestId("month-list");
	const previous = page.getByRole("button", { name: "上個月", exact: true });
	const next = page.getByRole("button", { name: "下個月", exact: true });
	await expect(summary).toContainText("總計 123.45");
	await expect(list.getByText(note, { exact: true })).toBeVisible();
	// 不能按是 aria-disabled（Playwright 的 toBeDisabled 兩種都認），不是原生的 disabled：
	// 原生的收不到焦點，見下面翻回這個月的那一段。
	await expect(next).toBeDisabled();
	await expect(next).toHaveAttribute("aria-disabled", "true");
	await expect(next).not.toHaveAttribute("disabled");
	await expect(page).toHaveURL(/\/reports$/);

	// 上個月：新帳號，什麼都沒有。
	await previous.click();
	await expect(page).toHaveURL(/\/reports\?month=\d{4}-\d{2}$/);
	const pastUrl = page.url();
	const pastHeading = page.getByRole("heading", {
		name: /^\d{4}年\d{1,2}月花了多少$/,
	});
	await expect(pastHeading).toBeVisible();
	// 先等那個月真的載入完（不是還留著、調淡的這個月），再斷言「沒有」。
	await expect(summary).toContainText("總計 0.00");
	await expect(page.getByTestId("month-summary")).not.toHaveAttribute(
		"aria-busy",
		"true",
	);
	await expect(summary).not.toContainText("123.45");
	await expect(list).not.toHaveAttribute("aria-busy", "true");
	await expect(list.getByText(note, { exact: true })).toHaveCount(0);
	await expect(next).toBeEnabled();

	// 重新整理：還在那個月。
	//
	// reload 之前**不清**離線快取（以前要清，handover §6 第 17 種）：它是節流寫入的，還原回來的
	// 可能是**記帳之前**總覽存的那一份「這個月 0.00」。現在還原回來的 query 一律重抓
	// （`src/api/persist.ts` 的 `serializePersistedClient`），下面翻回這個月時等到的是伺服器的
	// 123.45，不管快照是哪一份。
	await page.reload();
	await expect(pastHeading).toBeVisible();
	await expect(page).toHaveURL(pastUrl);
	await expect(summary).toContainText("總計 0.00");
	await expect(list.getByText(note, { exact: true })).toHaveCount(0);

	// 下個月＝這個月：網址沒有 ?month，剛記的那一筆在。
	await next.click();
	await expect(
		page.getByRole("heading", { name: "這個月花了多少", exact: true }),
	).toBeVisible();
	await expect(page).toHaveURL(/\/reports$/);
	await expect(summary).toContainText("總計 123.45");
	await expect(list.getByText(note, { exact: true })).toBeVisible();
	await expect(next).toBeDisabled();
	// 剛按下去的那顆變成不能按，但焦點還在它上面：用鍵盤的人還在原地——再按 Enter 沒有
	// 反應（網址不動），Shift+Tab 就是「上個月」。
	await expect(next).toBeFocused();
	await page.keyboard.press("Enter");
	await expect(page).toHaveURL(/\/reports$/);
	await expect(summary).toContainText("總計 123.45");
	await page.keyboard.press("Shift+Tab");
	await expect(previous).toBeFocused();

	// 換月份是一筆一筆的歷史紀錄：瀏覽器的上一頁回到上個月。
	await page.goBack();
	await expect(page).toHaveURL(pastUrl);
	await expect(pastHeading).toBeVisible();
});

test("匯出花費：下載的 CSV 檔名帶日期、開頭有 BOM、內容有剛記的那一筆", async ({
	page,
	request,
}) => {
	const account = await newAccount(request, "export");
	await loginAs(page, account);
	// 備註故意用 = 開頭：一路走到 CSV 裡要被加上單引號（不會被試算表當公式）。
	const note = `=e2e-export-${Date.now()}`;
	await addExpense(page, note);

	await page.getByRole("link", { name: "我的", exact: true }).click();
	await expect(
		page.getByRole("heading", { name: "匯出資料", exact: true }),
	).toBeVisible();
	const card = page.getByTestId("export-card");

	const downloading = page.waitForEvent("download");
	await card.getByRole("button", { name: "花費", exact: true }).click();
	const download = await downloading;

	expect(download.suggestedFilename()).toMatch(
		/^expenses-\d{4}-\d{2}-\d{2}\.csv$/,
	);
	await expect(card.getByRole("status")).toHaveText(
		`已下載 ${download.suggestedFilename()}`,
	);
	const path = await download.path();
	const bytes = await readFile(path);
	expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
	const lines = bytes.subarray(3).toString("utf8").split("\r\n");
	// 新帳號：標題、剛記的那一筆、結尾的空字串（最後一列也以 CRLF 結束）。
	expect(lines).toHaveLength(3);
	expect(lines[0]).toBe("日期,時間,分類,金額,備註,是否餐費");
	expect(lines[1]).toMatch(
		new RegExp(
			`^\\d{4}-\\d{2}-\\d{2},\\d{2}:\\d{2},交通,123\\.45,'${note},否$`,
		),
	);
	expect(lines[2]).toBe("");
	// 三顆按鈕都恢復可以按；下載中它們是 aria-disabled 而不是原生停用，所以按下去的
	// 那一顆從頭到尾沒有把焦點弄丟。
	const expensesButton = card.getByRole("button", {
		name: "花費",
		exact: true,
	});
	await expect(expensesButton).toBeEnabled();
	await expect(expensesButton).toBeFocused();
	for (const name of ["餐點", "補劑"]) {
		await expect(card.getByRole("button", { name, exact: true })).toBeEnabled();
	}
});

/** 用座標點一個元素的正中央。`locator.click()` 會等到元素「點得到」為止——要測的正是
 *  它點不到，所以不能用。 */
async function clickCentre(page: Page, target: Locator) {
	const box = await target.boundingBox();
	if (box === null) throw new Error("要點的元素量不到位置");
	await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

test("換月份時留著的上一個月：看得到但點不到、Tab 不到，載入完才能操作", async ({
	page,
	request,
}) => {
	const account = await newAccount(request, "stale");
	await loginAs(page, account);
	const note = `e2e-stale-${Date.now()}`;
	await addExpense(page, note);

	await page.getByRole("link", { name: "報表", exact: true }).click();
	const list = page.getByTestId("month-list");
	const previous = page.getByRole("button", { name: "上個月", exact: true });
	const next = page.getByRole("button", { name: "下個月", exact: true });
	await expect(list.getByText(note, { exact: true })).toBeVisible();
	// 用 CSS 找：inert 的那一層不在無障礙樹裡，getByRole 在那段時間找不到這幾顆。
	const edit = list.locator("button", { hasText: "修改" });
	const remove = list.locator("button", { hasText: "刪除" });
	const editor = list.locator("input");
	const confirm = list.locator('[role="alertdialog"]');

	// 上個月的兩個請求先扣住：這段時間標題已經是上個月，底下留著的是這個月的那一筆。
	let release: () => void = () => {};
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	await page.route(/\/api\/expenses(\/summary)?\?month=/, async (route) => {
		await held;
		await route.continue();
	});
	await previous.click();
	await expect(
		page.getByRole("heading", { name: /^\d{4}年\d{1,2}月花了多少$/ }),
	).toBeVisible();
	await expect(list).toHaveAttribute("aria-busy", "true");
	await expect(list.getByText(note, { exact: true })).toBeVisible();

	// 點不到：修改的輸入框、刪除的確認都沒有出現。
	await clickCentre(page, edit);
	await clickCentre(page, remove);
	await expect(editor).toHaveCount(0);
	await expect(confirm).toHaveCount(0);
	// Tab 不到：從「上個月」開始（剛才點在 inert 的地方，焦點已經不在按鈕上了），
	// 下一個是「下個月」，再下一個本來會是那一筆的「修改」。
	await previous.focus();
	await page.keyboard.press("Tab");
	await expect(next).toBeFocused();
	await page.keyboard.press("Tab");
	await expect(list.locator(":focus")).toHaveCount(0);

	release();
	await expect(page.getByTestId("expense-summary")).toContainText("總計 0.00");
	await expect(list).not.toHaveAttribute("aria-busy", "true");
	await expect(list.getByText(note, { exact: true })).toHaveCount(0);

	// 回到這個月：同樣的點法點得到——上面的「沒有反應」不是因為點歪了。
	await next.click();
	await expect(list.getByText(note, { exact: true })).toBeVisible();
	await expect(list).not.toHaveAttribute("aria-busy", "true");
	await clickCentre(page, edit);
	await expect(editor).toHaveCount(1);
});

test.describe("手機尺寸", () => {
	test.use({ viewport: PHONE });

	test("月份切換與匯出的按鈕都 ≥ 44px；月份切換排成一列、沒有橫向捲軸", async ({
		page,
	}) => {
		// 只看不改：用共用的示範帳號就好。
		await login(page);
		await page.getByRole("link", { name: "報表", exact: true }).click();
		await expect(
			page.getByRole("heading", { name: "這個月花了多少", exact: true }),
		).toBeVisible();
		const switcher = page.getByRole("group", { name: "切換月份", exact: true });
		const previous = switcher.getByRole("button", {
			name: "上個月",
			exact: true,
		});
		const next = switcher.getByRole("button", { name: "下個月", exact: true });
		// 等「這個月是哪個月」回來：在那之前「上個月」是停用的。
		await expect(previous).toBeEnabled();
		await expectTouchTargets(switcher.getByRole("button"), "月份切換");

		// 一個一個量、不從陣列解構：`noUncheckedIndexedAccess` 底下解構出來的每一個
		// 都多一個 `undefined`，只擋 `null` 過不了型別檢查。
		const left = await previous.boundingBox();
		const label = await switcher.getByRole("status").boundingBox();
		const right = await next.boundingBox();
		if (left === null || label === null || right === null) {
			throw new Error("月份切換的三個元素有一個量不到");
		}
		// 一列：由左到右是 上個月、月份、下個月，三個的垂直中心差不多。
		expect(label.x).toBeGreaterThanOrEqual(left.x + left.width);
		expect(right.x).toBeGreaterThanOrEqual(label.x + label.width);
		const centers = [left, label, right].map((box) => box.y + box.height / 2);
		expect(Math.max(...centers) - Math.min(...centers)).toBeLessThan(4);
		const overflow = await page.evaluate(
			() =>
				document.documentElement.scrollWidth -
				document.documentElement.clientWidth,
		);
		expect(overflow).toBeLessThanOrEqual(0);

		await previous.click();
		await expect(page).toHaveURL(/\/reports\?month=\d{4}-\d{2}$/);
		await expectTouchTargets(
			switcher.getByRole("button"),
			"月份切換（上個月）",
		);

		await page.getByRole("link", { name: "我的", exact: true }).click();
		await expect(
			page.getByRole("heading", { name: "匯出資料", exact: true }),
		).toBeVisible();
		await expectTouchTargets(
			page.getByTestId("export-card").getByRole("button"),
			"匯出資料",
		);
	});
});
