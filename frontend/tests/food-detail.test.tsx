import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { MemoryRouter, Route, Routes } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetRefreshStateForTests } from "../src/auth/refresh";
import { clearTokens, setTokens } from "../src/auth/store";
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

	it("份量清單唯讀——顯示得出來，但沒有新增或修改的表單", async () => {
		mockApi(foodRoutes(PRIVATE_FOOD, [], PORTIONS));

		render(wrap(<FoodDetail />, "/foods/1"));

		expect(await screen.findByText(/一份/)).toBeInTheDocument();
		expect(screen.getByText(/150 g/)).toBeInTheDocument();
		// 唯讀：不能新增也不能修改（規格 §5.3，份量管理 UI 不在 P3-B 範圍）。
		expect(
			screen.queryByRole("button", { name: /新增份量/ }),
		).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: /編輯份量/ }),
		).not.toBeInTheDocument();
	});

	it("編輯歷史每一筆顯示 status / change_note / created_at，被駁回的那筆顯示 reject_reason", async () => {
		mockApi(foodRoutes(PRIVATE_FOOD, REVISIONS, []));

		render(wrap(<FoodDetail />, "/foods/1"));

		expect(await screen.findByText("已通過")).toBeInTheDocument();
		expect(screen.getByText("初版")).toBeInTheDocument();
		expect(screen.getByText("2026-09-01T00:00:00Z")).toBeInTheDocument();

		expect(screen.getByText("已駁回")).toBeInTheDocument();
		expect(screen.getByText("改熱量")).toBeInTheDocument();
		expect(screen.getByText("2026-08-20T00:00:00Z")).toBeInTheDocument();
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
