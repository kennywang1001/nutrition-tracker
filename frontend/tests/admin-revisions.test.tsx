import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetRefreshStateForTests } from "../src/auth/refresh";
import { clearTokens, getRefreshToken, setTokens } from "../src/auth/store";
import { AdminRevisions } from "../src/screens/AdminRevisions";
import { json, mockApi, type Route } from "./helpers/mock-api";

// AdminRevisions 本身不用任何 react-router 的元件或 hook（沒有 <Link>，
// 「駁回理由」是一個 <form>，不是導覽）——不用包 MemoryRouter。
function wrap(children: ReactNode) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function errorEnvelope(code: string, message: string) {
	return { error: { code, message, details: {} } };
}

// 8 個數字刻意全部不同（165 / 31 / 3.6 / 0.5 / 170 / 32 / 4.1 / 1.2），
// 避免「目前生效」跟「提案」兩欄剛好印出同一個字串時，斷言分不清是哪一欄。
const REVISION_A = {
	id: 10,
	food_id: 66,
	food_name: "雞胸肉",
	food_brand: "全聯",
	base_unit: "g" as const,
	kcal: "170.00",
	protein_g: "32.00",
	fat_g: "4.10",
	carb_g: "1.20",
	status: "pending" as const,
	change_note: "調整包裝標示",
	created_by: 2,
	created_by_name: "小明",
	created_at: "2026-09-20T00:00:00Z",
	current_kcal: "165.00",
	current_protein_g: "31.00",
	current_fat_g: "3.60",
	current_carb_g: "0.50",
};

// 食物還沒有生效版本（規格 §5.5、§7.1 明寫的合法狀態）：四個 current_*
// 都是 null，畫面要顯示「—」，不是空白或 NaN。
const REVISION_NO_CURRENT = {
	id: 11,
	food_id: 67,
	food_name: "未生效的食物",
	food_brand: null,
	base_unit: "g" as const,
	kcal: "100.00",
	protein_g: "10.00",
	fat_g: "5.00",
	carb_g: "2.00",
	status: "pending" as const,
	change_note: null,
	created_by: 3,
	created_by_name: "阿華",
	created_at: "2026-09-21T00:00:00Z",
	current_kcal: null,
	current_protein_g: null,
	current_fat_g: null,
	current_carb_g: null,
};

function revisionResponse(
	revision: typeof REVISION_A,
	status: "approved" | "rejected",
) {
	return {
		id: revision.id,
		base_unit: revision.base_unit,
		kcal: revision.kcal,
		protein_g: revision.protein_g,
		fat_g: revision.fat_g,
		carb_g: revision.carb_g,
		status,
		change_note: revision.change_note,
		created_by: revision.created_by,
		created_at: revision.created_at,
		reviewed_by: 1,
		reviewed_at: "2026-09-22T00:00:00Z",
		reject_reason: status === "rejected" ? "數值跟包裝標示不符" : null,
		is_current: status === "approved",
	};
}

/** GET 佇列的路徑（`/api/admin/food-revisions`）是每一個 POST 審核端點
 *  （`/api/admin/food-revisions/{id}/approve`）的字串前綴，而 mock-api 是
 *  用 `url.includes(path)` 比對——這裡不會撞在一起，因為每個路由都指定了
 *  明確的 `method`（GET vs POST），mock-api 的比對是「method 也要對上」，
 *  不是只比路徑。仍然把具體路由排前面，跟 `food-detail.test.tsx` 的
 *  `foodRoutes` 同一個習慣。 */
function revisionRoutes(list: unknown[], extra: Route[] = []): Route[] {
	return [
		...extra,
		{
			method: "GET",
			path: "/api/admin/food-revisions",
			handler: () => json(list),
		},
	];
}

beforeEach(() => {
	localStorage.clear();
	clearTokens();
	resetRefreshStateForTests();
	vi.restoreAllMocks();
	setTokens({ access_token: "a", refresh_token: "r" });
});

describe("審核佇列 /admin/revisions", () => {
	it("新舊數值並排顯示；食物沒有生效版本時 current_* 顯示「—」", async () => {
		mockApi(revisionRoutes([REVISION_A, REVISION_NO_CURRENT]));

		render(wrap(<AdminRevisions />));

		const rowA = within(await screen.findByTestId("revision-10"));
		expect(rowA.getByText("雞胸肉（全聯）")).toBeInTheDocument();
		// 目前生效（4 個）
		expect(rowA.getByText("165")).toBeInTheDocument();
		expect(rowA.getByText("31")).toBeInTheDocument();
		expect(rowA.getByText("3.6")).toBeInTheDocument();
		expect(rowA.getByText("0.5")).toBeInTheDocument();
		// 提案（4 個）
		expect(rowA.getByText("170")).toBeInTheDocument();
		expect(rowA.getByText("32")).toBeInTheDocument();
		expect(rowA.getByText("4.1")).toBeInTheDocument();
		expect(rowA.getByText("1.2")).toBeInTheDocument();

		const rowNoCurrent = within(screen.getByTestId("revision-11"));
		expect(rowNoCurrent.getByText("未生效的食物")).toBeInTheDocument();
		expect(rowNoCurrent.getAllByText("—")).toHaveLength(4);
		expect(rowNoCurrent.queryByText(/NaN/)).not.toBeInTheDocument();
	});

	it("通過之後佇列重取", async () => {
		let listCalls = 0;
		mockApi([
			{
				method: "POST",
				path: `/api/admin/food-revisions/${REVISION_A.id}/approve`,
				handler: () => json(revisionResponse(REVISION_A, "approved")),
			},
			{
				method: "GET",
				path: "/api/admin/food-revisions",
				handler: () => {
					listCalls += 1;
					return listCalls === 1 ? json([REVISION_A]) : json([]);
				},
			},
		]);

		render(wrap(<AdminRevisions />));
		await screen.findByText("雞胸肉（全聯）");

		await userEvent.click(screen.getByRole("button", { name: "通過" }));

		expect(await screen.findByText("目前沒有待審的提案")).toBeInTheDocument();
		expect(listCalls).toBeGreaterThanOrEqual(2);
	});

	it("駁回沒填理由時送不出去——後端 min_length=1", async () => {
		const fetchMock = mockApi(revisionRoutes([REVISION_A]));

		render(wrap(<AdminRevisions />));
		await screen.findByText("雞胸肉（全聯）");

		await userEvent.click(screen.getByRole("button", { name: "駁回" }));

		expect(await screen.findByText("請輸入駁回理由")).toBeInTheDocument();
		const rejectCalls = fetchMock.mock.calls.filter(([input]) =>
			String(input).includes("/reject"),
		);
		expect(rejectCalls).toHaveLength(0);
	});

	it("403 FORBIDDEN 顯示「需要管理員權限」，而且不觸發登出", async () => {
		mockApi([
			{
				method: "GET",
				path: "/api/admin/food-revisions",
				handler: () => json(errorEnvelope("FORBIDDEN", "需要管理員權限"), 403),
			},
		]);

		render(wrap(<AdminRevisions />));

		expect(await screen.findByText("需要管理員權限")).toBeInTheDocument();
		// client.ts 只在 401 才換票、清 token；403 直接拋 ApiError。
		// 這裡驗證畫面沒有把 403 錯當登出訊號去清掉 refresh token。
		expect(getRefreshToken()).toBe("r");
	});

	it("409 REVISION_NOT_PENDING 顯示已經審核過，並重新載入佇列", async () => {
		let listCalls = 0;
		mockApi([
			{
				method: "POST",
				path: `/api/admin/food-revisions/${REVISION_A.id}/approve`,
				handler: () =>
					json(
						errorEnvelope("REVISION_NOT_PENDING", "這筆提案已經審核過了"),
						409,
					),
			},
			{
				method: "GET",
				path: "/api/admin/food-revisions",
				handler: () => {
					listCalls += 1;
					return json([REVISION_A]);
				},
			},
		]);

		render(wrap(<AdminRevisions />));
		await screen.findByText("雞胸肉（全聯）");

		await userEvent.click(screen.getByRole("button", { name: "通過" }));

		expect(await screen.findByText("這筆提案已經審核過了")).toBeInTheDocument();
		await waitFor(() => expect(listCalls).toBeGreaterThanOrEqual(2));
	});

	it("404 REVISION_NOT_FOUND 顯示找不到這筆提案", async () => {
		mockApi([
			{
				method: "POST",
				path: `/api/admin/food-revisions/${REVISION_A.id}/approve`,
				handler: () =>
					json(errorEnvelope("REVISION_NOT_FOUND", "找不到該編輯提案"), 404),
			},
			{
				method: "GET",
				path: "/api/admin/food-revisions",
				handler: () => json([REVISION_A]),
			},
		]);

		render(wrap(<AdminRevisions />));
		await screen.findByText("雞胸肉（全聯）");

		await userEvent.click(screen.getByRole("button", { name: "通過" }));

		expect(await screen.findByText("找不到該編輯提案")).toBeInTheDocument();
	});
});
