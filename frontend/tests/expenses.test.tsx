import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetRefreshStateForTests } from "../src/auth/refresh";
import { clearTokens, setTokens } from "../src/auth/store";
import { Expenses } from "../src/screens/Expenses";
import { json, mockApi } from "./helpers/mock-api";

// 不需要 MemoryRouter：這個畫面沒有 <Link> 也沒有 useNavigate
// （清單、新增、改刪、報表全在同一個畫面裡，跟 Supplements.tsx 同一個作法）。
function wrap(children: ReactNode) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const LUNCH = {
	id: 1,
	amount: "180.00",
	category: "food" as const,
	spent_at: "2026-12-15T04:00:00+00:00",
	note: "便當",
	meal_id: 11,
};

const TRAIN = {
	id: 2,
	amount: "250.50",
	category: "transport" as const,
	spent_at: "2026-12-14T02:00:00+00:00",
	note: null,
	meal_id: null,
};

const EMPTY_SUMMARY = { month: "2026-12", total: "0.00", by_category: [] };

/** 從 fetch 的 spy 裡挖出某一次請求送出的 JSON body。
 *
 *  **用 `fetchMock.mock.calls` 而不是再包一層 spy。** `mockApi()` 回傳的就是
 *  `vi.spyOn()` 的結果，呼叫記錄裡本來就有 `init`——再疊一層
 *  `vi.spyOn(globalThis, "fetch")` 去攔 body 不只多餘，還會因為
 *  `beforeEach` 的 `vi.restoreAllMocks()` 與疊加順序變得很難推理。
 *
 *  回傳 `Record<string, unknown> | null` 而不是 `any`：biome 的
 *  `recommended` preset 含 `noExplicitAny`，而測試檔也在 lint 範圍內
 *  （`biome.jsonc` 的 `includes` 只排除 `src/api/schema.d.ts`）。
 *  欄位取出來是 `unknown`，`expect(...)` 照樣吃得下。
 *
 *  **呼叫端一律用 `sent?.欄位`**：回傳型別含 `null`，strict 模式下
 *  直接 `sent.欄位` 是編譯錯誤。而 `undefined` 也不會等於期望值，
 *  所以斷言的鑑別力沒有因為 `?.` 而變弱。 */
function sentBody(
	fetchMock: ReturnType<typeof mockApi>,
	method: string,
	pathPart: string,
): Record<string, unknown> | null {
	const call = fetchMock.mock.calls.find(
		([input, init]) =>
			(init?.method ?? "GET").toUpperCase() === method.toUpperCase() &&
			String(input).includes(pathPart),
	);
	if (call === undefined) return null;
	return JSON.parse(String(call[1]?.body));
}

/** 這個 spy 收到過幾次「GET /api/expenses」（清單，不含 `/summary`）。
 *
 *  給「新增成功後清單會重取」那條測試用：用 `>= 2` 而不是算出確切次數，
 *  是因為掛載時已經打過一次，新增成功後 `invalidateQueries` 再觸發一次——
 *  在意的是「至少重取了一次」，不是 TanStack Query 內部確切打幾次請求。 */
function expenseListGetCount(fetchMock: ReturnType<typeof mockApi>): number {
	return fetchMock.mock.calls.filter(([input, init]) => {
		const url = String(input);
		return (
			(init?.method ?? "GET").toUpperCase() === "GET" &&
			url.includes("/api/expenses") &&
			!url.includes("/summary")
		);
	}).length;
}

/** 這個 spy 收到過的所有 HTTP method。 */
function methodsOf(fetchMock: ReturnType<typeof mockApi>): string[] {
	return fetchMock.mock.calls.map(([, init]) =>
		(init?.method ?? "GET").toUpperCase(),
	);
}

beforeEach(() => {
	localStorage.clear();
	clearTokens();
	resetRefreshStateForTests();
	vi.restoreAllMocks();
	setTokens({ access_token: "a", refresh_token: "r" });
});

describe("記帳 /expenses", () => {
	it("顯示這個月的花費，金額保留兩位小數", async () => {
		mockApi([
			// 更具體的路徑排前面：mock-api 用 url.includes(path) 依序比對，
			// "/api/expenses" 會先吃掉 "/api/expenses/summary" 的請求。
			{
				method: "GET",
				path: "/api/expenses/summary",
				handler: () => json(EMPTY_SUMMARY),
			},
			{
				method: "GET",
				path: "/api/expenses",
				handler: () => json([LUNCH, TRAIN]),
			},
		]);

		render(wrap(<Expenses />));

		expect(await screen.findByText("便當")).toBeInTheDocument();
		// 250.50 不能顯示成 250.5——這是 formatMoney 存在的理由
		expect(screen.getByText("250.50")).toBeInTheDocument();
		expect(screen.getByText("180.00")).toBeInTheDocument();
		// 分類顯示中文，不是 "food"——新增表單的 <select> 也有同樣文字的
		// <option>，所以要限定在該筆花費的列裡找，否則會撞到
		// "Found multiple elements"。
		expect(
			within(screen.getByTestId("expense-1")).getByText("飲食"),
		).toBeInTheDocument();
		expect(
			within(screen.getByTestId("expense-2")).getByText("交通"),
		).toBeInTheDocument();
	});

	it("沒有花費時講明白，不是空白畫面", async () => {
		mockApi([
			{
				method: "GET",
				path: "/api/expenses/summary",
				handler: () => json(EMPTY_SUMMARY),
			},
			{ method: "GET", path: "/api/expenses", handler: () => json([]) },
		]);

		render(wrap(<Expenses />));

		expect(await screen.findByText("這個月還沒有記錄花費")).toBeInTheDocument();
	});

	it("清單讀取失敗時講清楚，不是顯示成沒有花費", async () => {
		// 錯誤信封形狀跟 admin-revisions.test.tsx 的 errorEnvelope() 一樣：
		// { error: { code, message, details } }。
		mockApi([
			{
				method: "GET",
				path: "/api/expenses/summary",
				handler: () => json(EMPTY_SUMMARY),
			},
			{
				method: "GET",
				path: "/api/expenses",
				handler: () =>
					json(
						{
							error: {
								code: "INTERNAL_ERROR",
								message: "伺服器錯誤",
								details: {},
							},
						},
						500,
					),
			},
		]);

		render(wrap(<Expenses />));

		expect(await screen.findByText("無法載入花費清單")).toBeInTheDocument();
		// 失敗不能被誤讀成「這個月沒有花費」——那個措辭在金錢畫面上會
		// 引誘使用者以為真的沒記錄過，重打一筆造成重複記帳。
		expect(screen.queryByText("這個月還沒有記錄花費")).not.toBeInTheDocument();
	});

	it("新增一筆花費，送出的 spent_at 帶時區偏移", async () => {
		const fetchMock = mockApi([
			{
				method: "GET",
				path: "/api/expenses/summary",
				handler: () => json(EMPTY_SUMMARY),
			},
			{ method: "GET", path: "/api/expenses", handler: () => json([]) },
			{
				method: "POST",
				path: "/api/expenses",
				handler: () => json(TRAIN, 201),
			},
		]);

		render(wrap(<Expenses />));
		await screen.findByText("這個月還沒有記錄花費");

		await userEvent.type(screen.getByLabelText("金額"), "250.50");
		await userEvent.selectOptions(screen.getByLabelText("分類"), "transport");
		await userEvent.click(screen.getByRole("button", { name: "記一筆" }));

		await waitFor(() =>
			expect(sentBody(fetchMock, "POST", "/api/expenses")).not.toBeNull(),
		);
		const sent = sentBody(fetchMock, "POST", "/api/expenses");
		expect(sent?.amount).toBe("250.50");
		expect(sent?.category).toBe("transport");
		// 備註留空——後端 note 是「留空轉 null」，不是空字串。
		expect(sent?.note).toBeNull();
		// **關鍵斷言**：後端用 AwareDatetime，沒有 offset 的 datetime 會 422。
		// toISOString() 永遠以 Z 結尾。
		expect(sent?.spent_at).toMatch(/(Z|[+-]\d{2}:\d{2})$/);

		// 新增成功要讓清單重取，不然記完一筆之後畫面上還是舊資料——
		// 掛載時打過一次 GET /api/expenses，成功後 invalidateQueries
		// 應該再觸發至少一次。
		await waitFor(() =>
			expect(expenseListGetCount(fetchMock)).toBeGreaterThanOrEqual(2),
		);
	});

	it("金額留空時不送請求", async () => {
		const fetchMock = mockApi([
			{
				method: "GET",
				path: "/api/expenses/summary",
				handler: () => json(EMPTY_SUMMARY),
			},
			{ method: "GET", path: "/api/expenses", handler: () => json([]) },
		]);

		render(wrap(<Expenses />));
		await screen.findByText("這個月還沒有記錄花費");
		const before = fetchMock.mock.calls.length;

		await userEvent.click(screen.getByRole("button", { name: "記一筆" }));

		expect(await screen.findByRole("alert")).toHaveTextContent("請輸入金額");
		// 沒有多打任何請求——驗證擋在前端，不是靠後端回 422
		expect(fetchMock.mock.calls.length).toBe(before);
	});

	it("改掉一筆的金額", async () => {
		const fetchMock = mockApi([
			{
				method: "GET",
				path: "/api/expenses/summary",
				handler: () => json(EMPTY_SUMMARY),
			},
			{ method: "GET", path: "/api/expenses", handler: () => json([TRAIN]) },
			{
				method: "PATCH",
				path: "/api/expenses/2",
				handler: () => json({ ...TRAIN, amount: "300.00" }),
			},
		]);

		render(wrap(<Expenses />));
		await screen.findByText("250.50");

		await userEvent.click(screen.getByRole("button", { name: "修改" }));
		const amountInput = screen.getByLabelText("修改金額");
		await userEvent.clear(amountInput);
		await userEvent.type(amountInput, "300");
		await userEvent.click(screen.getByRole("button", { name: "儲存" }));

		await waitFor(() =>
			expect(sentBody(fetchMock, "PATCH", "/api/expenses/2")).not.toBeNull(),
		);
		const sent = sentBody(fetchMock, "PATCH", "/api/expenses/2");
		expect(sent?.amount).toBe("300");
		// **關鍵**：不送 spent_at。送了就要帶 offset，而這個畫面沒有
		// 日期選擇器——不送最安全，而且後端的 exclude_unset 會正確處理。
		expect(sent).not.toHaveProperty("spent_at");
		// 也不送 meal_id：後端的 ExpenseUpdateRequest 根本沒有這個欄位
		// （extra="ignore" 會丟掉它），但前端也不該送。
		expect(sent).not.toHaveProperty("meal_id");

		// 修改成功要讓清單重取，不然畫面上還是改之前的金額——掛載時打過
		// 一次 GET /api/expenses，成功後 invalidateQueries 應該再觸發至少一次。
		await waitFor(() =>
			expect(expenseListGetCount(fetchMock)).toBeGreaterThanOrEqual(2),
		);
	});

	it("修改金額留空時不送請求", async () => {
		const fetchMock = mockApi([
			{
				method: "GET",
				path: "/api/expenses/summary",
				handler: () => json(EMPTY_SUMMARY),
			},
			{ method: "GET", path: "/api/expenses", handler: () => json([TRAIN]) },
		]);

		render(wrap(<Expenses />));
		await screen.findByText("250.50");

		await userEvent.click(screen.getByRole("button", { name: "修改" }));
		const amountInput = screen.getByLabelText("修改金額");
		await userEvent.clear(amountInput);
		await userEvent.click(screen.getByRole("button", { name: "儲存" }));

		expect(await screen.findByRole("alert")).toHaveTextContent("請輸入金額");
		// 沒有送出 PATCH——驗證擋在前端，不是靠後端回 422
		expect(methodsOf(fetchMock)).not.toContain("PATCH");
	});

	it("修改金額格式被後端拒絕時顯示具體訊息", async () => {
		// 錯誤信封形狀跟「清單讀取失敗」那條測試一樣：
		// { error: { code, message, details } }。
		const fetchMock = mockApi([
			{
				method: "GET",
				path: "/api/expenses/summary",
				handler: () => json(EMPTY_SUMMARY),
			},
			{ method: "GET", path: "/api/expenses", handler: () => json([TRAIN]) },
			{
				method: "PATCH",
				path: "/api/expenses/2",
				handler: () =>
					json(
						{
							error: {
								code: "VALIDATION_ERROR",
								message: "amount must be greater than 0",
								details: {},
							},
						},
						422,
					),
			},
		]);

		render(wrap(<Expenses />));
		await screen.findByText("250.50");

		await userEvent.click(screen.getByRole("button", { name: "修改" }));
		const amountInput = screen.getByLabelText("修改金額");
		await userEvent.clear(amountInput);
		await userEvent.type(amountInput, "0");
		await userEvent.click(screen.getByRole("button", { name: "儲存" }));

		// 跟新增表單用同一句——都是同一個後端驗證規則，使用者不該在
		// 兩個表單看到兩種說法。
		expect(await screen.findByRole("alert")).toHaveTextContent(
			"金額格式不對，請輸入大於 0、最多兩位小數的數字",
		);
		expect(methodsOf(fetchMock)).toContain("PATCH");
	});

	it("刪除要先確認", async () => {
		const fetchMock = mockApi([
			{
				method: "GET",
				path: "/api/expenses/summary",
				handler: () => json(EMPTY_SUMMARY),
			},
			{ method: "GET", path: "/api/expenses", handler: () => json([TRAIN]) },
		]);

		render(wrap(<Expenses />));
		await screen.findByText("250.50");
		const before = fetchMock.mock.calls.length;

		await userEvent.click(screen.getByRole("button", { name: "刪除" }));

		// 按了刪除之後**還沒有**打任何請求——先出現確認
		expect(fetchMock.mock.calls.length).toBe(before);
		expect(screen.getByText("確定要刪掉這筆花費嗎？")).toBeInTheDocument();
	});

	it("確認之後才真的刪", async () => {
		const fetchMock = mockApi([
			{
				method: "GET",
				path: "/api/expenses/summary",
				handler: () => json(EMPTY_SUMMARY),
			},
			{ method: "GET", path: "/api/expenses", handler: () => json([TRAIN]) },
			{
				method: "DELETE",
				path: "/api/expenses/2",
				handler: () => new Response(null, { status: 204 }),
			},
		]);

		render(wrap(<Expenses />));
		await screen.findByText("250.50");

		await userEvent.click(screen.getByRole("button", { name: "刪除" }));
		await userEvent.click(screen.getByRole("button", { name: "確定刪除" }));

		// 不只「送過某個 DELETE」，要送到**這一筆**的 URL——否則刪錯列
		// 也會讓這條測試變綠。
		await waitFor(() => {
			const deletedUrls = fetchMock.mock.calls
				.filter(
					([, init]) => (init?.method ?? "GET").toUpperCase() === "DELETE",
				)
				.map(([input]) => String(input));
			expect(deletedUrls.some((url) => url.includes("/api/expenses/2"))).toBe(
				true,
			);
		});

		// 刪除成功要讓清單重取，不然畫面上還留著已經刪掉的那一筆——掛載時
		// 打過一次 GET /api/expenses，成功後 invalidateQueries 應該再觸發
		// 至少一次。
		await waitFor(() =>
			expect(expenseListGetCount(fetchMock)).toBeGreaterThanOrEqual(2),
		);
	});

	it("刪除失敗時講清楚", async () => {
		const fetchMock = mockApi([
			{
				method: "GET",
				path: "/api/expenses/summary",
				handler: () => json(EMPTY_SUMMARY),
			},
			{ method: "GET", path: "/api/expenses", handler: () => json([TRAIN]) },
			{
				method: "DELETE",
				path: "/api/expenses/2",
				handler: () =>
					json(
						{
							error: {
								code: "INTERNAL_ERROR",
								message: "伺服器錯誤",
								details: {},
							},
						},
						500,
					),
			},
		]);

		render(wrap(<Expenses />));
		await screen.findByText("250.50");

		await userEvent.click(screen.getByRole("button", { name: "刪除" }));
		await userEvent.click(screen.getByRole("button", { name: "確定刪除" }));

		expect(await screen.findByRole("alert")).toHaveTextContent(
			"刪除失敗，請再試一次",
		);
		expect(methodsOf(fetchMock)).toContain("DELETE");
	});

	it("取消確認就不刪", async () => {
		const fetchMock = mockApi([
			{
				method: "GET",
				path: "/api/expenses/summary",
				handler: () => json(EMPTY_SUMMARY),
			},
			{ method: "GET", path: "/api/expenses", handler: () => json([TRAIN]) },
		]);

		render(wrap(<Expenses />));
		await screen.findByText("250.50");

		await userEvent.click(screen.getByRole("button", { name: "刪除" }));
		await userEvent.click(screen.getByRole("button", { name: "取消" }));

		expect(methodsOf(fetchMock)).not.toContain("DELETE");
		expect(
			screen.queryByText("確定要刪掉這筆花費嗎？"),
		).not.toBeInTheDocument();
	});
});
