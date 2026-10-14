import { expect, type Locator, type Page, test } from "@playwright/test";
import { loginAs, newAccount } from "./new-account.ts";
import { expectTouchTargets } from "./touch-targets.ts";

// 運動紀錄規格 §9.3。一條測試一個新帳號：會設目標、記體重、改「加回額度」的設定。
// 小工具從 body-targets.spec.ts 複製過來（不 import：Playwright 會把那個檔案的測試也註冊進來）。
test.use({ viewport: { width: 390, height: 844 } });

const RUNNING = "跑步（約 10 km/h）";
const RUNNING_MET = 9.8;

/** 規格 §4：kcal = MET × 體重 × 小時，四捨五入到整數（HALF_UP；這裡的值都是正的，
 *  `Math.round` 的 .5 往上就是 HALF_UP）。測試自己算，不抄畫面。 */
function expectedKcal(met: number, kg: number, minutes: number): number {
	return Math.round((met * kg * minutes) / 60);
}

/** 同 `formatCivilDate`：「10/14」。 */
function shortDate(date: string): string {
	return `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;
}

async function openMe(page: Page) {
	await page.getByRole("link", { name: "我的", exact: true }).click();
	await expect(
		page.getByRole("heading", { name: "我的", exact: true, level: 1 }),
	).toBeVisible();
}

async function openTargets(page: Page) {
	await page.getByRole("link", { name: "修改每日目標", exact: true }).click();
	await expect(
		page.getByRole("heading", { name: "每日目標", exact: true, level: 1 }),
	).toBeVisible();
}

async function openOverview(page: Page) {
	await page.getByRole("link", { name: "總覽", exact: true }).click();
	await expect(
		page.getByRole("heading", { name: "總覽", exact: true, level: 1 }),
	).toBeVisible();
}

async function openAddExercise(page: Page) {
	await page.getByRole("button", { name: "新增紀錄", exact: true }).click();
	await page.getByRole("link", { name: "記運動", exact: true }).click();
	await expect(
		page.getByRole("heading", { name: "記運動", exact: true, level: 1 }),
	).toBeVisible();
	// 活動清單回來了才算表單好了（標題先出來）。
	await expect(
		page.getByRole("option", { name: RUNNING, exact: true }),
	).toBeAttached();
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

test("沒有體重要手動；記了體重之後估算；總覽的額度含運動；改分鐘、關掉加回、刪除", async ({
	page,
	request,
}) => {
	const account = await newAccount(request, "exercise");
	await loginAs(page, account);

	// 1. 目標 2000 kcal。
	await openMe(page);
	await openTargets(page);
	const manualTargets = page.getByRole("region", {
		name: "自己設定",
		exact: true,
	});
	await manualTargets.getByLabel("熱量（kcal）", { exact: true }).fill("2000");
	await manualTargets
		.getByRole("button", { name: "儲存", exact: true })
		.click();
	await expect(
		page.getByRole("heading", { name: "我的", exact: true, level: 1 }),
	).toBeVisible();
	const targetsCard = page.getByTestId("targets-card");
	await expect(targetsCard).toContainText("2000 kcal");

	// 2. 還沒有體重：只能手動，勾選框鎖住、熱量欄在、提示帶一個去記體重的連結。
	await openAddExercise(page);
	const activity = page.getByLabel("活動", { exact: true });
	const minutes = page.getByLabel("分鐘", { exact: true });
	const manual = page.getByRole("checkbox", {
		name: "手動輸入熱量",
		exact: true,
	});
	const kcalField = page.getByLabel("熱量（kcal）", { exact: true });
	await activity.selectOption({ label: RUNNING });
	await minutes.fill("30");
	// 提示跟連結在同一個 <p> 裡：Playwright 比整個元素的文字，所以不帶 exact。
	const hint = page.getByText("先記一次體重，就能自動估算");
	await expect(hint).toBeVisible();
	await expect(manual).toBeChecked();
	await expect(manual).toBeDisabled();
	await expect(kcalField).toBeVisible();
	await expectInputsAtLeast16px(page, kcalField, "記運動");
	await expectTouchTargets(
		page.locator(
			"main form button, main form label:has(input[type=checkbox]), main form p a",
		),
		"記運動",
	);
	// 不存：去記體重。
	await hint.getByRole("link", { name: "記錄體重", exact: true }).click();
	await expect(
		page.getByRole("heading", { name: "體重", exact: true, level: 1 }),
	).toBeVisible();

	// 3. 記 70 公斤（日期用預設的今天）。
	const weightForm = page.getByTestId("weight-form");
	const today = await weightForm
		.getByLabel("日期", { exact: true })
		.inputValue();
	expect(today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
	await weightForm.getByLabel("體重（公斤）", { exact: true }).fill("70");
	await weightForm.getByRole("button", { name: "儲存", exact: true }).click();
	await expect(
		page
			.getByRole("list", { name: "體重紀錄", exact: true })
			.getByRole("listitem"),
	).toHaveCount(1);

	// 4. 再記一次：這次有體重，預覽給估算，勾選框可以勾（不勾）。
	const thirty = expectedKcal(RUNNING_MET, 70, 30);
	expect(thirty).toBe(343);
	await openAddExercise(page);
	await activity.selectOption({ label: RUNNING });
	await minutes.fill("30");
	await expect(
		page.getByText(
			`約 ${thirty} kcal（依 ${shortDate(today)} 的體重 70 公斤）`,
			{ exact: true },
		),
	).toBeVisible();
	await expect(manual).not.toBeChecked();
	await expect(manual).toBeEnabled();
	await expect(kcalField).toHaveCount(0);
	await expect(hint).toHaveCount(0);
	await page.getByRole("button", { name: "儲存", exact: true }).click();
	await expect(
		page.getByRole("heading", { name: "總覽", exact: true, level: 1 }),
	).toBeVisible();

	// 5. 總覽：分母是目標＋運動，時間線有那一列。
	const todayKcal = page.getByTestId("today-kcal");
	await expect(todayKcal).toContainText(`/ ${2000 + thirty} kcal`);
	await expect(todayKcal).toContainText(`含運動 +${thirty}`);
	const exerciseRow = (minutesText: string) =>
		page
			.getByTestId("timeline-row")
			.filter({ hasText: `${RUNNING}・${minutesText} 分鐘` });
	await expect(exerciseRow("30")).toHaveCount(1);
	await expect(exerciseRow("30")).toContainText(`-${thirty} kcal`);

	// 6. 改成 60 分鐘：重估、總覽跟著變。
	await exerciseRow("30").getByRole("link").click();
	await expect(
		page.getByRole("heading", { name: "編輯運動", exact: true, level: 1 }),
	).toBeVisible();
	await expect(minutes).toHaveValue("30");
	const sixty = expectedKcal(RUNNING_MET, 70, 60);
	expect(sixty).toBe(686);
	await minutes.fill("60");
	await expect(
		page.getByText(
			`約 ${sixty} kcal（依 ${shortDate(today)} 的體重 70 公斤）`,
			{ exact: true },
		),
	).toBeVisible();
	await page.getByRole("button", { name: "儲存", exact: true }).click();
	await expect(
		page.getByRole("heading", { name: "總覽", exact: true, level: 1 }),
	).toBeVisible();
	await expect(todayKcal).toContainText(`/ ${2000 + sixty} kcal`);
	await expect(todayKcal).toContainText(`含運動 +${sixty}`);
	await expect(exerciseRow("60")).toContainText(`-${sixty} kcal`);
	await expect(exerciseRow("30")).toHaveCount(0);

	// 飲食頁的「今日運動」卡片：那一筆與合計。
	await page.getByRole("link", { name: "飲食", exact: true }).click();
	await expect(
		page.getByRole("heading", { name: "今日運動", exact: true, level: 2 }),
	).toBeVisible();
	const todayList = page.getByRole("list", { name: "今日運動", exact: true });
	await expect(todayList.getByRole("listitem")).toHaveCount(1);
	await expect(todayList).toContainText(`${RUNNING}・60 分鐘`);
	await expect(todayList).toContainText(`-${sixty} kcal`);
	await expect(
		page.getByText(`共 -${sixty} kcal`, { exact: true }),
	).toBeVisible();

	// 7. 關掉「加回」：分母回到目標，運動照樣在時間線上。
	await openMe(page);
	const budgetSwitch = targetsCard.getByRole("switch", {
		name: "運動消耗加回今天的熱量額度",
		exact: true,
	});
	await expect(budgetSwitch).toBeChecked();
	await budgetSwitch.click();
	await expect(budgetSwitch).not.toBeChecked();
	await expect(budgetSwitch).toBeEnabled();
	await openOverview(page);
	await expect(todayKcal).toContainText("/ 2000 kcal");
	await expect(todayKcal).not.toContainText("含運動");
	await expect(exerciseRow("60")).toContainText(`-${sixty} kcal`);

	// 8. 刪除：確認框的焦點在「取消」，按「刪除」回總覽，那一列不見。
	await exerciseRow("60").getByRole("link").click();
	await expect(
		page.getByRole("heading", { name: "編輯運動", exact: true, level: 1 }),
	).toBeVisible();
	await expect(minutes).toHaveValue("60");
	await page.getByRole("button", { name: "刪除這筆運動", exact: true }).click();
	const confirm = page.getByRole("alertdialog", {
		name: "刪除這筆運動？",
		exact: true,
	});
	await expect(
		confirm.getByRole("button", { name: "取消", exact: true }),
	).toBeFocused();
	await confirm.getByRole("button", { name: "刪除", exact: true }).click();
	await expect(
		page.getByRole("heading", { name: "總覽", exact: true, level: 1 }),
	).toBeVisible();
	await expect(page.getByText("今天還沒有紀錄", { exact: true })).toBeVisible();
	await expect(page.getByTestId("timeline-row")).toHaveCount(0);

	// 9. 飲食頁：卡片說今天還沒有運動，有「記運動」的連結。
	await page.getByRole("link", { name: "飲食", exact: true }).click();
	await expect(
		page.getByRole("heading", { name: "今日運動", exact: true, level: 2 }),
	).toBeVisible();
	await expect(page.getByText("今天還沒有運動", { exact: true })).toBeVisible();
	await expect(
		page.getByRole("link", { name: "記運動", exact: true }),
	).toBeVisible();
});
