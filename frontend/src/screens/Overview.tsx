import { Dumbbell } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { useWeights } from "../api/body";
import { useTodayExercises } from "../api/exercises";
import {
	CATEGORY_LABELS,
	useExpenseSummary,
	useExpensesByDate,
} from "../api/expenses";
import { MEAL_TYPE_LABELS, useTodayMeals } from "../api/meals";
import { useDailyStats } from "../api/stats";
import { BudgetSummary } from "../components/BudgetSummary";
import { Card } from "../components/Card";
import {
	CategoryIcon,
	EXERCISE_COLOR,
	IconBadge,
	MealTypeIcon,
} from "../components/IconBadge";
import layout from "../components/layout.module.css";
import { QuickActions } from "../components/QuickActions";
import ui from "../components/ui.module.css";
import { WeightSparkline } from "../components/WeightSparkline";
import { formatTime } from "../lib/dates";
import { formatMacro, formatMoney } from "../lib/decimal";
import { stashQuickPhoto, WEIGHT_FORM_STATE } from "../lib/quick-actions";
import { buildTimeline, type TimelineRow } from "../lib/timeline";
import { dateLabel, signedKg, weekChange } from "../lib/weights";
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

/** 本月支出（首頁改版規格 D12）：整塊是連到報表的連結。字樣照舊「本月支出」。
 *  span 之間的空白是連結名稱的一部分（「本月支出 $12480.00」）；欄排版裡它不佔位置。 */
function MonthSpendCard() {
	const summaryQuery = useExpenseSummary(null);
	const summary = summaryQuery.data;

	return (
		<Card testId="month-spend">
			<Link to="/reports" className={styles.glance}>
				<span className={styles.label}>本月支出</span>{" "}
				{summaryQuery.isPending ? (
					<span>載入中…</span>
				) : summary != null ? (
					<span className={styles.total}>${formatMoney(summary.total)}</span>
				) : (
					<span>無法載入本月支出</span>
				)}
			</Link>
		</Card>
	);
}

/** 今天熱量（首頁改版規格 §3）：圓環、三大營養素、已吃・預算。`data-testid="today-kcal"` 沿用（意義變成整張卡片，D7）。
 *  是 `<section>` 而不是 `Card`：要 region 的名稱「今天熱量」，跟時間線的「今天」分得開。
 *  資料優先於錯誤：重抓失敗時照樣顯示快取，離線提示由頂端那一條負責。 */
function TodayBudgetCard() {
	const statsQuery = useDailyStats();
	const stats = statsQuery.data;

	return (
		<section
			aria-labelledby="overview-budget"
			data-testid="today-kcal"
			className={styles.budgetCard}
		>
			<h2
				id="overview-budget"
				className={`${ui.sectionTitle} ${styles.budgetTitle}`}
			>
				今天熱量
			</h2>
			{statsQuery.isPending ? (
				<p>載入中…</p>
			) : stats == null ? (
				<p>無法載入今天的熱量</p>
			) : (
				<BudgetSummary stats={stats} />
			)}
		</section>
	);
}

/** 體重（首頁改版規格 D12）：最新一筆、比 7 天前（同「身體與目標」的體重卡片，`lib/weights.ts`），整塊連到 `/weight`。
 *  沒有紀錄：「記錄體重」，跟快速記錄的記體重同一個去處（焦點放在體重欄位，D11）。
 *  資料沿用 `useWeights()`（800 天、進離線快取），迷你折線自己篩最近 30 天——不多一個 query key（D23）。 */
function WeightGlanceCard() {
	const weights = useWeights();
	const data = weights.data;
	const latest = data?.entries.at(-1);
	const change = data == null ? null : weekChange(data.entries);
	const empty = data != null && latest === undefined;

	return (
		<Card testId="weight-glance">
			<Link
				to="/weight"
				state={empty ? WEIGHT_FORM_STATE : undefined}
				className={styles.glance}
			>
				<span className={styles.label}>體重</span>{" "}
				{weights.isPending ? (
					<span>載入中…</span>
				) : data == null ? (
					<span>無法載入體重</span>
				) : latest === undefined ? (
					<span className={styles.action}>記錄體重</span>
				) : (
					<>
						<span className={styles.total}>
							{formatMacro(latest.weight_kg)} 公斤
							{/* 最新一筆不是今天就帶日期（審查 M2）：兩個月沒量的人，首頁不該看起來像今天的數字。
							    「比 7 天前」也是從那一筆往回算的，有日期才讀得懂。 */}
							{latest.date !== data.today &&
								`・${dateLabel(latest.date, data.today)}`}
						</span>
						{change !== null && (
							<>
								{" "}
								<span className={styles.sub}>
									比 7 天前 {signedKg(change.change)} 公斤
								</span>
							</>
						)}
						{/* 最近 30 天的迷你折線（D22）：裝飾（aria-hidden），不進連結的名稱；少於 2 筆它自己不畫。 */}
						<WeightSparkline entries={data.entries} today={data.today} />
					</>
				)}
			</Link>
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

	// 運動列也是連到編輯畫面的連結（運動規格 §7.4）。消耗寫成負的：它從額度裡「還」回來，
	// 跟餐點列的熱量方向相反（D27：ASCII 減號，同全 app 的正負號）。
	if (row.kind === "exercise") {
		const { exercise } = row;
		return (
			<li className={styles.item} data-testid="timeline-row">
				<Link
					to={`/exercises/${exercise.id}/edit`}
					className={`${styles.row} ${styles.rowLink}`}
				>
					<IconBadge icon={Dumbbell} color={EXERCISE_COLOR} />
					<span className={styles.title}>
						{exercise.label}・{exercise.minutes} 分鐘
					</span>
					<span className={styles.time}>{formatTime(row.time)}</span>
					<span className={styles.value}>
						-{formatMacro(exercise.kcal)} kcal
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
	const exercisesQuery = useTodayExercises();

	// 資料優先於錯誤：只有「失敗而且沒有任何資料」才算壞掉。
	const stats = statsQuery.data;
	const statsUnusable =
		stats === null || (statsQuery.isError && stats === undefined);
	const mealsFailed = mealsQuery.isError && mealsQuery.data === undefined;
	const expensesFailed =
		expensesQuery.isError && expensesQuery.data === undefined;
	// 運動跟餐點一樣：清單抓不到就不能說「今天還沒有紀錄」。
	const exercisesFailed =
		exercisesQuery.isError && exercisesQuery.data === undefined;

	let body: ReactNode;
	if (statsUnusable || mealsFailed || expensesFailed || exercisesFailed) {
		body = <p>無法載入今天的紀錄</p>;
	} else if (
		mealsQuery.isPending ||
		expensesQuery.isPending ||
		exercisesQuery.isPending
	) {
		body = <p>載入中…</p>;
	} else {
		const rows = buildTimeline(
			mealsQuery.data ?? [],
			expensesQuery.data ?? [],
			exercisesQuery.data?.entries ?? [],
		);
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
			<h2
				id="overview-today"
				className={`${ui.sectionTitle} ${styles.todayTitle}`}
			>
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
	const exercisesQuery = useTodayExercises();
	// 體重小卡片（首頁改版規格 §3.4）：重抓失敗而手上有資料，也是畫面上的「離線資料」。
	const weightsQuery = useWeights();

	const stale = [
		statsQuery,
		summaryQuery,
		mealsQuery,
		expensesQuery,
		exercisesQuery,
		weightsQuery,
	].filter((query) => query.isError && query.data !== undefined);
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

/** 總覽（介面改版規格 §5.2、首頁改版規格 §3）：今天熱量的圓環卡片、快速記錄（§4）、
 *  兩張小卡片（本月支出、體重）、今天的時間線。
 *  每一塊**各自**處理載入與錯誤——一塊失敗不拖垮整頁。
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
			{/* 手機往下排、電腦版左欄（首頁改版規格 §3.1）：圓環 → 快速記錄 → 兩張小卡片並排；
			    右欄是時間線（電腦版版面規格 §4）。DOM 順序就是手機上的順序與焦點順序。 */}
			<div className={layout.columns}>
				<div className={styles.left}>
					<TodayBudgetCard />
					{/* 拍照記（D8）：照片放進記憶體裡的暫存，router state 只帶號碼——File 不進 history。 */}
					<QuickActions
						onPhoto={(file) =>
							navigate("/meals/new", { state: stashQuickPhoto(file) })
						}
					/>
					<div className={styles.cards}>
						<MonthSpendCard />
						<WeightGlanceCard />
					</div>
				</div>
				<TodayTimeline />
			</div>
		</section>
	);
}
