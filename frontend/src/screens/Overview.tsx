import type { ReactNode } from "react";
import {
	CATEGORY_LABELS,
	useExpenseSummary,
	useExpensesByDate,
} from "../api/expenses";
import { MEAL_TYPE_LABELS, useTodayMeals } from "../api/meals";
import { useDailyStats } from "../api/stats";
import { Card } from "../components/Card";
import { CategoryIcon, MealTypeIcon } from "../components/IconBadge";
import { formatTime } from "../lib/dates";
import { formatMacro, formatMoney, ratioOf } from "../lib/decimal";
import { buildTimeline, type TimelineRow } from "../lib/timeline";
import styles from "./Overview.module.css";

function MonthSpendCard() {
	const summaryQuery = useExpenseSummary(null);
	const summary = summaryQuery.data;

	return (
		<Card testId="month-spend">
			<p className={styles.label}>本月支出</p>
			{summaryQuery.isPending ? (
				<p>載入中…</p>
			) : summaryQuery.isError || summary == null ? (
				<p>無法載入本月支出</p>
			) : (
				<p className={styles.total}>${formatMoney(summary.total)}</p>
			)}
		</Card>
	);
}

function TodayKcalCard() {
	const statsQuery = useDailyStats();
	const stats = statsQuery.data;

	if (statsQuery.isPending) {
		return (
			<Card testId="today-kcal">
				<p className={styles.label}>今天熱量</p>
				<p>載入中…</p>
			</Card>
		);
	}
	if (statsQuery.isError || stats == null) {
		return (
			<Card testId="today-kcal">
				<p className={styles.label}>今天熱量</p>
				<p>無法載入今天的熱量</p>
			</Card>
		);
	}

	// 兩層 null（沿用 MacroBar 的語意）：`target` 整個是 null＝今天沒有目標；
	// `target.kcal` 是 null＝有目標但熱量沒設。兩種都只顯示數字、不畫進度條。
	const target = stats.target?.kcal ?? null;
	const ratio = ratioOf(stats.actual.kcal, target);

	return (
		<Card testId="today-kcal">
			<p className={styles.label}>今天熱量</p>
			<p className={styles.total}>
				{formatMacro(stats.actual.kcal)}
				<span className={styles.unit}>
					{target === null ? " kcal" : ` / ${formatMacro(target)} kcal`}
				</span>
			</p>
			{ratio !== null && (
				<progress
					className={styles.progress}
					max={1}
					value={Math.min(ratio, 1)}
					aria-label="熱量進度"
				/>
			)}
		</Card>
	);
}

function TimelineItem({ row }: { row: TimelineRow }) {
	if (row.kind === "meal") {
		const foods = row.meal.items.map((item) => item.food_name).join("、");
		return (
			<li className={styles.row} data-testid="timeline-row">
				<MealTypeIcon mealType={row.meal.meal_type} />
				<span className={styles.title}>
					{MEAL_TYPE_LABELS[row.meal.meal_type]}・
					{foods === "" ? "（沒有項目）" : foods}
				</span>
				<span className={styles.time}>{formatTime(row.time)}</span>
				<span className={styles.value}>
					{row.cost !== null
						? `$${formatMoney(row.cost)}`
						: `${formatMacro(row.meal.kcal)} kcal`}
				</span>
			</li>
		);
	}

	const { expense } = row;
	return (
		<li className={styles.row} data-testid="timeline-row">
			<CategoryIcon category={expense.category} />
			<span className={styles.title}>
				{expense.note ?? CATEGORY_LABELS[expense.category]}
			</span>
			<span className={styles.time}>{formatTime(row.time)}</span>
			<span className={styles.value}>${formatMoney(expense.amount)}</span>
		</li>
	);
}

/** 今天的時間線（規格 §5.2、§6.2）。
 *
 *  **今天的支出要等 `stats/daily` 回來才知道日期**（前端不自己算今天）。
 *  `useExpensesByDate(null)` 是 `enabled: false`，在 TanStack Query v5
 *  的狀態是 `isPending`——所以 stats 失敗時要**先**判斷錯誤，否則畫面會
 *  永遠停在「載入中」。`stats` 回 `null`（204，理論上不會）也當成失敗。 */
function TodayTimeline() {
	const statsQuery = useDailyStats();
	const mealsQuery = useTodayMeals();
	const today = statsQuery.data?.date ?? null;
	const expensesQuery = useExpensesByDate(today);

	const statsUnusable =
		statsQuery.isError || (statsQuery.isSuccess && statsQuery.data === null);

	let body: ReactNode;
	if (statsUnusable || mealsQuery.isError || expensesQuery.isError) {
		body = <p>無法載入今天的紀錄</p>;
	} else if (mealsQuery.isPending || expensesQuery.isPending) {
		body = <p>載入中…</p>;
	} else {
		const rows = buildTimeline(mealsQuery.data ?? [], expensesQuery.data ?? []);
		body =
			rows.length === 0 ? (
				<p>今天還沒有紀錄</p>
			) : (
				<ul className={styles.timeline}>
					{rows.map((row) => (
						<TimelineItem key={row.key} row={row} />
					))}
				</ul>
			);
	}

	return (
		<section aria-labelledby="overview-today">
			<h2 id="overview-today" className={styles.sectionTitle}>
				今天
			</h2>
			<Card>{body}</Card>
		</section>
	);
}

/** 總覽（介面改版規格 §5.2）：本月支出、今天熱量、今天的時間線。
 *  三塊**各自**處理載入與錯誤——一塊失敗不拖垮整頁。
 *  時間線的列只能看、不能點（規格 §1.3）。 */
export function Overview() {
	return (
		<section>
			<h1>總覽</h1>
			<div className={styles.cards}>
				<MonthSpendCard />
				<TodayKcalCard />
			</div>
			<TodayTimeline />
		</section>
	);
}
