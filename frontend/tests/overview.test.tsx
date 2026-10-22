import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import {
	MemoryRouter,
	Route as RouterRoute,
	Routes,
	useLocation,
} from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { queryKeys } from "../src/api/queries";
import { resetRefreshStateForTests } from "../src/auth/refresh";
import { clearTokens, setTokens } from "../src/auth/store";
import { ringDasharray } from "../src/components/CalorieRing";
import { Overview } from "../src/screens/Overview";
import { NO_WEIGHTS } from "./helpers/body-routes";
import { NO_EXERCISE, RUN } from "./helpers/exercise-routes";
import { json, mockApi, type Route } from "./helpers/mock-api";

function newClient() {
	return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function LocationState() {
	return (
		<pre data-testid="location-state">
			{JSON.stringify(useLocation().state)}
		</pre>
	);
}

function wrapAt(state: unknown) {
	return (
		<QueryClientProvider client={newClient()}>
			<MemoryRouter initialEntries={[{ pathname: "/", state }]}>
				<Overview />
				<LocationState />
			</MemoryRouter>
		</QueryClientProvider>
	);
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
		// 運動（運動規格 §7.4）：跟 `/api/expenses` 互不包含，順序不影響。
		"/api/exercises": () => json(NO_EXERCISE),
		// 體重小卡片（首頁改版規格 D12）：跟其他路徑互不包含，順序不影響。
		"/api/weights": () => json(NO_WEIGHTS),
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
		// 首頁改版規格 §3.2：還能吃＝額度 − 已吃（舊回應的額度退回目標 2000）。
		expect(kcal).toHaveTextContent("還能吃 760 kcal");
		expect(kcal).toHaveTextContent("已吃 1240・預算 2000");
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

	it("時間線的餐點列連到那一餐的編輯畫面；支出列不是連結", async () => {
		mockOverview();

		render(wrap(<Overview />));

		const [mealRow, expenseRow] = await screen.findAllByTestId("timeline-row");
		// noUncheckedIndexedAccess：先確認兩列都在，型別才會收窄。
		if (mealRow === undefined || expenseRow === undefined) {
			throw new Error("時間線應該有兩列");
		}
		expect(within(mealRow).getByRole("link")).toHaveAttribute(
			"href",
			"/meals/11/edit",
		);
		expect(within(expenseRow).queryByRole("link")).not.toBeInTheDocument();
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

	it("有目標時畫圓環（裝飾）", async () => {
		mockOverview();

		render(wrap(<Overview />));

		const kcal = screen.getByTestId("today-kcal");
		const arc = await within(kcal).findByTestId("calorie-ring-arc");
		expect(arc).toHaveAttribute("data-tone", "normal");
		expect(kcal.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
		// 圓環不是 progressbar（規格 D4）：念出來的是「還能吃 N kcal」。
		expect(
			screen.queryByRole("progressbar", { name: "熱量進度" }),
		).not.toBeInTheDocument();
	});

	it.each([
		["今天沒有目標（target 是 null）", null],
		[
			"有目標但熱量沒設（target.kcal 是 null）",
			{ kcal: null, protein_g: null, fat_g: null, carb_g: null },
		],
	])(
		"%s：還沒有每日目標，有『設定每日目標』，沒有『/』也沒有圓弧",
		async (_name, target) => {
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
			expect(
				await within(kcal).findByText("還沒有每日目標"),
			).toBeInTheDocument();
			expect(kcal).toHaveTextContent("已吃 1240 kcal");
			expect(
				within(kcal).getByRole("link", { name: "設定每日目標" }),
			).toHaveAttribute("href", "/me/targets");
			expect(kcal).not.toHaveTextContent("/");
			expect(
				within(kcal).queryByTestId("calorie-ring-arc"),
			).not.toBeInTheDocument();
			expect(within(kcal).queryByRole("progressbar")).not.toBeInTheDocument();
		},
	);

	it("連得到網路但到不了後端：保留快取資料並顯示離線提示", async () => {
		const client = newClient();
		const seeded = Date.now() - 60 * 60 * 1000; // 一小時前——只是讓「最後更新於」的時間貼近真實（測試用的 client 的 staleTime 是 0，不倒推也會重抓）
		const seed = (key: readonly unknown[], data: unknown) =>
			client.setQueryData(key, data, { updatedAt: seeded });
		seed(queryKeys.dailyStats, STATS);
		seed(queryKeys.expenseSummary(null), SUMMARY);
		seed(queryKeys.meals, [LUNCH]);
		seed(queryKeys.expensesByDate("2026-12-15"), [LUNCH_COST, METRO]);
		// 運動清單也在快取裡（運動規格 D23）。沒有的話它是「失敗而且沒有資料」，時間線說無法載入。
		seed(queryKeys.exercisesToday, NO_EXERCISE);
		// 體重也在快取裡（首頁改版規格 D23）。沒有的話體重小卡片是「無法載入體重」，下面的 /無法載入/ 會紅。
		seed(queryKeys.weights, NO_WEIGHTS);
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

	it("帶著通知進來時顯示通知（例如照片沒傳上去）", async () => {
		mockOverview();

		render(wrapAt({ notice: "照片沒有傳上去" }));

		expect(await screen.findByRole("status")).toHaveTextContent(
			"照片沒有傳上去",
		);
	});

	it("通知讀過就從 history 清掉：state 變成 null，畫面上的通知還在", async () => {
		mockOverview();

		render(wrapAt({ notice: "照片沒有傳上去" }));

		await screen.findByText("照片沒有傳上去");
		await waitFor(() =>
			expect(screen.getByTestId("location-state")).toHaveTextContent("null"),
		);
		expect(screen.getByText("照片沒有傳上去")).toBeInTheDocument();
	});

	it("時間線不顯示這一餐的描述（只在飲食頁的卡片）", async () => {
		mockOverview({
			"/api/meals": () =>
				json([{ ...LUNCH, description: "只在飲食頁出現的描述" }]),
		});

		render(wrap(<Overview />));

		// 先等時間線畫出來（第 41 種），再斷言沒有。
		expect(await screen.findAllByTestId("timeline-row")).toHaveLength(2);
		expect(screen.queryByText(/只在飲食頁出現的描述/)).not.toBeInTheDocument();
	});
});

/** 新的回應：目標 2000、今天運動 343、設定開 → 額度 2343（運動規格 D15）。 */
const STATS_WITH_EXERCISE = {
	...STATS,
	exercise_kcal: "343.00",
	exercise_adds_to_budget: true,
	kcal_budget: "2343.00",
};

/** 午餐（04:30Z）與捷運（01:00Z）中間的一筆跑步。 */
const MORNING_RUN = { ...RUN, performed_at: "2026-12-15T03:00:00+00:00" };

describe("總覽：運動（運動規格 §7.4）", () => {
	it("今天熱量的預算是額度，後面寫「（含運動 +343）」；圓環用額度算", async () => {
		mockOverview({ "/api/stats/daily": () => json(STATS_WITH_EXERCISE) });

		render(wrap(<Overview />));

		const kcal = screen.getByTestId("today-kcal");
		await waitFor(() => expect(kcal).toHaveTextContent("預算 2343"));
		expect(within(kcal).getByText("（含運動 +343）")).toBeInTheDocument();
		// 弧長的比例來源是額度（1240 / 2343），不是目標（1240 / 2000）。
		expect(within(kcal).getByTestId("calorie-ring-arc")).toHaveAttribute(
			"stroke-dasharray",
			ringDasharray(1240 / 2343),
		);
	});

	it("設定關掉：預算是目標，沒有「含運動」", async () => {
		mockOverview({
			"/api/stats/daily": () =>
				json({
					...STATS_WITH_EXERCISE,
					exercise_adds_to_budget: false,
					kcal_budget: "2000.00",
				}),
		});

		render(wrap(<Overview />));

		const kcal = screen.getByTestId("today-kcal");
		await waitFor(() => expect(kcal).toHaveTextContent("預算 2000"));
		expect(kcal).not.toHaveTextContent("含運動");
	});

	it("舊回應（沒有三個欄位，離線快取裡的）：預算退回目標 2000，沒有「含運動」", async () => {
		mockOverview();

		render(wrap(<Overview />));

		const kcal = screen.getByTestId("today-kcal");
		await waitFor(() => expect(kcal).toHaveTextContent("預算 2000"));
		expect(kcal).not.toHaveTextContent("含運動");
	});

	it("時間線有運動列：名稱・分鐘、-343 kcal，連到編輯畫面，跟餐與支出依時間排", async () => {
		mockOverview({
			"/api/exercises": () =>
				json({
					date: "2026-12-15",
					total_kcal: "343.00",
					entries: [MORNING_RUN],
				}),
		});

		render(wrap(<Overview />));

		const rows = await screen.findAllByTestId("timeline-row");
		expect(rows).toHaveLength(3);
		expect(rows[0]).toHaveTextContent("午餐・滷肉飯");
		expect(rows[1]).toHaveTextContent("跑步（約 10 km/h）・30 分鐘");
		expect(rows[1]).toHaveTextContent("-343 kcal");
		expect(rows[2]).toHaveTextContent("捷運");
		const [, exerciseRow] = rows;
		if (exerciseRow === undefined) throw new Error("應該有運動列");
		expect(within(exerciseRow).getByRole("link")).toHaveAttribute(
			"href",
			"/exercises/31/edit",
		);
	});

	it("運動清單失敗（沒有快取）：時間線說無法載入，不會說今天沒有紀錄", async () => {
		mockOverview({ "/api/exercises": serverError });

		render(wrap(<Overview />));

		const timeline = screen.getByRole("region", { name: "今天" });
		expect(
			await within(timeline).findByText("無法載入今天的紀錄"),
		).toBeInTheDocument();
		expect(
			within(timeline).queryByText("今天還沒有紀錄"),
		).not.toBeInTheDocument();
	});

	it("只有運動重抓失敗、手上有資料：離線提示也出現", async () => {
		const client = newClient();
		client.setQueryData(queryKeys.exercisesToday, {
			date: "2026-12-15",
			total_kcal: "343.00",
			entries: [MORNING_RUN],
		});
		mockOverview({ "/api/exercises": serverError });

		render(wrap(<Overview />, client));

		expect(await screen.findByTestId("offline-banner")).toHaveTextContent(
			"離線資料，最後更新於",
		);
		// 手上的那一筆照樣在時間線上。
		expect(await screen.findAllByTestId("timeline-row")).toHaveLength(3);
	});
});

/** 跟 `me.test.tsx` 的 `WEIGHTS` 一樣：10/14 的 79 比 10/07 的 80 少 1。 */
const WEIGHTS = {
	today: "2026-10-14",
	entries: [
		{ date: "2026-10-07", weight_kg: "80.00" },
		{ date: "2026-10-10", weight_kg: "79.60" },
		{ date: "2026-10-14", weight_kg: "79.00" },
	],
};

function precedes(a: Element, b: Element): boolean {
	return Boolean(
		a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING,
	);
}

describe("總覽：圓環卡片與小卡片（首頁改版規格 §3）", () => {
	it("圓環卡片是 region「今天熱量」，today-kcal 在它上面", async () => {
		mockOverview();

		render(wrap(<Overview />));

		const region = await screen.findByRole("region", { name: "今天熱量" });
		expect(region.dataset.testid).toBe("today-kcal");
	});

	it("超過：超過 57 kcal、弧是 over", async () => {
		mockOverview({
			"/api/stats/daily": () =>
				json({
					...STATS_WITH_EXERCISE,
					actual: { ...STATS.actual, kcal: "2400.00" },
				}),
		});

		render(wrap(<Overview />));

		const kcal = screen.getByTestId("today-kcal");
		await waitFor(() => expect(kcal).toHaveTextContent("超過 57 kcal"));
		expect(within(kcal).getByTestId("calorie-ring-arc")).toHaveAttribute(
			"data-tone",
			"over",
		);
	});

	it("本月支出是連到報表的連結，名稱含金額", async () => {
		mockOverview();

		render(wrap(<Overview />));

		const spend = await screen.findByTestId("month-spend");
		await within(spend).findByText("$12480.00");
		const link = within(spend).getByRole("link");
		expect(link).toHaveAttribute("href", "/reports");
		expect(link).toHaveAccessibleName("本月支出 $12480.00");
	});

	it("體重：最新一筆、比 7 天前，連到 /weight；迷你折線是裝飾、不進連結的名稱", async () => {
		mockOverview({ "/api/weights": () => json(WEIGHTS) });

		render(wrap(<Overview />));

		const glance = await screen.findByTestId("weight-glance");
		await waitFor(() => expect(glance).toHaveTextContent("79 公斤"));
		expect(glance).toHaveTextContent("比 7 天前 -1 公斤");
		const link = within(glance).getByRole("link", {
			name: "體重 79 公斤 比 7 天前 -1 公斤",
		});
		expect(link).toHaveAttribute("href", "/weight");
		const sparkline = within(glance).getByTestId("weight-sparkline");
		expect(sparkline).toHaveAttribute("aria-hidden", "true");
	});

	it("體重只有一筆：有數字，沒有迷你折線", async () => {
		mockOverview({
			"/api/weights": () =>
				json({
					today: "2026-10-14",
					entries: [{ date: "2026-10-14", weight_kg: "79.00" }],
				}),
		});

		render(wrap(<Overview />));

		const glance = await screen.findByTestId("weight-glance");
		await waitFor(() => expect(glance).toHaveTextContent("79 公斤"));
		expect(
			within(glance).queryByTestId("weight-sparkline"),
		).not.toBeInTheDocument();
	});

	it("沒有體重：「記錄體重」，沒有迷你折線；點了帶著 weightForm 到 /weight", async () => {
		mockOverview();

		render(
			<QueryClientProvider client={newClient()}>
				<MemoryRouter>
					<Routes>
						<RouterRoute path="/" element={<Overview />} />
						<RouterRoute path="/weight" element={<LocationState />} />
					</Routes>
				</MemoryRouter>
			</QueryClientProvider>,
		);

		const glance = await screen.findByTestId("weight-glance");
		const link = await within(glance).findByRole("link", {
			name: "體重 記錄體重",
		});
		expect(
			within(glance).queryByTestId("weight-sparkline"),
		).not.toBeInTheDocument();
		await userEvent.click(link);
		expect(await screen.findByTestId("location-state")).toHaveTextContent(
			'{"weightForm":true}',
		);
	});

	it("體重讀不到（沒有快取）：只有那張卡說無法載入，時間線照常", async () => {
		mockOverview({ "/api/weights": serverError });

		render(wrap(<Overview />));

		const glance = await screen.findByTestId("weight-glance");
		expect(await within(glance).findByText("無法載入體重")).toBeInTheDocument();
		expect(await screen.findAllByTestId("timeline-row")).toHaveLength(2);
	});

	it("只有體重重抓失敗、手上有資料：離線提示也出現", async () => {
		const client = newClient();
		client.setQueryData(queryKeys.weights, WEIGHTS);
		mockOverview({ "/api/weights": serverError });

		render(wrap(<Overview />, client));

		expect(await screen.findByTestId("offline-banner")).toHaveTextContent(
			"離線資料，最後更新於",
		);
		expect(screen.getByTestId("weight-glance")).toHaveTextContent("79 公斤");
	});

	it("順序：圓環卡片 → 本月支出 → 體重 → 今天的時間線", async () => {
		mockOverview();

		render(wrap(<Overview />));

		const today = await screen.findByRole("heading", { name: "今天" });
		const kcal = screen.getByTestId("today-kcal");
		const spend = screen.getByTestId("month-spend");
		const weight = screen.getByTestId("weight-glance");
		expect(precedes(kcal, spend)).toBe(true);
		expect(precedes(spend, weight)).toBe(true);
		expect(precedes(weight, today)).toBe(true);
	});

	it("stats 讀不到（沒有快取）：圓環卡片說無法載入，沒有圓弧", async () => {
		mockOverview({ "/api/stats/daily": serverError });

		render(wrap(<Overview />));

		const kcal = screen.getByTestId("today-kcal");
		expect(
			await within(kcal).findByText("無法載入今天的熱量"),
		).toBeInTheDocument();
		expect(
			within(kcal).queryByTestId("calorie-ring-arc"),
		).not.toBeInTheDocument();
	});
});
