import { type QueryClient, useQuery } from "@tanstack/react-query";
import { apiFetch } from "./client";
import { retryUnlessNotFound } from "./errors";
import { queryKeys } from "./queries";
import type { components } from "./schema";

/** 運動紀錄（運動規格 §6、§7）。全部是本人的資料，只在總覽、飲食頁、`/exercises/…` 用——
 *  **不准出現在好友或社群的程式碼裡**（§8）。 */

export type Activity = components["schemas"]["ActivityResponse"];
export type ActivityCode = Activity["code"];
export type Exercise = components["schemas"]["ExerciseResponse"];
export type ExerciseList = components["schemas"]["ExerciseListResponse"];
export type ExerciseInput = components["schemas"]["ExerciseCreateRequest"];
export type ExercisePatch = components["schemas"]["ExerciseUpdateRequest"];
/** `if (data.ready)` 收窄（D11：普通聯集，沒有 discriminator）。 */
export type ExerciseEstimate =
	| components["schemas"]["EstimateReady"]
	| components["schemas"]["EstimateMissing"];
export type EstimateParams = {
	activity: ActivityCode;
	minutes: string;
	/** ISO 時刻：「哪一天」由後端用帳號時區算（規格「與原始決定的差異」第 2 點）。 */
	performedAt: string;
};

function required<T>(value: T | null, what: string): T {
	if (value === null) throw new Error(`${what}的回應沒有 body`);
	return value;
}

/** 活動清單（D2：唯一的事實來源在後端）。一次載入裡是固定的，抓一次就不再重抓；
 *  **不進離線快取**（`persist.ts` 的 `NOT_PERSISTED`，審查 M3）：下一次載入一定重抓，
 *  後端新增或改名的活動代碼才會出現。 */
export function useActivities() {
	return useQuery({
		queryKey: queryKeys.exerciseActivities,
		queryFn: async () =>
			required(
				await apiFetch<Activity[]>("/api/exercise/activities"),
				"活動清單",
			),
		staleTime: Number.POSITIVE_INFINITY,
	});
}

/** 估算的預覽（D11）。`null`＝現在不能估算（沒選活動、是「其他」、手動、欄位不對），不發請求。
 *  422（太高、未來）是穩定的答案，不重試；每次都問最新的（體重可能剛記）。 */
export function useExerciseEstimate(params: EstimateParams | null) {
	return useQuery({
		queryKey:
			params === null
				? queryKeys.exerciseEstimateAll
				: queryKeys.exerciseEstimate(
						params.activity,
						params.minutes,
						params.performedAt,
					),
		queryFn: async () => {
			if (params === null) throw new Error("沒有參數不該發請求");
			const query = new URLSearchParams({
				activity: params.activity,
				minutes: params.minutes,
				performed_at: params.performedAt,
			});
			return required(
				await apiFetch<ExerciseEstimate>(`/api/exercise/estimate?${query}`),
				"估算",
			);
		},
		enabled: params !== null,
		staleTime: 0,
		retry: false,
	});
}

/** 今天的運動。**不帶日期**：後端用使用者時區的今天（D19，同 `dailyStats`）。 */
export function useTodayExercises() {
	return useQuery({
		queryKey: queryKeys.exercisesToday,
		queryFn: async () =>
			required(await apiFetch<ExerciseList>("/api/exercises"), "運動清單"),
	});
}

/** 編輯畫面的那一筆：掛載時一定重抓（同 `useMeal`），預填只用抓回來的那一份。
 *  `NaN`（網址不是有效的 id）不發請求；404 不重試。 */
export function useExercise(id: number) {
	return useQuery({
		queryKey: queryKeys.exercise(id),
		queryFn: async () =>
			required(await apiFetch<Exercise>(`/api/exercises/${id}`), "運動"),
		enabled: Number.isSafeInteger(id),
		refetchOnMount: "always",
		retry: retryUnlessNotFound,
	});
}

/** `kcal` 省略＝讓後端估算（D10）。 */
export async function createExercise(body: ExerciseInput): Promise<Exercise> {
	return required(
		await apiFetch<Exercise>("/api/exercises", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		}),
		"運動",
	);
}

/** `kcal: null`＝改回估算（D10）；不帶的鍵不動。 */
export async function updateExercise(
	id: number,
	body: ExercisePatch,
): Promise<Exercise> {
	return required(
		await apiFetch<Exercise>(`/api/exercises/${id}`, {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		}),
		"運動",
	);
}

export async function deleteExercise(id: number): Promise<void> {
	await apiFetch<null>(`/api/exercises/${id}`, { method: "DELETE" });
}

/** 運動變了：今天的清單、正在編輯的那一筆、今天的統計（額度）一起重抓。
 *  **不失效趨勢**（`rangeStatsAll`）：趨勢的比例不含運動（D13），抓了也一樣。 */
export function invalidateExercises(client: QueryClient): Promise<unknown> {
	return Promise.all([
		client.invalidateQueries({ queryKey: queryKeys.exercisesAll }),
		client.invalidateQueries({ queryKey: queryKeys.dailyStats }),
	]);
}
