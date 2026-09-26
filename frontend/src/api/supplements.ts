import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "./client";
import { queryKeys } from "./queries";
import type { components } from "./schema";

export type Supplement = components["schemas"]["SupplementResponse"];
export type TodaySupplementItem = components["schemas"]["TodaySupplementItem"];

/** 補劑搜尋。形狀照 `api/foods.ts` 的 `useFoodSearch`——`q` 是空字串時不發
 *  請求：後端的 `q` 可以省略（會回可見範圍的前 50 筆），但那不是使用者
 *  按下搜尋框時想看到的東西。
 *
 *  **刻意沒有 `scope` 參數。** `Supplements.tsx`（P3-C Task 2）不做食物庫
 *  那種「全部／公開／我建立的」三選一——使用者只要求「新增我有在使用的」
 *  ＋「當天有吃就點一份」，沒有要求依擁有權篩選，後端 `scope` 省略時
 *  預設 `all` 已經夠用。 */
export function useSupplementSearch(q: string) {
	return useQuery({
		queryKey: queryKeys.supplementSearch(q),
		queryFn: () =>
			apiFetch<Supplement[]>(`/api/supplements?q=${encodeURIComponent(q)}`),
		enabled: q.trim() !== "",
	});
}

/** 今日補劑清單（打卡 + 臨時記錄）。跟 `Today.tsx` 用同一個 query key
 *  （`queryKeys.supplementsToday`）——兩個畫面共用同一份快取，`Supplements.tsx`
 *  記一筆臨時記錄之後讓這個 key 失效，`Today.tsx` 也會跟著看到新資料，
 *  不需要各自查一次、各自失效一次。 */
export function useTodaySupplements() {
	return useQuery({
		queryKey: queryKeys.supplementsToday,
		queryFn: () => apiFetch<TodaySupplementItem[]>("/api/supplements/today"),
	});
}
