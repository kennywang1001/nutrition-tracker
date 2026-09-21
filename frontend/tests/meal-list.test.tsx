import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetRefreshStateForTests } from "../src/auth/refresh";
import { clearTokens, setTokens } from "../src/auth/store";
import { MealList } from "../src/screens/MealList";

// helper 三兄弟（wrap / mockApi / json）從 today.test.tsx 複製過來——刻意
// 不抽成共用模組，理由同 log-meal.test.tsx 開頭的註解。

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

const MEALS = [
	{
		id: 11,
		eaten_at: "2026-09-21T12:30:00+08:00",
		meal_type: "lunch",
		note: null,
		photo_path: "3/abc123.jpg",
		items: [
			{
				id: 1,
				food_id: 3,
				food_name: "滷肉飯",
				portion_id: null,
				quantity: "200.00",
				quantity_g: "200.00",
				kcal: "440.00",
				protein_g: "13.00",
				fat_g: "14.00",
				carb_g: "44.00",
			},
		],
		kcal: "440.00",
		protein_g: "13.00",
		fat_g: "14.00",
		carb_g: "44.00",
	},
	{
		id: 12,
		eaten_at: "2026-09-21T19:00:00+08:00",
		meal_type: "dinner",
		note: null,
		photo_path: null,
		items: [],
		kcal: "0.00",
		protein_g: "0.00",
		fat_g: "0.00",
		carb_g: "0.00",
	},
];

beforeEach(() => {
	localStorage.clear();
	clearTokens();
	resetRefreshStateForTests();
	vi.restoreAllMocks();
	setTokens({ access_token: "a", refresh_token: "r" });
});

describe("今日餐點清單", () => {
	it("不傳 date 參數——日界線由伺服器決定", async () => {
		// 跟 /api/stats/daily 同一條規矩(計畫二 Task 4)。後端的
		// `list_meals` 省略 date 時走 today_in_timezone(user.timezone)，
		// 跟 stats/daily 與 supplements/today 是同一個函式。
		const fetchMock = mockApi({ "/api/meals": () => json(MEALS) });

		render(wrap(<MealList />));
		await screen.findByText("滷肉飯");

		const call = fetchMock.mock.calls.find(([input]) =>
			String(input).includes("/api/meals"),
		);
		expect(String(call?.[0])).toBe("/api/meals");
	});

	it("列出每一餐的項目與熱量", async () => {
		mockApi({ "/api/meals": () => json(MEALS) });

		render(wrap(<MealList />));

		expect(await screen.findByText("滷肉飯")).toBeInTheDocument();
		expect(screen.getByText(/440/)).toBeInTheDocument();
	});

	it("photo_path 不會被當成網址塞進 img", async () => {
		// **規格 §5.2：`photo_path` 是伺服器端的相對路徑，不是 URL。**
		// 它唯一的用途是判斷「這一餐有沒有照片」。真的要拿到圖必須打
		// GET /api/meals/{id}/photo，而那個端點會先驗 JWT 與擁有權。
		//
		// 直接塞進 <img src> 的話：瀏覽器會對 /3/abc123.jpg 發一個沒有
		// Authorization 的請求，回 404（SPA fallback 的話更糟——回 HTML）。
		mockApi({ "/api/meals": () => json(MEALS) });

		render(wrap(<MealList />));
		await screen.findByText("滷肉飯");

		// **不要用 getByRole("img")。** ARIA 規則下 `alt=""`（裝飾用圖片）
		// 會把 img 的 role 改成 presentation，於是它從 accessibility tree
		// 消失、`queryAllByRole("img")` 找不到它——這條守衛就瞎了。
		//
		// 實測踩過：用 `<img src={photo_path} alt="" />` 做突變時，
		// 這條測試「巧合地」通過了。
		//
		// 直接斷言那個字串從來沒有進到 DOM，是這個性質最直接的表達：
		// photo_path 不該被渲染成任何東西的網址。
		expect(document.body.innerHTML).not.toContain("abc123.jpg");
	});

	it("沒有照片的餐不顯示照片區塊", async () => {
		mockApi({ "/api/meals": () => json(MEALS) });

		render(wrap(<MealList />));
		await screen.findByText("滷肉飯");

		// photo_path 為 null 的那一餐（id 12）不該有任何照片相關的東西
		expect(screen.queryByTestId("meal-photo-12")).not.toBeInTheDocument();
		expect(screen.getByTestId("meal-photo-11")).toBeInTheDocument();
	});
});
