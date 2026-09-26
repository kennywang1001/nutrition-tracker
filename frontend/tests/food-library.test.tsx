import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetRefreshStateForTests } from "../src/auth/refresh";
import { clearTokens, setTokens } from "../src/auth/store";
import { FoodLibrary } from "../src/screens/FoodLibrary";
import { json, mockApi } from "./helpers/mock-api";

// 需要 MemoryRouter：FoodResultList 的 renderAction（Task 3 Step 3）與
// 「新增食物」連結都是 <Link>，不掛 Router 會直接炸掉。
function wrap(children: ReactNode) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return (
		<QueryClientProvider client={client}>
			<MemoryRouter initialEntries={["/foods"]}>{children}</MemoryRouter>
		</QueryClientProvider>
	);
}

function nutrition(kcal: string) {
	return {
		base_unit: "g" as const,
		kcal,
		protein_g: "0.00",
		fat_g: "0.00",
		carb_g: "0.00",
	};
}

const CHICKEN = {
	id: 1,
	name: "雞胸肉",
	brand: "全聯",
	is_global: true,
	nutrition: nutrition("165.00"),
};

const NO_REVISION_FOOD = {
	id: 66,
	name: "未生效的食物",
	brand: null,
	is_global: true,
	// 規格 §5.5：後端明寫的合法狀態（全域食物的初版被駁回）。
	// 開工前查證：GET /api/foods?scope=global 實測查得到這種食物。
	nutrition: null,
};

beforeEach(() => {
	localStorage.clear();
	clearTokens();
	resetRefreshStateForTests();
	vi.restoreAllMocks();
	setTokens({ access_token: "a", refresh_token: "r" });
});

describe("食物庫 /foods", () => {
	it("一進畫面不發搜尋請求——q 是空的", async () => {
		const fetchMock = mockApi([
			{ method: "GET", path: "/api/foods", handler: () => json([CHICKEN]) },
		]);

		render(wrap(<FoodLibrary />));

		// 等超過 debounce 的 300ms，確認「什麼都沒打字」不會在計時器到期時
		// 意外觸發一次查詢。
		await new Promise((resolve) => setTimeout(resolve, 350));

		expect(
			fetchMock.mock.calls.some(([input]) =>
				String(input).includes("/api/foods"),
			),
		).toBe(false);
	});

	it("輸入之後（等過 debounce）發出帶 q 的請求，結果顯示出來", async () => {
		const fetchMock = mockApi([
			{ method: "GET", path: "/api/foods", handler: () => json([CHICKEN]) },
		]);

		render(wrap(<FoodLibrary />));
		await userEvent.type(screen.getByLabelText("搜尋食物"), "雞");

		expect(await screen.findByText("雞胸肉")).toBeInTheDocument();

		const call = fetchMock.mock.calls.find(([input]) =>
			String(input).includes("/api/foods"),
		);
		expect(call).toBeDefined();
		expect(String(call?.[0])).toContain(`q=${encodeURIComponent("雞")}`);
	});

	it("切換 scope 會重新查詢，而且 scope 真的進了 URL", async () => {
		const fetchMock = mockApi([
			{ method: "GET", path: "/api/foods", handler: () => json([CHICKEN]) },
		]);

		render(wrap(<FoodLibrary />));
		await userEvent.type(screen.getByLabelText("搜尋食物"), "雞");
		await screen.findByText("雞胸肉");

		const firstCall = fetchMock.mock.calls.find(([input]) =>
			String(input).includes("/api/foods"),
		);
		expect(String(firstCall?.[0])).toContain("scope=all");

		await userEvent.click(screen.getByLabelText("公開食物"));

		await waitFor(() => {
			const globalCall = fetchMock.mock.calls.find(([input]) =>
				String(input).includes("scope=global"),
			);
			expect(globalCall).toBeDefined();
		});
	});

	it("nutrition 是 null 的食物顯示得出來，而且標示它沒有營養素資料", async () => {
		mockApi([
			{
				method: "GET",
				path: "/api/foods",
				handler: () => json([NO_REVISION_FOOD]),
			},
		]);

		render(wrap(<FoodLibrary />));
		await userEvent.type(screen.getByLabelText("搜尋食物"), "未生效");

		expect(await screen.findByText("未生效的食物")).toBeInTheDocument();
		expect(screen.getByText("尚無營養素資料")).toBeInTheDocument();

		// 「顯示得出來 + 標示」，不是「不能點」——食物庫這邊照常點得進詳情頁
		// （規格 §5.5、計畫 Task 3 Step 1 第 4 條）。
		const link = screen.getByRole("link", { name: "未生效的食物" });
		expect(link).toHaveAttribute("href", "/foods/66");
	});

	it("沒有結果時顯示「找不到符合的食物」，不是一片空白", async () => {
		mockApi([{ method: "GET", path: "/api/foods", handler: () => json([]) }]);

		render(wrap(<FoodLibrary />));
		await userEvent.type(screen.getByLabelText("搜尋食物"), "不存在的食物");

		expect(await screen.findByText("找不到符合的食物")).toBeInTheDocument();
	});

	it("「新增食物」連結存在", () => {
		mockApi([
			{ method: "GET", path: "/api/foods", handler: () => json([CHICKEN]) },
		]);

		render(wrap(<FoodLibrary />));

		expect(screen.getByRole("link", { name: "新增食物" })).toHaveAttribute(
			"href",
			"/foods/new",
		);
	});
});
