import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { queryKeys } from "../src/api/queries";
import { resetRefreshStateForTests } from "../src/auth/refresh";
import { clearTokens, setTokens } from "../src/auth/store";
import { Overview } from "../src/screens/Overview";
import { json, mockApi, type Route } from "./helpers/mock-api";

function newClient() {
	return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function wrap(children: ReactNode, client = newClient()) {
	return (
		<QueryClientProvider client={client}>
			<MemoryRouter>{children}</MemoryRouter>
		</QueryClientProvider>
	);
}

const STATS = {
	date: "2026-12-15",
	actual: {
		kcal: "1240.00",
		protein_g: "50.00",
		fat_g: "40.00",
		carb_g: "150.00",
	},
	target: { kcal: "2000.00", protein_g: null, fat_g: null, carb_g: null },
	ratio: { kcal: "0.62", protein_g: null, fat_g: null, carb_g: null },
};

const SUMMARY = {
	month: "2026-12",
	total: "12480.00",
	by_category: [],
};

const LUNCH = {
	id: 11,
	eaten_at: "2026-12-15T04:30:00+00:00",
	meal_type: "lunch",
	note: null,
	photo_path: null,
	items: [
		{
			id: 1,
			food_id: 1,
			food_name: "滷肉飯",
			portion_id: null,
			quantity: "1",
			quantity_g: "250.00",
			kcal: "620.00",
			protein_g: "18.00",
			fat_g: "22.00",
			carb_g: "82.00",
		},
	],
	kcal: "620.00",
	protein_g: "18.00",
	fat_g: "22.00",
	carb_g: "82.00",
};

const LUNCH_COST = {
	id: 1,
	amount: "180.00",
	category: "food",
	spent_at: "2026-12-15T04:30:00+00:00",
	note: null,
	meal_id: 11,
};

const BLANK_NOTE_TAXI = {
	id: 3,
	amount: "90.00",
	category: "transport",
	spent_at: "2026-12-15T00:30:00+00:00",
	note: null,
	meal_id: null,
};

const EMPTY_NOTE_SNACK = {
	id: 4,
	amount: "30.00",
	category: "food",
	spent_at: "2026-12-15T00:10:00+00:00",
	note: "  ",
	meal_id: null,
};

const METRO = {
	id: 2,
	amount: "25.00",
	category: "transport",
	spent_at: "2026-12-15T01:00:00+00:00",
	note: "捷運",
	meal_id: null,
};

/** 預設四個端點都成功；個別測試用 `overrides` 換掉其中一個。
 *  **`/api/expenses/summary` 一定排在 `/api/expenses` 之前**（mock-api 依序
 *  用 `url.includes` 比對）。 */
function mockOverview(
	overrides: Partial<Record<string, Route["handler"]>> = {},
) {
	const handlers: Record<string, Route["handler"]> = {
		"/api/stats/daily": () => json(STATS),
		"/api/expenses/summary": () => json(SUMMARY),
		"/api/expenses": () => json([LUNCH_COST, METRO]),
		"/api/meals": () => json([LUNCH]),
		...overrides,
	};
	return mockApi(
		Object.entries(handlers).flatMap(([path, handler]) =>
			handler === undefined ? [] : [{ method: "GET", path, handler }],
		),
	);
}

function serverError() {
	return json(
		{ error: { code: "INTERNAL_ERROR", message: "壞了", details: {} } },
		500,
	);
}

beforeEach(() => {
	localStorage.clear();
	clearTokens();
	resetRefreshStateForTests();
	vi.restoreAllMocks();
	setTokens({ access_token: "a", refresh_token: "r" });
});

describe("總覽", () => {
	it("顯示本月支出與今天熱量", async () => {
		mockOverview();

		render(wrap(<Overview />));

		const spend = await screen.findByTestId("month-spend");
		expect(await within(spend).findByText("$12480.00")).toBeInTheDocument();
		const kcal = screen.getByTestId("today-kcal");
		expect(await within(kcal).findByText(/1240/)).toBeInTheDocument();
		expect(within(kcal).getByText(/2000/)).toBeInTheDocument();
	});

	it("時間線：有餐費的那一餐只出現一次，支出各自一列，由新到舊", async () => {
		mockOverview();

		render(wrap(<Overview />));

		const rows = await screen.findAllByTestId("timeline-row");
		expect(rows).toHaveLength(2);
		expect(rows[0]).toHaveTextContent("午餐・滷肉飯");
		expect(rows[0]).toHaveTextContent("$180.00");
		expect(rows[1]).toHaveTextContent("捷運");
		expect(rows[1]).toHaveTextContent("$25.00");
	});

	it("今天的支出用後端回的日期去查——前端不自己算今天", async () => {
		const fetchMock = mockOverview();

		render(wrap(<Overview />));
		await screen.findAllByTestId("timeline-row");

		const urls = fetchMock.mock.calls.map(([input]) => String(input));
		expect(urls).toContain("/api/expenses?date=2026-12-15");
	});

	it("月報表失敗時只有那張卡說失敗，時間線照常顯示", async () => {
		mockOverview({ "/api/expenses/summary": serverError });

		render(wrap(<Overview />));

		expect(await screen.findByText("無法載入本月支出")).toBeInTheDocument();
		expect(await screen.findAllByTestId("timeline-row")).toHaveLength(2);
	});

	it("stats 失敗時時間線說失敗，不會永遠停在載入中", async () => {
		// 今天的支出要等 stats 回來才知道日期（enabled 依賴）。stats 失敗時
		// 那個 query 永遠是 pending——沒有特別處理的話，畫面會一直「載入中」。
		mockOverview({ "/api/stats/daily": serverError });

		render(wrap(<Overview />));

		// **只看時間線那一區**：月支出卡在這個時間點可能還在「載入中…」，
		// 用整個畫面的 queryByText 會時紅時綠。
		const timeline = screen.getByRole("region", { name: "今天" });
		expect(
			await within(timeline).findByText("無法載入今天的紀錄"),
		).toBeInTheDocument();
		expect(within(timeline).queryByText("載入中…")).not.toBeInTheDocument();
	});

	it("今天什麼都沒有時講明白", async () => {
		mockOverview({
			"/api/expenses": () => json([]),
			"/api/meals": () => json([]),
		});

		render(wrap(<Overview />));

		expect(await screen.findByText("今天還沒有紀錄")).toBeInTheDocument();
	});

	it("沒有金額對應的餐顯示熱量；備註空白的支出顯示分類名稱", async () => {
		mockOverview({
			"/api/expenses": () => json([BLANK_NOTE_TAXI, EMPTY_NOTE_SNACK]),
		});

		render(wrap(<Overview />));

		const rows = await screen.findAllByTestId("timeline-row");
		expect(rows).toHaveLength(3);
		expect(rows[0]).toHaveTextContent("午餐・滷肉飯");
		expect(rows[0]).toHaveTextContent("620 kcal");
		expect(rows[1]).toHaveTextContent("交通");
		expect(rows[1]).toHaveTextContent("$90.00");
		expect(rows[2]).toHaveTextContent("飲食");
		expect(rows[2]).toHaveTextContent("$30.00");
	});

	it("meals 失敗時時間線說失敗，不會說今天沒有紀錄", async () => {
		mockOverview({ "/api/meals": serverError });

		render(wrap(<Overview />));

		const timeline = screen.getByRole("region", { name: "今天" });
		expect(
			await within(timeline).findByText("無法載入今天的紀錄"),
		).toBeInTheDocument();
		expect(
			within(timeline).queryByText("今天還沒有紀錄"),
		).not.toBeInTheDocument();
	});

	it("今天的支出失敗時時間線說失敗，不會說今天沒有紀錄", async () => {
		mockOverview({ "/api/expenses": serverError });

		render(wrap(<Overview />));

		const timeline = screen.getByRole("region", { name: "今天" });
		expect(
			await within(timeline).findByText("無法載入今天的紀錄"),
		).toBeInTheDocument();
		expect(
			within(timeline).queryByText("今天還沒有紀錄"),
		).not.toBeInTheDocument();
	});

	it("有目標時畫熱量進度條", async () => {
		mockOverview();

		render(wrap(<Overview />));

		expect(
			await screen.findByRole("progressbar", { name: "熱量進度" }),
		).toBeInTheDocument();
	});

	it.each([
		["今天沒有目標（target 是 null）", null],
		[
			"有目標但熱量沒設（target.kcal 是 null）",
			{ kcal: null, protein_g: null, fat_g: null, carb_g: null },
		],
	])("%s：只顯示數字，沒有「/」也沒有進度條", async (_name, target) => {
		mockOverview({
			"/api/stats/daily": () =>
				json({
					...STATS,
					target,
					ratio: { kcal: null, protein_g: null, fat_g: null, carb_g: null },
				}),
		});

		render(wrap(<Overview />));

		const kcal = screen.getByTestId("today-kcal");
		expect(await within(kcal).findByText(/1240/)).toBeInTheDocument();
		expect(kcal).not.toHaveTextContent("/");
		expect(within(kcal).queryByRole("progressbar")).not.toBeInTheDocument();
	});

	it("連得到網路但到不了後端：保留快取資料並顯示離線提示", async () => {
		const client = newClient();
		const seeded = Date.now() - 60 * 60 * 1000; // 一小時前——要比 staleTime 舊才會重抓
		const seed = (key: readonly unknown[], data: unknown) =>
			client.setQueryData(key, data, { updatedAt: seeded });
		seed(queryKeys.dailyStats, STATS);
		seed(queryKeys.expenseSummary(null), SUMMARY);
		seed(queryKeys.meals, [LUNCH]);
		seed(queryKeys.expensesByDate("2026-12-15"), [LUNCH_COST, METRO]);
		vi.spyOn(globalThis, "fetch").mockRejectedValue(
			new TypeError("network request failed"),
		);

		render(wrap(<Overview />, client));

		expect(await screen.findByTestId("offline-banner")).toHaveTextContent(
			"離線資料，最後更新於",
		);
		expect(screen.getByText("$12480.00")).toBeInTheDocument();
		expect(
			within(screen.getByTestId("today-kcal")).getByText(/1240/),
		).toBeInTheDocument();
		expect(screen.getAllByTestId("timeline-row")).toHaveLength(2);
		expect(screen.queryByText(/無法載入/)).not.toBeInTheDocument();
	});
});
