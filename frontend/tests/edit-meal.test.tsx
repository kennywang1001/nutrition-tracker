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
		await userEvent.click(await screen.findByRole("button", { name: "白飯" }));
		const form = screen.getByRole("form", { name: "加一項" });
		expect(within(form).getByText("已選擇：白飯")).toBeInTheDocument();
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
});
