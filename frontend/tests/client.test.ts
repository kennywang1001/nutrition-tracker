import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiFetch } from "../src/api/client";
import { ApiError } from "../src/api/errors";
import { resetRefreshStateForTests } from "../src/auth/refresh";
import { clearTokens, setTokens } from "../src/auth/store";

function ok(body: unknown) {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

function unauthorized() {
	return new Response(
		JSON.stringify({
			error: {
				code: "INVALID_TOKEN",
				message: "token 無效或已過期",
				details: {},
			},
		}),
		{ status: 401, headers: { "content-type": "application/json" } },
	);
}

beforeEach(() => {
	localStorage.clear();
	clearTokens();
	resetRefreshStateForTests();
	vi.restoreAllMocks();
});

describe("apiFetch", () => {
	it("帶上 Authorization", async () => {
		setTokens({ access_token: "a", refresh_token: "r" });
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(ok({ ok: true }));

		await apiFetch("/api/me");

		const init = fetchMock.mock.calls[0]?.[1];
		expect(new Headers(init?.headers).get("authorization")).toBe("Bearer a");
	});

	it("沒有 token 時不帶 Authorization，而不是帶 'Bearer null'", async () => {
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(ok({ ok: true }));

		await apiFetch("/api/health");

		const init = fetchMock.mock.calls[0]?.[1];
		expect(new Headers(init?.headers).has("authorization")).toBe(false);
	});

	it("401 之後換票並重送一次，成功就回新結果", async () => {
		setTokens({ access_token: "old", refresh_token: "r1" });
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(unauthorized())
			.mockResolvedValueOnce(
				ok({ access_token: "new", refresh_token: "r2", token_type: "bearer" }),
			)
			.mockResolvedValueOnce(ok({ display_name: "我" }));

		const body = await apiFetch<{ display_name: string }>("/api/me");

		// apiFetch 的回傳型別是 T | null（204 時回 null），
		// 所以要用 ?. —— 如果真的是 null，這個斷言會因為
		// undefined !== "我" 而正確地失敗，不會被靜默放過。
		expect(body?.display_name).toBe("我");
		expect(fetchMock).toHaveBeenCalledTimes(3);
		// 重送那一次要帶新的 token
		const retryInit = fetchMock.mock.calls[2]?.[1];
		expect(new Headers(retryInit?.headers).get("authorization")).toBe(
			"Bearer new",
		);
	});

	it("重送之後又 401 就不再重試", async () => {
		// 規格 §6.2：重送之後又 401 代表問題不在票過期，
		// 無限重試只會把 429 也一起惹出來。
		setTokens({ access_token: "old", refresh_token: "r1" });
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(unauthorized())
			.mockResolvedValueOnce(
				ok({ access_token: "new", refresh_token: "r2", token_type: "bearer" }),
			)
			.mockResolvedValueOnce(unauthorized());

		await expect(apiFetch("/api/me")).rejects.toBeInstanceOf(ApiError);
		expect(fetchMock).toHaveBeenCalledTimes(3);
	});

	it("換票失敗時直接拋，不重送原請求", async () => {
		setTokens({ access_token: "old", refresh_token: "r1" });
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(unauthorized())
			.mockResolvedValueOnce(unauthorized()); // refresh 也失敗

		await expect(apiFetch("/api/me")).rejects.toBeInstanceOf(ApiError);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("非 401 的錯誤不會觸發換票", async () => {
		// 404 拿去換票是沒有意義的，而且會白白消耗一次輪替
		// （後端的輪替是一次性的，換一次就少一張）。
		setTokens({ access_token: "a", refresh_token: "r" });
		const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(
				JSON.stringify({
					error: { code: "MEAL_NOT_FOUND", message: "找不到", details: {} },
				}),
				{ status: 404, headers: { "content-type": "application/json" } },
			),
		);

		await expect(apiFetch("/api/meals/1")).rejects.toMatchObject({
			code: "MEAL_NOT_FOUND",
		});
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("204 不嘗試解析 body", async () => {
		// 登出兩個端點都回 204。對空 body 呼叫 .json() 會拋。
		setTokens({ access_token: "a", refresh_token: "r" });
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(null, { status: 204 }),
		);

		await expect(
			apiFetch("/api/auth/logout-all", { method: "POST" }),
		).resolves.toBeNull();
	});
});
