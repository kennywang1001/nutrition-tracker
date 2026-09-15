import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetRefreshStateForTests } from "../src/auth/refresh";
import { clearTokens, setTokens } from "../src/auth/store";
import { LogMeal } from "../src/screens/LogMeal";

// helper 三兄弟（wrap / mockApi / json）從 today.test.tsx 複製過來——刻意
// 不抽成共用模組。兩個畫面的 mock 路由表差很多（今日總覽是
// stats/supplements，這裡是 foods/meals），抽共用只會長出一堆參數。

function wrap(children: ReactNode) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

/** 依 URL 分派的 fetch mock。**一律先驗 Authorization** ——
 *  沒帶就回 401 信封。這是規格 §9.2 第 2 條：mock 不檢查 header 的話，
 *  「所有請求都要帶 token」這個保證零鑑別力。 */
function mockApi(routes: Record<string, () => Response>) {
	return vi
		.spyOn(globalThis, "fetch")
		.mockImplementation(async (input, init) => {
			const url = typeof input === "string" ? input : String(input);
			if (!new Headers(init?.headers).has("authorization")) {
				return new Response(
					JSON.stringify({
						error: {
							code: "NOT_AUTHENTICATED",
							message: "需要登入",
							details: {},
						},
					}),
					{ status: 401, headers: { "content-type": "application/json" } },
				);
			}
			// 用 Object.entries 一次拿到 handler，而不是先找 key 再回頭索引。
			// 後者在 noUncheckedIndexedAccess 之下是 `T | undefined`，
			// 需要一個 non-null assertion 才過得了型別——而那正是
			// Biome 的 noNonNullAssertion 在擋的東西。
			const handler = Object.entries(routes).find(([path]) =>
				url.includes(path),
			)?.[1];
			if (handler === undefined)
				throw new Error(`測試沒有為這個路徑準備回應：${url}`);
			return handler();
		});
}

function json(body: unknown) {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
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
});
