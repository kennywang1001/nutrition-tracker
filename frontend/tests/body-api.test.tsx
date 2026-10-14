import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	applySuggestion,
	deleteWeight,
	invalidateBody,
	saveBodyProfile,
	saveWeight,
	useTargetSuggestion,
	useWeights,
} from "../src/api/body";
import { queryKeys } from "../src/api/queries";
import { resetRefreshStateForTests } from "../src/auth/refresh";
import { clearTokens, setTokens } from "../src/auth/store";
import { EMPTY_PROFILE } from "./helpers/body-routes";
import { json, mockApi } from "./helpers/mock-api";

function wrapper(client: QueryClient) {
	return ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
}

/** 每一個請求的（方法、網址、body）：`mockApi` 只比對路徑的子字串，打的是哪一支、
 *  用什麼方法要看實際送出去的。 */
function sent(spy: ReturnType<typeof mockApi>) {
	return spy.mock.calls.map(([url, init]) => ({
		method: (init?.method ?? "GET").toUpperCase(),
		url: String(url),
		body: typeof init?.body === "string" ? init.body : null,
	}));
}

beforeEach(() => {
	localStorage.clear();
	clearTokens();
	resetRefreshStateForTests();
	vi.restoreAllMocks();
	setTokens({ access_token: "a", refresh_token: "r" });
});

describe("體重的寫入", () => {
	it("saveWeight 送 PUT /api/weights/{日期}，體重是字串原樣", async () => {
		const spy = mockApi([
			{
				method: "PUT",
				path: "/api/weights/2026-10-14",
				handler: () => json({ date: "2026-10-14", weight_kg: "72.40" }),
			},
		]);

		await expect(saveWeight("2026-10-14", "72.4")).resolves.toEqual({
			date: "2026-10-14",
			weight_kg: "72.40",
		});

		expect(sent(spy)).toEqual([
			{
				method: "PUT",
				url: "/api/weights/2026-10-14",
				body: '{"weight_kg":"72.4"}',
			},
		]);
	});

	it("deleteWeight 送 DELETE（204 沒有 body）", async () => {
		const spy = mockApi([
			{
				method: "DELETE",
				path: "/api/weights/2026-10-10",
				handler: () => new Response(null, { status: 204 }),
			},
		]);

		await deleteWeight("2026-10-10");

		expect(sent(spy)).toEqual([
			{ method: "DELETE", url: "/api/weights/2026-10-10", body: null },
		]);
	});
});

describe("身體資料與建議", () => {
	it("saveBodyProfile 送 PUT /api/me/body-profile，七個鍵都在", async () => {
		const spy = mockApi([
			{
				method: "PUT",
				path: "/api/me/body-profile",
				handler: () => json(EMPTY_PROFILE),
			},
		]);

		await saveBodyProfile(EMPTY_PROFILE);

		const [request] = sent(spy);
		expect(request?.method).toBe("PUT");
		expect(request?.url).toBe("/api/me/body-profile");
		expect(Object.keys(JSON.parse(request?.body ?? "{}")).sort()).toEqual([
			"activity_level",
			"birth_year",
			"goal",
			"height_cm",
			"rate_kg_per_week",
			"sex",
			"target_weight_kg",
		]);
	});

	it("applySuggestion 送 POST …/apply，帶畫面上的四個數字", async () => {
		const spy = mockApi([
			{
				method: "POST",
				path: "/api/me/target-suggestion/apply",
				handler: () =>
					json({
						effective_from: "2026-10-14",
						kcal: "2110.00",
						protein_g: "144.00",
						fat_g: "59.00",
						carb_g: "251.00",
					}),
			},
		]);

		await applySuggestion({
			kcal: "2110",
			protein_g: "144",
			fat_g: "59",
			carb_g: "251",
		});

		expect(sent(spy)).toEqual([
			{
				method: "POST",
				url: "/api/me/target-suggestion/apply",
				body: '{"kcal":"2110","protein_g":"144","fat_g":"59","carb_g":"251"}',
			},
		]);
	});

	it("useTargetSuggestion 在 ready: false 時收窄得出 missing", async () => {
		mockApi([
			{
				method: "GET",
				path: "/api/me/target-suggestion",
				handler: () => json({ ready: false, missing: ["sex", "weight"] }),
			},
		]);
		const client = new QueryClient();

		const { result } = renderHook(() => useTargetSuggestion(), {
			wrapper: wrapper(client),
		});

		await waitFor(() => expect(result.current.isSuccess).toBe(true));
		const data = result.current.data;
		// 這一段也是給 typecheck 看的：`ready` 收窄之後才拿得到 `missing`／`kcal`。
		if (data === undefined || data.ready)
			throw new Error("應該是 ready: false");
		expect(data.missing).toEqual(["sex", "weight"]);
	});

	it("useWeights 打 GET /api/weights（不帶日期：今天由後端決定）", async () => {
		const spy = mockApi([
			{
				method: "GET",
				path: "/api/weights",
				handler: () => json({ today: "2026-10-14", entries: [] }),
			},
		]);
		const client = new QueryClient();

		const { result } = renderHook(() => useWeights(), {
			wrapper: wrapper(client),
		});

		await waitFor(() => expect(result.current.isSuccess).toBe(true));
		expect(result.current.data?.today).toBe("2026-10-14");
		expect(sent(spy)).toEqual([
			{ method: "GET", url: "/api/weights", body: null },
		]);
	});

	it("invalidateBody 一次打到身體資料、建議、體重，不碰別的", async () => {
		const client = new QueryClient();
		client.setQueryData(queryKeys.bodyProfile, EMPTY_PROFILE);
		client.setQueryData(queryKeys.targetSuggestion, {
			ready: false,
			missing: [],
		});
		client.setQueryData(queryKeys.weights, {
			today: "2026-10-14",
			entries: [],
		});
		client.setQueryData(queryKeys.me, { id: 1 });

		await invalidateBody(client);

		for (const key of [
			queryKeys.bodyProfile,
			queryKeys.targetSuggestion,
			queryKeys.weights,
		]) {
			expect(client.getQueryState(key)?.isInvalidated).toBe(true);
		}
		expect(client.getQueryState(queryKeys.me)?.isInvalidated).toBe(false);
	});
});
