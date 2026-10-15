import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "./client";
import { queryKeys } from "./queries";
import type { components } from "./schema";

export type LibrarySuggestions =
	components["schemas"]["LibrarySuggestionsResponse"];
export type PlannedCombo = components["schemas"]["PlannedComboResponse"];
export type PlannedItem = components["schemas"]["PlannedItemResponse"];

/** 今天還能吃什麼——從常吃的食物配（營養素配餐規格 §7.3）。`staleTime: 0`：每次進頁面重抓
 *  （剛記完一餐回來，剩下的就變了；app 預設的 60 秒會讓回來時先看到記之前的組合）。
 *  也不進離線快取（D25，`persist.ts` 的 `NOT_PERSISTED`）。 */
export function useLibrarySuggestions() {
	return useQuery({
		queryKey: queryKeys.plannerLibrary,
		queryFn: async () => {
			const result = await apiFetch<LibrarySuggestions>(
				"/api/planner/library-suggestions",
			);
			// 後端成功時一律回 200 + JSON；null 代表 apiFetch 的假設被破壞。
			if (result === null) throw new Error("沒有回傳建議");
			return result;
		},
		staleTime: 0,
	});
}
