import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
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

	it("其他錯誤：說載入失敗，不是說找不到", async () => {
		mockApi([
			{
				path: "/api/meals/5",
				handler: () =>
					json({ error: { code: "X", message: "x", details: {} } }, 500),
			},
		]);
		renderEditMeal();

		expect(await screen.findByText("無法載入這一餐")).toBeInTheDocument();
	});

	it("沒有項目時說沒有項目", async () => {
		mockApi(routes({ ...MEAL, items: [] }));
		renderEditMeal();

		expect(await screen.findByText("這一餐沒有項目")).toBeInTheDocument();
	});
});

describe("編輯這一餐：餐別、金額、備註", () => {
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
	it("網址的 id 不是數字：說找不到，也不打 /api/meals", async () => {
		const fetchMock = mockApi(routes());
		const client = newClient();
		render(
			<QueryClientProvider client={client}>
				<MemoryRouter initialEntries={["/meals/abc/edit"]}>
					<Routes>
						<Route path="/meals/:id/edit" element={<EditMeal />} />
					</Routes>
				</MemoryRouter>
			</QueryClientProvider>,
		);

		expect(await screen.findByText("找不到這一餐")).toBeInTheDocument();
		expect(calls(fetchMock, "GET", "/api/meals")).toHaveLength(0);
	});

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
