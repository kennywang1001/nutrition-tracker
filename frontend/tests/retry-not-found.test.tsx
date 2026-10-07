import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useFood } from "../src/api/foods";
import { resetRefreshStateForTests } from "../src/auth/refresh";
import { clearTokens, setTokens } from "../src/auth/store";
import { json, mockApi } from "./helpers/mock-api";

/** 不關重試（跟各畫面測試的 `retry: false` 不同）；`retryDelay` 縮短，
 *  重試的那一組才不會等上 7 秒。 */
function renderUseFood(foodId: number) {
	const client = new QueryClient({
		defaultOptions: { queries: { retryDelay: 1 } },
	});
	return renderHook(() => useFood(foodId), {
		wrapper: ({ children }: { children: ReactNode }) => (
			<QueryClientProvider client={client}>{children}</QueryClientProvider>
		),
	});
}

function foodCalls(fetchMock: ReturnType<typeof mockApi>) {
	return fetchMock.mock.calls.filter(([input]) =>
		String(input).endsWith("/api/foods/7"),
	);
}

beforeEach(() => {
	localStorage.clear();
	clearTokens();
	resetRefreshStateForTests();
	vi.restoreAllMocks();
	setTokens({ access_token: "a", refresh_token: "r" });
});

describe("useFood 的重試", () => {
	it("404 不重試：只打一次", async () => {
		const fetchMock = mockApi([
			{
				path: "/api/foods/7",
				handler: () =>
					json(
						{
							error: {
								code: "FOOD_NOT_FOUND",
								message: "找不到該食物",
								details: {},
							},
						},
						404,
					),
			},
		]);
		const { result } = renderUseFood(7);

		await waitFor(() => expect(result.current.isError).toBe(true));
		expect(foodCalls(fetchMock)).toHaveLength(1);
	});

	it("其他錯誤照樣重試（最多 3 次）", async () => {
		const fetchMock = mockApi([
			{
				path: "/api/foods/7",
				handler: () =>
					json({ error: { code: "X", message: "x", details: {} } }, 500),
			},
		]);
		const { result } = renderUseFood(7);

		await waitFor(() => expect(result.current.isError).toBe(true));
		expect(foodCalls(fetchMock)).toHaveLength(4);
	});
});
