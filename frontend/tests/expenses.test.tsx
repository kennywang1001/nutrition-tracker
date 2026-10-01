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

/** 這個 spy 收到過的所有 HTTP method。 */
function methodsOf(fetchMock: ReturnType<typeof mockApi>): string[] {
	return fetchMock.mock.calls.map(([, init]) =>
		(init?.method ?? "GET").toUpperCase(),
	);
}
// Task 4 會用到（編輯／刪除）；Task 3 先留著會被 biome 的
// noUnusedVariables 擋下來，所以暫時標成已使用的佔位呼叫。
void methodsOf;

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
		// **關鍵斷言**：後端用 AwareDatetime，沒有 offset 的 datetime 會 422。
		// toISOString() 永遠以 Z 結尾。
		expect(sent?.spent_at).toMatch(/(Z|[+-]\d{2}:\d{2})$/);
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
});
