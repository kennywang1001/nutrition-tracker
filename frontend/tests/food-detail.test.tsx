import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { MemoryRouter, Route, Routes } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { queryKeys } from "../src/api/queries";
import { resetRefreshStateForTests } from "../src/auth/refresh";
import { clearTokens, setTokens } from "../src/auth/store";
import { formatDateTime } from "../src/lib/dates";
import { FoodDetail } from "../src/screens/FoodDetail";
import { json, type Route as MockRoute, mockApi } from "./helpers/mock-api";

function wrap(children: ReactNode, path = "/foods/1") {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return (
		<QueryClientProvider client={client}>
			<MemoryRouter initialEntries={[path]}>
				<Routes>
					<Route path="/foods/:id" element={children} />
				</Routes>
			</MemoryRouter>
		</QueryClientProvider>
	);
}

function nutrition(kcal: string) {
	return {
		base_unit: "g" as const,
		kcal,
		protein_g: "30.00",
		fat_g: "20.00",
		carb_g: "60.00",
	};
}

const PRIVATE_FOOD = {
	id: 1,
	name: "自製便當",
	brand: null,
	is_global: false,
	nutrition: nutrition("550.00"),
};

const GLOBAL_FOOD = {
	id: 2,
	name: "雞胸肉",
	brand: "全聯",
	is_global: true,
	nutrition: nutrition("165.00"),
};

const NO_NUTRITION_FOOD = {
	id: 3,
	name: "未生效的食物",
	brand: null,
	is_global: true,
	nutrition: null,
};

const REVISIONS = [
	{
		id: 20,
		base_unit: "g" as const,
		kcal: "165.00",
		protein_g: "31.00",
		fat_g: "3.60",
		carb_g: "0.00",
		status: "approved" as const,
		change_note: "初版",
		created_by: 1,
		created_at: "2026-09-01T00:00:00Z",
		reviewed_by: 1,
		reviewed_at: "2026-09-01T00:00:00Z",
		reject_reason: null,
		is_current: true,
	},
	{
		id: 19,
		base_unit: "g" as const,
		kcal: "170.00",
		protein_g: "30.00",
		fat_g: "4.00",
		carb_g: "1.00",
		status: "rejected" as const,
		change_note: "改熱量",
		created_by: 2,
		created_at: "2026-08-20T00:00:00Z",
		reviewed_by: 1,
		reviewed_at: "2026-08-21T00:00:00Z",
		reject_reason: "數值跟包裝標示不符",
		is_current: false,
	},
];

const PORTIONS = [
	{ id: 1, label: "一份", grams: "150.00", is_default: true, is_global: true },
];

const LIQUID_FOOD = {
	id: 4,
	name: "豆漿",
	brand: null,
	is_global: false,
	nutrition: { ...nutrition("60.00"), base_unit: "ml" as const },
};

function postedPortion(
	fetchMock: ReturnType<typeof mockApi>,
): Record<string, unknown> | null {
	const call = fetchMock.mock.calls.find(
		([input, init]) =>
			(init?.method ?? "GET").toUpperCase() === "POST" &&
			String(input).includes("/portions"),
	);
	return call === undefined ? null : JSON.parse(String(call[1]?.body));
}

function portionGets(fetchMock: ReturnType<typeof mockApi>): number {
	return fetchMock.mock.calls.filter(
		([input, init]) =>
			(init?.method ?? "GET").toUpperCase() === "GET" &&
			String(input).includes("/portions"),
	).length;
}

/** 三個 GET 共用同一個路徑前綴（`/api/foods/{id}`），而 mock-api 的比對是
 *  `url.includes(path)`——`/api/foods/1/revisions` 也「包含」`/api/foods/1`。
 *  所以更具體的路徑（revisions、portions）一定要排在通用的食物路徑之前，
 *  否則通用路徑會先比對到，兩個具體路由永遠吃不到請求
 *  （跟 `mock-api.ts` 的 docstring 講的是同一件事）。 */
function foodRoutes(
	food: unknown,
	revisions: unknown[] = [],
	portions: unknown[] = [],
	extra: MockRoute[] = [],
): MockRoute[] {
	const id = (food as { id: number }).id;
	return [
		...extra,
		{
			method: "GET",
			path: `/api/foods/${id}/revisions`,
			handler: () => json(revisions),
		},
		{
			method: "GET",
			path: `/api/foods/${id}/portions`,
			handler: () => json(portions),
		},
		{ method: "GET", path: `/api/foods/${id}`, handler: () => json(food) },
	];
}

beforeEach(() => {
	localStorage.clear();
	clearTokens();
	resetRefreshStateForTests();
	vi.restoreAllMocks();
	setTokens({ access_token: "a", refresh_token: "r" });
});

describe("食物詳情 /foods/:id", () => {
	it("顯示目前生效的營養素", async () => {
		mockApi(foodRoutes(PRIVATE_FOOD, [], []));

		render(wrap(<FoodDetail />, "/foods/1"));

		expect(await screen.findByText("自製便當")).toBeInTheDocument();
		expect(screen.getByText("550 kcal / 100g")).toBeInTheDocument();
	});

	it("nutrition 是 null 時顯示「這個食物還沒有生效的營養素資料」，不是空白或 NaN", async () => {
		mockApi(foodRoutes(NO_NUTRITION_FOOD, [], []));

		render(wrap(<FoodDetail />, "/foods/3"));

		expect(await screen.findByText("未生效的食物")).toBeInTheDocument();
		expect(
			screen.getByText("這個食物還沒有生效的營養素資料"),
		).toBeInTheDocument();
		expect(screen.queryByText(/NaN/)).not.toBeInTheDocument();
	});

	it("份量清單顯示名稱與重量", async () => {
		mockApi(foodRoutes(PRIVATE_FOOD, [], PORTIONS));

		render(wrap(<FoodDetail />, "/foods/1"));

		expect(await screen.findByText(/一份/)).toBeInTheDocument();
		expect(screen.getByText(/150 g/)).toBeInTheDocument();
	});

	it("新增份量：送出名稱、重量與預設，成功後清單重抓、表單清空", async () => {
		const fetchMock = mockApi(
			foodRoutes(
				PRIVATE_FOOD,
				[],
				[],
				[
					{
						method: "POST",
						path: "/api/foods/1/portions",
						handler: () =>
							json(
								{
									id: 9,
									label: "碗",
									grams: "150.00",
									is_default: true,
									is_global: false,
								},
								201,
							),
					},
				],
			),
		);
		render(wrap(<FoodDetail />, "/foods/1"));
		await screen.findByText("自製便當");

		await userEvent.type(screen.getByLabelText("份量名稱"), "碗");
		await userEvent.type(screen.getByLabelText("重量（g）"), "150");
		await userEvent.click(screen.getByRole("button", { name: "新增份量" }));

		await waitFor(() =>
			expect(portionGets(fetchMock)).toBeGreaterThanOrEqual(2),
		);
		expect(postedPortion(fetchMock)).toEqual({
			label: "碗",
			grams: "150",
			is_default: true,
		});
		expect(screen.getByLabelText("份量名稱")).toHaveValue("");
	});

	it("重量前後有空白：照樣接受，送出時去掉空白", async () => {
		const fetchMock = mockApi(
			foodRoutes(
				PRIVATE_FOOD,
				[],
				[],
				[
					{
						method: "POST",
						path: "/api/foods/1/portions",
						handler: () =>
							json(
								{
									id: 9,
									label: "碗",
									grams: "150.00",
									is_default: true,
									is_global: false,
								},
								201,
							),
					},
				],
			),
		);
		render(wrap(<FoodDetail />, "/foods/1"));
		await screen.findByText("自製便當");

		await userEvent.type(screen.getByLabelText("份量名稱"), "碗");
		await userEvent.type(screen.getByLabelText("重量（g）"), " 150 ");
		await userEvent.click(screen.getByRole("button", { name: "新增份量" }));

		await waitFor(() => expect(postedPortion(fetchMock)).not.toBeNull());
		expect(postedPortion(fetchMock)).toEqual({
			label: "碗",
			grams: "150",
			is_default: true,
		});
	});

	it("已經有預設份量時，「預設」勾選框一開始不勾；沒有時勾起來", async () => {
		mockApi(foodRoutes(PRIVATE_FOOD, [], PORTIONS));
		const { unmount } = render(wrap(<FoodDetail />, "/foods/1"));
		await screen.findByText(/一份/);

		expect(
			screen.getByRole("checkbox", { name: "記一餐時預設用這個份量" }),
		).not.toBeChecked();
		unmount();

		vi.restoreAllMocks();
		setTokens({ access_token: "a", refresh_token: "r" });
		mockApi(foodRoutes(PRIVATE_FOOD, [], []));
		render(wrap(<FoodDetail />, "/foods/1"));
		await screen.findByText("這個食物還沒有份量資料");

		expect(
			screen.getByRole("checkbox", { name: "記一餐時預設用這個份量" }),
		).toBeChecked();
	});

	it("「會取代原本的預設」只在自己已有預設、而且勾了預設時才出現", async () => {
		const checkboxName = "記一餐時預設用這個份量";
		// 只有公開的預設：後端不會動它，不能說「會取代」。
		mockApi(foodRoutes(PRIVATE_FOOD, [], PORTIONS));
		const { unmount } = render(wrap(<FoodDetail />, "/foods/1"));
		await screen.findByText(/一份/);
		await userEvent.click(screen.getByRole("checkbox", { name: checkboxName }));
		expect(screen.getByRole("checkbox", { name: checkboxName })).toBeChecked();
		expect(screen.queryByText("會取代原本的預設")).not.toBeInTheDocument();
		unmount();

		// 自己已有預設：勾了就會取代。
		vi.restoreAllMocks();
		setTokens({ access_token: "a", refresh_token: "r" });
		mockApi(
			foodRoutes(PRIVATE_FOOD, [], [{ ...PORTIONS[0], is_global: false }]),
		);
		render(wrap(<FoodDetail />, "/foods/1"));
		await screen.findByText(/一份/);
		expect(screen.queryByText("會取代原本的預設")).not.toBeInTheDocument();
		await userEvent.click(screen.getByRole("checkbox", { name: checkboxName }));
		expect(screen.getByText("會取代原本的預設")).toBeInTheDocument();
	});

	it("同名份量：顯示後端的訊息", async () => {
		mockApi(
			foodRoutes(PRIVATE_FOOD, [], PORTIONS, [
				{
					method: "POST",
					path: "/api/foods/1/portions",
					handler: () =>
						json(
							{
								error: {
									code: "PORTION_EXISTS",
									message: "你已經為這個食物建過同名的份量了",
									details: {},
								},
							},
							409,
						),
				},
			]),
		);
		render(wrap(<FoodDetail />, "/foods/1"));
		await screen.findByText(/一份/);

		await userEvent.type(screen.getByLabelText("份量名稱"), "一份");
		await userEvent.type(screen.getByLabelText("重量（g）"), "150");
		await userEvent.click(screen.getByRole("button", { name: "新增份量" }));

		expect(
			await screen.findByText("你已經為這個食物建過同名的份量了"),
		).toBeInTheDocument();
	});

	it("名稱或重量沒填：擋下來，不送請求", async () => {
		const fetchMock = mockApi(foodRoutes(PRIVATE_FOOD, [], []));
		render(wrap(<FoodDetail />, "/foods/1"));
		await screen.findByText("自製便當");

		await userEvent.type(screen.getByLabelText("重量（g）"), "150");
		await userEvent.click(screen.getByRole("button", { name: "新增份量" }));

		expect(await screen.findByText("請輸入份量名稱")).toBeInTheDocument();
		expect(postedPortion(fetchMock)).toBeNull();
	});

	it("液體食物的份量與重量欄位顯示 ml", async () => {
		mockApi(
			foodRoutes(
				LIQUID_FOOD,
				[],
				[
					{
						id: 2,
						label: "杯",
						grams: "300.00",
						is_default: true,
						is_global: false,
					},
				],
			),
		);
		render(wrap(<FoodDetail />, "/foods/4"));

		expect(await screen.findByText(/300 ml/)).toBeInTheDocument();
		expect(screen.getByLabelText("重量（ml）")).toBeInTheDocument();
	});

	it("編輯歷史每一筆顯示 status / change_note / created_at，被駁回的那筆顯示 reject_reason", async () => {
		mockApi(foodRoutes(PRIVATE_FOOD, REVISIONS, []));

		render(wrap(<FoodDetail />, "/foods/1"));

		expect(await screen.findByText("已通過")).toBeInTheDocument();
		expect(screen.getByText("初版")).toBeInTheDocument();
		expect(
			screen.getByText(formatDateTime("2026-09-01T00:00:00Z")),
		).toBeInTheDocument();
		expect(screen.queryByText("2026-09-01T00:00:00Z")).not.toBeInTheDocument();

		expect(screen.getByText("已駁回")).toBeInTheDocument();
		expect(screen.getByText("改熱量")).toBeInTheDocument();
		expect(
			screen.getByText(formatDateTime("2026-08-20T00:00:00Z")),
		).toBeInTheDocument();
		expect(screen.queryByText("2026-08-20T00:00:00Z")).not.toBeInTheDocument();
		expect(
			screen.getByText("駁回原因：數值跟包裝標示不符"),
		).toBeInTheDocument();
	});

	it("is_global === false 時，送出前的說明是「立刻生效」", async () => {
		mockApi(foodRoutes(PRIVATE_FOOD, [], []));

		render(wrap(<FoodDetail />, "/foods/1"));

		expect(await screen.findByText(/立刻生效/)).toBeInTheDocument();
		expect(screen.queryByText(/送審/)).not.toBeInTheDocument();
	});

	it("is_global === true 時，送出前的說明是「送審」", async () => {
		mockApi(foodRoutes(GLOBAL_FOOD, [], []));

		render(wrap(<FoodDetail />, "/foods/2"));

		expect(await screen.findByText(/送審/)).toBeInTheDocument();
		expect(screen.queryByText(/立刻生效/)).not.toBeInTheDocument();
	});

	it("409 REVISION_PENDING 顯示「這個食物已經有一筆待審的編輯，請等審核完成」", async () => {
		mockApi(
			foodRoutes(
				GLOBAL_FOOD,
				[],
				[],
				[
					{
						method: "POST",
						path: "/api/foods/2/revisions",
						handler: () =>
							json(
								{
									error: {
										code: "REVISION_PENDING",
										message: "這個食物已經有一筆待審的編輯，請等審核完成",
										details: {},
									},
								},
								409,
							),
					},
				],
			),
		);

		render(wrap(<FoodDetail />, "/foods/2"));
		await screen.findByText("雞胸肉");

		await userEvent.type(
			screen.getByLabelText("熱量（每 100 單位 kcal）"),
			"170",
		);
		await userEvent.type(screen.getByLabelText("蛋白質（g）"), "30");
		await userEvent.type(screen.getByLabelText("脂肪（g）"), "4");
		await userEvent.type(screen.getByLabelText("碳水化合物（g）"), "1");
		await userEvent.click(screen.getByRole("button", { name: "送出" }));

		expect(
			await screen.findByText("這個食物已經有一筆待審的編輯，請等審核完成"),
		).toBeInTheDocument();
		// 不是被通用文案蓋過去。
		expect(screen.queryByText("送出失敗，請再試一次")).not.toBeInTheDocument();
	});
});

const MY_BOWL = {
	id: 5,
	label: "我的碗",
	grams: "220.00",
	is_default: false,
	is_global: false,
};

function portionRequests(
	fetchMock: ReturnType<typeof mockApi>,
	method: string,
): Array<[unknown, RequestInit | undefined]> {
	return fetchMock.mock.calls.filter(
		([input, init]) =>
			(init?.method ?? "GET").toUpperCase() === method &&
			String(input).includes("/portions/5"),
	) as Array<[unknown, RequestInit | undefined]>;
}

/** 跟 `wrap` 一樣的外殼，但自己建 client 並回傳，讓測試可以監看 invalidate。 */
function renderDetail(): QueryClient {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	render(
		<QueryClientProvider client={client}>
			<MemoryRouter initialEntries={["/foods/1"]}>
				<Routes>
					<Route path="/foods/:id" element={<FoodDetail />} />
				</Routes>
			</MemoryRouter>
		</QueryClientProvider>,
	);
	return client;
}

describe("食物詳情：份量的修改與刪除", () => {
	it("公開份量沒有修改、刪除按鈕；自己的有", async () => {
		mockApi(foodRoutes(PRIVATE_FOOD, [], [...PORTIONS, MY_BOWL]));
		renderDetail();

		await screen.findByText(/我的碗（220 g）/);
		expect(
			screen.getByRole("button", { name: "修改我的碗" }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "刪除我的碗" }),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "修改一份" }),
		).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "刪除一份" }),
		).not.toBeInTheDocument();
	});

	it("修改：只送改過的欄位，成功後重抓份量清單", async () => {
		const fetchMock = mockApi(
			foodRoutes(
				PRIVATE_FOOD,
				[],
				[MY_BOWL],
				[
					{
						method: "PATCH",
						path: "/portions/5",
						handler: () => json({ ...MY_BOWL, grams: "250.00" }),
					},
				],
			),
		);
		const client = renderDetail();
		const invalidate = vi.spyOn(client, "invalidateQueries");

		await userEvent.click(
			await screen.findByRole("button", { name: "修改我的碗" }),
		);
		const form = screen.getByRole("form", { name: "修改我的碗" });
		const grams = within(form).getByLabelText("重量（g）");
		expect(grams).toHaveValue("220");
		await userEvent.clear(grams);
		await userEvent.type(grams, "250");
		await userEvent.click(within(form).getByRole("button", { name: "儲存" }));

		await waitFor(() =>
			expect(portionRequests(fetchMock, "PATCH")).toHaveLength(1),
		);
		const body = JSON.parse(
			String(portionRequests(fetchMock, "PATCH")[0]?.[1]?.body),
		);
		expect(body).toEqual({ grams: "250" });
		await waitFor(() =>
			expect(invalidate).toHaveBeenCalledWith({
				queryKey: queryKeys.portions(PRIVATE_FOOD.id),
			}),
		);
	});

	it("沒改任何東西就儲存：不送，收起來", async () => {
		const fetchMock = mockApi(foodRoutes(PRIVATE_FOOD, [], [MY_BOWL]));
		renderDetail();

		await userEvent.click(
			await screen.findByRole("button", { name: "修改我的碗" }),
		);
		const form = screen.getByRole("form", { name: "修改我的碗" });
		await userEvent.click(within(form).getByRole("button", { name: "儲存" }));

		expect(
			screen.queryByRole("form", { name: "修改我的碗" }),
		).not.toBeInTheDocument();
		expect(portionRequests(fetchMock, "PATCH")).toHaveLength(0);
	});

	it("名稱清空：擋下，不送", async () => {
		const fetchMock = mockApi(foodRoutes(PRIVATE_FOOD, [], [MY_BOWL]));
		renderDetail();

		await userEvent.click(
			await screen.findByRole("button", { name: "修改我的碗" }),
		);
		const form = screen.getByRole("form", { name: "修改我的碗" });
		await userEvent.clear(within(form).getByLabelText("份量名稱"));
		await userEvent.click(within(form).getByRole("button", { name: "儲存" }));

		expect(within(form).getByRole("alert")).toHaveTextContent("請輸入份量名稱");
		expect(portionRequests(fetchMock, "PATCH")).toHaveLength(0);
	});

	it("改名撞名：顯示後端的訊息", async () => {
		mockApi(
			foodRoutes(
				PRIVATE_FOOD,
				[],
				[MY_BOWL],
				[
					{
						method: "PATCH",
						path: "/portions/5",
						handler: () =>
							json(
								{
									error: {
										code: "PORTION_EXISTS",
										message: "你已經為這個食物建過同名的份量了",
										details: {},
									},
								},
								409,
							),
					},
				],
			),
		);
		renderDetail();

		await userEvent.click(
			await screen.findByRole("button", { name: "修改我的碗" }),
		);
		const form = screen.getByRole("form", { name: "修改我的碗" });
		await userEvent.type(within(form).getByLabelText("份量名稱"), "2");
		await userEvent.click(within(form).getByRole("button", { name: "儲存" }));

		expect(await within(form).findByRole("alert")).toHaveTextContent(
			"你已經為這個食物建過同名的份量了",
		);
	});

	it("刪除要先確認，寫明已記的餐不受影響；取消就不送", async () => {
		const fetchMock = mockApi(foodRoutes(PRIVATE_FOOD, [], [MY_BOWL]));
		renderDetail();

		await userEvent.click(
			await screen.findByRole("button", { name: "刪除我的碗" }),
		);
		const dialog = screen.getByRole("alertdialog", { name: "確認刪除我的碗" });
		expect(dialog).toHaveTextContent("已經記下的餐不受影響，公克數照舊");
		await userEvent.click(within(dialog).getByRole("button", { name: "取消" }));

		expect(portionRequests(fetchMock, "DELETE")).toHaveLength(0);
	});

	it("確認刪除：送 DELETE，成功後重抓份量清單", async () => {
		const fetchMock = mockApi(
			foodRoutes(
				PRIVATE_FOOD,
				[],
				[MY_BOWL],
				[
					{
						method: "DELETE",
						path: "/portions/5",
						handler: () => new Response(null, { status: 204 }),
					},
				],
			),
		);
		const client = renderDetail();
		const invalidate = vi.spyOn(client, "invalidateQueries");

		await userEvent.click(
			await screen.findByRole("button", { name: "刪除我的碗" }),
		);
		const dialog = screen.getByRole("alertdialog", { name: "確認刪除我的碗" });
		await userEvent.click(
			within(dialog).getByRole("button", { name: "確定刪除" }),
		);

		await waitFor(() =>
			expect(portionRequests(fetchMock, "DELETE")).toHaveLength(1),
		);
		await waitFor(() =>
			expect(invalidate).toHaveBeenCalledWith({
				queryKey: queryKeys.portions(PRIVATE_FOOD.id),
			}),
		);
	});
});
