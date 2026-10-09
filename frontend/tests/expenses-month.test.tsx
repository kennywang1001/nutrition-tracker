import {
	onlineManager,
	QueryClient,
	QueryClientProvider,
} from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation, useNavigate } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetRefreshStateForTests } from "../src/auth/refresh";
import { clearTokens, setTokens } from "../src/auth/store";
import { Expenses } from "../src/screens/Expenses";
import expensesStyles from "../src/screens/Expenses.module.css";
import { json, mockApi, type Route } from "./helpers/mock-api";

/** 換月份時調淡卡片的 class（同 trend.test.tsx 的作法：真的不見了會變成
 *  "undefined"，斷言一樣紅，不會空字串假綠）。 */
const STALE_CLASS = String(expensesStyles.stale);

/** 後端說的這個月是 2026-12；上個月是 2026-11。 */
const DEC_SUMMARY = {
	month: "2026-12",
	total: "180.00",
	by_category: [{ category: "food", total: "180.00", count: 1 }],
};
const DEC_ROW = {
	id: 1,
	amount: "180.00",
	category: "food" as const,
	spent_at: "2026-12-15T04:00:00+00:00",
	note: "十二月的便當",
	meal_id: null,
};
const NOV_SUMMARY = {
	month: "2026-11",
	total: "999.00",
	by_category: [{ category: "transport", total: "999.00", count: 1 }],
};
const NOV_ROW = {
	id: 2,
	amount: "999.00",
	category: "transport" as const,
	spent_at: "2026-11-20T04:00:00+00:00",
	note: "十一月的高鐵",
	meal_id: null,
};

/** 十二月（沒帶 `?month=`）的兩個端點。**放在最後面**：mock 用 `url.includes(path)`
 *  依序比對，`/api/expenses` 會吃掉 `/api/expenses/summary` 與任何帶 `?month=` 的請求
 *  （第 43 種）——越具體的越前面。 */
const DECEMBER: Route[] = [
	{
		method: "GET",
		path: "/api/expenses/summary",
		handler: () => json(DEC_SUMMARY),
	},
	{ method: "GET", path: "/api/expenses", handler: () => json([DEC_ROW]) },
];

const NOVEMBER: Route[] = [
	{
		method: "GET",
		path: "/api/expenses/summary?month=2026-11",
		handler: () => json(NOV_SUMMARY),
	},
	{
		method: "GET",
		path: "/api/expenses?month=2026-11",
		handler: () => json([NOV_ROW]),
	},
];

/** 目前的網址，外加一顆「上一頁」——分辨換月份是 push 還是 replace 用的。 */
function LocationProbe() {
	const location = useLocation();
	const navigate = useNavigate();
	return (
		<>
			<span data-testid="location">{location.pathname + location.search}</span>
			<button type="button" onClick={() => navigate(-1)}>
				測試用：上一頁
			</button>
		</>
	);
}

/** 在 `entries` 的最後一個網址上畫報表（前面的是「之前去過的頁面」）。 */
function renderAt(...entries: string[]) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return render(
		<QueryClientProvider client={client}>
			<MemoryRouter initialEntries={entries} initialIndex={entries.length - 1}>
				<Expenses />
				<LocationProbe />
			</MemoryRouter>
		</QueryClientProvider>,
	);
}

/** 這個 spy 收到過的 GET 網址。 */
function requested(fetchMock: ReturnType<typeof mockApi>): string[] {
	return fetchMock.mock.calls
		.filter(([, init]) => (init?.method ?? "GET").toUpperCase() === "GET")
		.map(([input]) => String(input));
}

function location(): string {
	return screen.getByTestId("location").textContent ?? "";
}

/** 月份切換那一組。「2026年11月」同時是月份標籤與清單的標題——一律限定範圍找
 *  （第 38 種）。 */
function switcher() {
	return within(screen.getByRole("group", { name: "切換月份" }));
}
const previousButton = () => switcher().getByRole("button", { name: "上個月" });
const nextButton = () => switcher().getByRole("button", { name: "下個月" });
const monthLabel = () => switcher().getByRole("status");

beforeEach(() => {
	localStorage.clear();
	clearTokens();
	resetRefreshStateForTests();
	vi.restoreAllMocks();
	setTokens({ access_token: "a", refresh_token: "r" });
});

describe("報表：切換月份", () => {
	it("沒帶月份：顯示後端說的這個月，「下個月」不能按", async () => {
		mockApi(DECEMBER);
		renderAt("/reports");

		expect(await screen.findByText("十二月的便當")).toBeInTheDocument();
		expect(monthLabel()).toHaveTextContent("2026年12月");
		expect(nextButton()).toBeDisabled();
		expect(previousButton()).toBeEnabled();
		expect(
			screen.getByRole("heading", { name: "這個月花了多少" }),
		).toBeInTheDocument();
		expect(screen.getByRole("heading", { name: "這個月" })).toBeInTheDocument();
		expect(location()).toBe("/reports");
	});

	it("還不知道這個月是哪個月：兩顆都不能按（前端不拿裝置的日期猜）", async () => {
		let resolveSummary: (response: Response) => void = () => {};
		mockApi([
			{
				method: "GET",
				path: "/api/expenses/summary",
				handler: () =>
					new Promise<Response>((resolve) => {
						resolveSummary = resolve;
					}),
			},
			{ method: "GET", path: "/api/expenses", handler: () => json([DEC_ROW]) },
		]);
		renderAt("/reports");

		// 清單已經回來了，報表（也就是「這個月是哪個月」）還沒。
		expect(await screen.findByText("十二月的便當")).toBeInTheDocument();
		expect(previousButton()).toBeDisabled();
		expect(nextButton()).toBeDisabled();
		expect(monthLabel()).toHaveTextContent("這個月");

		resolveSummary(json(DEC_SUMMARY));

		await waitFor(() => expect(previousButton()).toBeEnabled());
		expect(monthLabel()).toHaveTextContent("2026年12月");
		expect(nextButton()).toBeDisabled();
	});

	it("上個月：網址帶上月份，清單與報表都換成那個月，標題跟著改；下個月回到沒有參數的網址", async () => {
		const fetchMock = mockApi([...NOVEMBER, ...DECEMBER]);
		renderAt("/reports");
		await screen.findByText("十二月的便當");

		await userEvent.click(previousButton());

		expect(await screen.findByText("十一月的高鐵")).toBeInTheDocument();
		expect(location()).toBe("/reports?month=2026-11");
		expect(requested(fetchMock)).toContain(
			"/api/expenses/summary?month=2026-11",
		);
		expect(requested(fetchMock)).toContain("/api/expenses?month=2026-11");
		expect(monthLabel()).toHaveTextContent("2026年11月");
		expect(
			screen.getByRole("heading", { name: "2026年11月花了多少" }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("heading", { name: "2026年11月" }),
		).toBeInTheDocument();
		// 「999.00」在摘要裡出現兩次（總計、佔 100% 的那個分類）——比整段文字（第 38 種）。
		expect(screen.getByTestId("expense-summary")).toHaveTextContent(
			"總計 999.00",
		);
		expect(screen.queryByText("十二月的便當")).not.toBeInTheDocument();
		expect(nextButton()).toBeEnabled();

		await userEvent.click(nextButton());

		expect(await screen.findByText("十二月的便當")).toBeInTheDocument();
		// 回到這個月＝沒有參數，不是 ?month=2026-12。
		expect(location()).toBe("/reports");
		expect(
			screen.getByRole("heading", { name: "這個月花了多少" }),
		).toBeInTheDocument();
		expect(nextButton()).toBeDisabled();

		// 換月份是 push：上一頁回到十一月。
		await userEvent.click(
			screen.getByRole("button", { name: "測試用：上一頁" }),
		);
		expect(location()).toBe("/reports?month=2026-11");
		expect(await screen.findByText("十一月的高鐵")).toBeInTheDocument();
	});

	it("新的月份還在載入：留著上一個月的資料但調淡、標成載入中；月份與標題已經是新的", async () => {
		let resolveSummary: (response: Response) => void = () => {};
		let resolveList: (response: Response) => void = () => {};
		mockApi([
			{
				method: "GET",
				path: "/api/expenses/summary?month=2026-11",
				handler: () =>
					new Promise<Response>((resolve) => {
						resolveSummary = resolve;
					}),
			},
			{
				method: "GET",
				path: "/api/expenses?month=2026-11",
				handler: () =>
					new Promise<Response>((resolve) => {
						resolveList = resolve;
					}),
			},
			...DECEMBER,
		]);
		renderAt("/reports");
		await screen.findByText("十二月的便當");
		expect(screen.getByTestId("month-summary")).not.toHaveAttribute(
			"aria-busy",
		);
		expect(screen.getByTestId("month-list")).not.toHaveAttribute("aria-busy");

		await userEvent.click(previousButton());

		// 十一月的兩個回應都還掛著。
		expect(monthLabel()).toHaveTextContent("2026年11月");
		expect(
			screen.getByRole("heading", { name: "2026年11月花了多少" }),
		).toBeInTheDocument();
		for (const testId of ["month-summary", "month-list"]) {
			expect(screen.getByTestId(testId)).toHaveAttribute("aria-busy", "true");
			expect(screen.getByTestId(testId)).toHaveClass(STALE_CLASS);
			// 留著的是十二月的資料、標題卻已經是十一月：這一層只能看，不能操作。
			expect(screen.getByTestId(testId)).toHaveAttribute("inert");
		}
		expect(screen.getByText("十二月的便當")).toBeInTheDocument();
		expect(screen.queryByText("載入中…")).not.toBeInTheDocument();
		// 十二月那一筆的「修改」「刪除」都在 inert 的那一層裡面（瀏覽器不讓它們被點到、
		// 被 Tab 到；jsdom 不實作 inert，真的點不到由 e2e 守）。
		const staleRow = screen.getByTestId("expense-1");
		for (const name of ["修改", "刪除"]) {
			expect(
				within(staleRow)
					.getByText(name, { selector: "button" })
					.closest("[inert]"),
			).toBe(screen.getByTestId("month-list"));
		}
		// 按下去的那顆還在、焦點沒跑掉。
		expect(document.activeElement).toBe(previousButton());

		resolveSummary(json(NOV_SUMMARY));
		resolveList(json([NOV_ROW]));

		expect(await screen.findByText("十一月的高鐵")).toBeInTheDocument();
		for (const testId of ["month-summary", "month-list"]) {
			expect(screen.getByTestId(testId)).not.toHaveAttribute("aria-busy");
			expect(screen.getByTestId(testId)).not.toHaveClass(STALE_CLASS);
			expect(screen.getByTestId(testId)).not.toHaveAttribute("inert");
		}
		expect(screen.queryByText("十二月的便當")).not.toBeInTheDocument();
	});

	it("離線翻到沒看過的月份：說讀不到，不把上一個月的數字留在新的月份底下；恢復連線就載入", async () => {
		// 離線時 query 是 paused，不會自己結束——keepPreviousData 留著的十二月會一直掛在
		// 「2026年11月」底下，而且沒有任何訊息。
		const fetchMock = mockApi([...NOVEMBER, ...DECEMBER]);
		renderAt("/reports");
		await screen.findByText("十二月的便當");
		expect(screen.getByTestId("expense-summary")).toHaveTextContent(
			"總計 180.00",
		);

		onlineManager.setOnline(false);
		try {
			await userEvent.click(previousButton());

			expect(monthLabel()).toHaveTextContent("2026年11月");
			expect(
				await screen.findByText("無法載入2026年11月的報表"),
			).toBeInTheDocument();
			expect(screen.getByText("無法載入花費清單")).toBeInTheDocument();
			// 十二月的東西一樣都不在：數字、那一筆、它的按鈕。
			expect(screen.queryByText("十二月的便當")).not.toBeInTheDocument();
			expect(screen.getByTestId("expense-summary")).not.toHaveTextContent(
				"180.00",
			);
			expect(
				screen.queryByRole("button", { name: "修改" }),
			).not.toBeInTheDocument();
			// 不是「載入中」：沒有在抓，也就沒有調淡、aria-busy。
			for (const testId of ["month-summary", "month-list"]) {
				expect(screen.getByTestId(testId)).not.toHaveAttribute("aria-busy");
				expect(screen.getByTestId(testId)).not.toHaveClass(STALE_CLASS);
				expect(screen.getByTestId(testId)).not.toHaveAttribute("inert");
			}
			expect(
				requested(fetchMock).filter((url) => url.includes("month=2026-11")),
			).toEqual([]);
		} finally {
			onlineManager.setOnline(true);
		}

		// 恢復連線：暫停的請求送出去，十一月出來。
		expect(await screen.findByText("十一月的高鐵")).toBeInTheDocument();
		expect(screen.getByTestId("expense-summary")).toHaveTextContent(
			"總計 999.00",
		);
		expect(screen.queryByText("無法載入花費清單")).not.toBeInTheDocument();
	});

	it("離線直接打開沒看過的月份：說讀不到，不是一直「載入中…」", async () => {
		mockApi([...NOVEMBER, ...DECEMBER]);
		onlineManager.setOnline(false);
		try {
			renderAt("/reports?month=2026-11");

			expect(
				await screen.findByText("無法載入2026年11月的報表"),
			).toBeInTheDocument();
			expect(screen.getByText("無法載入花費清單")).toBeInTheDocument();
			expect(screen.queryByText("載入中…")).not.toBeInTheDocument();
		} finally {
			onlineManager.setOnline(true);
		}
	});

	it("重新整理停在過去的月份：一開始就問那個月，不先問這個月的清單", async () => {
		const fetchMock = mockApi([...NOVEMBER, ...DECEMBER]);
		renderAt("/reports?month=2026-11");

		expect(await screen.findByText("十一月的高鐵")).toBeInTheDocument();
		await waitFor(() => expect(nextButton()).toBeEnabled());
		expect(monthLabel()).toHaveTextContent("2026年11月");
		expect(
			screen.getByRole("heading", { name: "2026年11月" }),
		).toBeInTheDocument();
		expect(location()).toBe("/reports?month=2026-11");
		// 這個月只問了報表（為了知道這個月是哪個月），沒有問清單。
		expect(requested(fetchMock).sort()).toEqual([
			"/api/expenses/summary",
			"/api/expenses/summary?month=2026-11",
			"/api/expenses?month=2026-11",
		]);
	});

	it.each([["2026-13"], ["2026-1"], ["abc"], [""]])(
		"?month=%s 格式不對：當成這個月，網址用 replace 清掉，而且沒有拿它去問後端",
		async (bad) => {
			const fetchMock = mockApi(DECEMBER);
			renderAt("/", `/reports?month=${bad}`);

			expect(await screen.findByText("十二月的便當")).toBeInTheDocument();
			await waitFor(() => expect(location()).toBe("/reports"));
			expect(monthLabel()).toHaveTextContent("2026年12月");
			expect(
				requested(fetchMock).filter((url) => url.includes("month=")),
			).toEqual([]);

			// replace：上一頁回到進報表之前的那一頁，不是回到壞掉的網址（再被清一次）。
			await userEvent.click(
				screen.getByRole("button", { name: "測試用：上一頁" }),
			);
			expect(location()).toBe("/");
		},
	);

	it("未來的月份：後端回了這個月才知道，退回這個月並用 replace 清掉網址", async () => {
		mockApi([
			{
				method: "GET",
				path: "/api/expenses/summary?month=2027-01",
				handler: () =>
					json({ month: "2027-01", total: "0.00", by_category: [] }),
			},
			{
				method: "GET",
				path: "/api/expenses?month=2027-01",
				handler: () => json([]),
			},
			...DECEMBER,
		]);
		renderAt("/", "/reports?month=2027-01");

		expect(await screen.findByText("十二月的便當")).toBeInTheDocument();
		await waitFor(() => expect(location()).toBe("/reports"));
		expect(monthLabel()).toHaveTextContent("2026年12月");
		expect(
			screen.getByRole("heading", { name: "這個月花了多少" }),
		).toBeInTheDocument();
		expect(nextButton()).toBeDisabled();

		await userEvent.click(
			screen.getByRole("button", { name: "測試用：上一頁" }),
		);
		expect(location()).toBe("/");
	});

	it("?month 剛好是這個月：照樣是「這個月」，下個月不能按，網址不動", async () => {
		mockApi([
			{
				method: "GET",
				path: "/api/expenses/summary?month=2026-12",
				handler: () => json(DEC_SUMMARY),
			},
			{
				method: "GET",
				path: "/api/expenses?month=2026-12",
				handler: () => json([DEC_ROW]),
			},
			...DECEMBER,
		]);
		renderAt("/reports?month=2026-12");

		expect(await screen.findByText("十二月的便當")).toBeInTheDocument();
		expect(
			await screen.findByRole("heading", { name: "這個月花了多少" }),
		).toBeInTheDocument();
		expect(nextButton()).toBeDisabled();
		expect(previousButton()).toBeEnabled();
		expect(location()).toBe("/reports?month=2026-12");
	});

	it("這個月的報表讀不到：過去的月份照樣看得到、可以再往前，但不能往後", async () => {
		mockApi([
			...NOVEMBER,
			{
				method: "GET",
				path: "/api/expenses/summary",
				handler: () =>
					json({ error: { code: "X", message: "x", details: {} } }, 500),
			},
			{ method: "GET", path: "/api/expenses", handler: () => json([]) },
		]);
		renderAt("/reports?month=2026-11");

		expect(await screen.findByText("十一月的高鐵")).toBeInTheDocument();
		expect(monthLabel()).toHaveTextContent("2026年11月");
		expect(previousButton()).toBeEnabled();
		expect(nextButton()).toBeDisabled();
		expect(location()).toBe("/reports?month=2026-11");
	});

	it("過去的月份沒有資料、讀不到時，說的是那個月，不是「這個月」", async () => {
		mockApi([
			{
				method: "GET",
				path: "/api/expenses/summary?month=2026-11",
				handler: () =>
					json({ month: "2026-11", total: "0.00", by_category: [] }),
			},
			{
				method: "GET",
				path: "/api/expenses?month=2026-11",
				handler: () => json([]),
			},
			{
				method: "GET",
				path: "/api/expenses/summary?month=2026-10",
				handler: () =>
					json({ error: { code: "X", message: "x", details: {} } }, 500),
			},
			{
				method: "GET",
				path: "/api/expenses?month=2026-10",
				handler: () => json([]),
			},
			...DECEMBER,
		]);
		renderAt("/reports?month=2026-11");

		expect(await screen.findByText("2026年11月沒有支出")).toBeInTheDocument();
		expect(screen.getByText("2026年11月沒有記錄花費")).toBeInTheDocument();
		expect(screen.queryByText(/這個月還沒有/)).not.toBeInTheDocument();

		await userEvent.click(previousButton());

		expect(
			await screen.findByText("無法載入2026年10月的報表"),
		).toBeInTheDocument();
		expect(location()).toBe("/reports?month=2026-10");
	});

	it("在過去的月份刪掉一筆：重抓的是那個月的清單與報表", async () => {
		let deleted = false;
		const fetchMock = mockApi([
			{
				method: "DELETE",
				path: "/api/expenses/2",
				handler: () => {
					deleted = true;
					return new Response(null, { status: 204 });
				},
			},
			{
				method: "GET",
				path: "/api/expenses/summary?month=2026-11",
				handler: () =>
					json(
						deleted
							? { month: "2026-11", total: "0.00", by_category: [] }
							: NOV_SUMMARY,
					),
			},
			{
				method: "GET",
				path: "/api/expenses?month=2026-11",
				handler: () => json(deleted ? [] : [NOV_ROW]),
			},
			...DECEMBER,
		]);
		renderAt("/reports?month=2026-11");
		const row = await screen.findByTestId("expense-2");

		await userEvent.click(within(row).getByRole("button", { name: "刪除" }));
		await userEvent.click(
			within(row).getByRole("button", { name: "確定刪除" }),
		);

		expect(
			await screen.findByText("2026年11月沒有記錄花費"),
		).toBeInTheDocument();
		expect(await screen.findByText("2026年11月沒有支出")).toBeInTheDocument();
		expect(
			requested(fetchMock).filter(
				(url) => url === "/api/expenses?month=2026-11",
			),
		).toHaveLength(2);
		expect(location()).toBe("/reports?month=2026-11");
	});
});
