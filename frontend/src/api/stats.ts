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
		queryFn: () => apiFetch<DailyStats>("/api/stats/daily"),
	});
}
