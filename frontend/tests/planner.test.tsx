import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LibrarySuggestions } from "../src/api/planner";
import { resetRefreshStateForTests } from "../src/auth/refresh";
import { clearTokens, setTokens } from "../src/auth/store";
import { itemsState } from "../src/lib/planner";
import { Planner } from "../src/screens/Planner";
import { json, mockApi } from "./helpers/mock-api";
import {
	OK_SUGGESTIONS,
	plannerRoutes,
	suggestionsWithStatus,
} from "./helpers/planner-routes";

beforeEach(() => {
	localStorage.clear();
	clearTokens();
	resetRefreshStateForTests();
	vi.restoreAllMocks();
	setTokens({ access_token: "a", refresh_token: "r" });
});

/** 記一餐的替身：把帶過來的 router state 原樣印出來，看「記成一餐」與「讓 AI 配一餐」帶了什麼。 */
function StateProbe() {
	const location = useLocation();
	return <pre data-testid="state">{JSON.stringify(location.state)}</pre>;
}

function renderPlanner() {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return render(
		<QueryClientProvider client={client}>
			<MemoryRouter initialEntries={["/planner"]}>
				<Routes>
					<Route path="/planner" element={<Planner />} />
					<Route path="/meals/new" element={<StateProbe />} />
					<Route path="/me/targets" element={<p>目標頁</p>} />
				</Routes>
			</MemoryRouter>
		</QueryClientProvider>,
	);
}

const FIRST = OK_SUGGESTIONS.combos[0];
if (FIRST === undefined) throw new Error("OK_SUGGESTIONS 至少要有一組");

describe("/planner 今天還能吃什麼（營養素配餐規格 §7.3）", () => {
	it("標題與「還能吃」：熱量與有目標的營養素；沒設目標的不列", async () => {
		mockApi(plannerRoutes());
		renderPlanner();

		expect(
			screen.getByRole("heading", { level: 1, name: "今天還能吃什麼" }),
		).toBeInTheDocument();
		const remaining = await screen.findByRole("region", { name: "還能吃" });
		const terms = within(remaining)
			.getAllByRole("term")
			.map((term) => term.textContent);
		const values = within(remaining)
			.getAllByRole("definition")
			.map((value) => value.textContent);
		expect(terms).toEqual(["熱量", "蛋白質"]);
		expect(values).toEqual(["700 kcal", "50 g"]);
	});

	it("每一組一張：組合 N、每一樣一行、合計、佔剩下的熱量", async () => {
		mockApi(plannerRoutes());
		renderPlanner();

		const list = await screen.findByRole("list", { name: "從食物庫配的組合" });
		// 直接子層：每一組裡面每一樣也是 listitem（巢狀清單）。
		const combos = within(list)
			.getAllByRole("listitem")
			.filter((item) => item.parentElement === list);
		expect(combos).toHaveLength(2);
		const [first] = combos;
		if (first === undefined) throw new Error("沒有第一組");
		expect(
			within(first).getByRole("heading", { level: 3, name: "組合 1" }),
		).toBeInTheDocument();
		const lines = within(first)
			.getAllByRole("listitem")
			.map((item) => item.textContent);
		expect(lines).toEqual([
			"雞胸 175 g・192.5 kcal",
			"白飯 1.5 份（1 碗）・540 kcal",
		]);
		// 合計拆成四段（各自不換行）：看整個段落的字。
		expect(
			within(first)
				.getByText(/^合計 /)
				.closest("p"),
		).toHaveTextContent(
			/^合計 732\.5 kcal・蛋白質 49\.25 g・脂肪 4\.13 g・碳水 120 g$/,
		);
		expect(within(first).getByText("佔剩下的熱量 105%")).toBeInTheDocument();
	});

	it("「記成一餐」帶著那一組的 router state 到記一餐", async () => {
		mockApi(plannerRoutes());
		renderPlanner();

		await userEvent.click(
			await screen.findByRole("button", { name: "把組合 1 記成一餐" }),
		);

		expect(screen.getByTestId("state").textContent).toBe(
			JSON.stringify(itemsState(FIRST)),
		);
	});

	it("「讓 AI 配一餐」帶著 plannerSuggest 到記一餐", async () => {
		mockApi(plannerRoutes());
		renderPlanner();

		await userEvent.click(
			await screen.findByRole("button", { name: "讓 AI 配一餐" }),
		);

		expect(screen.getByTestId("state").textContent).toBe(
			'{"plannerSuggest":true}',
		);
	});

	it.each<{
		status: Exclude<LibrarySuggestions["status"], "ok">;
		text: string;
		ai: boolean;
	}>([
		{
			status: "no_target",
			text: "先設定每日目標，才知道今天還能吃多少",
			ai: false,
		},
		{ status: "full", text: "今天的熱量差不多用完了", ai: false },
		{
			status: "no_candidates",
			text: "先記幾餐，常吃的食物會出現在這裡",
			ai: true,
		},
		{ status: "no_fit", text: "常吃的食物裡，沒有份量夠小的組合", ai: true },
	])("$status：「$text」；讓 AI 配一餐：$ai", async ({ status, text, ai }) => {
		mockApi(plannerRoutes(suggestionsWithStatus(status)));
		renderPlanner();

		expect(await screen.findByText(text)).toBeInTheDocument();
		expect(
			screen.queryByRole("list", { name: "從食物庫配的組合" }),
		).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "讓 AI 配一餐" }) !== null,
		).toBe(ai);
		if (status === "no_target") {
			expect(
				screen.getByRole("link", { name: "設定每日目標" }),
			).toHaveAttribute("href", "/me/targets");
			// 沒有額度就沒有「還能吃」可列（`remaining` 是 null）。
			expect(
				screen.queryByRole("region", { name: "還能吃" }),
			).not.toBeInTheDocument();
		} else {
			expect(
				screen.getByRole("region", { name: "還能吃" }),
			).toBeInTheDocument();
		}
	});

	it("載入失敗：「無法載入建議」，「再試一次」會再打一次", async () => {
		let calls = 0;
		mockApi([
			{
				method: "GET",
				path: "/api/planner/library-suggestions",
				handler: () => {
					calls += 1;
					return calls === 1
						? json(
								{
									error: { code: "INTERNAL", message: "x", details: {} },
								},
								500,
							)
						: json(OK_SUGGESTIONS);
				},
			},
		]);
		renderPlanner();

		expect(await screen.findByRole("alert")).toHaveTextContent("無法載入建議");
		await userEvent.click(screen.getByRole("button", { name: "再試一次" }));

		expect(
			await screen.findByRole("list", { name: "從食物庫配的組合" }),
		).toBeInTheDocument();
		expect(calls).toBe(2);
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
	});
});
