import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useLibrarySuggestions } from "../src/api/planner";
import { resetRefreshStateForTests } from "../src/auth/refresh";
import { clearTokens, setTokens } from "../src/auth/store";
import { json, mockApi } from "./helpers/mock-api";
import { OK_SUGGESTIONS } from "./helpers/planner-routes";

beforeEach(() => {
	localStorage.clear();
	clearTokens();
	resetRefreshStateForTests();
	vi.restoreAllMocks();
	setTokens({ access_token: "a", refresh_token: "r" });
});

/** `staleTime` 跟 app 的 `queryClient` 一樣是 60 秒：「掛兩次會抓兩次」只有在預設會留住快取時
 *  才證明得了 `useLibrarySuggestions` 自己的 `staleTime: 0`。 */
function newClient() {
	return new QueryClient({
		defaultOptions: { queries: { retry: false, staleTime: 60_000 } },
	});
}

function wrapper(client: QueryClient) {
	return ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
}

describe("useLibrarySuggestions", () => {
	it("GET /api/planner/library-suggestions，回傳 body", async () => {
		const spy = mockApi([
			{
				method: "GET",
				path: "/api/planner/library-suggestions",
				handler: () => json(OK_SUGGESTIONS),
			},
		]);
		const { result } = renderHook(() => useLibrarySuggestions(), {
			wrapper: wrapper(newClient()),
		});

		await waitFor(() => expect(result.current.isSuccess).toBe(true));
		expect(result.current.data).toEqual(OK_SUGGESTIONS);
		expect(spy.mock.calls.map(([url]) => String(url))).toEqual([
			"/api/planner/library-suggestions",
		]);
	});

	it("每次掛載都重抓（剛記完一餐回來，剩下的就變了）", async () => {
		const spy = mockApi([
			{
				method: "GET",
				path: "/api/planner/library-suggestions",
				handler: () => json(OK_SUGGESTIONS),
			},
		]);
		const client = newClient();

		const first = renderHook(() => useLibrarySuggestions(), {
			wrapper: wrapper(client),
		});
		await waitFor(() => expect(first.result.current.isSuccess).toBe(true));
		first.unmount();

		const second = renderHook(() => useLibrarySuggestions(), {
			wrapper: wrapper(client),
		});
		await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
		await waitFor(() => expect(second.result.current.isFetching).toBe(false));
	});
});
