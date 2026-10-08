import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "./client";
import { queryKeys } from "./queries";
import type { components } from "./schema";

export type DailyStats = components["schemas"]["DailyStatsResponse"];

/** 今天的營養素統計。**不帶 `date`**：後端用使用者時區的今天
 *  （`app/days.py` 的 `today_in_timezone`）。
 *
 *  原本 `Today.tsx` 與 `Trend.tsx` 各寫一份一模一樣的 `useQuery`；總覽是
 *  第三個使用者，所以抽出來——同一個 key 有好幾份 `queryFn`，哪天其中
 *  一份改了，快取裡的資料形狀就看哪個畫面先掛載。
 *
 *  回應裡的 `date` 是後端算好的「使用者時區的今天」：趨勢頁拿它當區間
 *  終點、總覽拿它查今天的支出——兩者都不自己算日界線。 */
export function useDailyStats() {
	return useQuery({
		queryKey: queryKeys.dailyStats,
		queryFn: fetchDailyStats,
	});
}

function fetchDailyStats() {
	return apiFetch<DailyStats>("/api/stats/daily");
}

/** 同一份統計（同一個 key、同一個快取），但**掛載時一定重抓**——給「拿目前的值預填表單，
 *  存的時候整組送回去」的畫面用（`/me/targets`）。
 *
 *  `useDailyStats` 在 `staleTime`（60 秒）內掛載不會重抓，離線快取還原的更舊。拿那份預填，
 *  使用者只改一格按儲存，其他格就被悄悄改回快取裡的舊值（帳號設定審查 M5）。
 *
 *  **`refetchOnMount: "always"` 只保證「會去抓」，不保證「你手上這份是抓回來的」。** 呼叫端要
 *  做兩件事：
 *
 *  1. 用 `isFetchedAfterMount && isSuccess` 判斷「這一份是掛載之後才拿到的」。
 *  2. **離線快取還在還原時（`useIsRestoring()`）不要呼叫這支 hook**——包一層，還原完才掛。
 *     `isFetchedAfterMount` 比的是「現在的 `dataUpdateCount`」與「observer 建立時的」；還原
 *     期間建立的 observer 記下的是 0，還原把 localStorage 裡那份狀態（≥ 1）蓋上去之後，
 *     它就是 true 了——而那時一個請求都還沒回來。整頁重新載入停在那個畫面時就會遇到
 *     （`screens/Targets.tsx` 的 `Targets`／`TargetsLoader`，`tests/targets.test.tsx`
 *     「整頁重新載入」）。 */
export function useFreshDailyStats() {
	return useQuery({
		queryKey: queryKeys.dailyStats,
		queryFn: fetchDailyStats,
		refetchOnMount: "always",
	});
}
