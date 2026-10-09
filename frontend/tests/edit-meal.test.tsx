import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	act,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AMOUNT_FORMAT_ERROR } from "../src/api/expenses";
import { queryKeys } from "../src/api/queries";
import { resetRefreshStateForTests } from "../src/auth/refresh";
import { clearTokens, setTokens } from "../src/auth/store";
import { EditMeal } from "../src/screens/EditMeal";
import { json, type Route as MockRoute, mockApi } from "./helpers/mock-api";

vi.mock("../src/lib/resize-image", () => ({
	shrinkToLongestEdge: vi.fn((file: File) => Promise.resolve(file)),
}));

const ITEM = {
	id: 51,
	food_id: 1,
	food_name: "滷肉飯",
	portion_id: null,
	quantity: "200.00",
	quantity_g: "200.00",
	kcal: "360.00",
	protein_g: "13.00",
	fat_g: "14.00",
	carb_g: "44.00",
};

const MEAL = {
	id: 5,
	eaten_at: "2026-10-04T12:30:00+08:00",
	meal_type: "lunch",
	note: null,
	photo_path: null,
	cost: "180.00",
	is_private: false,
	items: [ITEM],
	kcal: "360.00",
	protein_g: "13.00",
	fat_g: "14.00",
	carb_g: "44.00",
};

const RICE = {
	id: 1,
	name: "滷肉飯",
	brand: null,
	is_global: true,
	nutrition: {
		base_unit: "g",
		kcal: "180.00",
		protein_g: "6.50",
		fat_g: "7.00",
		carb_g: "22.00",
	},
};

const BOWL = {
	id: 8,
	label: "碗",
	grams: "150.00",
	is_default: true,
	is_global: true,
};

const WHITE_RICE = { ...RICE, id: 3, name: "白飯" };

const SMALL_BOWL = {
	id: 9,
	label: "小碗",
	grams: "100.00",
	is_default: false,
	is_global: true,
};

/** 每次呼叫回一個新的 Response（body 只能讀一次）。 */
function portionMismatch() {
	return json(
		{
			error: {
				code: "PORTION_FOOD_MISMATCH",
				message: "這個份量不屬於指定的食物",
				details: {},
			},
		},
		422,
	);
}

function itemNotFound() {
	return json(
		{
			error: {
				code: "MEAL_ITEM_NOT_FOUND",
				message: "找不到該項目",
				details: {},
			},
		},
		404,
	);
}

function quantityOutOfRange() {
	return json(
		{
			error: {
				code: "QUANTITY_OUT_OF_RANGE",
				message: "換算後的公克數超出範圍（0.01 到 999,999.99 g），請改數量",
				details: {},
			},
		},
		422,
	);
}

/** `extra` 排在前面：`mockApi` 依序用 `url.includes` 比對，而
 *  `/api/meals/5/photo`、`/api/meals/5/items/51` 都「包含」`/api/meals/5`。 */
function routes(
	meal: unknown | (() => unknown) = MEAL,
	extra: MockRoute[] = [],
): MockRoute[] {
	const current = () => (typeof meal === "function" ? meal() : meal);
	return [
		...extra,
		{
			method: "GET",
			path: "/api/meals/5/photo",
			handler: () =>
				new Response(new Blob(["fake-jpeg"], { type: "image/jpeg" })),
		},
		{ method: "GET", path: "/api/meals/5", handler: () => json(current()) },
		{ method: "PATCH", path: "/api/meals/5", handler: () => json(current()) },
		{
			method: "DELETE",
			path: "/api/meals/5",
			handler: () => new Response(null, { status: 204 }),
		},
		{ path: "/api/foods/1/portions", handler: () => json([]) },
		{ path: "/api/foods/1", handler: () => json(RICE) },
		{ path: "/api/foods/frequent", handler: () => json([]) },
		{ path: "/api/foods/recent", handler: () => json([]) },
	];
}

function newClient() {
	return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

/** 預設從總覽點進來（history 有上一頁）。`entries` 只給一個時＝直接打開網址。 */
function renderEditMeal(
	client = newClient(),
	entries: string[] = ["/", "/diet", "/meals/5/edit"],
) {
	render(
		<QueryClientProvider client={client}>
			<MemoryRouter initialEntries={entries} initialIndex={entries.length - 1}>
				<Routes>
					<Route path="/" element={<p>總覽頁</p>} />
					<Route path="/diet" element={<p>飲食頁</p>} />
					<Route path="/meals/:id/edit" element={<EditMeal />} />
				</Routes>
			</MemoryRouter>
		</QueryClientProvider>,
	);
	return client;
}

function calls(
	fetchMock: ReturnType<typeof mockApi>,
	method: string,
	path: string,
) {
	return fetchMock.mock.calls.filter(
		([input, init]) =>
			(init?.method ?? "GET").toUpperCase() === method &&
			String(input).includes(path),
	);
}

function bodyOf(
	fetchMock: ReturnType<typeof mockApi>,
	method: string,
	path: string,
): unknown {
	const call = calls(fetchMock, method, path)[0];
	return call === undefined ? undefined : JSON.parse(String(call[1]?.body));
}

function keysOf(spy: { mock: { calls: unknown[][] } }): unknown[] {
	return spy.mock.calls.map(
		(call) => (call[0] as { queryKey?: unknown } | undefined)?.queryKey,
	);
}

function validationError(loc: unknown[]) {
	return json(
		{
			error: {
				code: "VALIDATION_ERROR",
				message: "格式錯誤",
				details: { errors: [{ loc, msg: "x" }] },
			},
		},
		422,
	);
}

beforeEach(() => {
	localStorage.clear();
	clearTokens();
	resetRefreshStateForTests();
	vi.restoreAllMocks();
	setTokens({ access_token: "a", refresh_token: "r" });
});

describe("編輯這一餐：讀取", () => {
	it("帶入目前的餐別、金額、備註與項目", async () => {
		mockApi(routes());
		renderEditMeal();

		expect(await screen.findByLabelText("餐別")).toHaveValue("lunch");
		expect(screen.getByLabelText("金額（選填）")).toHaveValue("180.00");
		expect(screen.getByLabelText("備註（選填）")).toHaveValue("");
		expect(screen.getByTestId("meal-item-51")).toHaveTextContent("滷肉飯");
	});

	it("項目的份量照 base_unit 寫單位：液體是 ml（直接輸入與用份量記的都是）", async () => {
		const milk = {
			...ITEM,
			id: 52,
			food_id: 4,
			food_name: "鮮奶",
			quantity: "250.00",
			quantity_g: "250.00",
			base_unit: "ml",
		};
		const glass = {
			...ITEM,
			id: 53,
			food_id: 4,
			food_name: "豆漿",
			portion_id: 12,
			quantity: "2.00",
			quantity_g: "480.00",
			base_unit: "ml",
		};
		const rice = { ...ITEM, base_unit: "g" };
		mockApi(routes({ ...MEAL, items: [rice, milk, glass] }));
		renderEditMeal();

		expect(await screen.findByTestId("meal-item-52")).toHaveTextContent(
			"250 ml · 360 kcal",
		);
		expect(screen.getByTestId("meal-item-53")).toHaveTextContent(
			"2 份（480 ml）",
		);
		expect(screen.getByTestId("meal-item-51")).toHaveTextContent(
			"200 g · 360 kcal",
		);
	});

	it("改一項：直接輸入的單位用這一項釘住的那一版（食物後來改成 g 也照樣是 ml）", async () => {
		// 食物 1（RICE）現在的版本是 g；這一項是當初用 ml 的那一版記的。PATCH 不換
		// 釘住的版本，所以輸入的數字照樣是 ml——單位要跟著這一項，不是跟著食物現在。
		const milk = {
			...ITEM,
			id: 52,
			food_name: "鮮奶",
			quantity: "250.00",
			quantity_g: "250.00",
			base_unit: "ml",
		};
		mockApi(routes({ ...MEAL, items: [milk] }));
		renderEditMeal();

		await userEvent.click(
			await screen.findByRole("button", { name: "修改鮮奶" }),
		);

		expect(
			await screen.findByTestId("item-52-quantity-unit"),
		).toHaveTextContent(/^ml$/);
	});

	it("404：找不到這一餐（可能在另一台裝置上刪了）", async () => {
		mockApi([
			{
				path: "/api/meals/5",
				handler: () =>
					json(
						{
							error: {
								code: "MEAL_NOT_FOUND",
								message: "找不到該餐點",
								details: {},
							},
						},
						404,
					),
			},
		]);
		renderEditMeal();

		expect(await screen.findByText("找不到這一餐")).toBeInTheDocument();
	});

	/** `useMeal` 自己給了 `retry`（蓋過 `newClient` 的 `retry: false`）：
	 *  會失敗的讀取都要給一個 `retryDelay` 短的 client，不然要等 7 秒。 */
	describe("重試", () => {
		it("404 不重試：只打一次，立刻說找不到", async () => {
			const fetchMock = mockApi([
				{
					path: "/api/meals/5",
					handler: () =>
						json(
							{
								error: {
									code: "MEAL_NOT_FOUND",
									message: "找不到該餐點",
									details: {},
								},
							},
							404,
						),
				},
			]);
			// 預設的 retry（3 次）與 retryDelay（1、2、4 秒）：會重試的話，
			// findByText 的 1 秒等不到「找不到這一餐」。
			renderEditMeal(new QueryClient());

			expect(await screen.findByText("找不到這一餐")).toBeInTheDocument();
			expect(calls(fetchMock, "GET", "/api/meals/5")).toHaveLength(1);
		});

		it("其他錯誤照樣重試（最多 3 次），之後說載入失敗，不是說找不到", async () => {
			const fetchMock = mockApi([
				{
					path: "/api/meals/5",
					handler: () =>
						json({ error: { code: "X", message: "x", details: {} } }, 500),
				},
			]);
			renderEditMeal(
				new QueryClient({ defaultOptions: { queries: { retryDelay: 1 } } }),
			);

			expect(await screen.findByText("無法載入這一餐")).toBeInTheDocument();
			expect(calls(fetchMock, "GET", "/api/meals/5")).toHaveLength(4);
		});
	});

	it("沒有項目時說沒有項目", async () => {
		mockApi(routes({ ...MEAL, items: [] }));
		renderEditMeal();

		expect(await screen.findByText("這一餐沒有項目")).toBeInTheDocument();
	});
});

describe("編輯這一餐：從清單點進來（清單快取當 placeholder）", () => {
	/** 一個要等測試說話才回的 GET。`mockApi` 的 handler 型別是同步的，但它在
	 *  async 的 fetch mock 裡被 return，回 Promise 也一樣被等。 */
	function deferredMeal() {
		let resolve: (response: Response) => void = () => {};
		const pending = new Promise<Response>((done) => {
			resolve = done;
		});
		return {
			handler: () => pending as unknown as Response,
			resolve: (meal: unknown) => resolve(json(meal)),
		};
	}

	it("清單裡有這一餐：立刻顯示它的餐別與金額，不先「載入中」", () => {
		const neverResolves = deferredMeal();
		mockApi(
			routes(MEAL, [
				{ method: "GET", path: "/api/meals/5", handler: neverResolves.handler },
			]),
		);
		const client = newClient();
		client.setQueryData(queryKeys.meals, [MEAL]);
		renderEditMeal(client);

		expect(screen.queryByText("載入中…")).not.toBeInTheDocument();
		expect(screen.getByLabelText("餐別")).toHaveValue("lunch");
		expect(screen.getByLabelText("金額（選填）")).toHaveValue("180.00");
	});

	it("清單裡沒有這一餐（別天的）：照樣「載入中」", () => {
		const neverResolves = deferredMeal();
		mockApi(
			routes(MEAL, [
				{ method: "GET", path: "/api/meals/5", handler: neverResolves.handler },
			]),
		);
		const client = newClient();
		client.setQueryData(queryKeys.meals, [{ ...MEAL, id: 6 }]);
		renderEditMeal(client);

		expect(screen.getByText("載入中…")).toBeInTheDocument();
	});

	it("在 placeholder 上改了備註，真的資料才回來：草稿留著、沒動的欄位跟伺服器，只送備註", async () => {
		const meal = deferredMeal();
		const fetchMock = mockApi(
			routes(MEAL, [
				{ method: "GET", path: "/api/meals/5", handler: meal.handler },
			]),
		);
		const client = newClient();
		// 清單快取是舊的：另一台裝置已經把餐別改成晚餐。
		client.setQueryData(queryKeys.meals, [MEAL]);
		renderEditMeal(client);

		await userEvent.type(screen.getByLabelText("備註（選填）"), "少飯");
		meal.resolve({ ...MEAL, meal_type: "dinner" });

		await waitFor(() =>
			expect(screen.getByLabelText("餐別")).toHaveValue("dinner"),
		);
		expect(screen.getByLabelText("備註（選填）")).toHaveValue("少飯");
		await userEvent.click(screen.getByRole("button", { name: "儲存" }));

		await waitFor(() =>
			expect(bodyOf(fetchMock, "PATCH", "/api/meals/5")).toEqual({
				note: "少飯",
			}),
		);
	});

	it("真的資料還沒回來就存：只送改過的欄位，不把 placeholder 的其他值送回去", async () => {
		const neverResolves = deferredMeal();
		const fetchMock = mockApi(
			routes(MEAL, [
				{ method: "GET", path: "/api/meals/5", handler: neverResolves.handler },
			]),
		);
		const client = newClient();
		client.setQueryData(queryKeys.meals, [MEAL]);
		renderEditMeal(client);

		await userEvent.selectOptions(screen.getByLabelText("餐別"), "dinner");
		await userEvent.click(screen.getByRole("button", { name: "儲存" }));

		await waitFor(() =>
			expect(bodyOf(fetchMock, "PATCH", "/api/meals/5")).toEqual({
				meal_type: "dinner",
			}),
		);
	});
});

describe("編輯這一餐：餐別、金額、備註", () => {
	it("改成只有我看得到：PATCH 只送 is_private", async () => {
		const fetchMock = mockApi(routes());
		renderEditMeal();

		const toggle = await screen.findByLabelText(
			"只有我看得到（好友看不到這一餐）",
		);
		expect(toggle).not.toBeChecked();
		await userEvent.click(toggle);
		await userEvent.click(screen.getByRole("button", { name: "儲存" }));

		await waitFor(() =>
			expect(bodyOf(fetchMock, "PATCH", "/api/meals/5")).toEqual({
				is_private: true,
			}),
		);
	});

	it("只改餐別：PATCH 的 body 只有 meal_type，不失效花費", async () => {
		const fetchMock = mockApi(routes());
		const client = renderEditMeal();
		const invalidate = vi.spyOn(client, "invalidateQueries");

		await userEvent.selectOptions(
			await screen.findByLabelText("餐別"),
			"dinner",
		);
		await userEvent.click(screen.getByRole("button", { name: "儲存" }));

		await waitFor(() =>
			expect(bodyOf(fetchMock, "PATCH", "/api/meals/5")).toEqual({
				meal_type: "dinner",
			}),
		);
		await waitFor(() =>
			expect(keysOf(invalidate)).toContainEqual(queryKeys.meals),
		);
		expect(keysOf(invalidate)).not.toContainEqual(queryKeys.expensesAll);
	});

	it("改金額：送 cost，失效花費", async () => {
		const fetchMock = mockApi(routes());
		const client = renderEditMeal();
		const invalidate = vi.spyOn(client, "invalidateQueries");

		const cost = await screen.findByLabelText("金額（選填）");
		await userEvent.clear(cost);
		await userEvent.type(cost, "200");
		await userEvent.click(screen.getByRole("button", { name: "儲存" }));

		await waitFor(() =>
			expect(bodyOf(fetchMock, "PATCH", "/api/meals/5")).toEqual({
				cost: "200",
			}),
		);
		await waitFor(() =>
			expect(keysOf(invalidate)).toContainEqual(queryKeys.expensesAll),
		);
	});

	it("清空金額：送 cost: null（拿掉餐費）", async () => {
		const fetchMock = mockApi(routes());
		renderEditMeal();

		await userEvent.clear(await screen.findByLabelText("金額（選填）"));
		await userEvent.click(screen.getByRole("button", { name: "儲存" }));

		await waitFor(() =>
			expect(bodyOf(fetchMock, "PATCH", "/api/meals/5")).toEqual({
				cost: null,
			}),
		);
	});

	it("沒改任何東西時不能按儲存", async () => {
		mockApi(routes());
		renderEditMeal();

		await screen.findByLabelText("餐別");
		expect(screen.getByRole("button", { name: "儲存" })).toBeDisabled();
	});

	it("金額格式錯誤：顯示金額專屬訊息", async () => {
		mockApi(
			routes(MEAL, [
				{
					method: "PATCH",
					path: "/api/meals/5",
					handler: () => validationError(["body", "cost"]),
				},
			]),
		);
		renderEditMeal();

		const cost = await screen.findByLabelText("金額（選填）");
		await userEvent.clear(cost);
		await userEvent.type(cost, "0");
		await userEvent.click(screen.getByRole("button", { name: "儲存" }));

		expect(await screen.findByText(AMOUNT_FORMAT_ERROR)).toBeInTheDocument();
	});

	it("金額被別的裝置改過（409）：顯示後端訊息、換成另一台存的金額、失效清單與花費", async () => {
		const message = "這一餐的金額剛被另一台裝置改過，請重新整理再試";
		let conflicted = false;
		const fetchMock = mockApi(
			routes(
				() => (conflicted ? { ...MEAL, cost: "220.00" } : MEAL),
				[
					{
						method: "PATCH",
						path: "/api/meals/5",
						handler: () => {
							conflicted = true;
							return json(
								{
									error: {
										code: "MEAL_COST_CONFLICT",
										message,
										details: {},
									},
								},
								409,
							);
						},
					},
				],
			),
		);
		const client = renderEditMeal();
		const invalidate = vi.spyOn(client, "invalidateQueries");

		const cost = await screen.findByLabelText("金額（選填）");
		await userEvent.clear(cost);
		await userEvent.type(cost, "200");
		await userEvent.click(screen.getByRole("button", { name: "儲存" }));

		expect(await screen.findByText(message)).toBeInTheDocument();
		await waitFor(() =>
			expect(calls(fetchMock, "GET", "/api/meals/5")).toHaveLength(2),
		);
		// 草稿「200」清掉，欄位顯示另一台存的值——不是使用者剛剛打的。
		await waitFor(() =>
			expect(screen.getByLabelText("金額（選填）")).toHaveValue("220.00"),
		);
		// 總覽的今日清單與報表的支出也要拿到另一台的金額。
		expect(keysOf(invalidate)).toContainEqual(queryKeys.meals);
		expect(keysOf(invalidate)).toContainEqual(queryKeys.expensesAll);
	});

	// 測試固定在台北時區跑（vite.config.ts 的 test.env.TZ）：下面寫死的值只在
	// 台北對，UTC 下用 getUTC* 或「…Z」寫錯會拿到另一個值。
	it("日期與時間預填這一餐在裝置時區的時刻", async () => {
		mockApi(routes({ ...MEAL, eaten_at: "2026-10-03T16:05:00Z" }));
		renderEditMeal();

		// UTC 還是 10/3，台北已經是 10/4 的 00:05。
		expect(await screen.findByLabelText("日期")).toHaveValue("2026-10-04");
		expect(screen.getByLabelText("時間")).toHaveValue("00:05");
	});

	it("只改日期：送出的 eaten_at 換成新日期、時間不變；之後失效統計、趨勢、支出", async () => {
		const fetchMock = mockApi(routes());
		const client = renderEditMeal();
		const invalidate = vi.spyOn(client, "invalidateQueries");

		const dateInput = await screen.findByLabelText("日期");
		await userEvent.clear(dateInput);
		await userEvent.type(dateInput, "2026-10-02");
		await userEvent.click(screen.getByRole("button", { name: "儲存" }));

		await waitFor(() =>
			expect(bodyOf(fetchMock, "PATCH", "/api/meals/5")).toEqual({
				// 台北 10/2 12:30＝UTC 04:30。
				eaten_at: "2026-10-02T04:30:00.000Z",
			}),
		);
		await waitFor(() => {
			const keys = keysOf(invalidate);
			expect(keys).toContainEqual(queryKeys.dailyStats);
			expect(keys).toContainEqual(queryKeys.rangeStatsAll);
			expect(keys).toContainEqual(queryKeys.expensesAll);
			// 「最近吃」依吃的時間排。
			expect(keys).toContainEqual(queryKeys.recentFoods);
		});
	});

	it("沒動日期與時間：PATCH 不帶 eaten_at", async () => {
		const fetchMock = mockApi(routes());
		renderEditMeal();

		await userEvent.selectOptions(
			await screen.findByLabelText("餐別"),
			"dinner",
		);
		await userEvent.click(screen.getByRole("button", { name: "儲存" }));

		await waitFor(() =>
			expect(bodyOf(fetchMock, "PATCH", "/api/meals/5")).toEqual({
				meal_type: "dinner",
			}),
		);
	});

	it("未來的時間：顯示訊息、不能儲存，硬送出（Enter）也不送", async () => {
		const fetchMock = mockApi(routes());
		renderEditMeal();

		const dateInput = await screen.findByLabelText("日期");
		await userEvent.clear(dateInput);
		await userEvent.type(dateInput, "2099-01-01");

		expect(await screen.findByText("不能選未來的時間")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "儲存" })).toBeDisabled();
		// disabled 的按鈕按不下去；表單本身還是能被送出（例如在欄位裡按 Enter）。
		fireEvent.submit(screen.getByRole("form", { name: "這一餐" }));
		await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
		expect(calls(fetchMock, "PATCH", "/api/meals/5")).toHaveLength(0);
	});

	it("今天稍晚的時間也是未來：比到分鐘，不是只比日期", async () => {
		// 只假 Date：userEvent 與 TanStack 的計時器照常跑。
		vi.useFakeTimers({ toFake: ["Date"] });
		// 台北 2026-10-04 14:00——這一餐是同一天的 12:30。
		vi.setSystemTime(new Date("2026-10-04T06:00:00Z"));
		try {
			const fetchMock = mockApi(routes());
			renderEditMeal();

			const timeInput = await screen.findByLabelText("時間");
			await userEvent.clear(timeInput);
			await userEvent.type(timeInput, "13:59");
			// 稍早一點的時間可以存：這支測試不是什麼都擋。
			expect(screen.queryByText("不能選未來的時間")).not.toBeInTheDocument();
			expect(screen.getByRole("button", { name: "儲存" })).toBeEnabled();

			await userEvent.clear(timeInput);
			await userEvent.type(timeInput, "14:01");

			expect(await screen.findByText("不能選未來的時間")).toBeInTheDocument();
			expect(screen.getByRole("button", { name: "儲存" })).toBeDisabled();
			fireEvent.submit(screen.getByRole("form", { name: "這一餐" }));
			await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
			expect(calls(fetchMock, "PATCH", "/api/meals/5")).toHaveLength(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it("2000 年以前：日期太早了，不能儲存", async () => {
		const fetchMock = mockApi(routes());
		renderEditMeal();

		const dateInput = await screen.findByLabelText("日期");
		expect(dateInput).toHaveAttribute("min", "2000-01-01");
		await userEvent.clear(dateInput);
		await userEvent.type(dateInput, "0002-10-04");

		expect(await screen.findByText("日期太早了")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "儲存" })).toBeDisabled();
		fireEvent.submit(screen.getByRole("form", { name: "這一餐" }));
		await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
		expect(calls(fetchMock, "PATCH", "/api/meals/5")).toHaveLength(0);
	});

	it("日期時間有問題：兩個欄位都標成無效，並指到那則訊息", async () => {
		mockApi(routes());
		renderEditMeal();

		const dateInput = await screen.findByLabelText("日期");
		const timeInput = screen.getByLabelText("時間");
		for (const input of [dateInput, timeInput]) {
			expect(input).not.toHaveAttribute("aria-invalid");
			expect(input).not.toHaveAttribute("aria-describedby");
		}

		await userEvent.clear(dateInput);
		await userEvent.type(dateInput, "2099-01-01");

		await screen.findByText("不能選未來的時間");
		for (const input of [dateInput, timeInput]) {
			expect(input).toHaveAttribute("aria-invalid", "true");
			expect(input).toHaveAccessibleDescription("不能選未來的時間");
		}
	});

	it("原本的時刻有秒數：日期改了又改回來，不算改了時間", async () => {
		// 台北 2026-10-04 12:30:45。比的是到分鐘的日期與時間，不是時刻——
		// 時刻比的話 12:30:00 ≠ 12:30:45，會多送一個 eaten_at 把秒數抹掉。
		const fetchMock = mockApi(
			routes({ ...MEAL, eaten_at: "2026-10-04T04:30:45Z" }),
		);
		renderEditMeal();

		const dateInput = await screen.findByLabelText("日期");
		await userEvent.clear(dateInput);
		await userEvent.type(dateInput, "2026-10-02");
		await userEvent.clear(dateInput);
		await userEvent.type(dateInput, "2026-10-04");
		await userEvent.selectOptions(screen.getByLabelText("餐別"), "dinner");
		await userEvent.click(screen.getByRole("button", { name: "儲存" }));

		await waitFor(() =>
			expect(bodyOf(fetchMock, "PATCH", "/api/meals/5")).toEqual({
				meal_type: "dinner",
			}),
		);
	});
});

describe("編輯這一餐：照片", () => {
	it("沒有照片：只有「加照片」，沒有刪除", async () => {
		mockApi(routes());
		renderEditMeal();

		expect(await screen.findByLabelText("加照片")).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "刪除照片" }),
		).not.toBeInTheDocument();
	});

	it("預覽要的是原圖，不是縮圖", async () => {
		const fetchMock = mockApi(routes({ ...MEAL, photo_path: "3/abc.jpg" }));
		renderEditMeal();

		await screen.findByRole("button", { name: "刪除照片" });
		await waitFor(() =>
			expect(
				fetchMock.mock.calls.some(([url]) =>
					String(url).endsWith("/api/meals/5/photo"),
				),
			).toBe(true),
		);
		expect(
			fetchMock.mock.calls.some(([url]) => String(url).includes("size=thumb")),
		).toBe(false);
	});

	it("確認框打開時焦點在「取消」；取消後回到「刪除照片」", async () => {
		mockApi(routes({ ...MEAL, photo_path: "3/abc.jpg" }));
		renderEditMeal();

		await userEvent.click(
			await screen.findByRole("button", { name: "刪除照片" }),
		);
		const dialog = screen.getByRole("alertdialog", { name: "確認刪除照片" });
		const cancel = within(dialog).getByRole("button", { name: "取消" });
		expect(cancel).toHaveFocus();
		await userEvent.click(cancel);

		expect(screen.getByRole("button", { name: "刪除照片" })).toHaveFocus();
	});

	it("刪除照片要先確認；取消就不送", async () => {
		const fetchMock = mockApi(
			routes({ ...MEAL, photo_path: "3/abc.jpg" }, [
				{
					method: "DELETE",
					path: "/api/meals/5/photo",
					handler: () => new Response(null, { status: 204 }),
				},
			]),
		);
		renderEditMeal();

		await userEvent.click(
			await screen.findByRole("button", { name: "刪除照片" }),
		);
		const dialog = screen.getByRole("alertdialog", { name: "確認刪除照片" });
		await userEvent.click(within(dialog).getByRole("button", { name: "取消" }));

		expect(calls(fetchMock, "DELETE", "/api/meals/5/photo")).toHaveLength(0);
	});

	it("確認刪除照片：送 DELETE，失效清單、移除這一餐的照片快取", async () => {
		let current: Record<string, unknown> = {
			...MEAL,
			photo_path: "3/abc.jpg",
		};
		const fetchMock = mockApi(
			routes(
				() => current,
				[
					{
						method: "DELETE",
						path: "/api/meals/5/photo",
						handler: () => {
							current = { ...MEAL, photo_path: null };
							return new Response(null, { status: 204 });
						},
					},
				],
			),
		);
		const client = renderEditMeal();
		const invalidate = vi.spyOn(client, "invalidateQueries");
		const remove = vi.spyOn(client, "removeQueries");

		expect(await screen.findByLabelText("換照片")).toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: "刪除照片" }));
		const dialog = screen.getByRole("alertdialog", { name: "確認刪除照片" });
		await userEvent.click(
			within(dialog).getByRole("button", { name: "確定刪除" }),
		);

		await waitFor(() =>
			expect(calls(fetchMock, "DELETE", "/api/meals/5/photo")).toHaveLength(1),
		);
		await waitFor(() =>
			expect(keysOf(invalidate)).toContainEqual(queryKeys.meals),
		);
		await waitFor(() =>
			expect(keysOf(remove)).toContainEqual(queryKeys.mealPhoto(5)),
		);
	});

	it("刪除照片之後不再回頭抓那張照片", async () => {
		let current: Record<string, unknown> = {
			...MEAL,
			photo_path: "3/abc.jpg",
		};
		const fetchMock = mockApi(
			routes(
				() => current,
				[
					{
						method: "DELETE",
						path: "/api/meals/5/photo",
						handler: () => {
							current = { ...MEAL, photo_path: null };
							return new Response(null, { status: 204 });
						},
					},
				],
			),
		);
		renderEditMeal();

		await userEvent.click(
			await screen.findByRole("button", { name: "刪除照片" }),
		);
		const dialog = screen.getByRole("alertdialog", { name: "確認刪除照片" });
		await userEvent.click(
			within(dialog).getByRole("button", { name: "確定刪除" }),
		);

		await waitFor(() =>
			expect(
				screen.queryByRole("button", { name: "刪除照片" }),
			).not.toBeInTheDocument(),
		);
		expect(
			fetchMock.mock.calls.filter(
				([input, init]) =>
					(init?.method ?? "GET").toUpperCase() === "GET" &&
					String(input).endsWith("/api/meals/5/photo"),
			),
		).toHaveLength(1);
	});
});

describe("編輯這一餐：刪除這一餐", () => {
	it("有餐費時，確認文字寫出餐費也會一起刪；取消就不送", async () => {
		const fetchMock = mockApi(routes());
		renderEditMeal();

		await userEvent.click(
			await screen.findByRole("button", { name: "刪除這一餐" }),
		);
		const dialog = screen.getByRole("alertdialog", { name: "確認刪除這一餐" });
		expect(dialog).toHaveTextContent("這一餐的餐費 $180.00 也會一起刪除");
		await userEvent.click(within(dialog).getByRole("button", { name: "取消" }));

		expect(calls(fetchMock, "DELETE", "/api/meals/5")).toHaveLength(0);
	});

	it("確認框打開時焦點在「取消」；取消後回到「刪除這一餐」", async () => {
		mockApi(routes());
		renderEditMeal();

		await userEvent.click(
			await screen.findByRole("button", { name: "刪除這一餐" }),
		);
		const dialog = screen.getByRole("alertdialog", { name: "確認刪除這一餐" });
		const cancel = within(dialog).getByRole("button", { name: "取消" });
		expect(cancel).toHaveFocus();
		await userEvent.click(cancel);

		expect(screen.getByRole("button", { name: "刪除這一餐" })).toHaveFocus();
	});

	it("沒有餐費時，確認文字不提餐費", async () => {
		mockApi(routes({ ...MEAL, cost: null }));
		renderEditMeal();

		await userEvent.click(
			await screen.findByRole("button", { name: "刪除這一餐" }),
		);
		expect(
			screen.getByRole("alertdialog", { name: "確認刪除這一餐" }),
		).not.toHaveTextContent("餐費");
	});

	it("確認刪除：送 DELETE、移除這一餐的快取、失效相關的一切、回上一頁", async () => {
		const fetchMock = mockApi(routes());
		const client = renderEditMeal();
		const invalidate = vi.spyOn(client, "invalidateQueries");
		const remove = vi.spyOn(client, "removeQueries");

		await userEvent.click(
			await screen.findByRole("button", { name: "刪除這一餐" }),
		);
		const dialog = screen.getByRole("alertdialog", { name: "確認刪除這一餐" });
		await userEvent.click(
			within(dialog).getByRole("button", { name: "確定刪除" }),
		);

		expect(await screen.findByText("飲食頁")).toBeInTheDocument();
		expect(calls(fetchMock, "DELETE", "/api/meals/5")).toHaveLength(1);
		expect(keysOf(remove)).toEqual(
			expect.arrayContaining([queryKeys.meal(5), queryKeys.mealPhoto(5)]),
		);
		expect(keysOf(invalidate)).toEqual(
			expect.arrayContaining([
				queryKeys.meals,
				queryKeys.dailyStats,
				queryKeys.rangeStatsAll,
				queryKeys.frequentFoods,
				queryKeys.recentFoods,
				queryKeys.expensesAll,
			]),
		);
		// 已經回到總覽頁（EditMeal 卸載了）才數：刪掉之後沒有人再去抓
		// 那一餐（會是一個 404）。
		expect(calls(fetchMock, "GET", "/api/meals/5")).toHaveLength(1);
	});

	it("直接打開網址（沒有上一頁）時，刪完回總覽", async () => {
		mockApi(routes());
		renderEditMeal(newClient(), ["/meals/5/edit"]);

		await userEvent.click(
			await screen.findByRole("button", { name: "刪除這一餐" }),
		);
		const dialog = screen.getByRole("alertdialog", { name: "確認刪除這一餐" });
		await userEvent.click(
			within(dialog).getByRole("button", { name: "確定刪除" }),
		);

		expect(await screen.findByText("總覽頁")).toBeInTheDocument();
	});

	it("✕ 回上一頁", async () => {
		mockApi(routes());
		renderEditMeal();

		await userEvent.click(await screen.findByRole("button", { name: "關閉" }));

		expect(await screen.findByText("飲食頁")).toBeInTheDocument();
	});
});

describe("編輯這一餐：草稿只記動過的欄位", () => {
	it("改了日期與時間、存好之後：兩個欄位跟著伺服器，之後的重抓也跟", async () => {
		let current: typeof MEAL = MEAL;
		mockApi(
			routes(
				() => current,
				[
					{
						method: "PATCH",
						path: "/api/meals/5",
						handler: () => {
							// 台北 10/2 13:45。
							current = { ...MEAL, eaten_at: "2026-10-02T05:45:00Z" };
							return json(current);
						},
					},
				],
			),
		);
		const client = renderEditMeal();

		const dateInput = await screen.findByLabelText("日期");
		const timeInput = screen.getByLabelText("時間");
		await userEvent.clear(dateInput);
		await userEvent.type(dateInput, "2026-10-02");
		await userEvent.clear(timeInput);
		await userEvent.type(timeInput, "13:45");
		await userEvent.click(screen.getByRole("button", { name: "儲存" }));

		expect(await screen.findByText("已儲存")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "儲存" })).toBeDisabled();

		// 另一台裝置又改了時間（台北 10/1 09:15）：草稿清掉了才會跟。
		current = { ...MEAL, eaten_at: "2026-10-01T01:15:00Z" };
		await client.invalidateQueries({ queryKey: queryKeys.meal(5) });

		await waitFor(() => expect(dateInput).toHaveValue("2026-10-01"));
		expect(timeInput).toHaveValue("09:15");
		expect(screen.getByRole("button", { name: "儲存" })).toBeDisabled();
	});

	it("存好之後表單顯示伺服器的值、儲存回到 disabled", async () => {
		let current: typeof MEAL = MEAL;
		mockApi(
			routes(
				() => current,
				[
					{
						method: "PATCH",
						path: "/api/meals/5",
						handler: () => {
							current = { ...MEAL, cost: "200.00" };
							return json(current);
						},
					},
				],
			),
		);
		renderEditMeal();

		const cost = await screen.findByLabelText("金額（選填）");
		await userEvent.clear(cost);
		await userEvent.type(cost, "200");
		await userEvent.click(screen.getByRole("button", { name: "儲存" }));

		expect(await screen.findByText("已儲存")).toBeInTheDocument();
		await waitFor(() =>
			expect(screen.getByLabelText("金額（選填）")).toHaveValue("200.00"),
		);
		expect(screen.getByRole("button", { name: "儲存" })).toBeDisabled();
	});

	it("存好之後直接用 PATCH 的回應更新表單，不等重抓、不閃回舊值", async () => {
		const updated = { ...MEAL, cost: "200.00" };
		const fetchMock = mockApi(
			routes(MEAL, [
				{ method: "PATCH", path: "/api/meals/5", handler: () => json(updated) },
			]),
		);
		// 存好之後的重抓（invalidate）刻意卡住：慢速連線上，重抓回來之前使用者
		// 看到的就是快取裡的值。沒有用回應更新快取的話，那會是舊的 180.00。
		const real = fetchMock.getMockImplementation();
		let patched = false;
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		fetchMock.mockImplementation(async (input, init) => {
			const method = (init?.method ?? "GET").toUpperCase();
			if (method === "PATCH") patched = true;
			if (
				method === "GET" &&
				patched &&
				String(input).endsWith("/api/meals/5")
			) {
				await gate;
			}
			return real === undefined ? fetch(input, init) : real(input, init);
		});
		renderEditMeal();

		const cost = await screen.findByLabelText("金額（選填）");
		await userEvent.clear(cost);
		await userEvent.type(cost, "200");
		await userEvent.click(screen.getByRole("button", { name: "儲存" }));

		expect(await screen.findByText("已儲存")).toBeInTheDocument();
		expect(screen.getByLabelText("金額（選填）")).toHaveValue("200.00");
		release();
	});

	it("另一台裝置改了餐別：沒動過的欄位跟著伺服器，不會變成「有改動」", async () => {
		let current: typeof MEAL = MEAL;
		mockApi(routes(() => current));
		const client = renderEditMeal();

		expect(await screen.findByLabelText("餐別")).toHaveValue("lunch");
		current = { ...MEAL, meal_type: "dinner" };
		await client.invalidateQueries({ queryKey: queryKeys.meal(5) });

		await waitFor(() =>
			expect(screen.getByLabelText("餐別")).toHaveValue("dinner"),
		);
		expect(screen.getByRole("button", { name: "儲存" })).toBeDisabled();
	});

	it("只動備註、伺服器同時改了餐別：PATCH 只有 note", async () => {
		let current: typeof MEAL = MEAL;
		const fetchMock = mockApi(routes(() => current));
		const client = renderEditMeal();

		const note = await screen.findByLabelText("備註（選填）");
		await userEvent.type(note, "加蛋");
		current = { ...MEAL, meal_type: "dinner" };
		await client.invalidateQueries({ queryKey: queryKeys.meal(5) });
		await waitFor(() =>
			expect(screen.getByLabelText("餐別")).toHaveValue("dinner"),
		);
		await userEvent.click(screen.getByRole("button", { name: "儲存" }));

		await waitFor(() =>
			expect(bodyOf(fetchMock, "PATCH", "/api/meals/5")).toEqual({
				note: "加蛋",
			}),
		);
	});

	it("備註：清空既有的備註送 note: null", async () => {
		const fetchMock = mockApi(routes({ ...MEAL, note: "原本的備註" }));
		renderEditMeal();

		const note = await screen.findByLabelText("備註（選填）");
		expect(note).toHaveValue("原本的備註");
		await userEvent.clear(note);
		await userEvent.click(screen.getByRole("button", { name: "儲存" }));

		await waitFor(() =>
			expect(bodyOf(fetchMock, "PATCH", "/api/meals/5")).toEqual({
				note: null,
			}),
		);
	});

	it("備註：輸入新的備註送 note", async () => {
		const fetchMock = mockApi(routes());
		renderEditMeal();

		await userEvent.type(await screen.findByLabelText("備註（選填）"), "加蛋");
		await userEvent.click(screen.getByRole("button", { name: "儲存" }));

		await waitFor(() =>
			expect(bodyOf(fetchMock, "PATCH", "/api/meals/5")).toEqual({
				note: "加蛋",
			}),
		);
	});

	it("描述：顯示伺服器的值；改了只送 description", async () => {
		const fetchMock = mockApi(
			routes({ ...MEAL, description: "原本的描述", note: "原本的備註" }),
		);
		renderEditMeal();

		const field = await screen.findByLabelText("描述（選填）");
		expect(field).toHaveValue("原本的描述");
		// 兩格各顯示各的。
		expect(screen.getByLabelText("備註（選填）")).toHaveValue("原本的備註");
		await userEvent.clear(field);
		await userEvent.type(field, "  改過的描述  ");
		await userEvent.click(screen.getByRole("button", { name: "儲存" }));

		await waitFor(() =>
			expect(bodyOf(fetchMock, "PATCH", "/api/meals/5")).toEqual({
				description: "改過的描述",
			}),
		);
	});

	it("描述：清空既有的描述送 description: null", async () => {
		const fetchMock = mockApi(routes({ ...MEAL, description: "原本的描述" }));
		renderEditMeal();

		const field = await screen.findByLabelText("描述（選填）");
		await userEvent.clear(field);
		await userEvent.click(screen.getByRole("button", { name: "儲存" }));

		await waitFor(() =>
			expect(bodyOf(fetchMock, "PATCH", "/api/meals/5")).toEqual({
				description: null,
			}),
		);
	});

	it("描述：沒動它、只改備註時不送 description", async () => {
		const fetchMock = mockApi(routes({ ...MEAL, description: "原本的描述" }));
		renderEditMeal();

		await userEvent.type(await screen.findByLabelText("備註（選填）"), "加蛋");
		await userEvent.click(screen.getByRole("button", { name: "儲存" }));

		await waitFor(() =>
			expect(bodyOf(fetchMock, "PATCH", "/api/meals/5")).toEqual({
				note: "加蛋",
			}),
		);
	});

	it("描述：舊快取裡的餐沒有 description 這個欄位——欄位是空的，「儲存」不能按", async () => {
		mockApi(routes());
		renderEditMeal();

		const field = await screen.findByLabelText("描述（選填）");
		expect(field).toHaveValue("");
		expect(screen.getByRole("button", { name: "儲存" })).toBeDisabled();
		// `?? ""` 讓這個欄位從頭到尾都是受控的。少了它，舊快取的 undefined 讓 React 先把
		// 它當成非受控（畫面上一樣是空的，上面兩行看不出來），打第一個字才警告
		// 「uncontrolled → controlled」。
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		await userEvent.type(field, "新");
		expect(field).toHaveValue("新");
		expect(errors).not.toHaveBeenCalled();
	});

	it("描述與備註各有一句說明：誰看得到", async () => {
		mockApi(routes());
		renderEditMeal();

		expect(
			await screen.findByLabelText("描述（選填）"),
		).toHaveAccessibleDescription("好友看得到這段描述");
		expect(screen.getByLabelText("備註（選填）")).toHaveAccessibleDescription(
			"備註只有自己看得到",
		);
	});

	it.each([
		["非金額欄位的 422", () => validationError(["body", "note"])],
		[
			"500",
			() => json({ error: { code: "X", message: "x", details: {} } }, 500),
		],
	])("儲存失敗（%s）：說儲存失敗，不說金額格式", async (_name, failure) => {
		mockApi(
			routes(MEAL, [
				{ method: "PATCH", path: "/api/meals/5", handler: failure },
			]),
		);
		renderEditMeal();

		await userEvent.type(await screen.findByLabelText("備註（選填）"), "x");
		await userEvent.click(screen.getByRole("button", { name: "儲存" }));

		expect(await screen.findByText("儲存失敗，請再試一次")).toBeInTheDocument();
		expect(screen.queryByText(AMOUNT_FORMAT_ERROR)).not.toBeInTheDocument();
	});
});

describe("編輯這一餐：其他", () => {
	// 跟餐點頁同一個 `parseResourceId`（社群審查 M6）。以前這裡只擋「不是數字」：
	// `Number("1.5")`、`Number("-3")`、`Number("")`、太長的數字都是「數字」，照樣去問，
	// 後端回 422——不是 404，所以重試三次（約 7 秒）之後是「無法載入這一餐」。
	it.each([
		"abc",
		"0",
		"1.5",
		"-3",
		"9223372036854775808",
		"9007199254740993",
		"99999999999999999999999999",
	])(
		"網址的 id 不是一餐的 id（%s）：說找不到，也不打 /api/meals",
		async (id) => {
			const fetchMock = mockApi(routes());
			const client = newClient();
			render(
				<QueryClientProvider client={client}>
					<MemoryRouter initialEntries={[`/meals/${id}/edit`]}>
						<Routes>
							<Route path="/meals/:id/edit" element={<EditMeal />} />
						</Routes>
					</MemoryRouter>
				</QueryClientProvider>,
			);

			expect(await screen.findByText("找不到這一餐")).toBeInTheDocument();
			// 等一下再看：請求是掛載之後才送的。
			await new Promise((resolve) => setTimeout(resolve, 30));
			expect(calls(fetchMock, "GET", "/api/meals")).toHaveLength(0);
			expect(screen.getByText("找不到這一餐")).toBeInTheDocument();
		},
	);

	it("上傳照片進行中顯示「上傳中…」", async () => {
		const fetchMock = mockApi(routes());
		const real = fetchMock.getMockImplementation();
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		fetchMock.mockImplementation(async (input, init) => {
			if (
				(init?.method ?? "GET").toUpperCase() === "POST" &&
				String(input).includes("/api/meals/5/photo")
			) {
				await gate;
				return json(MEAL);
			}
			return real === undefined ? fetch(input, init) : real(input, init);
		});
		renderEditMeal();

		await userEvent.upload(
			await screen.findByLabelText("加照片"),
			new File(["x"], "a.jpg", { type: "image/jpeg" }),
		);

		expect(await screen.findByText("上傳中…")).toBeInTheDocument();
		release();
	});
});

describe("編輯這一餐：項目", () => {
	/** 這一項的份量清單有一個公開的預設份量「碗」。 */
	function itemRoutes(
		patch: () => Response = () => json(MEAL),
		remove: () => Response = () => new Response(null, { status: 204 }),
	) {
		return routes(MEAL, [
			{ method: "PATCH", path: "/api/meals/5/items/51", handler: patch },
			{ method: "DELETE", path: "/api/meals/5/items/51", handler: remove },
			{ path: "/api/foods/1/portions", handler: () => json([BOWL]) },
		]);
	}

	async function openEditor() {
		await userEvent.click(
			await screen.findByRole("button", { name: "修改滷肉飯" }),
		);
		const editor = screen.getByRole("form", { name: "修改滷肉飯" });
		await within(editor).findByRole("option", { name: "碗" });
		return editor;
	}

	it("改數量：帶入目前的值、預設份量不蓋掉它，PATCH 帶 quantity 與 portion_id", async () => {
		const fetchMock = mockApi(itemRoutes());
		const client = renderEditMeal();
		const invalidate = vi.spyOn(client, "invalidateQueries");

		const editor = await openEditor();
		// 這一項當初是「直接輸入 200 g」：食物後來才有的預設份量「碗」
		// 不能把它變成 200 碗。
		expect(within(editor).getByLabelText("份量選項")).toHaveValue("");
		const quantity = within(editor).getByLabelText("份量");
		expect(quantity).toHaveValue("200");
		await userEvent.clear(quantity);
		await userEvent.type(quantity, "250");
		await userEvent.click(within(editor).getByRole("button", { name: "儲存" }));

		await waitFor(() =>
			expect(bodyOf(fetchMock, "PATCH", "/api/meals/5/items/51")).toEqual({
				quantity: "250",
				portion_id: null,
			}),
		);
		await waitFor(() =>
			expect(keysOf(invalidate)).toEqual(
				expect.arrayContaining([
					queryKeys.meals,
					queryKeys.dailyStats,
					queryKeys.rangeStatsAll,
					queryKeys.frequentFoods,
					queryKeys.recentFoods,
				]),
			),
		);
		// 改項目不動餐費。
		expect(keysOf(invalidate)).not.toContainEqual(queryKeys.expensesAll);
		// 存好就收起來。
		await waitFor(() =>
			expect(
				screen.queryByRole("form", { name: "修改滷肉飯" }),
			).not.toBeInTheDocument(),
		);
	});

	it("改成某個份量：送那個份量的 id", async () => {
		const fetchMock = mockApi(itemRoutes());
		renderEditMeal();

		const editor = await openEditor();
		await userEvent.selectOptions(
			within(editor).getByLabelText("份量選項"),
			"8",
		);
		const quantity = within(editor).getByLabelText("份量");
		await userEvent.clear(quantity);
		await userEvent.type(quantity, "1");
		await userEvent.click(within(editor).getByRole("button", { name: "儲存" }));

		await waitFor(() =>
			expect(bodyOf(fetchMock, "PATCH", "/api/meals/5/items/51")).toEqual({
				quantity: "1",
				portion_id: 8,
			}),
		);
	});

	it("原本用份量記的一項：帶入那個份量與份數", async () => {
		mockApi(
			routes(
				{
					...MEAL,
					items: [{ ...ITEM, portion_id: 9, quantity: "1.50" }],
				},
				[
					{
						path: "/api/foods/1/portions",
						handler: () => json([BOWL, SMALL_BOWL]),
					},
				],
			),
		);
		renderEditMeal();

		const editor = await openEditor();
		// 不是預設的 8：那一項記的是「小碗」。
		expect(within(editor).getByLabelText("份量選項")).toHaveValue("9");
		expect(within(editor).getByLabelText("份量")).toHaveValue("1.5");
	});

	it("份量不屬於這個食物：說清楚", async () => {
		mockApi(itemRoutes(portionMismatch));
		renderEditMeal();

		const editor = await openEditor();
		await userEvent.click(within(editor).getByRole("button", { name: "儲存" }));

		expect(
			await within(editor).findByText("這個份量不屬於這個食物"),
		).toBeInTheDocument();
	});

	it("數量格式錯誤：指到數量，不說成金額錯誤", async () => {
		mockApi(itemRoutes(() => validationError(["body", "quantity"])));
		renderEditMeal();

		const editor = await openEditor();
		await userEvent.click(within(editor).getByRole("button", { name: "儲存" }));

		expect(
			await within(editor).findByText(
				"數量要大於 0、不超過 10000，最多兩位小數",
			),
		).toBeInTheDocument();
		expect(screen.queryByText(AMOUNT_FORMAT_ERROR)).not.toBeInTheDocument();
	});

	it("放棄：收起來，不送", async () => {
		const fetchMock = mockApi(itemRoutes());
		renderEditMeal();

		const editor = await openEditor();
		await userEvent.click(within(editor).getByRole("button", { name: "放棄" }));

		expect(
			screen.queryByRole("form", { name: "修改滷肉飯" }),
		).not.toBeInTheDocument();
		expect(calls(fetchMock, "PATCH", "/api/meals/5/items/51")).toHaveLength(0);
	});

	it("同一時間只開一個編輯器：打開「加一項」就收起正在改的那一項", async () => {
		mockApi(itemRoutes());
		renderEditMeal();

		await openEditor();
		await userEvent.click(screen.getByRole("button", { name: "＋ 加一項" }));

		expect(
			screen.queryByRole("form", { name: "修改滷肉飯" }),
		).not.toBeInTheDocument();
		expect(screen.getByLabelText("搜尋食物")).toBeInTheDocument();
	});

	it("刪除一項的確認框打開時焦點在「取消」；取消後回到這一項的「刪除」", async () => {
		mockApi(itemRoutes());
		renderEditMeal();

		await userEvent.click(
			await screen.findByRole("button", { name: "刪除滷肉飯" }),
		);
		const dialog = screen.getByRole("alertdialog", { name: "確認刪除滷肉飯" });
		const cancel = within(dialog).getByRole("button", { name: "取消" });
		expect(cancel).toHaveFocus();
		await userEvent.click(cancel);

		expect(screen.getByRole("button", { name: "刪除滷肉飯" })).toHaveFocus();
	});

	it("刪除一項要先確認；取消就不送", async () => {
		const fetchMock = mockApi(itemRoutes());
		renderEditMeal();

		await userEvent.click(
			await screen.findByRole("button", { name: "刪除滷肉飯" }),
		);
		const dialog = screen.getByRole("alertdialog", { name: "確認刪除滷肉飯" });
		await userEvent.click(within(dialog).getByRole("button", { name: "取消" }));

		expect(calls(fetchMock, "DELETE", "/api/meals/5/items/51")).toHaveLength(0);
	});

	it("確認刪除一項：送 DELETE，失效營養素相關的 query", async () => {
		const fetchMock = mockApi(itemRoutes());
		const client = renderEditMeal();
		const invalidate = vi.spyOn(client, "invalidateQueries");

		await userEvent.click(
			await screen.findByRole("button", { name: "刪除滷肉飯" }),
		);
		const dialog = screen.getByRole("alertdialog", { name: "確認刪除滷肉飯" });
		await userEvent.click(
			within(dialog).getByRole("button", { name: "確定刪除" }),
		);

		await waitFor(() =>
			expect(calls(fetchMock, "DELETE", "/api/meals/5/items/51")).toHaveLength(
				1,
			),
		);
		await waitFor(() =>
			expect(keysOf(invalidate)).toEqual(
				expect.arrayContaining([
					queryKeys.meals,
					queryKeys.dailyStats,
					queryKeys.rangeStatsAll,
					queryKeys.frequentFoods,
					queryKeys.recentFoods,
				]),
			),
		);
		expect(keysOf(invalidate)).not.toContainEqual(queryKeys.expensesAll);
	});

	it("加一項：選食物、填數量，POST 到這一餐", async () => {
		const fetchMock = mockApi(
			routes(MEAL, [
				{
					method: "POST",
					path: "/api/meals/5/items",
					handler: () => json(MEAL, 201),
				},
				{ path: "/api/foods/frequent", handler: () => json([WHITE_RICE]) },
				{ path: "/api/foods/3/portions", handler: () => json([]) },
			]),
		);
		const client = renderEditMeal();
		const invalidate = vi.spyOn(client, "invalidateQueries");

		await userEvent.click(
			await screen.findByRole("button", { name: "＋ 加一項" }),
		);
		// 「加一項」也有 AI 估算（AI 與編輯畫面的收尾規格 §2 第 1 項）。
		expect(screen.getByLabelText("搜尋食物")).toBeInTheDocument();
		expect(screen.getByLabelText("拍照估算")).toBeInTheDocument();
		await userEvent.click(await screen.findByRole("button", { name: "白飯" }));
		const form = screen.getByRole("form", { name: "加一項" });
		// 焦點移到「已選擇」（同記一餐）：份量欄位就在它下面。
		expect(within(form).getByText("已選擇：白飯")).toHaveFocus();
		const quantity = within(form).getByLabelText("份量");
		await userEvent.clear(quantity);
		await userEvent.type(quantity, "150");
		await userEvent.click(within(form).getByRole("button", { name: "加入" }));

		await waitFor(() =>
			expect(bodyOf(fetchMock, "POST", "/api/meals/5/items")).toEqual({
				food_id: 3,
				quantity: "150",
			}),
		);
		await waitFor(() =>
			expect(keysOf(invalidate)).toContainEqual(queryKeys.dailyStats),
		);
	});

	it("存檔還在送的時候改開「加一項」：存好不會把加一項關掉", async () => {
		const fetchMock = mockApi(itemRoutes());
		const real = fetchMock.getMockImplementation();
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		fetchMock.mockImplementation(async (input, init) => {
			if (
				(init?.method ?? "GET").toUpperCase() === "PATCH" &&
				String(input).includes("/api/meals/5/items/51")
			) {
				await gate;
			}
			return real === undefined ? fetch(input, init) : real(input, init);
		});
		renderEditMeal();

		const editor = await openEditor();
		await userEvent.click(within(editor).getByRole("button", { name: "儲存" }));
		await waitFor(() =>
			expect(calls(fetchMock, "PATCH", "/api/meals/5/items/51")).toHaveLength(
				1,
			),
		);
		await userEvent.click(screen.getByRole("button", { name: "＋ 加一項" }));
		release();

		// PATCH 回來並處理完之後再看：加一項的表單還在。
		await waitFor(() =>
			expect(
				screen.queryByRole("form", { name: "修改滷肉飯" }),
			).not.toBeInTheDocument(),
		);
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(screen.getByLabelText("搜尋食物")).toBeInTheDocument();
	});

	it("食物的份量被刪掉了（portion_id 是 NULL）：帶入公克數，不是份數", async () => {
		mockApi(
			routes(
				{
					...MEAL,
					items: [
						{
							...ITEM,
							portion_id: null,
							quantity: "1.50",
							quantity_g: "225.00",
						},
					],
				},
				[{ path: "/api/foods/1/portions", handler: () => json([BOWL]) }],
			),
		);
		renderEditMeal();

		const editor = await openEditor();
		expect(within(editor).getByLabelText("份量")).toHaveValue("225");
	});

	it("開著刪除確認時打開「加一項」：確認收起來", async () => {
		mockApi(itemRoutes());
		renderEditMeal();

		await userEvent.click(
			await screen.findByRole("button", { name: "刪除滷肉飯" }),
		);
		expect(
			screen.getByRole("alertdialog", { name: "確認刪除滷肉飯" }),
		).toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: "＋ 加一項" }));

		expect(
			screen.queryByRole("alertdialog", { name: "確認刪除滷肉飯" }),
		).not.toBeInTheDocument();
		expect(screen.getByLabelText("搜尋食物")).toBeInTheDocument();
		// 不是按「取消」收起來的：焦點不搶回「刪除」。
		expect(
			screen.getByRole("button", { name: "刪除滷肉飯" }),
		).not.toHaveFocus();
	});

	it("開著刪除確認時，這一列的修改與刪除按鈕先藏起來", async () => {
		mockApi(itemRoutes());
		renderEditMeal();

		await userEvent.click(
			await screen.findByRole("button", { name: "刪除滷肉飯" }),
		);

		expect(
			screen.queryByRole("button", { name: "修改滷肉飯" }),
		).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "刪除滷肉飯" }),
		).not.toBeInTheDocument();
	});

	it("刪除時這一項已經在別的裝置刪掉了（404）：當作成功，不顯示錯誤", async () => {
		const fetchMock = mockApi(itemRoutes(undefined, itemNotFound));
		const client = renderEditMeal();
		const invalidate = vi.spyOn(client, "invalidateQueries");

		await userEvent.click(
			await screen.findByRole("button", { name: "刪除滷肉飯" }),
		);
		const dialog = screen.getByRole("alertdialog", { name: "確認刪除滷肉飯" });
		await userEvent.click(
			within(dialog).getByRole("button", { name: "確定刪除" }),
		);

		await waitFor(() =>
			expect(keysOf(invalidate)).toContainEqual(queryKeys.meals),
		);
		expect(calls(fetchMock, "DELETE", "/api/meals/5/items/51")).toHaveLength(1);
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
	});

	it("改的時候這一項已經不在了（404）：說明，並重抓這一餐", async () => {
		mockApi(itemRoutes(itemNotFound));
		const client = renderEditMeal();
		const invalidate = vi.spyOn(client, "invalidateQueries");

		const editor = await openEditor();
		await userEvent.click(within(editor).getByRole("button", { name: "儲存" }));

		expect(
			await within(editor).findByText(
				"這一項已經不在了（可能在別的裝置刪掉了）",
			),
		).toBeInTheDocument();
		expect(keysOf(invalidate)).toContainEqual(queryKeys.meals);
	});

	it("換算後的公克數超出範圍（422）：顯示後端訊息，不是通用的儲存失敗", async () => {
		mockApi(itemRoutes(quantityOutOfRange));
		renderEditMeal();

		const editor = await openEditor();
		await userEvent.click(within(editor).getByRole("button", { name: "儲存" }));

		expect(
			await within(editor).findByText(
				"換算後的公克數超出範圍（0.01 到 999,999.99 g），請改數量",
			),
		).toBeInTheDocument();
		expect(
			within(editor).queryByText("儲存失敗，請再試一次"),
		).not.toBeInTheDocument();
	});

	it("非數量欄位的 422：說儲存失敗，不說成數量錯誤", async () => {
		mockApi(itemRoutes(() => validationError(["body", "portion_id"])));
		renderEditMeal();

		const editor = await openEditor();
		await userEvent.click(within(editor).getByRole("button", { name: "儲存" }));

		expect(
			await within(editor).findByText("儲存失敗，請再試一次"),
		).toBeInTheDocument();
		expect(
			within(editor).queryByText("數量要大於 0、不超過 10000，最多兩位小數"),
		).not.toBeInTheDocument();
	});

	it("改完用回應更新這一餐的快取（不等重抓）", async () => {
		const updated = {
			...MEAL,
			items: [{ ...ITEM, quantity: "250.00", quantity_g: "250.00" }],
		};
		const fetchMock = mockApi(itemRoutes(() => json(updated)));
		// 存好之後的重抓卡住：快取裡的值只可能來自 PATCH 的回應。
		const real = fetchMock.getMockImplementation();
		let patched = false;
		fetchMock.mockImplementation(async (input, init) => {
			const method = (init?.method ?? "GET").toUpperCase();
			if (method === "PATCH") patched = true;
			if (
				method === "GET" &&
				patched &&
				String(input).endsWith("/api/meals/5")
			) {
				return new Promise<Response>(() => {});
			}
			return real === undefined ? fetch(input, init) : real(input, init);
		});
		const client = renderEditMeal();

		const editor = await openEditor();
		const quantity = within(editor).getByLabelText("份量");
		await userEvent.clear(quantity);
		await userEvent.type(quantity, "250");
		await userEvent.click(within(editor).getByRole("button", { name: "儲存" }));

		await waitFor(() =>
			expect(client.getQueryData(queryKeys.meal(5))).toEqual(updated),
		);
	});

	it("加一項：食物有預設份量時，送預設份量的 id 與 quantity 1", async () => {
		const fetchMock = mockApi(
			routes(MEAL, [
				{
					method: "POST",
					path: "/api/meals/5/items",
					handler: () => json(MEAL, 201),
				},
				{ path: "/api/foods/frequent", handler: () => json([WHITE_RICE]) },
				{ path: "/api/foods/3/portions", handler: () => json([BOWL]) },
			]),
		);
		renderEditMeal();

		await userEvent.click(
			await screen.findByRole("button", { name: "＋ 加一項" }),
		);
		await userEvent.click(await screen.findByRole("button", { name: "白飯" }));
		const form = screen.getByRole("form", { name: "加一項" });
		await within(form).findByRole("option", { name: "碗" });
		await userEvent.click(within(form).getByRole("button", { name: "加入" }));

		await waitFor(() =>
			expect(bodyOf(fetchMock, "POST", "/api/meals/5/items")).toEqual({
				food_id: 3,
				quantity: "1",
				portion_id: 8,
			}),
		);
	});

	describe("加一項：AI 估算", () => {
		const ESTIMATE = {
			analysis_id: 12,
			food_id: null,
			name: "牛肉麵",
			brand: null,
			nutrition: {
				base_unit: "g",
				serving_grams: "550.00",
				kcal: "112.73",
				protein_g: "5.82",
				fat_g: "3.27",
				carb_g: "14.55",
				serving_kcal: "620.00",
				serving_protein_g: "32.00",
				serving_fat_g: "18.00",
				serving_carb_g: "80.00",
			},
			confidence: "0.37",
			consistency: {
				atwater_kcal: "610.00",
				deviation: "10.00",
				flagged: false,
			},
			remaining_today: 19,
		};

		const NOODLES = {
			id: 30,
			name: "牛肉麵",
			brand: null,
			is_global: false,
			nutrition: {
				base_unit: "g",
				kcal: "112.73",
				protein_g: "5.82",
				fat_g: "3.27",
				carb_g: "14.55",
			},
		};

		// AI 存出來的食物帶一個自己的預設份量「一份」。
		const ONE_SERVING = {
			id: 300,
			label: "一份",
			grams: "550.00",
			is_default: true,
			is_global: false,
		};

		function aiRoutes(library: unknown[] = []) {
			return routes(MEAL, [
				{
					method: "POST",
					path: "/api/meals/5/items",
					handler: () => json(MEAL, 201),
				},
				{ path: "/api/foods/frequent", handler: () => json([WHITE_RICE]) },
				{ path: "/api/foods/3/portions", handler: () => json([]) },
				{ path: "/api/foods/30/portions", handler: () => json([ONE_SERVING]) },
				{ path: "/api/foods/40/portions", handler: () => json([]) },
				// 選擇器的搜尋與面板存之前的同名檢查都打這一支。
				{ method: "GET", path: "/api/foods?", handler: () => json(library) },
				{
					method: "POST",
					path: "/api/ai/analyze",
					handler: () => json(ESTIMATE),
				},
				{
					method: "POST",
					path: "/api/foods",
					handler: () => json(NOODLES, 201),
				},
			]);
		}

		async function estimateAndConfirm() {
			await userEvent.type(screen.getByLabelText("搜尋食物"), "牛肉麵");
			await userEvent.click(
				screen.getByRole("button", { name: "用 AI 估算「牛肉麵」" }),
			);
			const card = await screen.findByRole("region", { name: "AI 估算結果" });
			await userEvent.click(within(card).getByRole("button", { name: "確認" }));
			return card;
		}

		it("食物庫沒有的：估算、確認，存好的食物進到加一項（一份 × 1）", async () => {
			const fetchMock = mockApi(aiRoutes());
			renderEditMeal();

			await userEvent.click(
				await screen.findByRole("button", { name: "＋ 加一項" }),
			);
			await estimateAndConfirm();

			const form = await screen.findByRole("form", { name: "加一項" });
			// 按下的「確認」跟著卡片消失：焦點移到「已選擇」，不掉到 body。
			expect(within(form).getByText("已選擇：牛肉麵")).toHaveFocus();
			await waitFor(() =>
				expect(within(form).getByLabelText("份量選項")).toHaveValue("300"),
			);
			expect(within(form).getByLabelText("份量")).toHaveValue("1");
			await userEvent.click(within(form).getByRole("button", { name: "加入" }));

			await waitFor(() =>
				expect(bodyOf(fetchMock, "POST", "/api/meals/5/items")).toEqual({
					food_id: 30,
					quantity: "1",
					portion_id: 300,
				}),
			);
		});

		it("原本選的食物份量打了 200：AI 的食物回到「一份 × 1」", async () => {
			mockApi(aiRoutes());
			renderEditMeal();

			await userEvent.click(
				await screen.findByRole("button", { name: "＋ 加一項" }),
			);
			await userEvent.click(
				await screen.findByRole("button", { name: "白飯" }),
			);
			const quantity = within(
				screen.getByRole("form", { name: "加一項" }),
			).getByLabelText("份量");
			await userEvent.clear(quantity);
			await userEvent.type(quantity, "200");
			await estimateAndConfirm();

			const form = screen.getByRole("form", { name: "加一項" });
			expect(
				await within(form).findByText("已選擇：牛肉麵"),
			).toBeInTheDocument();
			await waitFor(() =>
				expect(within(form).getByLabelText("份量選項")).toHaveValue("300"),
			);
			expect(within(form).getByLabelText("份量")).toHaveValue("1");
		});

		it("食物庫裡已經有同名的：「用食物庫的」進到加一項，不建新食物", async () => {
			const LIBRARY = { ...NOODLES, id: 40, is_global: true };
			const fetchMock = mockApi(aiRoutes([LIBRARY]));
			renderEditMeal();

			await userEvent.click(
				await screen.findByRole("button", { name: "＋ 加一項" }),
			);
			const card = await estimateAndConfirm();
			await userEvent.click(
				await within(card).findByRole("button", { name: "用食物庫的" }),
			);

			const form = await screen.findByRole("form", { name: "加一項" });
			expect(within(form).getByText("已選擇：牛肉麵")).toBeInTheDocument();
			await userEvent.click(within(form).getByRole("button", { name: "加入" }));

			await waitFor(() =>
				expect(bodyOf(fetchMock, "POST", "/api/meals/5/items")).toEqual({
					food_id: 40,
					quantity: "1",
				}),
			);
			expect(
				calls(fetchMock, "POST", "/api/foods").filter(([input]) =>
					String(input).endsWith("/api/foods"),
				),
			).toHaveLength(0);
		});
	});
});
