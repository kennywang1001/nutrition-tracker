import { beforeEach, describe, expect, it, vi } from "vitest";
import { refreshTokens, resetRefreshStateForTests } from "../src/auth/refresh";
import { clearTokens, setTokens } from "../src/auth/store";

beforeEach(() => {
	localStorage.clear();
	clearTokens();
	resetRefreshStateForTests();
	vi.restoreAllMocks();
});

describe("single-flight refresh", () => {
	it("同時呼叫三次，只會送出一個請求", async () => {
		// 規格 §6.4：後端的重用偵測讓「同時兩個 refresh 在飛」變成會導致
		// 使用者莫名被登出的錯誤。這條測試守的就是那件事。
		setTokens({ access_token: "old", refresh_token: "r1" });

		let calls = 0;
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockImplementation(async () => {
				calls += 1;
				// 刻意讓它慢一點，確保三個呼叫真的重疊
				await new Promise((resolve) => setTimeout(resolve, 20));
				return new Response(
					JSON.stringify({
						access_token: "new",
						refresh_token: "r2",
						token_type: "bearer",
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			});

		const results = await Promise.all([
			refreshTokens(),
			refreshTokens(),
			refreshTokens(),
		]);

		expect(calls).toBe(1);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(results).toEqual([true, true, true]);
	});

	it("換到新票之後，store 裡是新的那一張", async () => {
		setTokens({ access_token: "old", refresh_token: "r1" });
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(
				JSON.stringify({
					access_token: "new",
					refresh_token: "r2",
					token_type: "bearer",
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			),
		);

		await refreshTokens();

		const { getAccessToken, getRefreshToken } = await import(
			"../src/auth/store"
		);
		expect(getAccessToken()).toBe("new");
		expect(getRefreshToken()).toBe("r2");
	});

	it("沒有 refresh token 時直接回 false，不發請求", async () => {
		const fetchMock = vi.spyOn(globalThis, "fetch");

		expect(await refreshTokens()).toBe(false);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("後端回 401 時清空 token 並回 false", async () => {
		// INVALID_TOKEN 可能是「票過期了」也可能是「重用偵測撤銷了整條鏈」——
		// 前端分不出來，處理一律相同（規格 §6.5）。
		setTokens({ access_token: "old", refresh_token: "r1" });
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(
				JSON.stringify({
					error: {
						code: "INVALID_TOKEN",
						message: "token 無效或已過期",
						details: {},
					},
				}),
				{ status: 401, headers: { "content-type": "application/json" } },
			),
		);

		expect(await refreshTokens()).toBe(false);

		const { getRefreshToken } = await import("../src/auth/store");
		expect(getRefreshToken()).toBeNull();
	});

	it("一次失敗之後，下一次呼叫會重新嘗試", async () => {
		// in-flight 的 promise 必須在結束後被清掉，否則第一次失敗會把
		// 「已經失敗」這個結果永遠快取住，使用者重新登入也沒用。
		setTokens({ access_token: "old", refresh_token: "r1" });
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						error: { code: "INVALID_TOKEN", message: "x", details: {} },
					}),
					{
						status: 401,
						headers: { "content-type": "application/json" },
					},
				),
			)
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						access_token: "new",
						refresh_token: "r2",
						token_type: "bearer",
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
			);

		expect(await refreshTokens()).toBe(false);
		setTokens({ access_token: "old", refresh_token: "r3" });
		expect(await refreshTokens()).toBe(true);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});
});
