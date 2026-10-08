import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetRefreshStateForTests } from "../src/auth/refresh";
import {
	clearTokens,
	getRefreshToken,
	type LoggedOutEvent,
	onLoggedOut,
	setTokens,
} from "../src/auth/store";
import { useSessionConfirmed } from "../src/auth/use-session-confirmed";

function jsonResponse(status: number, body: unknown) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function unauthorized() {
	return jsonResponse(401, {
		error: {
			code: "INVALID_TOKEN",
			message: "token 無效或已過期",
			details: {},
		},
	});
}

const ME = {
	id: 1,
	email: "kenny@example.com",
	display_name: "Kenny",
	role: "user",
	timezone: "Asia/Taipei",
};

/** 等過一輪再斷言「還是 false」：立刻斷言在請求還沒回來的時候也成立（第 41 種）。 */
function settle() {
	return act(() => new Promise<void>((resolve) => setTimeout(resolve, 50)));
}

function mockFetch(respond: (url: string) => Response | Promise<Response>) {
	return vi
		.spyOn(globalThis, "fetch")
		.mockImplementation(async (input) => respond(String(input)));
}

function requestedPaths(spy: ReturnType<typeof mockFetch>): string[] {
	return spy.mock.calls.map(([url]) => String(url));
}

/** 記下 store 的登出通知；回傳的陣列會跟著長。訂閱在每條測試結束時取消（store 是模組層的）。 */
const unsubscribers: Array<() => void> = [];
function recordLogouts(): LoggedOutEvent[] {
	const events: LoggedOutEvent[] = [];
	unsubscribers.push(onLoggedOut((event) => events.push(event)));
	return events;
}

afterEach(() => {
	for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
});

beforeEach(() => {
	localStorage.clear();
	clearTokens();
	resetRefreshStateForTests();
	vi.restoreAllMocks();
	// 整頁載入之後的樣子：localStorage 裡有票，記憶體裡沒有 access token。
	setTokens({ access_token: "a", refresh_token: "r" });
	clearTokens({ keepStorage: true });
});

describe("useSessionConfirmed", () => {
	it("`/api/me` 回來之前是 false，成功（先換票）之後才是 true", async () => {
		let respondMe: (response: Response) => void = () => undefined;
		let refreshed = false;
		const spy = mockFetch((url) => {
			if (url === "/api/auth/refresh") {
				refreshed = true;
				return jsonResponse(200, { access_token: "a2", refresh_token: "r2" });
			}
			if (url === "/api/me") {
				if (!refreshed) return unauthorized();
				return new Promise<Response>((resolve) => {
					respondMe = resolve;
				});
			}
			throw new Error(`沒有準備：${url}`);
		});

		const { result } = renderHook(() => useSessionConfirmed());

		expect(result.current).toBe(false);
		await waitFor(() => expect(getRefreshToken()).toBe("r2"));
		await settle();
		// 換到票還不算：要的是一個帶著票的請求真的成功。
		expect(result.current).toBe(false);

		respondMe(jsonResponse(200, ME));

		await waitFor(() => expect(result.current).toBe(true));
		expect(requestedPaths(spy)).toEqual([
			"/api/me",
			"/api/auth/refresh",
			"/api/me",
		]);
	});

	it("票無效（`/api/me` 401、換票 401）：一直是 false；登出由 refresh.ts 通知，不是這裡", async () => {
		mockFetch(() => unauthorized());
		const logouts = recordLogouts();

		const { result } = renderHook(() => useSessionConfirmed());

		await waitFor(() => expect(logouts).toEqual([{ forced: true }]));
		await settle();
		expect(result.current).toBe(false);
		expect(getRefreshToken()).toBeNull();
	});

	it.each([
		[
			"連不上",
			(): Promise<Response> =>
				Promise.reject(new TypeError("network request failed")),
		],
		[
			"伺服器 500",
			(): Promise<Response> =>
				Promise.resolve(
					jsonResponse(500, {
						error: { code: "INTERNAL_ERROR", message: "壞了", details: {} },
					}),
				),
		],
	])("%s：不知道——維持 false，也不登出", async (_name, respond) => {
		const spy = mockFetch(respond);
		const logouts = recordLogouts();

		const { result } = renderHook(() => useSessionConfirmed());

		await waitFor(() => expect(spy).toHaveBeenCalled());
		await settle();
		expect(result.current).toBe(false);
		expect(logouts).toEqual([]);
		expect(getRefreshToken()).toBe("r");
	});
});
