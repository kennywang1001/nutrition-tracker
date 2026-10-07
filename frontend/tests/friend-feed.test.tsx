import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetRefreshStateForTests } from "../src/auth/refresh";
import { clearTokens, setTokens } from "../src/auth/store";
import { FriendFeed } from "../src/screens/FriendFeed";
import { json, mockApi, type Route } from "./helpers/mock-api";

function friendMeal(id: number, overrides: Record<string, unknown> = {}) {
	return {
		id,
		user: { id: 2, display_name: "鮑伯" },
		eaten_at: "2026-10-06T04:00:00Z",
		meal_type: "lunch",
		items: [{ food_name: `便當 ${id}`, quantity_g: "350.00", kcal: "620.00" }],
		kcal: "620.00",
		protein_g: "25.00",
		fat_g: "20.00",
		carb_g: "80.00",
		has_photo: false,
		...overrides,
	};
}

const FRIENDS = [
	{ id: 2, display_name: "鮑伯", since: "2026-10-01T00:00:00Z" },
];

function renderFeed() {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	render(
		<QueryClientProvider client={client}>
			<MemoryRouter>
				<FriendFeed />
			</MemoryRouter>
		</QueryClientProvider>,
	);
}

/** `/api/friends/feed` 必須排在 `/api/friends` 之前（`mockApi` 用 includes 依序比對）。 */
function feedRoutes(
	feed: () => Response,
	friends: unknown[] = FRIENDS,
): Route[] {
	return [
		{ method: "GET", path: "/api/friends/feed", handler: feed },
		{ method: "GET", path: "/api/friends", handler: () => json(friends) },
	];
}

beforeEach(() => {
	localStorage.clear();
	clearTokens();
	resetRefreshStateForTests();
	vi.restoreAllMocks();
	setTokens({ access_token: "a", refresh_token: "r" });
});

describe("好友動態", () => {
	it("卡片：名字連到他的一天、餐別、食物、熱量", async () => {
		mockApi(
			feedRoutes(() => json({ meals: [friendMeal(7)], next_cursor: null })),
		);
		renderFeed();

		expect(await screen.findByText("便當 7")).toBeInTheDocument();
		expect(screen.getByRole("link", { name: "鮑伯" })).toHaveAttribute(
			"href",
			"/friends/2",
		);
		expect(screen.getByText(/午餐/)).toBeInTheDocument();
		expect(screen.getByText(/620 kcal/)).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "載入更多" }),
		).not.toBeInTheDocument();
	});

	it("有照片時用好友的照片端點取圖，不打自己的照片端點", async () => {
		const spy = mockApi([
			{
				method: "GET",
				path: "/api/friends/2/meals/7/photo",
				handler: () =>
					new Response(new Blob(["jpeg"]), {
						headers: { "content-type": "image/jpeg" },
					}),
			},
			...feedRoutes(() =>
				json({
					meals: [friendMeal(7, { has_photo: true })],
					next_cursor: null,
				}),
			),
		]);
		renderFeed();

		await screen.findByText("便當 7");
		await waitFor(() =>
			expect(
				spy.mock.calls.some(([url]) =>
					String(url).endsWith("/api/friends/2/meals/7/photo?size=thumb"),
				),
			).toBe(true),
		);
		expect(
			spy.mock.calls.some(([url]) =>
				String(url).includes("/api/meals/7/photo"),
			),
		).toBe(false);
	});

	it("有照片的卡片要的是縮圖", async () => {
		const spy = mockApi([
			{
				method: "GET",
				path: "/api/friends/2/meals/7/photo",
				handler: () =>
					new Response(new Blob(["jpeg"]), {
						headers: { "content-type": "image/jpeg" },
					}),
			},
			...feedRoutes(() =>
				json({
					meals: [friendMeal(7, { has_photo: true })],
					next_cursor: null,
				}),
			),
		]);
		renderFeed();

		await screen.findByText("便當 7");
		await waitFor(() =>
			expect(
				spy.mock.calls.some(([url]) =>
					String(url).endsWith("/api/friends/2/meals/7/photo?size=thumb"),
				),
			).toBe(true),
		);
		expect(
			spy.mock.calls.some(([url]) =>
				String(url).endsWith("/api/friends/2/meals/7/photo"),
			),
		).toBe(false);
	});

	it("載入更多：帶上一頁的游標；沒有下一頁時按鈕消失", async () => {
		let page = 0;
		const spy = mockApi(
			feedRoutes(() => {
				page += 1;
				return page === 1
					? json({ meals: [friendMeal(9)], next_cursor: "CURSOR-1" })
					: json({ meals: [friendMeal(8)], next_cursor: null });
			}),
		);
		renderFeed();

		await userEvent.click(
			await screen.findByRole("button", { name: "載入更多" }),
		);

		expect(await screen.findByText("便當 8")).toBeInTheDocument();
		expect(screen.getByText("便當 9")).toBeInTheDocument();
		expect(
			spy.mock.calls.some(([url]) =>
				String(url).endsWith("/api/friends/feed?before=CURSOR-1"),
			),
		).toBe(true);
		expect(
			screen.queryByRole("button", { name: "載入更多" }),
		).not.toBeInTheDocument();
	});

	it("還沒有好友", async () => {
		mockApi(feedRoutes(() => json({ meals: [], next_cursor: null }), []));
		renderFeed();

		expect(
			await screen.findByText("還沒有好友。到「我的」→「好友」用好友碼加朋友"),
		).toBeInTheDocument();
	});

	it("有好友但還沒有餐點", async () => {
		mockApi(feedRoutes(() => json({ meals: [], next_cursor: null })));
		renderFeed();

		expect(await screen.findByText("好友還沒有記錄餐點")).toBeInTheDocument();
	});
});
