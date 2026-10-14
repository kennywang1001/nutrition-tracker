import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetRefreshStateForTests } from "../src/auth/refresh";
import { clearTokens, setTokens } from "../src/auth/store";
import { TodayExercises } from "../src/components/TodayExercises";
import { formatTime } from "../src/lib/dates";
import { NO_EXERCISE, RUN } from "./helpers/exercise-routes";
import { json, mockApi } from "./helpers/mock-api";

const WALK = {
	...RUN,
	id: 32,
	performed_at: "2026-10-14T12:00:00Z",
	activity: "walking" as const,
	label: "走路",
	minutes: 20,
	kcal: "100.00",
};

function renderCard() {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	render(
		<QueryClientProvider client={client}>
			<MemoryRouter>
				<TodayExercises />
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

describe("今日運動卡片", () => {
	it("沒有運動：說今天還沒有運動；有「記運動」連結", async () => {
		mockApi([
			{
				method: "GET",
				path: "/api/exercises",
				handler: () => json(NO_EXERCISE),
			},
		]);
		renderCard();

		expect(
			screen.getByRole("heading", { name: "今日運動", level: 2 }),
		).toBeInTheDocument();
		expect(await screen.findByText("今天還沒有運動")).toBeInTheDocument();
		expect(screen.getByRole("link", { name: "記運動" })).toHaveAttribute(
			"href",
			"/exercises/new",
		);
		expect(screen.queryByText(/^共 /)).not.toBeInTheDocument();
	});

	it("兩筆：各一列連到編輯（名稱・分鐘、時間、-kcal），合計用後端的 total_kcal", async () => {
		mockApi([
			{
				method: "GET",
				path: "/api/exercises",
				handler: () =>
					json({
						date: "2026-10-14",
						total_kcal: "443.00",
						entries: [RUN, WALK],
					}),
			},
		]);
		renderCard();

		const list = await screen.findByRole("list", { name: "今日運動" });
		const links = within(list).getAllByRole("link");
		expect(links.map((link) => link.getAttribute("href"))).toEqual([
			"/exercises/31/edit",
			"/exercises/32/edit",
		]);
		expect(links[0]).toHaveTextContent("跑步（約 10 km/h）・30 分鐘");
		expect(links[0]).toHaveTextContent(formatTime(RUN.performed_at));
		expect(links[0]).toHaveTextContent("-343 kcal");
		expect(links[1]).toHaveTextContent("走路・20 分鐘");
		expect(links[1]).toHaveTextContent("-100 kcal");
		expect(screen.getByText("共 -443 kcal")).toBeInTheDocument();
	});

	it("載入失敗、沒有資料：說無法載入", async () => {
		mockApi([
			{
				method: "GET",
				path: "/api/exercises",
				handler: () =>
					json(
						{ error: { code: "INTERNAL_ERROR", message: "壞了", details: {} } },
						500,
					),
			},
		]);
		renderCard();

		expect(await screen.findByText("無法載入今天的運動")).toBeInTheDocument();
	});

	it("載入中", () => {
		mockApi([
			{
				method: "GET",
				path: "/api/exercises",
				handler: () => new Promise<Response>(() => {}),
			},
		]);
		renderCard();

		expect(screen.getByText("載入中…")).toBeInTheDocument();
	});
});
