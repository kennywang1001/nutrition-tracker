import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetRefreshStateForTests } from "../src/auth/refresh";
import { clearTokens, setTokens } from "../src/auth/store";
import type { HandoffItem } from "../src/lib/planner";
import { LogMeal } from "../src/screens/LogMeal";
import { json, mockApi } from "./helpers/mock-api";
import { CHICKEN, RICE } from "./helpers/planner-routes";

vi.mock("../src/lib/resize-image", () => ({
	shrinkToLongestEdge: vi.fn((file: File) => Promise.resolve(file)),
}));

function wrap(children: ReactNode) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

/** 「今天還能吃什麼」的第一組：雞胸 175 g（沒有份量）＋白飯 1.5 份（1 碗）。 */
const PLANNED: HandoffItem[] = [
	{ food: CHICKEN, quantity: "175", portion: null },
	{ food: RICE, quantity: "1.5", portion: { id: 9, label: "1 碗" } },
];

const NOODLES = {
	id: 10,
	name: "牛肉麵",
	brand: null,
	is_global: true,
	nutrition: {
		base_unit: "g",
		kcal: "110.00",
		protein_g: "5.00",
		fat_g: "5.00",
		carb_g: "5.00",
	},
};

// AI 估的一樣（要建的私人食物）；名稱跟配餐的兩樣都不同，「移除 X」才找得到唯一的一顆。
const BRAISED = {
	name: "滷雞腿",
	brand: null,
	nutrition: {
		base_unit: "g",
		kcal: "200.00",
		protein_g: "5.00",
		fat_g: "5.00",
		carb_g: "5.00",
		serving_grams: "150.00",
		serving_kcal: "300.00",
		serving_protein_g: "5.00",
		serving_fat_g: "5.00",
		serving_carb_g: "5.00",
	},
	confidence: "0.70",
	consistency: { atwater_kcal: "300.00", deviation: "0.00", flagged: false },
	library_food: null,
};
const ESTIMATE = {
	analysis_id: 41,
	description: "滷雞腿一隻",
	items: [BRAISED],
	remaining_today: 18,
};
const CREATED_BRAISED = {
	id: 30,
	name: "滷雞腿",
	brand: null,
	is_global: false,
	nutrition: NOODLES.nutrition,
};

/** 具體的排前面（`url.includes` 依序比對）。沒有 `/api/ai/analyze`（單樣）的路由。 */
function mockLogMeal() {
	return mockApi([
		{ path: "/api/foods/frequent", handler: () => json([NOODLES]) },
		{ path: "/api/foods/recent", handler: () => json([]) },
		{ path: "/api/foods/10/portions", handler: () => json([]) },
		{ method: "GET", path: "/api/foods?q=", handler: () => json([]) },
		{
			method: "POST",
			path: "/api/ai/analyze-meal",
			handler: () => json(ESTIMATE),
		},
		{
			method: "POST",
			path: "/api/foods",
			handler: () => json(CREATED_BRAISED, 201),
		},
		{
			method: "POST",
			path: "/api/meals",
			handler: () => json({ id: 99 }, 201),
		},
	]);
}

type FetchMock = ReturnType<typeof mockApi>;

function mealPosts(fetchMock: FetchMock) {
	return fetchMock.mock.calls.filter(
		([input, init]) =>
			(init?.method ?? "GET").toUpperCase() === "POST" &&
			String(input).endsWith("/api/meals"),
	);
}

function mealBody(fetchMock: FetchMock): Record<string, unknown> | undefined {
	const call = mealPosts(fetchMock)[0];
	return call === undefined ? undefined : JSON.parse(String(call[1]?.body));
}

function plannerItems() {
	return screen.getByRole("region", { name: "配餐的項目" });
}

beforeEach(() => {
	localStorage.clear();
	clearTokens();
	resetRefreshStateForTests();
	vi.restoreAllMocks();
	setTokens({ access_token: "a", refresh_token: "r" });
});

describe("記一餐：配餐的項目（營養素配餐規格 D22、D23）", () => {
	it("帶進來的兩樣在「配餐的項目」底下：沒有份量的是 g、有份量的是幾份；表單已經展開", async () => {
		mockLogMeal();
		render(wrap(<LogMeal onSaved={vi.fn()} initialItems={PLANNED} />));

		const section = plannerItems();
		expect(
			within(section).getByRole("heading", { level: 2, name: "配餐的項目" }),
		).toBeInTheDocument();
		expect(within(section).getByLabelText("雞胸（g）")).toHaveValue("175");
		expect(
			within(section).getByLabelText("白飯（份，1 份＝1 碗）"),
		).toHaveValue("1.5");
		expect(
			screen.queryByRole("heading", { name: "AI 估的項目" }),
		).not.toBeInTheDocument();
		expect(screen.getByRole("button", { name: "記錄" })).toBeInTheDocument();
		// 沒有手選的食物：沒有「已選擇」。
		expect(screen.queryByText(/^已選擇：/)).not.toBeInTheDocument();
		// 等常吃的清單回來（不然 act 警告）。
		expect(
			await screen.findByRole("button", { name: "牛肉麵" }),
		).toBeInTheDocument();
	});

	it("選晚餐 →「記錄」：有份量的那一樣送 portion_id 與份數；沒有的只送量", async () => {
		const fetchMock = mockLogMeal();
		const onSaved = vi.fn();
		render(wrap(<LogMeal onSaved={onSaved} initialItems={PLANNED} />));

		await userEvent.selectOptions(screen.getByLabelText("餐別"), "dinner");
		await userEvent.click(screen.getByRole("button", { name: "記錄" }));

		await waitFor(() => expect(onSaved).toHaveBeenCalled());
		const body = mealBody(fetchMock);
		// 整個比：不能多出自己算的公克數。
		expect(body?.items).toEqual([
			{ food_id: 1, quantity: "175" },
			{ food_id: 2, quantity: "1.5", portion_id: 9 },
		]);
		expect(body?.meal_type).toBe("dinner");
	});

	it("份量改成不是數字：「記錄」擋下來、指名那一樣，沒有送出", async () => {
		const fetchMock = mockLogMeal();
		render(wrap(<LogMeal onSaved={vi.fn()} initialItems={PLANNED} />));

		const rice = within(plannerItems()).getByLabelText(
			"白飯（份，1 份＝1 碗）",
		);
		await userEvent.clear(rice);
		await userEvent.type(rice, "abc");
		await userEvent.click(screen.getByRole("button", { name: "記錄" }));

		expect(screen.getByRole("alert")).toHaveTextContent(
			"「白飯」的份量要是大於 0 的數字",
		);
		expect(mealPosts(fetchMock)).toHaveLength(0);
	});

	it("移除：一樣一樣拿掉，最後一樣拿掉之後表單收起來", async () => {
		mockLogMeal();
		render(wrap(<LogMeal onSaved={vi.fn()} initialItems={PLANNED} />));

		await userEvent.click(screen.getByRole("button", { name: "移除 雞胸" }));
		expect(
			within(plannerItems()).queryByLabelText("雞胸（g）"),
		).not.toBeInTheDocument();
		expect(
			within(plannerItems()).getByLabelText("白飯（份，1 份＝1 碗）"),
		).toBeInTheDocument();

		await userEvent.click(screen.getByRole("button", { name: "移除 白飯" }));
		expect(
			screen.queryByRole("region", { name: "配餐的項目" }),
		).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "記錄" }),
		).not.toBeInTheDocument();
	});

	it("再手選一個食物：「不記這一樣」看得到；送出時配餐的在前、手選的在後", async () => {
		const fetchMock = mockLogMeal();
		render(wrap(<LogMeal onSaved={vi.fn()} initialItems={PLANNED} />));

		await userEvent.click(
			await screen.findByRole("button", { name: "牛肉麵" }),
		);
		expect(
			screen.getByRole("button", { name: "不記這一樣" }),
		).toBeInTheDocument();
		await userEvent.clear(screen.getByLabelText("份量"));
		await userEvent.type(screen.getByLabelText("份量"), "450");
		await userEvent.click(screen.getByRole("button", { name: "記錄" }));

		await waitFor(() => expect(mealBody(fetchMock)).toBeDefined());
		expect(mealBody(fetchMock)?.items).toEqual([
			{ food_id: 1, quantity: "175" },
			{ food_id: 2, quantity: "1.5", portion_id: 9 },
			{ food_id: 10, quantity: "450" },
		]);
	});

	it("AI 填的描述只在表單收起來時清：還有配餐的項目時移除 AI 那一樣，描述還在", async () => {
		mockLogMeal();
		render(wrap(<LogMeal onSaved={vi.fn()} initialItems={PLANNED} />));

		await userEvent.type(screen.getByLabelText("搜尋食物"), "滷雞腿");
		await userEvent.click(
			screen.getByRole("button", { name: "用 AI 估算「滷雞腿」" }),
		);
		const card = await screen.findByRole("region", { name: "AI 估算結果" });
		await userEvent.click(
			within(card).getByRole("button", { name: "加入這 1 樣" }),
		);
		const aiSection = await screen.findByRole("region", {
			name: "AI 估的項目",
		});
		expect(within(aiSection).getByLabelText("滷雞腿（g）")).toHaveValue("150");
		expect(screen.getByLabelText("描述（選填）")).toHaveValue("滷雞腿一隻");

		// 移除 AI 那一樣：配餐的兩樣還在、表單還開著——描述看得到，留給使用者決定。
		await userEvent.click(screen.getByRole("button", { name: "移除 滷雞腿" }));
		expect(screen.getByLabelText("描述（選填）")).toHaveValue("滷雞腿一隻");

		// 再移除配餐的兩樣：表單收起來，AI 填的描述跟著清掉（審查 M5）。
		await userEvent.click(screen.getByRole("button", { name: "移除 雞胸" }));
		await userEvent.click(screen.getByRole("button", { name: "移除 白飯" }));
		expect(screen.queryByLabelText("描述（選填）")).not.toBeInTheDocument();
		await userEvent.clear(screen.getByLabelText("搜尋食物"));
		await userEvent.click(
			await screen.findByRole("button", { name: "牛肉麵" }),
		);
		expect(screen.getByLabelText("描述（選填）")).toHaveValue("");
	});
});
