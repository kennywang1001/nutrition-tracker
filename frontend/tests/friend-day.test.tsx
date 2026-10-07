import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
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
});
