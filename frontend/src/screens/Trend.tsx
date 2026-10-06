import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { apiFetch } from "../api/client";
import { queryKeys } from "../api/queries";
import type { components } from "../api/schema";
import { useDailyStats } from "../api/stats";
import {
	TREND_METRIC_ORDER,
	TREND_METRICS,
	TrendChart,
	type TrendDay,
	type TrendMetric,
} from "../components/TrendChart";
import ui from "../components/ui.module.css";
import { shiftDays } from "../lib/civil-date";
import { formatMacro } from "../lib/decimal";
import styles from "./Trend.module.css";

type RangeStats = components["schemas"]["RangeStatsResponse"];

/** 最近七天。兩端都含，所以起點是終點往回推 6 天（不是 7）——
 *  `app/api/routes/stats.py` 的 `get_range_stats`：
 *  「使用者說『9/1 到 9/7』預期的是 7 天」。 */
const SPAN_DAYS = 7;

/** 今天那一項的摘要：「今天 1240 / 2000 kcal」；那一項沒有目標（整天沒有
 *  目標，或有目標但這一項沒設）時只寫實際值。 */
function todaySummary(day: TrendDay, metric: TrendMetric): string {
	const { unit } = TREND_METRICS[metric];
	const actual = formatMacro(day.actual[metric]);
	const target = day.target === null ? null : day.target[metric];
	return target === null
		? `今天 ${actual} ${unit}`
		: `今天 ${actual} / ${formatMacro(target)} ${unit}`;
}

/** 趨勢畫面（規格 §4）。
 *
 *  ## 日期錨點
 *
 *  `GET /api/stats/range` 的 `from` / `to` **都是必填**，跟
 *  `GET /api/stats/daily` 不一樣（後者省略 `date` 時會用
 *  `today_in_timezone(user.timezone)` 幫你算今天）。
 *
 *  所以「最近七天」要先知道今天是幾號 —— 而前端**永遠不自己算日界線**。
 *  解法是拿 `stats/daily` 回應裡的 `date`：那就是伺服器對「這個使用者的
 *  今天是哪一天」的答案，這裡只是讀回來，沒有重新推導它。
 *
 *  **代價是冷快取時有一次瀑布式等待。** 實務上「今日營養素」已經在打同一支
 *  查詢、結果已經在快取裡（`staleTime: 60_000`），所以通常不會真的多一個
 *  往返；離線時它在持久化快取裡，錨點一樣拿得到。
 */
export function Trend() {
	const anchorQuery = useDailyStats();

	const today = anchorQuery.data?.date ?? null;
	const from = today === null ? null : shiftDays(today, -(SPAN_DAYS - 1));

	const rangeQuery = useQuery({
		// key 一定要有值（TanStack Query 不接受 undefined 的 key），
		// 但 enabled 保證錨點是 null 時不會真的發請求——所以這組空字串
		// 的 key 永遠不會被寫入任何資料。
		queryKey: queryKeys.rangeStats(from ?? "", today ?? ""),
		queryFn: () =>
			apiFetch<RangeStats>(`/api/stats/range?from=${from}&to=${today}`),
		enabled: from !== null && today !== null,
	});

	const range = rangeQuery.data;
	const [metric, setMetric] = useState<TrendMetric>("kcal");
	const todayDay = range?.trend.find((day) => day.date === today) ?? null;

	return (
		<section className={ui.screen}>
			<h1>趨勢</h1>

			{anchorQuery.isError && <p>無法載入趨勢</p>}
			{!range && !anchorQuery.isError && <p>載入中…</p>}

			{range && (
				<>
					<fieldset className={styles.metrics}>
						<legend className={styles.legend}>營養素</legend>
						{TREND_METRIC_ORDER.map((option) => (
							<label key={option} className={styles.metric}>
								<input
									type="radio"
									name="trend-metric"
									value={option}
									checked={metric === option}
									onChange={() => setMetric(option)}
									className={styles.metricInput}
								/>
								{TREND_METRICS[option].label}
							</label>
						))}
					</fieldset>

					<div>
						<TrendChart days={range.trend} metric={metric} today={today} />
						{todayDay !== null && (
							<p data-testid="today-summary" className={styles.summary}>
								{todaySummary(todayDay, metric)}
							</p>
						)}
					</div>

					<div>
						{/* 規格 §4.7：null 不能顯示成 0%。
						    0 讀起來是「一次都沒吃」，而 null 的意思是「沒有計畫，
						    這個比率沒有定義」——把「沒有標準」講成「做得很差」。 */}
						<p data-testid="adherence">
							{range.adherence === null
								? "這段期間沒有補劑計畫"
								: `補劑依從率 ${Number(range.adherence).toLocaleString(
										undefined,
										{
											style: "percent",
											maximumFractionDigits: 0,
										},
									)}`}
						</p>
					</div>
				</>
			)}
		</section>
	);
}
