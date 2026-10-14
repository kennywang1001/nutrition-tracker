import { expect, type Locator, type Page, test } from "@playwright/test";
import { loginAs, newAccount } from "./new-account.ts";
import { expectTouchTargets } from "./touch-targets.ts";

// 身體資料與目標（含體重紀錄）規格 §8.3。一條測試一個新帳號：這些測試會改目標、記體重。
test.use({ viewport: { width: 390, height: 844 } });

/** 「YYYY-MM-DD」加減幾天。用 UTC 算（同前端的 `lib/civil-date`），不碰本機時區。
 *  起點一律是畫面上的日期欄預設值——那是後端給的「使用者的今天」，不是這台機器的今天。 */
function shiftDays(date: string, days: number): string {
	const [y, m, d] = date.split("-").map(Number);
	return new Date(Date.UTC(y ?? 0, (m ?? 1) - 1, (d ?? 1) + days))
		.toISOString()
		.slice(0, 10);
}

/** 同 `formatCivilDate`：「10/12」。 */
function shortDate(date: string): string {
	return `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;
}

/** 同 `lib/weights` 的 `dateLabel`：跟今天不同年的日期寫「2025/10/12」（一月初往回推會跨年）。 */
function dateLabel(date: string, today: string): string {
	return date.slice(0, 4) === today.slice(0, 4)
		? shortDate(date)
		: `${date.slice(0, 4)}/${shortDate(date)}`;
}

async function openMe(page: Page) {
	await page.getByRole("link", { name: "我的", exact: true }).click();
	await expect(
		page.getByRole("heading", { name: "我的", exact: true, level: 1 }),
	).toBeVisible();
}

/** 「我的」的體重卡片記一筆（日期用預設的今天），回傳那個今天。 */
async function recordWeightOnMe(page: Page, kg: string): Promise<string> {
	const card = page.getByTestId("weight-card");
	await card.getByRole("button", { name: "記錄體重", exact: true }).click();
	// 表單打開時「記錄體重」與「看全部」那一列整個換成表單。
	await expect(
		card.getByRole("link", { name: "看全部", exact: true }),
	).toBeHidden();
	const today = await card.getByLabel("日期", { exact: true }).inputValue();
	expect(today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
	await card.getByLabel("體重（公斤）", { exact: true }).fill(kg);
	await card.getByRole("button", { name: "儲存", exact: true }).click();
	await expect(
		card.getByRole("button", { name: "記錄體重", exact: true }),
	).toBeVisible();
	await expect(card).toContainText(`${kg} 公斤・${shortDate(today)}`);
	return today;
}

async function openTargets(page: Page) {
	await page.getByRole("link", { name: "修改每日目標", exact: true }).click();
	await expect(
		page.getByRole("heading", { name: "每日目標", exact: true, level: 1 }),
	).toBeVisible();
}

/** 建議目標的熱量（「2070 kcal」裡的數字）。 */
async function suggestedKcal(page: Page): Promise<string> {
	const suggestion = page.getByTestId("suggestion");
	await expect(
		suggestion.getByRole("button", { name: "套用建議目標", exact: true }),
	).toBeVisible();
	const text = (
		await suggestion.getByTestId("suggestion-kcal").textContent()
	)?.trim();
	const kcal = /^(\d+) kcal$/.exec(text ?? "")?.[1];
	if (kcal === undefined) throw new Error(`建議熱量的格式不對：${text}`);
	return kcal;
}

async function applySuggestion(page: Page) {
	await page
		.getByTestId("suggestion")
		.getByRole("button", { name: "套用建議目標", exact: true })
		.click();
	await expect(
		page.getByRole("heading", { name: "我的", exact: true, level: 1 }),
	).toBeVisible();
}

/** iOS 在 < 16px 的欄位上會自動放大（handover「mobile-form-zoom」）。
 *  `ready` 是表單畫出來之後才有的欄位：標題先出來、資料還在載入時，數到的是 0 個。 */
async function expectInputsAtLeast16px(
	page: Page,
	ready: Locator,
	where: string,
) {
	await expect(ready).toBeVisible();
	const controls = page.locator("main input, main select");
	const count = await controls.count();
	expect(count, `${where}：要有輸入框`).toBeGreaterThan(0);
	for (let i = 0; i < count; i++) {
		const px = await controls
			.nth(i)
			.evaluate((node) => Number.parseFloat(getComputedStyle(node).fontSize));
		expect(px, `${where} 第 ${i} 個欄位`).toBeGreaterThanOrEqual(16);
	}
}

test("缺資料時說還差什麼；填身體資料、記體重、套用建議，總覽的分母跟著變；體重變了就提示重算", async ({
	page,
	request,
}) => {
	const account = await newAccount(request, "body");
	await loginAs(page, account);
	await openMe(page);
	await expect(page.getByTestId("body-profile-card")).toContainText("還沒有填");
	await expect(page.getByTestId("weight-card")).toContainText("還沒有體重紀錄");

	// 什麼都沒填：建議區塊列出缺的（固定順序），兩個連結都在。
	await openTargets(page);
	const suggestion = page.getByTestId("suggestion");
	await expect(suggestion).toContainText(
		"還差：性別、出生年、身高、活動量、目標、速度、體重",
	);
	await expect(
		suggestion.getByRole("link", { name: "記錄體重", exact: true }),
	).toBeVisible();
	await expect(
		suggestion.getByRole("button", { name: "套用建議目標", exact: true }),
	).toHaveCount(0);
	await suggestion
		.getByRole("link", { name: "填寫身體資料", exact: true })
		.click();

	await expect(
		page.getByRole("heading", { name: "身體資料", exact: true, level: 1 }),
	).toBeVisible();
	await expectInputsAtLeast16px(
		page,
		page.getByLabel("出生年", { exact: true }),
		"身體資料",
	);
	await page
		.getByRole("group", { name: "性別", exact: true })
		.getByLabel("男", { exact: true })
		.check();
	await page.getByLabel("出生年", { exact: true }).fill("1990");
	await page.getByLabel("身高（cm）", { exact: true }).fill("175");
	await page
		.getByRole("combobox", { name: "活動量", exact: true })
		.selectOption({ label: "中度（每週運動 3–5 天）" });
	const goal = page.getByRole("group", { name: "目標", exact: true });
	const rate = page.getByRole("group", { name: "速度", exact: true });
	// 速度只有減重、增重才問。
	await goal.getByLabel("維持", { exact: true }).check();
	await expect(rate).toHaveCount(0);
	await goal.getByLabel("減重", { exact: true }).check();
	await rate.getByLabel("每週 0.5 公斤", { exact: true }).check();
	await expectTouchTargets(
		page.locator("main button:visible, main label:has(input[type=radio])"),
		"身體資料",
	);
	await page.getByRole("button", { name: "儲存", exact: true }).click();
	await expect(
		page.getByRole("heading", { name: "我的", exact: true, level: 1 }),
	).toBeVisible();
	await expect(page.getByTestId("body-profile-card")).toContainText(
		"男・1990 年生・175 cm・中度活動・減重每週 0.5 公斤",
	);

	await recordWeightOnMe(page, "80");
	await openTargets(page);
	const kcal = await suggestedKcal(page);
	await expect(suggestion).toContainText("依 ");
	await expect(suggestion).toContainText("的體重 80 公斤");
	await applySuggestion(page);
	await expect(page.getByTestId("targets-card")).toContainText(`${kcal} kcal`);

	await page.getByRole("link", { name: "總覽", exact: true }).click();
	await expect(
		page.getByRole("heading", { name: "總覽", exact: true }),
	).toBeVisible();
	await expect(page.getByTestId("today-kcal")).toContainText(`/ ${kcal} kcal`);

	await openMe(page);
	const targetsCard = page.getByTestId("targets-card");
	await expect(targetsCard).toContainText(`${kcal} kcal`);
	await expect(targetsCard).not.toContainText("體重變了");
	await recordWeightOnMe(page, "78.5"); // 同一天：更正，最新體重是 78.5
	await expect(targetsCard).toContainText(
		"體重變了 -1.5 公斤，要重算建議目標嗎？",
	);

	// 重算：建議跟著新體重變，套用之後提示消失。
	await targetsCard
		.getByRole("link", { name: "重算建議目標", exact: true })
		.click();
	await expect(
		page.getByRole("heading", { name: "每日目標", exact: true, level: 1 }),
	).toBeVisible();
	await expect(suggestion).toContainText("的體重 78.5 公斤");
	const lighter = await suggestedKcal(page);
	expect(Number(lighter)).toBeLessThan(Number(kcal));
	await applySuggestion(page);
	await expect(targetsCard).toContainText(`${lighter} kcal`);
	await expect(targetsCard).not.toContainText("體重變了");
});

test("只差體重時只給「記錄體重」；記了之後有目標線，建議調到最低熱量", async ({
	page,
	request,
}) => {
	const account = await newAccount(request, "floor");
	await loginAs(page, account);
	await openMe(page);

	await page.getByRole("link", { name: "修改身體資料", exact: true }).click();
	await expect(
		page.getByRole("heading", { name: "身體資料", exact: true, level: 1 }),
	).toBeVisible();
	await page
		.getByRole("group", { name: "性別", exact: true })
		.getByLabel("女", { exact: true })
		.check();
	await page.getByLabel("出生年", { exact: true }).fill("1990");
	await page.getByLabel("身高（cm）", { exact: true }).fill("150");
	await page
		.getByRole("combobox", { name: "活動量", exact: true })
		.selectOption({ label: "久坐（幾乎不運動）" });
	await page
		.getByRole("group", { name: "目標", exact: true })
		.getByLabel("減重", { exact: true })
		.check();
	await page
		.getByRole("group", { name: "速度", exact: true })
		.getByLabel("每週 0.5 公斤", { exact: true })
		.check();
	await page.getByLabel("目標體重（kg，選填）", { exact: true }).fill("42");
	await page.getByRole("button", { name: "儲存", exact: true }).click();
	await expect(
		page.getByRole("heading", { name: "我的", exact: true, level: 1 }),
	).toBeVisible();
	await expect(page.getByTestId("body-profile-card")).toContainText(
		"目標 42 公斤",
	);

	await openTargets(page);
	const suggestion = page.getByTestId("suggestion");
	await expect(suggestion).toContainText("還差：體重");
	await expect(
		suggestion.getByRole("link", { name: "填寫身體資料", exact: true }),
	).toHaveCount(0);
	await suggestion.getByRole("link", { name: "記錄體重", exact: true }).click();

	await expect(
		page.getByRole("heading", { name: "體重", exact: true, level: 1 }),
	).toBeVisible();
	await expect(page.getByText("還沒有體重紀錄", { exact: true })).toBeVisible();
	// 沒有任何紀錄時不畫期間切換與圖。
	await expect(
		page.getByRole("group", { name: "期間", exact: true }),
	).toHaveCount(0);
	const form = page.getByTestId("weight-form");
	const today = await form.getByLabel("日期", { exact: true }).inputValue();
	await form.getByLabel("體重（公斤）", { exact: true }).fill("45");
	await form.getByRole("button", { name: "儲存", exact: true }).click();
	const chart = page.getByRole("group", { name: "體重", exact: true });
	await expect(
		chart.getByRole("img", {
			name: `${dateLabel(today, today)}，45 公斤`,
			exact: true,
		}),
	).toBeVisible();
	// 水平線的外框高度是 0，Playwright 會當成看不見：只看它在不在。
	await expect(chart.getByTestId("weight-target")).toHaveCount(1);
	await expect(page.getByText("目標 42 公斤", { exact: true })).toBeVisible();
	await expect(
		page.getByText("最近 7 天平均 45 公斤", { exact: true }),
	).toBeVisible();

	// 女、36 歲上下、150 cm、45 kg、久坐、每週減 0.5：原始值遠低於 1200，調到下限。
	await openMe(page);
	await openTargets(page);
	expect(await suggestedKcal(page)).toBe("1200");
	await expect(suggestion).toContainText("已調到最低建議熱量 1200 kcal");
});

test("體重頁：記幾天、切期間、改一筆、刪一筆；卡片跟 7 天前比", async ({
	page,
	request,
}) => {
	const account = await newAccount(request, "weight");
	await loginAs(page, account);
	await openMe(page);
	const today = await recordWeightOnMe(page, "79");
	await page
		.getByTestId("weight-card")
		.getByRole("link", { name: "看全部", exact: true })
		.click();
	await expect(
		page.getByRole("heading", { name: "體重", exact: true, level: 1 }),
	).toBeVisible();
	await expectInputsAtLeast16px(
		page,
		page.getByTestId("weight-form").getByLabel("日期", { exact: true }),
		"體重",
	);

	const list = page.getByRole("list", { name: "體重紀錄", exact: true });
	const rows = list.getByRole("listitem");
	const chart = page.getByRole("group", { name: "體重", exact: true });
	const points = chart.getByRole("img");
	const form = page.getByTestId("weight-form");
	async function record(date: string, kg: string) {
		await form.getByLabel("日期", { exact: true }).fill(date);
		await form.getByLabel("體重（公斤）", { exact: true }).fill(kg);
		await form.getByRole("button", { name: "儲存", exact: true }).click();
		await expect(
			list.getByText(dateLabel(date, today), { exact: true }),
		).toBeVisible();
	}

	const weekAgo = shiftDays(today, -7);
	const twoDaysAgo = shiftDays(today, -2);
	const longAgo = shiftDays(today, -40);
	await record(weekAgo, "79.4");
	await record(twoDaysAgo, "81.2");
	await record(longAgo, "83");
	await expect(rows).toHaveCount(4);
	// 由新到舊。
	await expect(rows.first()).toContainText(dateLabel(today, today));
	await expect(rows.last()).toContainText(dateLabel(longAgo, today));

	// 預設 30 天：40 天前那筆不在圖上；90 天才有。
	await expect(points).toHaveCount(3);
	await expect(chart.getByTestId(`weight-point-${longAgo}`)).toHaveCount(0);
	const span = page.getByRole("group", { name: "期間", exact: true });
	await span.getByLabel("90 天", { exact: true }).check();
	await expect(points).toHaveCount(4);
	await expect(
		chart.getByRole("img", {
			name: `${dateLabel(longAgo, today)}，83 公斤`,
			exact: true,
		}),
	).toBeVisible();
	await span.getByLabel("全部", { exact: true }).check();
	await expect(points).toHaveCount(4);
	await span.getByLabel("30 天", { exact: true }).check();
	await expect(points).toHaveCount(3);

	// 最近 7 天＝[今天 − 6, 今天]：79 與 81.2。
	await expect(
		page.getByText("最近 7 天平均 80.1 公斤", { exact: true }),
	).toBeVisible();

	const older = dateLabel(twoDaysAgo, today);
	await list
		.getByRole("button", { name: `修改 ${older}`, exact: true })
		.click();
	const editing = rows.filter({
		has: page.getByLabel(`${older} 的體重（公斤）`, { exact: true }),
	});
	await editing
		.getByLabel(`${older} 的體重（公斤）`, { exact: true })
		.fill("81");
	await editing.getByRole("button", { name: "儲存", exact: true }).click();
	await expect(
		chart.getByRole("img", { name: `${older}，81 公斤`, exact: true }),
	).toBeVisible();
	await expect(
		list.getByRole("button", { name: `修改 ${older}`, exact: true }),
	).toBeFocused();
	await expect(
		page.getByText("最近 7 天平均 80 公斤", { exact: true }),
	).toBeVisible();

	await list
		.getByRole("button", { name: `刪除 ${older}`, exact: true })
		.click();
	const confirm = page.getByRole("alertdialog", {
		name: `刪除 ${older} 的體重？`,
		exact: true,
	});
	await expect(
		confirm.getByRole("button", { name: "取消", exact: true }),
	).toBeFocused();
	await confirm.getByRole("button", { name: "刪除", exact: true }).click();
	await expect(rows).toHaveCount(3);
	await expect(points).toHaveCount(2);
	await expect(chart.getByTestId(`weight-point-${twoDaysAgo}`)).toHaveCount(0);
	await expect(
		page.getByText("最近 7 天平均 79 公斤", { exact: true }),
	).toBeVisible();
	await expectTouchTargets(page.locator("main button:visible"), "體重");

	// 卡片：最新一筆是今天的 79，7 天前（含）最近的一筆是 79.4。
	await openMe(page);
	const card = page.getByTestId("weight-card");
	await expect(card).toContainText(`79 公斤・${shortDate(today)}`);
	await expect(card).toContainText("比 7 天前 -0.4 公斤");
});
