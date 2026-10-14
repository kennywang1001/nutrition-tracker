import { type QueryClient, useQuery } from "@tanstack/react-query";
import { apiFetch } from "./client";
import { queryKeys } from "./queries";
import type { components } from "./schema";

/** 身體資料、建議目標、體重（身體資料規格 §5、§6）。全部是本人的資料，只在「我的」、
 *  `/me/body`、`/me/targets`、`/weight` 用——**不准出現在好友或社群的程式碼裡**（§7）。 */

export type BodyProfile = components["schemas"]["BodyProfileResponse"];
export type BodyProfileInput = components["schemas"]["BodyProfileRequest"];
export type SuggestionReady = components["schemas"]["SuggestionReady"];
export type TargetSuggestion =
	| SuggestionReady
	| components["schemas"]["SuggestionMissing"];
export type WeightList = components["schemas"]["WeightListResponse"];
export type WeightEntry = components["schemas"]["WeightEntryResponse"];
type Target = components["schemas"]["TargetResponse"];

function required<T>(value: T | null, what: string): T {
	if (value === null) throw new Error(`${what}的回應沒有 body`);
	return value;
}

const fetchProfile = async () =>
	required(await apiFetch<BodyProfile>("/api/me/body-profile"), "身體資料");

/** 卡片用：一般的快取（離線時看得到上一次的）。 */
export function useBodyProfile() {
	return useQuery({ queryKey: queryKeys.bodyProfile, queryFn: fetchProfile });
}

/** 掛載時一定重抓——給 `/me/body` 的表單預填用（D27，同 `useFreshDailyStats` 的兩條規矩：
 *  `isFetchedAfterMount && isSuccess` 才算、離線快取還原完才掛）。PUT 是整組取代，拿舊值
 *  預填的話，沒動的欄位會被悄悄改回去。 */
export function useFreshBodyProfile() {
	return useQuery({
		queryKey: queryKeys.bodyProfile,
		queryFn: fetchProfile,
		refetchOnMount: "always",
	});
}

/** 七個鍵都要送（D5），`null`＝不設定；少一個鍵後端回 422。 */
export async function saveBodyProfile(
	body: BodyProfileInput,
): Promise<BodyProfile> {
	return required(
		await apiFetch<BodyProfile>("/api/me/body-profile", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		}),
		"身體資料",
	);
}

/** 建議目標，或缺什麼。`if (data.ready)` 收窄（D10：普通聯集，沒有 discriminator）。 */
export function useTargetSuggestion() {
	return useQuery({
		queryKey: queryKeys.targetSuggestion,
		queryFn: async () =>
			required(
				await apiFetch<TargetSuggestion>("/api/me/target-suggestion"),
				"建議目標",
			),
	});
}

/** 送畫面上看到的四個數字（D15）：後端重算，不一樣就 409 `SUGGESTION_CHANGED`。
 *  存的永遠是後端重算的值，不是這四個。 */
export async function applySuggestion(
	shown: Pick<SuggestionReady, "kcal" | "protein_g" | "fat_g" | "carb_g">,
): Promise<Target> {
	return required(
		await apiFetch<Target>("/api/me/target-suggestion/apply", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(shown),
		}),
		"套用建議目標",
	);
}

/** 最近 800 天（後端的預設，不帶 from／to）。回應裡的 `today` 是使用者的今天——
 *  表單的預設日期與圖表的右端都用它，前端不自己算（D14）。 */
export function useWeights() {
	return useQuery({
		queryKey: queryKeys.weights,
		queryFn: async () =>
			required(await apiFetch<WeightList>("/api/weights"), "體重"),
	});
}

/** 記一筆或更正（同一天再記就是更正，D13）。體重照使用者打的字串送，不經過 number。 */
export async function saveWeight(
	date: string,
	weightKg: string,
): Promise<WeightEntry> {
	return required(
		await apiFetch<WeightEntry>(`/api/weights/${date}`, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ weight_kg: weightKg }),
		}),
		"體重",
	);
}

export async function deleteWeight(date: string): Promise<void> {
	await apiFetch<null>(`/api/weights/${date}`, { method: "DELETE" });
}

/** 體重或身體資料變了：體重清單、身體資料、建議（含重算提示）一起重抓。 */
export function invalidateBody(client: QueryClient): Promise<void> {
	return client.invalidateQueries({ queryKey: queryKeys.bodyAll });
}
