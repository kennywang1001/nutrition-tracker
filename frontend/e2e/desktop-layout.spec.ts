import { expect, type Locator, type Page, test } from "@playwright/test";
import { login } from "./touch-targets.ts";

// 電腦版版面（電腦版版面規格 §6）。jsdom 不做版面計算，單元測試只測得到
// 「畫了哪個導覽、加了哪個 class」；這裡量真的幾何：導覽在哪、誰在誰右邊、
// 有沒有橫向捲軸、鍵盤多寬。
//
// 斷點是 1024px：1280 一定是電腦版、390 一定是手機版，兩邊各離斷點夠遠，
// 不會因為捲軸寬度之類的細節落到另一邊。

/** 這個檔案量的五頁。
 *
 *  **登入之後只用點擊換頁，不用 `page.goto`**（同 money-loop.spec.ts）：token
 *  在記憶體裡，每次整頁載入都要打 `/api/auth/refresh` 換一組新的。頁面獨有的
 *  標題比 refresh 的回應先畫出來，緊接著的下一個 `goto` 就會拿舊的 refresh
 *  token 再換一次——後端當成重用、撤銷整個 family，使用者被登出。並行跑全部
 *  e2e 時這條檔案因此偶爾掉到登入畫面。點擊導航不重新載入頁面，不打 refresh。
 *
 *  `link`：「主要導覽」裡的連結名稱。記帳不是導覽裡的連結，要從「新增紀錄」
 *  選單進去；手機版的記帳頁沒有分頁列，所以它在清單的**最後一個**——進去之後
 *  就點不回別頁了。
 *
 *  `ready`：換頁之後先等的東西——**只有那一頁才有**（handover §6 第 53 種）。
 *  `exact: true`：Playwright 的名稱是子字串比對，「我的」會同時對到
 *  「我的好友碼」；導覽裡的「總覽」「報表」是連結不是標題，不會混到。
 *  記帳頁的標題「記帳」跟新增選單裡的連結同名，改等它獨有的「記一筆」。 */
const PAGES: readonly {
	path: string;
	link: string | null;
	ready: (page: Page) => Locator;
}[] = [
	{
		path: "/",
		link: "總覽",
		ready: (page) => page.getByRole("heading", { name: "總覽", exact: true }),
	},
	{
		path: "/reports",
		link: "報表",
		ready: (page) => page.getByRole("heading", { name: "報表", exact: true }),
	},
	{
		path: "/diet",
		link: "飲食",
		ready: (page) => page.getByRole("heading", { name: "飲食", exact: true }),
	},
	{
		path: "/me",
		link: "我的",
		ready: (page) => page.getByRole("heading", { name: "我的", exact: true }),
	},
	{
		path: "/expenses/new",
		link: null,
		ready: (page) => page.getByRole("button", { name: "記一筆", exact: true }),
	},
];

/** 點導覽換頁，等到那一頁獨有的東西出現才開始量——不然量到的可能是還沒畫完
 *  的頁面。 */
async function go(page: Page, path: string) {
	const entry = PAGES.find((candidate) => candidate.path === path);
	if (entry === undefined) throw new Error(`PAGES 裡沒有 ${path}`);
	if (entry.link === null) {
		await page.getByRole("button", { name: "新增紀錄", exact: true }).click();
		await page
			.getByRole("dialog", { name: "新增紀錄" })
			.getByRole("link", { name: "記帳", exact: true })
			.click();
	} else {
		await page
			.getByRole("navigation", { name: "主要導覽" })
			.getByRole("link", { name: entry.link, exact: true })
			.click();
	}
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
			await go(page, path);
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
		await go(page, "/");
		const card = await box(page.getByTestId("month-spend"));
		const timeline = await box(
			page.getByRole("heading", { name: "今天", exact: true }),
		);
		expect(timeline.x).toBeGreaterThan(card.x + card.width);
	});

	test("報表：明細在摘要的右邊", async ({ page }) => {
		await login(page);
		await go(page, "/reports");
		const summary = await box(page.getByTestId("expense-summary"));
		const list = await box(
			page.getByRole("heading", { name: "這個月", exact: true }),
		);
		expect(list.x).toBeGreaterThan(summary.x + summary.width);
	});

	test("飲食：餐點在右欄，補劑在左欄的營養素下面", async ({ page }) => {
		await login(page);
		await go(page, "/diet");
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
		// 右欄的餐點比左欄長時多出來的高度會平分，營養素與補劑中間空一截。
		//
		// 那個缺陷只在「右欄比左欄長」時看得到，而右欄多長看資料庫裡今天記了
		// 幾餐——乾淨的資料庫上量不出差別。所以這裡自己把右欄撐高，不靠資料：
		// 撐到比整個 grid（≥ 左欄）再高 3000px。多留這麼多是因為補劑清單可能在
		// 量完 grid 之後才載入完、把左欄撐長；3000px 要幾十個補劑才填得滿。
		// 兩列都 auto 的話，多出來的 ≥ 3000px 平分，補劑會往下掉 1500px 以上。
		await page
			.getByRole("heading", { name: "今日餐點", exact: true })
			.evaluate((heading) => {
				// 標題 → MealList 的 <section> → 右欄（grid item）→ grid。
				const mealsColumn = heading.closest("section")?.parentElement;
				const grid = mealsColumn?.parentElement;
				if (!mealsColumn || !grid) throw new Error("找不到飲食頁的兩欄");
				const height = grid.getBoundingClientRect().height + 3000;
				mealsColumn.style.minHeight = `${height}px`;
			});
		const lastMacro = await box(page.getByTestId("macro-carb_g"));
		const supplementsAfter = await box(
			page.getByRole("heading", { name: "今日補劑", exact: true }),
		);
		const gap = supplementsAfter.y - (lastMacro.y + lastMacro.height);
		expect(gap).toBeLessThan(100);
	});

	test("我的：內容最寬 640px，在導覽右邊的空間裡置中", async ({ page }) => {
		await login(page);
		await go(page, "/me");
		const nav = await box(page.getByRole("navigation", { name: "主要導覽" }));
		const content = await box(page.locator("main > .app-content"));
		const viewport = await page.evaluate(
			() => document.documentElement.clientWidth,
		);
		// 可用的寬度是 1280 − 導覽 − 左右留白，遠比 640 寬：量到的應該剛好是上限。
		// 下限是防量錯元素——一個縮成內容寬度的元素也會 ≤ 640。
		expect(content.width).toBeLessThanOrEqual(640);
		expect(content.width).toBeGreaterThan(600);
		// 置中的基準是導覽右緣到視窗右緣，不是整個視窗：max-width 寫在 main 上
		// 的話，內容會貼著導覽（index.css 的 .app-desktop .app-main）。
		const spaceCenter = (nav.x + nav.width + viewport) / 2;
		expect(
			Math.abs(content.x + content.width / 2 - spaceCenter),
		).toBeLessThanOrEqual(2);
	});

	test("記帳：數字鍵盤最寬 480px", async ({ page }) => {
		await login(page);
		await go(page, "/expenses/new");
		const keypad = await box(page.getByRole("group", { name: "數字鍵盤" }));
		expect(keypad.width).toBeLessThanOrEqual(480);
	});

	test("新增選單是畫面中間的對話框", async ({ page }) => {
		await login(page);
		await go(page, "/");
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
			await go(page, path);
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

test.describe("直立平板 768×1024（手機版）", () => {
	test.use({ viewport: { width: 768, height: 1024 } });

	test("內容最寬 600px、在視窗置中", async ({ page }) => {
		await login(page);
		// 768 比斷點窄：手機版的外框，沒有 app-desktop。
		await expect(page.locator(".app-desktop")).toHaveCount(0);
		const main = await box(page.getByRole("main"));
		const viewport = await page.evaluate(
			() => document.documentElement.clientWidth,
		);
		// index.css 的 .app-main 是 border-box，600 含左右留白，量到的就是 main 的寬。
		// 下限同上，防量錯元素。
		expect(main.width).toBeLessThanOrEqual(600);
		expect(main.width).toBeGreaterThan(560);
		expect(
			Math.abs(main.x + main.width / 2 - viewport / 2),
		).toBeLessThanOrEqual(2);
	});
});
