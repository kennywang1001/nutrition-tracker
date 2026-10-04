import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router";
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

/** 從路由 state 拿通知（例如記一餐「照片沒傳上去」）。state 是 unknown——
 *  任何頁面都可能 navigate 過來，形狀不對就當作沒有。 */
function noticeFrom(state: unknown): string | null {
	if (
		typeof state === "object" &&
		state !== null &&
		"notice" in state &&
		typeof state.notice === "string"
	) {
		return state.notice;
	}
	return null;
}

function MonthSpendCard() {
	const summaryQuery = useExpenseSummary(null);
	const summary = summaryQuery.data;

	return (
		<Card testId="month-spend">
			<p className={styles.label}>本月支出</p>
			{summaryQuery.isPending ? (
				<p>載入中…</p>
			) : summary != null ? (
				<p className={styles.total}>${formatMoney(summary.total)}</p>
			) : (
				<p>無法載入本月支出</p>
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
	// 資料優先於錯誤：重抓失敗時（連得到網路、到不了後端）照樣顯示快取，
	// 離線提示由 Overview 頂端那一條負責。
	if (stats == null) {
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

/** 時間線的一列。**餐點列是連到編輯畫面的連結**（編輯餐點規格 §4.3）；
 *  支出列只能看（支出在報表改，介面改版規格 §1.3）。
 *
 *  `data-testid` 留在 `<li>` 上（`e2e/money-loop.spec.ts` 用它找列），
 *  格線排版在裡面那一層（`.row`）。 */
function TimelineItem({ row }: { row: TimelineRow }) {
	if (row.kind === "meal") {
		const foods = row.meal.items.map((item) => item.food_name).join("、");
		return (
			<li className={styles.item} data-testid="timeline-row">
				<Link
					to={`/meals/${row.meal.id}/edit`}
					className={`${styles.row} ${styles.rowLink}`}
				>
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
				</Link>
			</li>
		);
	}

	const { expense } = row;
	return (
		<li className={styles.item} data-testid="timeline-row">
			<div className={styles.row}>
				<CategoryIcon category={expense.category} />
				<span className={styles.title}>
					{expense.note?.trim() || CATEGORY_LABELS[expense.category]}
				</span>
				<span className={styles.time}>{formatTime(row.time)}</span>
				<span className={styles.value}>${formatMoney(expense.amount)}</span>
			</div>
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

	// 資料優先於錯誤：只有「失敗而且沒有任何資料」才算壞掉。
	const stats = statsQuery.data;
	const statsUnusable =
		stats === null || (statsQuery.isError && stats === undefined);
	const mealsFailed = mealsQuery.isError && mealsQuery.data === undefined;
	const expensesFailed =
		expensesQuery.isError && expensesQuery.data === undefined;

	let body: ReactNode;
	if (statsUnusable || mealsFailed || expensesFailed) {
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

/** 任何一個 query「重抓失敗但手上還有資料」就顯示一條離線提示（跟今日
 *  總覽同字樣、同 testid）。時間取最舊的那個——它代表畫面上最不新鮮的資料。
 *  TanStack 會把相同 key 的 query 去重，這裡重複呼叫 hook 不會多發請求。 */
function OfflineBanner() {
	const statsQuery = useDailyStats();
	const summaryQuery = useExpenseSummary(null);
	const mealsQuery = useTodayMeals();
	const expensesQuery = useExpensesByDate(statsQuery.data?.date ?? null);

	const stale = [statsQuery, summaryQuery, mealsQuery, expensesQuery].filter(
		(query) => query.isError && query.data !== undefined,
	);
	if (stale.length === 0) {
		return null;
	}
	const oldest = Math.min(...stale.map((query) => query.dataUpdatedAt));
	return (
		<p data-testid="offline-banner" className={styles.offline}>
			離線資料，最後更新於 {formatTime(oldest)}
		</p>
	);
}

/** 總覽（介面改版規格 §5.2）：本月支出、今天熱量、今天的時間線。
 *  三塊**各自**處理載入與錯誤——一塊失敗不拖垮整頁。
 *  時間線的餐點列連到編輯畫面；支出列只能看（編輯餐點規格 §4.3）。 */
export function Overview() {
	const location = useLocation();
	const navigate = useNavigate();
	const [notice, setNotice] = useState<string | null>(null);
	const incoming = noticeFrom(location.state);

	// 通知讀過就從 history 清掉：BrowserRouter 把 state 存在 history 裡，不清的話
	// 重新整理或返回會再跳出來（照片可能已經補傳了）。通知先放進元件自己的
	// state，所以清掉 history 之後畫面上仍然看得到。
	// 刻意在掛載之後才設定：role="status" 的區塊要先存在、再填字，
	// 螢幕閱讀器才會唸（一開始就有字的 live region 常常不唸）。
	useEffect(() => {
		if (incoming === null) return;
		setNotice(incoming);
		navigate(`${location.pathname}${location.search}`, {
			replace: true,
			state: null,
		});
	}, [incoming, location.pathname, location.search, navigate]);

	return (
		<section>
			<h1>總覽</h1>
			<div role="status">
				{notice !== null && <p className={styles.notice}>{notice}</p>}
			</div>
			<OfflineBanner />
			<div className={styles.cards}>
				<MonthSpendCard />
				<TodayKcalCard />
			</div>
			<TodayTimeline />
		</section>
	);
}
