import { expect, type Locator, type Page, test } from "@playwright/test";
import { login } from "./touch-targets.ts";

// 電腦版版面（電腦版版面規格 §6）。jsdom 不做版面計算，單元測試只測得到
// 「畫了哪個導覽、加了哪個 class」；這裡量真的幾何：導覽在哪、誰在誰右邊、
// 有沒有橫向捲軸、鍵盤多寬。
//
// 斷點是 1024px：1280 一定是電腦版、390 一定是手機版，兩邊各離斷點夠遠，
// 不會因為捲軸寬度之類的細節落到另一邊。

/** 每一頁換頁之後先等的東西——**只有那一頁才有**（handover §6 第 53 種）。
 *  `exact: true`：Playwright 的名稱是子字串比對，「我的」會同時對到
 *  「我的好友碼」；導覽裡的「總覽」「報表」是連結不是標題，不會混到。
 *  記帳頁的標題「記帳」跟新增選單裡的連結同名，改等它獨有的「記一筆」。 */
const PAGES: readonly { path: string; ready: (page: Page) => Locator }[] = [
	{
		path: "/",
		ready: (page) => page.getByRole("heading", { name: "總覽", exact: true }),
	},
	{
		path: "/reports",
		ready: (page) => page.getByRole("heading", { name: "報表", exact: true }),
	},
	{
		path: "/diet",
		ready: (page) => page.getByRole("heading", { name: "飲食", exact: true }),
	},
	{
		path: "/me",
		ready: (page) => page.getByRole("heading", { name: "我的", exact: true }),
	},
	{
		path: "/expenses/new",
		ready: (page) => page.getByRole("button", { name: "記一筆", exact: true }),
	},
];

/** 換頁，等到那一頁獨有的東西出現才開始量——不然量到的可能是還沒畫完的頁面。 */
async function open(page: Page, path: string) {
	const entry = PAGES.find((candidate) => candidate.path === path);
	if (entry === undefined) throw new Error(`PAGES 裡沒有 ${path}`);
	await page.goto(path);
	await expect(entry.ready(page)).toBeVisible();
}

async function expectNoHorizontalScroll(page: Page, path: string) {
	const overflow = await page.evaluate(
		() =>
			document.documentElement.scrollWidth -
			document.documentElement.clientWidth,
	);
	expect(overflow, `${path} 有橫向捲軸`).toBeLessThanOrEqual(0);
}

/** boundingBox 在元素不在畫面上時回 null；這裡直接當失敗，不要讓 `?.` 把
 *  null 變成 undefined、再讓比較式靜靜地不成立或成立。 */
async function box(locator: Locator) {
	await expect(locator).toBeVisible();
	const b = await locator.boundingBox();
	if (b === null) throw new Error("元素不在畫面上");
	return b;
}

test.describe("電腦版 1280×800", () => {
	test.use({ viewport: { width: 1280, height: 800 } });

	test("左側導覽、各頁沒有橫向捲軸", async ({ page }) => {
		await login(page);
		for (const { path } of PAGES) {
			await open(page, path);
			// 每一頁都有左側導覽，包括記帳（規格 §3）。
			const nav = page.getByRole("navigation", { name: "主要導覽" });
			const b = await box(nav);
			expect(b.x, `${path} 導覽的左緣`).toBe(0);
			expect(b.width, `${path} 導覽的寬度`).toBeLessThan(260);
			expect(b.height, `${path} 導覽的高度`).toBeGreaterThan(700);
			await expectNoHorizontalScroll(page, path);
		}
	});

	test("總覽：時間線在數字卡的右邊", async ({ page }) => {
		await login(page);
		await open(page, "/");
		const card = await box(page.getByTestId("month-spend"));
		const timeline = await box(
			page.getByRole("heading", { name: "今天", exact: true }),
		);
		expect(timeline.x).toBeGreaterThan(card.x + card.width);
	});

	test("報表：明細在摘要的右邊", async ({ page }) => {
		await login(page);
		await open(page, "/reports");
		const summary = await box(page.getByTestId("expense-summary"));
		const list = await box(
			page.getByRole("heading", { name: "這個月", exact: true }),
		);
		expect(list.x).toBeGreaterThan(summary.x + summary.width);
	});

	test("飲食：餐點在右欄，補劑在左欄的營養素下面", async ({ page }) => {
		await login(page);
		await open(page, "/diet");
		// 營養素（有沒有設目標都有 macro-kcal）出現了，統計才載入完、版面才定。
		const macros = await box(page.getByTestId("macro-kcal"));
		const meals = await box(
			page.getByRole("heading", { name: "今日餐點", exact: true }),
		);
		const supplements = await box(
			page.getByRole("heading", { name: "今日補劑", exact: true }),
		);
		expect(meals.x).toBeGreaterThan(supplements.x + supplements.width);
		// 補劑跟營養素同一欄（左緣差不多，卡片的內距一樣），而且在它下面。
		// DOM 順序是 營養素 → 餐點 → 補劑；grid-template-areas 沒生效的話，
		// 補劑會掉到餐點下面、或是跑到右欄。
		expect(Math.abs(supplements.x - macros.x)).toBeLessThan(40);
		expect(supplements.y).toBeGreaterThan(macros.y + macros.height);
		// 緊貼在營養素卡片下面：中間只有兩張卡片的內距、兩列的間距、標題的上邊距。
		// Today.module.css 第二列是 1fr 不是 auto 的理由——兩列都 auto 的話，
		// 右欄的餐點比較長時多出來的高度會平分，營養素與補劑中間空一截。
		// （今天的餐點比左欄短時兩種寫法量起來一樣，這條只在餐點多的時候有鑑別力。）
		const lastMacro = await box(page.getByTestId("macro-carb_g"));
		const gap = supplements.y - (lastMacro.y + lastMacro.height);
		expect(gap).toBeLessThan(100);
	});

	test("記帳：數字鍵盤最寬 480px", async ({ page }) => {
		await login(page);
		await open(page, "/expenses/new");
		const keypad = await box(page.getByRole("group", { name: "數字鍵盤" }));
		expect(keypad.width).toBeLessThanOrEqual(480);
	});

	test("新增選單是畫面中間的對話框", async ({ page }) => {
		await login(page);
		await open(page, "/");
		await page.getByRole("button", { name: "新增紀錄" }).click();
		const dialog = await box(page.getByRole("dialog", { name: "新增紀錄" }));
		expect(dialog.width).toBeLessThanOrEqual(400);
		// 底部面板會貼著畫面下緣；對話框上下都留白。
		expect(dialog.y + dialog.height).toBeLessThan(800 - 50);
		expect(dialog.y).toBeGreaterThan(50);
		// 左右也置中（以整個視窗為準：遮罩蓋住整個畫面，包括左側導覽）。
		expect(Math.abs(dialog.x + dialog.width / 2 - 1280 / 2)).toBeLessThan(2);
	});
});

test.describe("手機 390×844", () => {
	test.use({ viewport: { width: 390, height: 844 } });

	test("導覽在底部、各頁沒有橫向捲軸", async ({ page }) => {
		await login(page);
		for (const { path } of PAGES) {
			await open(page, path);
			await expectNoHorizontalScroll(page, path);
			const nav = page.getByRole("navigation", { name: "主要導覽" });
			if (path === "/expenses/new") {
				// 手機版的記帳頁不顯示分頁列（記帳與離線規格 §2 (b)）。
				await expect(nav).toHaveCount(0);
				continue;
			}
			const b = await box(nav);
			expect(b.y + b.height, `${path} 導覽的下緣`).toBeGreaterThan(844 - 2);
			expect(b.width, `${path} 導覽的寬度`).toBeGreaterThan(380);
		}
	});
});
