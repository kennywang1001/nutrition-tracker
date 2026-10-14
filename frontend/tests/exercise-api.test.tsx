import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	createExercise,
	deleteExercise,
	invalidateExercises,
	updateExercise,
	useActivities,
	useExercise,
	useExerciseEstimate,
	useTodayExercises,
} from "../src/api/exercises";
import { exerciseAddsToBudgetOf, type Me } from "../src/api/me";
import { queryKeys } from "../src/api/queries";
import {
	type DailyStats,
	exerciseInBudgetOf,
	kcalBudgetOf,
} from "../src/api/stats";
import { resetRefreshStateForTests } from "../src/auth/refresh";
import { clearTokens, setTokens } from "../src/auth/store";
import { ACTIVITY_LIST, NO_EXERCISE, RUN } from "./helpers/exercise-routes";
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

describe("運動的寫入", () => {
	it("createExercise 送 POST /api/exercises，body 原樣", async () => {
		const spy = mockApi([
			{ method: "POST", path: "/api/exercises", handler: () => json(RUN, 201) },
		]);
		const body = {
			activity: "running" as const,
			name: null,
			minutes: 30,
			performed_at: "2026-10-14T10:30:00.000Z",
			note: null,
		};

		await expect(createExercise(body)).resolves.toEqual(RUN);

		expect(sent(spy)).toEqual([
			{ method: "POST", url: "/api/exercises", body: JSON.stringify(body) },
		]);
	});

	it("updateExercise 送 PATCH /api/exercises/{id}，kcal: null 照樣送出去", async () => {
		const spy = mockApi([
			{ method: "PATCH", path: "/api/exercises/31", handler: () => json(RUN) },
		]);

		await updateExercise(31, { minutes: 60, kcal: null });

		expect(sent(spy)).toEqual([
			{
				method: "PATCH",
				url: "/api/exercises/31",
				body: '{"minutes":60,"kcal":null}',
			},
		]);
	});

	it("deleteExercise 送 DELETE（204 沒有 body）", async () => {
		const spy = mockApi([
			{
				method: "DELETE",
				path: "/api/exercises/31",
				handler: () => new Response(null, { status: 204 }),
			},
		]);

		await deleteExercise(31);

		expect(sent(spy)).toEqual([
			{ method: "DELETE", url: "/api/exercises/31", body: null },
		]);
	});
});

describe("運動的讀取", () => {
	it("useActivities 打 GET /api/exercise/activities，key 不在 exercises 底下", async () => {
		const spy = mockApi([
			{
				method: "GET",
				path: "/api/exercise/activities",
				handler: () => json(ACTIVITY_LIST),
			},
		]);
		const client = new QueryClient();

		const { result } = renderHook(() => useActivities(), {
			wrapper: wrapper(client),
		});

		await waitFor(() => expect(result.current.isSuccess).toBe(true));
		expect(result.current.data).toEqual(ACTIVITY_LIST);
		expect(sent(spy)).toEqual([
			{ method: "GET", url: "/api/exercise/activities", body: null },
		]);
		// 失效 exercisesAll 不該連帶重抓固定的清單。
		await client.invalidateQueries({ queryKey: queryKeys.exercisesAll });
		expect(
			client.getQueryState(queryKeys.exerciseActivities)?.isInvalidated,
		).toBe(false);
	});

	it("useTodayExercises 打 GET /api/exercises（不帶日期：今天由後端決定）", async () => {
		const spy = mockApi([
			{
				method: "GET",
				path: "/api/exercises",
				handler: () => json(NO_EXERCISE),
			},
		]);
		const client = new QueryClient();

		const { result } = renderHook(() => useTodayExercises(), {
			wrapper: wrapper(client),
		});

		await waitFor(() => expect(result.current.isSuccess).toBe(true));
		expect(result.current.data?.total_kcal).toBe("0.00");
		expect(sent(spy)).toEqual([
			{ method: "GET", url: "/api/exercises", body: null },
		]);
	});

	it("useExercise 打 GET /api/exercises/{id}；NaN 不發請求", async () => {
		const spy = mockApi([
			{ method: "GET", path: "/api/exercises/31", handler: () => json(RUN) },
		]);
		const client = new QueryClient();

		const { result } = renderHook(() => useExercise(31), {
			wrapper: wrapper(client),
		});
		await waitFor(() => expect(result.current.isSuccess).toBe(true));
		expect(result.current.data?.label).toBe("跑步（約 10 km/h）");

		const nan = renderHook(() => useExercise(Number.NaN), {
			wrapper: wrapper(client),
		});
		expect(nan.result.current.fetchStatus).toBe("idle");
		expect(sent(spy)).toEqual([
			{ method: "GET", url: "/api/exercises/31", body: null },
		]);
	});

	it("useExercise 遇到 404 不重試", async () => {
		const spy = mockApi([
			{
				method: "GET",
				path: "/api/exercises/9",
				handler: () =>
					json(
						{
							error: {
								code: "EXERCISE_NOT_FOUND",
								message: "找不到這筆運動",
								details: {},
							},
						},
						404,
					),
			},
		]);
		const client = new QueryClient();

		const { result } = renderHook(() => useExercise(9), {
			wrapper: wrapper(client),
		});

		await waitFor(() => expect(result.current.isError).toBe(true));
		expect(spy).toHaveBeenCalledTimes(1);
	});
});

describe("估算的預覽", () => {
	it("參數是 null 時不發請求", async () => {
		const spy = mockApi([]);
		const client = new QueryClient();

		const { result } = renderHook(() => useExerciseEstimate(null), {
			wrapper: wrapper(client),
		});

		expect(result.current.fetchStatus).toBe("idle");
		expect(spy).not.toHaveBeenCalled();
	});

	it("query string 帶活動、分鐘、編碼過的 performed_at", async () => {
		const ready = {
			ready: true,
			kcal: "343",
			met: "9.8",
			weight_kg: "70.00",
			weight_date: "2026-10-14",
		};
		const spy = mockApi([
			{
				method: "GET",
				path: "/api/exercise/estimate",
				handler: () => json(ready),
			},
		]);
		const client = new QueryClient();

		const { result } = renderHook(
			() =>
				useExerciseEstimate({
					activity: "running",
					minutes: "30",
					performedAt: "2026-10-14T04:00:00.000+08:00",
				}),
			{ wrapper: wrapper(client) },
		);

		await waitFor(() => expect(result.current.isSuccess).toBe(true));
		expect(result.current.data).toEqual(ready);
		expect(sent(spy)).toEqual([
			{
				method: "GET",
				url: "/api/exercise/estimate?activity=running&minutes=30&performed_at=2026-10-14T04%3A00%3A00.000%2B08%3A00",
				body: null,
			},
		]);
	});

	it("422 不重試（穩定的答案）", async () => {
		const spy = mockApi([
			{
				method: "GET",
				path: "/api/exercise/estimate",
				handler: () =>
					json(
						{
							error: {
								code: "EXERCISE_ESTIMATE_TOO_HIGH",
								message: "估算超過 5000 kcal",
								details: {},
							},
						},
						422,
					),
			},
		]);
		const client = new QueryClient();

		const { result } = renderHook(
			() =>
				useExerciseEstimate({
					activity: "running",
					minutes: "600",
					performedAt: "2026-10-14T04:00:00.000Z",
				}),
			{ wrapper: wrapper(client) },
		);

		await waitFor(() => expect(result.current.isError).toBe(true));
		expect(spy).toHaveBeenCalledTimes(1);
	});
});

describe("invalidateExercises", () => {
	it("今天的運動、正在編輯的那一筆、今天的統計都失效；趨勢與活動清單不動", async () => {
		const client = new QueryClient();
		client.setQueryData(queryKeys.exercisesToday, NO_EXERCISE);
		client.setQueryData(queryKeys.exercise(31), RUN);
		client.setQueryData(queryKeys.dailyStats, { date: "2026-10-14" });
		client.setQueryData(queryKeys.rangeStats("2026-10-08", "2026-10-14"), []);
		client.setQueryData(queryKeys.exerciseActivities, ACTIVITY_LIST);

		await invalidateExercises(client);

		for (const key of [
			queryKeys.exercisesToday,
			queryKeys.exercise(31),
			queryKeys.dailyStats,
		]) {
			expect(client.getQueryState(key)?.isInvalidated).toBe(true);
		}
		for (const key of [
			queryKeys.rangeStats("2026-10-08", "2026-10-14"),
			queryKeys.exerciseActivities,
		]) {
			expect(client.getQueryState(key)?.isInvalidated).toBe(false);
		}
	});
});

const TARGET = {
	kcal: "2000.00",
	protein_g: "100.00",
	fat_g: null,
	carb_g: null,
};
const MACROS = { kcal: "1200", protein_g: "60", fat_g: "40", carb_g: "150" };

/** 新的回應（三個欄位都有）。 */
function stats(overrides: Partial<DailyStats> = {}): DailyStats {
	return {
		date: "2026-10-14",
		actual: MACROS,
		target: TARGET,
		ratio: { kcal: "0.6", protein_g: "0.6", fat_g: null, carb_g: null },
		breakdown: { food: MACROS, supplement: MACROS },
		exercise_kcal: "343.00",
		exercise_adds_to_budget: true,
		kcal_budget: "2343.00",
		...overrides,
	};
}

/** 離線快取裡加這三個欄位之前的回應：鍵根本不在。 */
function oldStats(target: typeof TARGET | null = TARGET): DailyStats {
	const {
		exercise_kcal: _a,
		exercise_adds_to_budget: _b,
		kcal_budget: _c,
		...rest
	} = stats({ target });
	return rest as DailyStats;
}

describe("kcalBudgetOf", () => {
	it("新的回應用 kcal_budget", () => {
		expect(kcalBudgetOf(stats())).toBe("2343.00");
	});
	it("kcal_budget 是 null（沒有熱量目標）→ null", () => {
		expect(
			kcalBudgetOf(
				stats({ target: { ...TARGET, kcal: null }, kcal_budget: null }),
			),
		).toBeNull();
	});
	it("舊回應（沒有欄位）退回目標的熱量", () => {
		expect(kcalBudgetOf(oldStats())).toBe("2000.00");
	});
	it("舊回應、沒有目標 → null", () => {
		expect(kcalBudgetOf(oldStats(null))).toBeNull();
	});
});

describe("exerciseInBudgetOf", () => {
	it("設定開、有額度、有運動 → 運動的熱量", () => {
		expect(exerciseInBudgetOf(stats())).toBe("343.00");
	});
	it("設定關 → null", () => {
		expect(
			exerciseInBudgetOf(
				stats({ exercise_adds_to_budget: false, kcal_budget: "2000.00" }),
			),
		).toBeNull();
	});
	it("運動是 0.00 → null（不顯示「含運動 +0」）", () => {
		expect(
			exerciseInBudgetOf(
				stats({ exercise_kcal: "0.00", kcal_budget: "2000.00" }),
			),
		).toBeNull();
	});
	it("沒有額度（沒有熱量目標）→ null", () => {
		expect(exerciseInBudgetOf(stats({ kcal_budget: null }))).toBeNull();
	});
	it("舊回應 → null", () => {
		expect(exerciseInBudgetOf(oldStats())).toBeNull();
	});
});

describe("exerciseAddsToBudgetOf", () => {
	const me = {
		id: 1,
		email: "a@example.com",
		display_name: "A",
		role: "user",
		timezone: "Asia/Taipei",
	} as unknown as Me;
	it("回應裡的值", () => {
		expect(
			exerciseAddsToBudgetOf({ ...me, exercise_adds_to_budget: false }),
		).toBe(false);
		expect(
			exerciseAddsToBudgetOf({ ...me, exercise_adds_to_budget: true }),
		).toBe(true);
	});
	it("舊快取沒有這個欄位 → 開（同後端的預設）", () => {
		expect(exerciseAddsToBudgetOf(me)).toBe(true);
	});
});
