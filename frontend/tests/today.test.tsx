import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { MemoryRouter, useLocation } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { queryKeys } from "../src/api/queries";
import { resetRefreshStateForTests } from "../src/auth/refresh";
import { clearTokens, setTokens } from "../src/auth/store";
import { Today } from "../src/screens/Today";
import { json, mockApiByPath as mockApi } from "./helpers/mock-api";

// 需要 MemoryRouter：P3-C Task 2 在「今日補劑」區塊加了一個連到
// /supplements 的 <Link>，不掛 Router 會直接炸掉（跟 food-library.test.tsx
// 需要 MemoryRouter 的理由一樣）。
function wrap(children: ReactNode) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return (
		<QueryClientProvider client={client}>
			<MemoryRouter>{children}</MemoryRouter>
		</QueryClientProvider>
	);
}

const STATS_WITH_TARGET = {
	date: "2026-09-15",
	actual: {
		kcal: "1800.00",
		protein_g: "90.50",
		fat_g: "60.00",
		carb_g: "200.00",
	},
	target: {
		kcal: "2000.00",
		protein_g: "150.00",
		fat_g: null,
		carb_g: "250.00",
	},
	ratio: { kcal: "0.90", protein_g: "0.60", fat_g: null, carb_g: "0.80" },
	breakdown: {
		food: {
			kcal: "1700.00",
			protein_g: "80.50",
			fat_g: "55.00",
			carb_g: "190.00",
		},
		supplement: {
			kcal: "100.00",
			protein_g: "10.00",
			fat_g: "5.00",
			carb_g: "10.00",
		},
	},
};

beforeEach(() => {
	localStorage.clear();
	clearTokens();
	resetRefreshStateForTests();
	vi.restoreAllMocks();
	setTokens({ access_token: "a", refresh_token: "r" });
});

describe("今日總覽", () => {
	it("不傳 date 參數——日界線由伺服器決定", async () => {
		// 規格 §5.3 與後端 app/days.py：省略 ?date= 時後端用
		// today_in_timezone(user.timezone)。前端自己算「今天」就是建立
		// 第二個事實來源，而且在使用者時區跟瀏覽器時區不同時會靜默算錯
		// ——大部分時候對，只在午夜前後錯。
		const fetchMock = mockApi({
			"/api/stats/daily": () => json(STATS_WITH_TARGET),
			"/api/supplements/today": () => json([]),
		});

		render(wrap(<Today />));
		await screen.findByText(/1800/);

		const statsCall = fetchMock.mock.calls.find(([input]) =>
			String(input).includes("/api/stats/daily"),
		);
		expect(String(statsCall?.[0])).toBe("/api/stats/daily");
	});

	it("顯示攝取與目標的比例", async () => {
		mockApi({
			"/api/stats/daily": () => json(STATS_WITH_TARGET),
			"/api/supplements/today": () => json([]),
		});

		render(wrap(<Today />));

		expect(await screen.findByText(/1800/)).toBeInTheDocument();
		expect(screen.getByText(/2000/)).toBeInTheDocument();
	});

	it("某一項沒設目標時只有那一項顯示未設定，其他照常", async () => {
		// 規格 §5.7 的第二層 null：target 存在、但 fat_g 是 null。
		// 把兩層混為一談的話，這個畫面會整個顯示成「尚未設定目標」。
		mockApi({
			"/api/stats/daily": () => json(STATS_WITH_TARGET),
			"/api/supplements/today": () => json([]),
		});

		render(wrap(<Today />));

		const fatRow = await screen.findByTestId("macro-fat_g");
		expect(fatRow).toHaveTextContent("未設定");
		expect(screen.getByTestId("macro-protein_g")).not.toHaveTextContent(
			"未設定",
		);
	});

	it("有比例的營養素畫進度條，超過目標時夾在滿格；沒設目標的那一項不畫", async () => {
		// 進度條的寬度跟總覽「今天熱量」一樣來自 ratioOf()，不是手算。
		// 空的進度條會被讀成「0%」，所以「未設定」那一列不能有條。
		mockApi({
			"/api/stats/daily": () =>
				json({
					...STATS_WITH_TARGET,
					actual: { ...STATS_WITH_TARGET.actual, carb_g: "500.00" },
				}),
			"/api/supplements/today": () => json([]),
		});

		render(wrap(<Today />));

		const kcal = await screen.findByRole("progressbar", { name: "熱量進度" });
		expect(kcal).toHaveAttribute("value", "0.9");
		// 500 / 250 = 2：條畫滿（1），超過多少看百分比文字。
		const carbRow = screen.getByTestId("macro-carb_g");
		expect(within(carbRow).getByRole("progressbar")).toHaveAttribute(
			"value",
			"1",
		);
		expect(carbRow).toHaveTextContent("200%");
		expect(
			within(screen.getByTestId("macro-fat_g")).queryByRole("progressbar"),
		).not.toBeInTheDocument();
	});

	it("整天沒有目標時顯示的是「尚未設定目標」，不是四個未設定", async () => {
		// 第一層 null：target 整個是 null。
		mockApi({
			"/api/stats/daily": () =>
				json({ ...STATS_WITH_TARGET, target: null, ratio: null }),
			"/api/supplements/today": () => json([]),
		});

		render(wrap(<Today />));

		expect(await screen.findByText("尚未設定目標")).toBeInTheDocument();
	});

	it("有計畫但還沒打卡的補劑可以打卡", async () => {
		const fetchMock = mockApi({
			"/api/stats/daily": () => json(STATS_WITH_TARGET),
			"/api/supplements/today": () =>
				json([
					{
						plan_id: 1,
						supplement_id: 7,
						supplement_name: "魚油",
						dose: "1.00",
						time_of_day: "morning",
						done: false,
						intake_id: null,
					},
				]),
			"/api/supplement-intakes": () => json({ id: 99 }),
		});

		render(wrap(<Today />));
		await userEvent.click(await screen.findByRole("button", { name: /打卡/ }));

		await waitFor(() => {
			expect(
				fetchMock.mock.calls.some(
					([input, init]) =>
						String(input).includes("/api/supplement-intakes") &&
						init?.method === "POST",
				),
			).toBe(true);
		});
	});

	it("臨時記錄沒有打卡按鈕——它一定已經完成了", async () => {
		// 規格 §5.8：plan_id 為 null 代表這是一筆臨時記錄（沒有對應的固定
		// 計畫），這種項目一定 done: true。給它一個「打卡」按鈕是沒有意義的。
		mockApi({
			"/api/stats/daily": () => json(STATS_WITH_TARGET),
			"/api/supplements/today": () =>
				json([
					{
						plan_id: null,
						supplement_id: 7,
						supplement_name: "臨時吃的",
						dose: "1.00",
						time_of_day: null,
						done: true,
						intake_id: 55,
					},
				]),
		});

		render(wrap(<Today />));
		await screen.findByText("臨時吃的");

		expect(
			screen.queryByRole("button", { name: /打卡/ }),
		).not.toBeInTheDocument();
		expect(screen.getByRole("button", { name: /取消/ })).toBeInTheDocument();
	});

	it("強制登出會清掉 query 快取", async () => {
		// 規格 §6.5：不清的話，下一個登入的人會先看到上一個人的今日總覽，
		// 然後才被重新 fetch 覆蓋掉——**那是使用者會親眼看到的跨使用者
		// 資料外洩**，不是理論上的。
		const { clearQueryCacheOnForcedLogout } = await import(
			"../src/api/queries"
		);
		const client = new QueryClient();
		client.setQueryData(queryKeys.dailyStats, { marker: "前一個使用者的資料" });

		clearQueryCacheOnForcedLogout(client);

		expect(client.getQueryData(queryKeys.dailyStats)).toBeUndefined();
	});

	it("有食物庫的入口連結", async () => {
		// 「食物庫」不再是 tab（介面改版）。沒有這條測試，拿掉這個連結不會
		// 有任何東西變紅——這個專案已經三次蓋好功能卻沒有入口。
		mockApi({
			"/api/stats/daily": () => json(STATS_WITH_TARGET),
			"/api/supplements/today": () => json([]),
		});

		render(wrap(<Today />));

		expect(await screen.findByRole("link", { name: "食物庫" })).toHaveAttribute(
			"href",
			"/foods",
		);
	});

	it("切到好友顯示好友動態、切回我的", async () => {
		// `/api/friends/feed` 要排在 `/api/friends` 之前（includes 依序比對）。
		mockApi({
			"/api/stats/daily": () => json(STATS_WITH_TARGET),
			"/api/supplements/today": () => json([]),
			"/api/friends/feed": () => json({ meals: [], next_cursor: null }),
			"/api/friends": () => json([]),
		});

		render(wrap(<Today />));
		expect(await screen.findByText("今日餐點")).toBeInTheDocument();

		await userEvent.click(screen.getByRole("radio", { name: "好友" }));

		expect(
			await screen.findByText("還沒有好友。到「我的」→「好友」用好友碼加朋友"),
		).toBeInTheDocument();
		expect(screen.queryByText("今日餐點")).not.toBeInTheDocument();

		await userEvent.click(screen.getByRole("radio", { name: "我的" }));

		expect(await screen.findByText("今日餐點")).toBeInTheDocument();
	});

	it("網址帶 ?view=friends 直接顯示好友動態（從好友的一天按返回會回到這裡）", async () => {
		mockApi({
			"/api/stats/daily": () => json(STATS_WITH_TARGET),
			"/api/supplements/today": () => json([]),
			"/api/friends/feed": () => json({ meals: [], next_cursor: null }),
			"/api/friends": () => json([]),
		});
		let search = "";
		function SearchProbe() {
			search = useLocation().search;
			return null;
		}
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});

		render(
			<QueryClientProvider client={client}>
				<MemoryRouter initialEntries={["/diet?view=friends"]}>
					<Today />
					<SearchProbe />
				</MemoryRouter>
			</QueryClientProvider>,
		);

		expect(
			await screen.findByText("還沒有好友。到「我的」→「好友」用好友碼加朋友"),
		).toBeInTheDocument();
		expect(screen.getByRole("radio", { name: "好友" })).toBeChecked();
		expect(screen.queryByText("今日餐點")).not.toBeInTheDocument();

		await userEvent.click(screen.getByRole("radio", { name: "我的" }));

		expect(await screen.findByText("今日餐點")).toBeInTheDocument();
		expect(search).toBe("");
	});
});

/** a 在 b 前面（DOM 順序，也就是螢幕閱讀器與 Tab 鍵的順序）。 */
function expectOrder(...elements: HTMLElement[]) {
	for (let i = 1; i < elements.length; i++) {
		const previous = elements[i - 1] as HTMLElement;
		const current = elements[i] as HTMLElement;
		expect(
			previous.compareDocumentPosition(current) &
				Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
	}
}

describe("飲食頁的電腦版兩欄（電腦版版面規格 §4）", () => {
	// 電腦版靠 Today.module.css 的 grid-template-areas 把補劑擺到左欄下方，
	// DOM 順序不能跟著換——手機版與螢幕閱讀器都是照 DOM 往下讀的。這條守的是
	// 手機版（也就是 DOM）的順序；Today 本身不看寬度，所以不用分電腦版、手機版
	// 各跑一次。電腦版的左右擺放是 CSS，jsdom 量不到，在 e2e/desktop-layout.spec.ts。
	it("營養素 → 今日餐點 → 今日補劑 的 DOM 順序", async () => {
		mockApi({
			"/api/stats/daily": () => json(STATS_WITH_TARGET),
			"/api/supplements/today": () =>
				json([
					{
						plan_id: 1,
						supplement_id: 7,
						supplement_name: "魚油",
						dose: "1.00",
						time_of_day: "morning",
						done: false,
						intake_id: null,
					},
				]),
			"/api/meals": () =>
				json([
					{
						id: 12,
						eaten_at: "2026-09-15T19:00:00+08:00",
						meal_type: "dinner",
						note: null,
						photo_path: null,
						items: [
							{
								id: 1,
								food_id: 3,
								food_name: "滷肉飯",
								portion_id: null,
								quantity: "200.00",
								quantity_g: "200.00",
								kcal: "440.00",
								protein_g: "13.00",
								fat_g: "14.00",
								carb_g: "44.00",
							},
						],
						kcal: "440.00",
						protein_g: "13.00",
						fat_g: "14.00",
						carb_g: "44.00",
					},
				]),
		});

		render(wrap(<Today />));

		const kcal = await screen.findByTestId("macro-kcal");
		const meal = await screen.findByText(/滷肉飯/);
		const supplement = await screen.findByText("魚油");
		expectOrder(
			kcal,
			screen.getByRole("heading", { name: "今日餐點" }),
			meal,
			screen.getByRole("heading", { name: "今日補劑" }),
			supplement,
		);
	});
});
