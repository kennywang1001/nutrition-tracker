import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { refreshTokens, resetRefreshStateForTests } from "../src/auth/refresh";
import { changePassword } from "../src/auth/session";
import { clearTokens, getRefreshToken, setTokens } from "../src/auth/store";

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

	it.each([
		[429, "TOO_MANY_SESSION_REQUESTS"],
		[500, "INTERNAL_ERROR"],
		[502, "BAD_GATEWAY"],
	])("後端回 %i：保留登入（票沒有被判定無效）", async (status, code) => {
		// 安全補強規格 §4.1：限速的 429、部署重啟的 502 都不代表票無效。
		// 以前任何非成功都會登出——NAS 一重啟，正在換票的人全被踢出去。
		setTokens({ access_token: "old", refresh_token: "r1" });
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(
				JSON.stringify({ error: { code, message: "x", details: {} } }),
				{ status, headers: { "content-type": "application/json" } },
			),
		);

		expect(await refreshTokens()).toBe(false);

		const { getRefreshToken } = await import("../src/auth/store");
		expect(getRefreshToken()).toBe("r1");
	});

	it("網路斷線：保留登入", async () => {
		setTokens({ access_token: "old", refresh_token: "r1" });
		vi.spyOn(globalThis, "fetch").mockRejectedValue(
			new TypeError("Failed to fetch"),
		);

		expect(await refreshTokens()).toBe(false);

		const { getRefreshToken } = await import("../src/auth/store");
		expect(getRefreshToken()).toBe("r1");
	});
});

describe("換票的鎖（navigator.locks 的 token-refresh）", () => {
	// jsdom 沒有 navigator.locks。這裡裝一個只有 `request` 的假實作：同名的請求排隊、
	// 一次一個（Web Locks 的預設模式），並記下被要求過的名字。
	let requested: string[] = [];

	beforeEach(() => {
		requested = [];
		const tails = new Map<string, Promise<unknown>>();
		Object.defineProperty(navigator, "locks", {
			configurable: true,
			value: {
				request: (name: string, callback: () => Promise<unknown>) => {
					requested.push(name);
					const run = (tails.get(name) ?? Promise.resolve()).then(callback);
					tails.set(
						name,
						run.catch(() => undefined),
					);
					return run;
				},
			},
		});
	});

	afterEach(() => {
		Reflect.deleteProperty(navigator, "locks");
	});

	function tokens(access: string, refresh: string) {
		return new Response(
			JSON.stringify({
				access_token: access,
				refresh_token: refresh,
				token_type: "bearer",
			}),
			{ status: 200, headers: { "content-type": "application/json" } },
		);
	}

	/** 讓已經排進 microtask／timer 的東西都跑完：沒被鎖擋住的請求這時一定已經送出去了。 */
	async function settle() {
		for (let turn = 0; turn < 5; turn += 1) {
			await new Promise((resolve) => setTimeout(resolve, 0));
		}
	}

	it("換票在 token-refresh 這把鎖裡做", async () => {
		setTokens({ access_token: "old", refresh_token: "r1" });
		vi.spyOn(globalThis, "fetch").mockResolvedValue(tokens("new", "r2"));

		expect(await refreshTokens()).toBe(true);

		expect(requested).toEqual(["token-refresh"]);
	});

	it("改密碼握著同一把鎖：這段期間開始的換票要等它做完，而且用的是新的那張票", async () => {
		// 沒有鎖的話：改密碼的請求還在路上，另一個請求（或另一個分頁）拿舊票去換——
		// 換得到的那張被改密碼一起撤銷，卻可能比改密碼的新票晚寫進 localStorage，把它
		// 蓋掉；或者換票排在撤銷之後直接 401，把剛改完密碼的這台登出（帳號設定審查 M6）。
		setTokens({ access_token: "a1", refresh_token: "r1" });
		let finishPasswordChange: (response: Response) => void = () => undefined;
		const refreshedWith: string[] = [];
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			const url = String(input);
			if (url.includes("/api/me/password")) {
				return new Promise<Response>((resolve) => {
					finishPasswordChange = resolve;
				});
			}
			if (url.includes("/api/auth/refresh")) {
				refreshedWith.push(JSON.parse(String(init?.body)).refresh_token);
				return tokens("a3", "r3");
			}
			throw new Error(`沒有準備這個請求：${url}`);
		});

		const changing = changePassword("old-password", "new-password-1");
		await settle();
		const refreshing = refreshTokens();
		await settle();

		// 改密碼還沒回來：換票不能已經送出去。
		expect(refreshedWith).toEqual([]);

		finishPasswordChange(tokens("a2", "r2"));
		await changing;
		expect(await refreshing).toBe(true);

		// 等到鎖之後重新讀 localStorage：用的是改密碼拿到的 r2，不是進來時的 r1。
		expect(refreshedWith).toEqual(["r2"]);
		expect(getRefreshToken()).toBe("r3");
		expect(requested).toEqual(["token-refresh", "token-refresh"]);
	});

	it("改密碼時 access token 已經過期：在自己握著的鎖裡換票、重送，不會卡死", async () => {
		// Web Locks 不能重入。改密碼握著鎖，401 之後如果照平常呼叫 refreshTokens()（它會再
		// 要一次同一把鎖），就永遠等不到自己放手。
		setTokens({ access_token: "expired", refresh_token: "r1" });
		const calls: string[] = [];
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			const url = String(input);
			const bearer = new Headers(init?.headers).get("authorization");
			if (url.includes("/api/me/password")) {
				calls.push(`password ${bearer}`);
				if (bearer === "Bearer a2") return tokens("a3", "r3");
				return new Response(
					JSON.stringify({
						error: { code: "INVALID_TOKEN", message: "x", details: {} },
					}),
					{ status: 401, headers: { "content-type": "application/json" } },
				);
			}
			if (url.includes("/api/auth/refresh")) {
				calls.push(`refresh ${JSON.parse(String(init?.body)).refresh_token}`);
				return tokens("a2", "r2");
			}
			throw new Error(`沒有準備這個請求：${url}`);
		});

		const outcome = await Promise.race([
			changePassword("old-password", "new-password-1").then(() => "done"),
			new Promise((resolve) => setTimeout(() => resolve("卡住了"), 500)),
		]);

		expect(outcome).toBe("done");
		expect(calls).toEqual([
			"password Bearer expired",
			"refresh r1",
			"password Bearer a2",
		]);
		expect(getRefreshToken()).toBe("r3");
		// 只要了一次鎖（改密碼自己的那一次）；裡面的換票沒有再要。
		expect(requested).toEqual(["token-refresh"]);
	});
});
