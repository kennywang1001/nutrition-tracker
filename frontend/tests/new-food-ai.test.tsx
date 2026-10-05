import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { MemoryRouter, Route, Routes, useParams } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetRefreshStateForTests } from "../src/auth/refresh";
import { clearTokens, setTokens } from "../src/auth/store";
import { NewFood } from "../src/screens/NewFood";
import { json, mockApi } from "./helpers/mock-api";

vi.mock("../src/lib/resize-image", () => ({
	shrinkToLongestEdge: vi.fn((file: File) => Promise.resolve(file)),
}));

/** 用真的 react-router 比對確認「導到正確的 id」（同 new-food.test.tsx）。 */
function FakeFoodDetail() {
	const { id } = useParams();
	return <p>food-detail:{id}</p>;
}

function wrap(children: ReactNode) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return (
		<QueryClientProvider client={client}>
			<MemoryRouter initialEntries={["/foods/new"]}>
				<Routes>
					<Route path="/foods/new" element={children} />
					<Route path="/foods/:id" element={<FakeFoodDetail />} />
				</Routes>
			</MemoryRouter>
		</QueryClientProvider>
	);
}

const ESTIMATE = {
	analysis_id: 12,
	food_id: null,
	name: "牛肉麵",
	brand: null,
	nutrition: {
		base_unit: "g",
		serving_grams: "550.00",
		kcal: "112.73",
		protein_g: "5.82",
		fat_g: "3.27",
		carb_g: "14.55",
		serving_kcal: "620.00",
		serving_protein_g: "32.00",
		serving_fat_g: "18.00",
		serving_carb_g: "80.00",
	},
	confidence: "0.37",
	consistency: { atwater_kcal: "610.00", deviation: "10.00", flagged: false },
	remaining_today: 19,
};

beforeEach(() => {
	localStorage.clear();
	clearTokens();
	resetRefreshStateForTests();
	vi.restoreAllMocks();
	setTokens({ access_token: "a", refresh_token: "r" });
});

describe("新增食物：用 AI 填", () => {
	it("描述 → 估算 → 確認：存好之後導到那個食物的詳情頁", async () => {
		const fetchMock = mockApi([
			{
				method: "POST",
				path: "/api/ai/analyze",
				handler: () => json(ESTIMATE),
			},
			{
				method: "POST",
				path: "/api/foods",
				handler: () => json({ ...ESTIMATE, id: 30, is_global: false }, 201),
			},
		]);
		render(wrap(<NewFood />));

		await userEvent.type(screen.getByLabelText("描述這個食物"), "一碗牛肉麵");
		await userEvent.click(screen.getByRole("button", { name: "估算" }));
		const card = await screen.findByRole("region", { name: "AI 估算結果" });
		await userEvent.click(within(card).getByRole("button", { name: "確認" }));

		expect(await screen.findByText("food-detail:30")).toBeInTheDocument();
		const analyzeCall = fetchMock.mock.calls.find(([input]) =>
			String(input).includes("/api/ai/analyze"),
		);
		expect(JSON.parse(String(analyzeCall?.[1]?.body))).toEqual({
			kind: "text",
			text: "一碗牛肉麵",
		});
	});

	it("沒有描述時只有拍照估算；手動填表單的路照舊", () => {
		mockApi([]);
		render(wrap(<NewFood />));

		expect(
			screen.queryByRole("button", { name: "估算" }),
		).not.toBeInTheDocument();
		expect(screen.getByLabelText("拍照估算")).toBeInTheDocument();
		expect(screen.getByLabelText("名稱")).toBeInTheDocument();
	});
});
