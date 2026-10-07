import { keepPreviousData, useQuery } from "@tanstack/react-query";
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
import { averageOf, formatMacro, isPositiveAmount } from "../lib/decimal";
import styles from "./Trend.module.css";

type RangeStats = components["schemas"]["RangeStatsResponse"];

/** 可以選的期間（趨勢期間規格 §2）。預設 7 天，不記住上次選的——
 *  跟營養素切換一樣，每次進來都是 7 天。
 *
 *  兩端都含，所以起點是終點往回推 `span - 1` 天（7 天是往回 6 天，不是 7）——
 *  `app/api/routes/stats.py` 的 `get_range_stats`：
 *  「使用者說『9/1 到 9/7』預期的是 7 天」。 */
const SPANS = [7, 30] as const;
type Span = (typeof SPANS)[number];

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

/** 期間摘要（趨勢期間規格 §2）：「有記錄的 N 天，平均 X kcal」，那幾天有
 *  這一項的目標時接「，目標平均 Y kcal」。
 *
 *  - **「有記錄」是那一項的實際值 > 0。** 沒記的日子算進去，平均會被拉低成
 *    一個沒有意義的數字。
 *  - **目標平均只算「有記錄、而且有這一項目標」的那幾天。** 整天沒目標與有目標
 *    但這一項沒設（兩層 null）都不算進去，也不當成 0。
 *  - **只給數字，不判斷「達標」**（handover §4.8）：熱量是越低越好還是剛好
 *    就好、蛋白質是至少還是剛好，因人而異。
 *
 *  「> 0」借用 `isPositiveAmount`：它就是「經過 Decimal 比較、不丟例外的
 *  大於 0」，名字是記帳鍵盤取的，但判斷本身跟金額無關。 */
function periodSummary(days: readonly TrendDay[], metric: TrendMetric): string {
	const { unit } = TREND_METRICS[metric];
	const recorded = days.filter((day) => isPositiveAmount(day.actual[metric]));
	const average = averageOf(recorded.map((day) => day.actual[metric]));
	if (average === null) return "這段期間還沒有記錄";

	const targets = recorded
		.map((day) => (day.target === null ? null : day.target[metric]))
		.filter((value): value is string => value !== null);
	const targetAverage = averageOf(targets);
	const head = `有記錄的 ${recorded.length} 天，平均 ${formatMacro(average)} ${unit}`;
	return targetAverage === null
		? head
		: `${head}，目標平均 ${formatMacro(targetAverage)} ${unit}`;
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

	const [span, setSpan] = useState<Span>(7);
	const today = anchorQuery.data?.date ?? null;
	const from = today === null ? null : shiftDays(today, -(span - 1));

	const rangeQuery = useQuery({
		// key 一定要有值（TanStack Query 不接受 undefined 的 key），
		// 但 enabled 保證錨點是 null 時不會真的發請求——所以這組空字串
		// 的 key 永遠不會被寫入任何資料。
		queryKey: queryKeys.rangeStats(from ?? "", today ?? ""),
		queryFn: () =>
			apiFetch<RangeStats>(`/api/stats/range?from=${from}&to=${today}`),
		enabled: from !== null && today !== null,
		// 換期間時先留著上一段的資料，不要整個畫面退回「載入中…」——
		// 那會把兩組切換鈕一起拆掉，剛按下去的那顆單選鈕就失去焦點。
		placeholderData: keepPreviousData,
	});

	const range = rangeQuery.data;
	// 換期間後、新的那段還沒回來時，`range` 是上一段的資料（keepPreviousData）。
	// 它還畫在畫面上，但要標成過時：卡片調淡、aria-busy，摘要改說「載入中…」
	// ——不然「30 天」底下會寫著「有記錄的 7 天」。
	const stale = rangeQuery.isPlaceholderData;
	const staleProps = stale
		? { "aria-busy": true, className: styles.stale }
		: {};
	const [metric, setMetric] = useState<TrendMetric>("kcal");
	const todayDay = range?.trend.find((day) => day.date === today) ?? null;

	return (
		<section className={ui.screen}>
			<h1>趨勢</h1>

			{/* 還不知道今天是哪一天：什麼都畫不出來，連期間都沒得選。 */}
			{today === null &&
				(anchorQuery.isError ? <p>無法載入趨勢</p> : <p>載入中…</p>)}

			{/* 知道今天之後切換鈕就一直在，不等 range：某一段載入失敗時，
			    使用者還要能切回已經有快取的那一段。 */}
			{today !== null && (
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

					<fieldset className={styles.metrics}>
						<legend className={styles.legend}>期間</legend>
						{SPANS.map((option) => (
							<label key={option} className={styles.metric}>
								<input
									type="radio"
									name="trend-span"
									value={option}
									checked={span === option}
									onChange={() => setSpan(option)}
									className={styles.metricInput}
								/>
								{option} 天
							</label>
						))}
					</fieldset>

					{!range && rangeQuery.isError && <p>無法載入趨勢</p>}
					{!range && !rangeQuery.isError && <p>載入中…</p>}

					{range && (
						<>
							<div data-testid="trend-period-card" {...staleProps}>
								<TrendChart days={range.trend} metric={metric} today={today} />
								{todayDay !== null && (
									<p data-testid="today-summary" className={styles.summary}>
										{todaySummary(todayDay, metric)}
									</p>
								)}
								<p data-testid="period-summary" className={styles.summary}>
									{stale ? "載入中…" : periodSummary(range.trend, metric)}
								</p>
							</div>

							<div {...staleProps}>
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
				</>
			)}
		</section>
	);
}
