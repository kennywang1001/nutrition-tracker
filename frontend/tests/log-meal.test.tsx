import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetRefreshStateForTests } from "../src/auth/refresh";
import { clearTokens, setTokens } from "../src/auth/store";
import { LogMeal } from "../src/screens/LogMeal";
import { json, mockApiByPath as mockApi } from "./helpers/mock-api";

function wrap(children: ReactNode) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const FREQUENT_FOODS = [
	{
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
	},
	{
		// 全域食物的初版被駁回——nutrition 是 null。
		// 這不是假設情境，是 FoodResponse 明寫的狀態。
		id: 2,
		name: "沒有營養素的食物",
		brand: null,
		is_global: true,
		nutrition: null,
	},
];

const SEARCH_RESULT = {
	id: 3,
	name: "白飯",
	brand: null,
	is_global: true,
	nutrition: {
		base_unit: "g",
		kcal: "130.00",
		protein_g: "2.50",
		fat_g: "0.30",
		carb_g: "28.00",
	},
};

beforeEach(() => {
	localStorage.clear();
	clearTokens();
	resetRefreshStateForTests();
	vi.restoreAllMocks();
	setTokens({ access_token: "a", refresh_token: "r" });
});

describe("記一餐", () => {
	it("列出常吃的食物", async () => {
		mockApi({
			"/api/foods/frequent": () => json(FREQUENT_FOODS),
			"/api/foods/recent": () => json([]),
		});

		render(wrap(<LogMeal onSaved={vi.fn()} />));

		expect(await screen.findByText("滷肉飯")).toBeInTheDocument();
	});

	it("nutrition 是 null 的食物不會讓畫面炸掉", async () => {
		// FoodResponse.nutrition 的註解：「沒有生效版本時為 None ——
		// 全域食物的初版被駁回就會是這個狀態」。
		mockApi({
			"/api/foods/frequent": () => json(FREQUENT_FOODS),
			"/api/foods/recent": () => json([]),
		});

		render(wrap(<LogMeal onSaved={vi.fn()} />));

		expect(await screen.findByText("沒有營養素的食物")).toBeInTheDocument();
	});

	it("送出時只帶 food_id 與 quantity，不帶自己算的公克數", async () => {
		// 交接文件 §4.3：quantity_g 由伺服器在寫入當下算好並凍結。
		// 前端算一次就是把「凍結歷史」這個保證從另一頭破壞掉。
		const fetchMock = mockApi({
			"/api/foods/frequent": () => json(FREQUENT_FOODS),
			"/api/foods/recent": () => json([]),
			"/api/foods/1/portions": () => json([]),
			"/api/meals": () => json({ id: 1, items: [] }),
		});

		render(wrap(<LogMeal onSaved={vi.fn()} />));
		await userEvent.click(await screen.findByText("滷肉飯"));
		await userEvent.clear(screen.getByLabelText("份量"));
		await userEvent.type(screen.getByLabelText("份量"), "200");
		await userEvent.click(screen.getByRole("button", { name: "記錄" }));

		const mealCall = fetchMock.mock.calls.find(
			([input, init]) =>
				String(input).includes("/api/meals") && init?.method === "POST",
		);
		const body = JSON.parse(String(mealCall?.[1]?.body));
		expect(body.items[0]).toMatchObject({ food_id: 1, quantity: "200" });
		expect(body.items[0]).not.toHaveProperty("quantity_g");
	});

	it("送出成功後呼叫 onSaved", async () => {
		mockApi({
			"/api/foods/frequent": () => json(FREQUENT_FOODS),
			"/api/foods/recent": () => json([]),
			"/api/foods/1/portions": () => json([]),
			"/api/meals": () => json({ id: 1, items: [] }),
		});
		const onSaved = vi.fn();

		render(wrap(<LogMeal onSaved={onSaved} />));
		await userEvent.click(await screen.findByText("滷肉飯"));
		await userEvent.click(screen.getByRole("button", { name: "記錄" }));

		await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
	});

	it("搜尋框輸入之後（等過 debounce）出現搜尋結果，而且常吃/最近吃還在", async () => {
		const fetchMock = mockApi({
			"/api/foods/frequent": () => json(FREQUENT_FOODS),
			"/api/foods/recent": () => json([]),
			// 更具體的路徑（frequent/recent）排在前面——mockApiByPath 用
			// url.includes(path) 依序比對，"/api/foods" 這個廣義路徑放前面
			// 的話會搶先吃掉 /api/foods/frequent 的請求。
			"/api/foods": () => json([SEARCH_RESULT]),
		});

		render(wrap(<LogMeal onSaved={vi.fn()} />));
		expect(await screen.findByText("滷肉飯")).toBeInTheDocument();

		await userEvent.type(screen.getByLabelText("搜尋食物"), "白飯");

		expect(await screen.findByText("白飯")).toBeInTheDocument();
		// 常吃/最近吃還在——搜尋結果是加上去的，不是取代掉原本的清單。
		expect(screen.getByText("滷肉飯")).toBeInTheDocument();

		const searchCall = fetchMock.mock.calls.find(
			([input]) =>
				String(input).includes("/api/foods?") &&
				String(input).includes("q=%E7%99%BD%E9%A3%AF"),
		);
		expect(searchCall).toBeDefined();
	});

	it("從搜尋結果選一個食物，行為跟從常吃選一個完全一樣（進份量輸入）", async () => {
		mockApi({
			"/api/foods/frequent": () => json(FREQUENT_FOODS),
			"/api/foods/recent": () => json([]),
			"/api/foods/3/portions": () => json([]),
			"/api/foods": () => json([SEARCH_RESULT]),
		});

		render(wrap(<LogMeal onSaved={vi.fn()} />));
		await userEvent.type(screen.getByLabelText("搜尋食物"), "白飯");

		await userEvent.click(await screen.findByRole("button", { name: "白飯" }));

		expect(screen.getByText("已選擇：白飯")).toBeInTheDocument();
		expect(screen.getByLabelText("份量")).toBeInTheDocument();
	});

	it("nutrition === null 的食物不能被選——按鈕 disabled，並顯示原因", async () => {
		mockApi({
			"/api/foods/frequent": () => json(FREQUENT_FOODS),
			"/api/foods/recent": () => json([]),
		});

		render(wrap(<LogMeal onSaved={vi.fn()} />));

		const button = await screen.findByRole("button", {
			name: "沒有營養素的食物",
		});
		expect(button).toBeDisabled();
		expect(
			screen.getByText("這個食物還沒有生效的營養素資料"),
		).toBeInTheDocument();
	});

	it("409 FOOD_HAS_NO_REVISION 顯示具名訊息，不是通用的「記錄失敗，請再試一次」", async () => {
		// 搜尋到送出之間，食物有可能剛好失去生效版本——disabled 擋不住
		// 這種情況（選的當下 nutrition 還不是 null），所以後端這個 409
		// 仍然要具名處理。
		mockApi({
			"/api/foods/frequent": () => json(FREQUENT_FOODS),
			"/api/foods/recent": () => json([]),
			"/api/foods/1/portions": () => json([]),
			"/api/meals": () =>
				json(
					{
						error: {
							code: "FOOD_HAS_NO_REVISION",
							message: "這個食物目前沒有生效的版本",
							details: {},
						},
					},
					409,
				),
		});

		render(wrap(<LogMeal onSaved={vi.fn()} />));
		await userEvent.click(await screen.findByText("滷肉飯"));
		await userEvent.click(screen.getByRole("button", { name: "記錄" }));

		expect(
			await screen.findByText("這個食物目前沒有生效的版本"),
		).toBeInTheDocument();
		expect(screen.queryByText("記錄失敗，請再試一次")).not.toBeInTheDocument();
	});
});
