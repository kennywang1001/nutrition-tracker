import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetRefreshStateForTests } from "../src/auth/refresh";
import { clearTokens, setTokens } from "../src/auth/store";
import { FriendDay } from "../src/screens/FriendDay";
import { json, mockApi } from "./helpers/mock-api";

function dayResponse(day: string, mealName: string | null) {
	return {
		friend: { id: 2, display_name: "鮑伯" },
		day,
		meals:
			mealName === null
				? []
				: [
						{
							id: 7,
							user: { id: 2, display_name: "鮑伯" },
							eaten_at: `${day}T04:00:00Z`,
							meal_type: "lunch",
							items: [
								{ food_name: mealName, quantity_g: "350.00", kcal: "620.00" },
							],
							kcal: "620.00",
							protein_g: "25.00",
							fat_g: "20.00",
							carb_g: "80.00",
							has_photo: false,
							like_count: 1,
							comment_count: 2,
							liked_by_me: false,
						},
					],
	};
}

function renderDay() {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	render(
		<QueryClientProvider client={client}>
			<MemoryRouter initialEntries={["/friends/2"]}>
				<Routes>
					<Route path="/friends/:id" element={<FriendDay />} />
				</Routes>
			</MemoryRouter>
		</QueryClientProvider>,
	);
}

beforeEach(() => {
	localStorage.clear();
	clearTokens();
	resetRefreshStateForTests();
	vi.restoreAllMocks();
	setTokens({ access_token: "a", refresh_token: "r" });
});

describe("好友的某一天", () => {
	it("預設讓後端決定他的今天；前一天、後一天帶 date", async () => {
		// 帶 ?date= 的路由排在不帶的前面（mockApi 用 includes 依序比對）。
		const spy = mockApi([
			{
				method: "GET",
				path: "/api/friends/2/meals?date=2026-10-05",
				handler: () => json(dayResponse("2026-10-05", "昨天的麵")),
			},
			{
				method: "GET",
				path: "/api/friends/2/meals?date=2026-10-06",
				handler: () => json(dayResponse("2026-10-06", "今天的便當")),
			},
			{
				method: "GET",
				path: "/api/friends/2/meals",
				handler: () => json(dayResponse("2026-10-06", "今天的便當")),
			},
		]);
		renderDay();

		expect(
			await screen.findByRole("heading", { name: "鮑伯" }),
		).toBeInTheDocument();
		expect(await screen.findByText("今天的便當")).toBeInTheDocument();
		expect(String(spy.mock.calls[0]?.[0])).toMatch(/\/api\/friends\/2\/meals$/);

		await userEvent.click(screen.getByRole("button", { name: "前一天" }));
		expect(await screen.findByText("昨天的麵")).toBeInTheDocument();

		await userEvent.click(screen.getByRole("button", { name: "後一天" }));
		expect(await screen.findByText("今天的便當")).toBeInTheDocument();
	});

	it("那一天沒有餐", async () => {
		mockApi([
			{
				method: "GET",
				path: "/api/friends/2/meals",
				handler: () => json(dayResponse("2026-10-06", null)),
			},
		]);
		renderDay();

		expect(
			await screen.findByText("這一天沒有可以看的餐點"),
		).toBeInTheDocument();
	});

	it("不是好友（或剛被解除）：看不到", async () => {
		mockApi([
			{
				method: "GET",
				path: "/api/friends/2/meals",
				handler: () =>
					json(
						{
							error: {
								code: "FRIEND_NOT_FOUND",
								message: "找不到這個好友",
								details: {},
							},
						},
						404,
					),
			},
		]);
		renderDay();

		expect(await screen.findByText("看不到這個人的餐點")).toBeInTheDocument();
		expect(screen.getByRole("link", { name: "回飲食" })).toHaveAttribute(
			"href",
			"/diet?view=friends",
		);
	});

	it("某一天的卡片也顯示描述（跟動態同一個元件）", async () => {
		const day = dayResponse("2026-10-06", "今天的便當");
		mockApi([
			{
				method: "GET",
				path: "/api/friends/2/meals",
				handler: () =>
					json({
						...day,
						meals: day.meals.map((meal) => ({
							...meal,
							description: "公司樓下的雞腿便當",
						})),
					}),
			},
		]);
		renderDay();

		expect(
			await screen.findByTestId("friend-meal-description-7"),
		).toHaveTextContent("公司樓下的雞腿便當");
	});

	it("某一天的卡片也有讚的按鈕與「留言 N」（名字不在卡片上，但在可及名稱裡）", async () => {
		mockApi([
			{
				method: "GET",
				path: "/api/friends/2/meals",
				handler: () => json(dayResponse("2026-10-06", "今天的便當")),
			},
		]);
		renderDay();

		expect(
			await screen.findByRole("button", {
				name: "讚，鮑伯的午餐",
				pressed: false,
			}),
		).toHaveAccessibleDescription("1 個讚");
		const comments = screen.getByRole("link", {
			name: "鮑伯的午餐，留言 2 則",
		});
		expect(comments).toHaveAttribute("href", "/meals/7");
		expect(comments).toHaveTextContent(/^留言 2$/);
	});

	it("在某一天按讚：寫回這一天的快取（伺服器的數字），這一天不重抓", async () => {
		const spy = mockApi([
			{
				method: "PUT",
				path: "/api/social/meals/7/like",
				// 樂觀的是 1 ＋ 1；伺服器說 5。
				handler: () => json({ like_count: 5, liked_by_me: true }),
			},
			{
				method: "GET",
				path: "/api/friends/2/meals",
				handler: () => json(dayResponse("2026-10-06", "今天的便當")),
			},
		]);
		renderDay();

		await userEvent.click(
			await screen.findByRole("button", { name: "讚，鮑伯的午餐" }),
		);

		await waitFor(() =>
			expect(
				screen.getByRole("button", { name: "讚，鮑伯的午餐", pressed: true }),
			).toHaveAccessibleDescription("5 個讚"),
		);
		expect(
			spy.mock.calls.map(
				([url, init]) => `${init?.method ?? "GET"} ${String(url)}`,
			),
		).toEqual(["GET /api/friends/2/meals", "PUT /api/social/meals/7/like"]);
	});
});
