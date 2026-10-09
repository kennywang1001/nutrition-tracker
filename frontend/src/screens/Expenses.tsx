import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { apiFetch } from "../api/client";
import { ApiError } from "../api/errors";
import {
	AMOUNT_FORMAT_ERROR,
	CATEGORY_LABELS,
	type Expense,
	useExpenseSummary,
	useExpenses,
} from "../api/expenses";
import { queryKeys } from "../api/queries";
import { Card } from "../components/Card";
import { CategoryBar } from "../components/CategoryBar";
import { CategoryDonut } from "../components/CategoryDonut";
import { CategoryIcon } from "../components/IconBadge";
import layout from "../components/layout.module.css";
import ui from "../components/ui.module.css";
import { formatMoney, isPositiveAmount } from "../lib/decimal";
import { formatYearMonth, isYearMonth, shiftMonth } from "../lib/months";
import { useConfirmFocus } from "../lib/use-confirm-focus";
import styles from "./Expenses.module.css";

type RowProps = {
	expense: Expense;
	onChanged: () => void;
};

/** 一筆花費：顯示、修改、刪除。
 *
 *  **確認步驟用畫面上的一段文字 + 兩個按鈕，不是 `window.confirm()`。**
 *  `window.confirm` 在 jsdom 裡是未實作的（會需要 stub），而且不能用
 *  螢幕閱讀器讀到的方式表達「這是一個需要決定的狀態」。這裡用一個
 *  `useState` 開關 + `role="alertdialog"`，測試與無障礙都直接可用。
 *  焦點同編輯畫面的確認框（`useConfirmFocus`）：打開時到「取消」，按取消
 *  收起之後回到這一筆的「刪除」；刪成功收起時不搶焦點。
 *
 *  **不能改日期。** `spent_at` 不在可改欄位裡——改日期需要一個
 *  `<input type="datetime-local">`，而它產出的是沒有時區 offset 的字串，
 *  後端的 `AwareDatetime` 會回 422。真的要做時必須先轉成帶 offset 的格式
 *  （見計畫開頭「刻意避開的地雷」）。
 */
function ExpenseRow({ expense, onChanged }: RowProps) {
	const [editing, setEditing] = useState(false);
	const [confirmingDelete, setConfirmingDelete] = useState(false);
	const confirmFocus = useConfirmFocus(confirmingDelete);
	const [draftAmount, setDraftAmount] = useState(expense.amount);
	const [rowError, setRowError] = useState<string | null>(null);

	const save = useMutation({
		mutationFn: () =>
			apiFetch<Expense>(`/api/expenses/${expense.id}`, {
				method: "PATCH",
				headers: { "content-type": "application/json" },
				// **只送 amount。** 後端用 exclude_unset，沒帶的欄位不動。
				// 刻意不送 spent_at（沒有日期選擇器）也不送 meal_id（不可改）。
				body: JSON.stringify({ amount: draftAmount }),
			}),
		onSuccess: () => {
			setEditing(false);
			setRowError(null);
			onChanged();
		},
		onError: (caught: unknown) => {
			if (caught instanceof ApiError && caught.code === "VALIDATION_ERROR") {
				setRowError(AMOUNT_FORMAT_ERROR);
				return;
			}
			setRowError("修改失敗，請再試一次");
		},
	});

	const remove = useMutation({
		mutationFn: () =>
			apiFetch(`/api/expenses/${expense.id}`, { method: "DELETE" }),
		onSuccess: () => {
			setConfirmingDelete(false);
			onChanged();
		},
		onError: () => setRowError("刪除失敗，請再試一次"),
	});

	function handleSave(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		// 空字串擋在前端，不要白打一次請求。
		if (draftAmount.trim() === "") {
			setRowError("請輸入金額");
			return;
		}
		setRowError(null);
		save.mutate();
	}

	return (
		<li className={styles.row} data-testid={`expense-${expense.id}`}>
			<CategoryIcon category={expense.category} />
			<span>{CATEGORY_LABELS[expense.category]}</span>
			<span className={styles.amount}>{formatMoney(expense.amount)}</span>
			{expense.note !== null && <span>{expense.note}</span>}
			{/* meal_id 有值＝這筆是記一餐時順手建立的餐費（規格 §4.1）。
			    在編輯畫面刪掉那一餐時，後端連這筆一起刪（編輯餐點規格 §3.4），
			    EditMeal 會失效 expensesAll；別的路徑刪了餐點時是 SET NULL
			    （app/models/expense.py）：標示消失，但錢保留。 */}
			{expense.meal_id !== null && <span>（餐費）</span>}

			{editing ? (
				// 用 <form> 不是 onClick：Enter / 手機鍵盤的「前往」都該能儲存。
				// **故意不給 amount 加 required**——
				// 原生驗證會搶在「請輸入金額」這條 JS 擋欄之前擋下送出。
				<form onSubmit={handleSave}>
					<label htmlFor={`edit-amount-${expense.id}`}>修改金額</label>
					<input
						id={`edit-amount-${expense.id}`}
						type="text"
						inputMode="decimal"
						value={draftAmount}
						onChange={(event) => setDraftAmount(event.target.value)}
					/>
					<button type="submit" disabled={save.isPending}>
						儲存
					</button>
					<button
						type="button"
						onClick={() => {
							setEditing(false);
							setRowError(null);
						}}
					>
						放棄
					</button>
				</form>
			) : (
				<button
					type="button"
					onClick={() => {
						// 草稿在**打開編輯器的當下**重新載入，不是只在放棄時重設：
						// 如果清單在背景重取過（例如另一個分頁改了這筆），上次
						// 打開編輯器時讀到的 expense.amount 可能已經過期，這裡
						// 保證每次打開看到的都是目前畫面上顯示的金額。
						setDraftAmount(expense.amount);
						setRowError(null);
						setEditing(true);
					}}
				>
					修改
				</button>
			)}

			{confirmingDelete ? (
				<div role="alertdialog" aria-label="確認刪除">
					<p>確定要刪掉這筆花費嗎？</p>
					{/* disabled while pending——刪除兩次第二次會 404，
					    顯示出一個會誤導使用者的錯誤。 */}
					<button
						type="button"
						className={styles.danger}
						disabled={remove.isPending}
						onClick={() => {
							setRowError(null);
							remove.mutate();
						}}
					>
						確定刪除
					</button>
					<button
						ref={confirmFocus.cancelRef}
						type="button"
						onClick={() => {
							confirmFocus.cancelled();
							setConfirmingDelete(false);
							setRowError(null);
						}}
					>
						取消
					</button>
				</div>
			) : (
				<button
					ref={confirmFocus.triggerRef}
					type="button"
					className={styles.danger}
					onClick={() => {
						setConfirmingDelete(true);
						setRowError(null);
					}}
				>
					刪除
				</button>
			)}

			{rowError !== null && <p role="alert">{rowError}</p>}
		</li>
	);
}

type MonthQuery =
	| ReturnType<typeof useExpenseSummary>
	| ReturnType<typeof useExpenses>;

/** 這個月的資料現在**拿不到**：請求失敗了，或離線而且快取裡沒有這個月。
 *
 *  離線時 query 是 `paused`，不會自己結束（同 `Targets.tsx`）——不當成讀不到的話：
 *  - 換月份：`keepPreviousData` 留著的上一個月會一直掛在新月份的標題底下，沒有任何訊息；
 *  - 直接打開：一直是「載入中…」。
 *  快取裡有這個月（離線還原的、剛看過的）就不算：那是真的資料，照樣顯示。 */
function isUnavailable(query: MonthQuery): boolean {
	return (
		query.isError ||
		(query.fetchStatus === "paused" &&
			(query.isPending || query.isPlaceholderData))
	);
}

/** 畫面上留著的是**上一個月**的資料、新的那個月還在抓（`keepPreviousData`）。 */
function isShowingPreviousMonth(query: MonthQuery): boolean {
	return query.isPlaceholderData && !isUnavailable(query);
}

type MonthSummaryProps = {
	query: ReturnType<typeof useExpenseSummary>;
	/** 看的不是這個月時，那個月的名字（「2026年9月」）；這個月是 `null`。 */
	otherMonth: string | null;
};

/** 一個月的總額與分類佔比。用 early return 取代巢狀三元——跟 `ExpenseRow`
 *  同一個理由，分支一多，巢狀三元就比依序判斷難讀。
 *
 *  **本地 const 是讓窄化撐過 `.map()` callback 的關鍵**：TS 確實會窄化
 *  `query.data` 本身，但窄化不會跟著閉包進到 callback 裡——指到同一個
 *  本地變數就會。 */
function MonthSummary({ query, otherMonth }: MonthSummaryProps) {
	const unavailable = isUnavailable(query);
	if (query.isPending && !unavailable) return <p>載入中…</p>;
	const summary = query.data;
	// 失敗不能卡在「載入中…」——那會讓使用者以為還在等，而不是知道要重試。
	// 讀不到的時候 `data` 可能還是上一個月的（離線、keepPreviousData）：不拿它來畫。
	if (unavailable || summary == null) {
		return (
			<p>
				{otherMonth === null
					? "無法載入本月報表"
					: `無法載入${otherMonth}的報表`}
			</p>
		);
	}
	return (
		<div>
			<p className={styles.monthTotal}>
				總計 <span>{formatMoney(summary.total)}</span>
			</p>
			{/* 沒有支出（總額是 0 或沒有任何分類）時不畫甜甜圈——一個空的圈
			    讀起來像「載入失敗」。總計那一行照樣顯示 0.00。 */}
			{isPositiveAmount(summary.total) && summary.by_category.length > 0 ? (
				<>
					<CategoryDonut rows={summary.by_category} total={summary.total} />
					{summary.by_category.map((row) => (
						<CategoryBar
							key={row.category}
							row={row}
							monthTotal={summary.total}
						/>
					))}
				</>
			) : (
				<p>
					{otherMonth === null ? "這個月還沒有支出" : `${otherMonth}沒有支出`}
				</p>
			)}
		</div>
	);
}

/** 換月份後、新的那個月還沒回來時，畫面上留著的是上一個月的資料
 *  （`keepPreviousData`）：調淡、`aria-busy`，同趨勢頁換期間的作法。
 *
 *  **外加 `inert`**：標題已經是新的月份，底下那幾列的「修改」「刪除」卻是上一個月的
 *  ——不能讓人在「2026年9月」底下改到十月的帳。`inert` 讓整層點不到、Tab 不到、
 *  螢幕閱讀器也不唸（React 19 起是布林屬性）；新的月份回來就拿掉。 */
function staleProps(stale: boolean) {
	return stale
		? { "aria-busy": true, inert: true, className: styles.stale }
		: {};
}

/** 報表：一個月的總額、分類佔比與花費清單（可改金額、刪除）。
 *
 *  新增改由「＋」→ 記帳（`AddExpense.tsx`）；入口是 tab bar 的「報表」
 *  （`/reports`，舊網址 `/expenses` 會轉址過來）。
 *
 *  **看哪個月寫在網址上：`?month=YYYY-MM`，沒有就是這個月**（報表月份與匯出
 *  規格 §2）。重新整理、上一頁、下一頁因此都對。
 *
 *  **「這個月」是後端說的，不是裝置的日期。** `useExpenseSummary(null)` 不帶
 *  `?month=`，後端用使用者時區決定（`this_month_in_timezone`），回應的 `month`
 *  就是那個月——「下個月」到這裡為止、網址上的月份有沒有超過，都跟它比。
 *  還不知道（載入中、失敗）的時候不猜：沒帶月份就兩顆都不能按。
 *
 *  **網址上的月份不能用就當成沒帶，並用 `replace` 清掉**（上一頁不會回到一個
 *  只會再被清掉的網址）：格式不對的馬上清；比這個月還後面的，等後端回了這個月
 *  才知道，那時才清。剛好等於這個月的不清——清掉的話，離線快取裡那份「這個月」
 *  如果是上個月留下的，會把人從他要看的月份帶走。
 */
export function Expenses() {
	const queryClient = useQueryClient();
	const [searchParams, setSearchParams] = useSearchParams();

	const currentQuery = useExpenseSummary(null);
	const currentMonth = currentQuery.data?.month ?? null;

	const raw = searchParams.get("month");
	const requested = raw !== null && isYearMonth(raw) ? raw : null;
	// `YYYY-MM` 補零、等長：字串比大小就是月份的先後。
	const isFuture =
		requested !== null && currentMonth !== null && requested > currentMonth;
	/** 要看的月份；`null`＝這個月（讓後端決定）。 */
	const selected = isFuture ? null : requested;
	const needsCleanup = raw !== null && selected === null;

	useEffect(() => {
		if (!needsCleanup) return;
		setSearchParams(
			(current) => {
				const params = new URLSearchParams(current);
				params.delete("month");
				return params;
			},
			{ replace: true },
		);
	}, [needsCleanup, setSearchParams]);

	const expensesQuery = useExpenses(selected);
	const expenses = expensesQuery.data ?? [];
	const summaryQuery = useExpenseSummary(selected);

	/** 畫面上是哪個月；`null`＝沒帶月份，而且還不知道這個月是哪個月。 */
	const shownMonth = selected ?? currentMonth;
	const monthName = shownMonth === null ? null : formatYearMonth(shownMonth);
	const isCurrent = selected === null || selected === currentMonth;
	const otherMonth = isCurrent ? null : monthName;

	const previous = shownMonth === null ? null : shiftMonth(shownMonth, -1);
	const next =
		shownMonth === null || currentMonth === null || shownMonth >= currentMonth
			? null
			: shiftMonth(shownMonth, 1);

	/** 換月份：新的一筆歷史紀錄（預設就是 push）。到這個月就把參數拿掉——
	 *  沒有參數才會跟著後端的「這個月」走，跨月之後不會停在舊的月份。 */
	function goTo(month: string) {
		setSearchParams((current) => {
			const params = new URLSearchParams(current);
			if (month === currentMonth) params.delete("month");
			else params.set("month", month);
			return params;
		});
	}

	return (
		<section>
			<h1>報表</h1>

			{/* 介面改版：「趨勢」不再是 tab，入口在報表——兩者都是「回頭看」。 */}
			<nav className={styles.links} aria-label="報表相關">
				<Link to="/trend">營養趨勢</Link>
			</nav>

			{/* 箭頭是裝飾（aria-hidden）：按鈕的名稱就是「上個月」「下個月」。
			    月份是 role="status"：換月份時螢幕閱讀器會唸出新的月份。

			    不能按的時候是 aria-disabled，不是原生的 disabled（審查 M5）：從過去翻到
			    這個月的那一下，「下個月」正在焦點上——原生停用會讓它失去焦點（Chromium 實測，
			    e2e 守著）。兩顆用同一種作法（「上個月」到 1900-01 為止也一樣）。
			    瀏覽器不再替我們擋 click：onClick 裡的 `!== null` 就是那道擋。 */}
			{/* biome-ignore lint/a11y/useSemanticElements: role=group 與 fieldset 語意相同；fieldset 要另外重設 border、padding、min-inline-size（同 MoneyKeypad） */}
			<div className={styles.monthSwitch} role="group" aria-label="切換月份">
				<button
					type="button"
					className={ui.secondary}
					aria-disabled={previous === null}
					onClick={() => {
						if (previous !== null) goTo(previous);
					}}
				>
					<span aria-hidden="true">‹ </span>上個月
				</button>
				<p className={styles.monthLabel} role="status">
					{monthName ?? "這個月"}
				</p>
				<button
					type="button"
					className={ui.secondary}
					aria-disabled={next === null}
					onClick={() => {
						if (next !== null) goTo(next);
					}}
				>
					下個月<span aria-hidden="true"> ›</span>
				</button>
			</div>

			{/* 電腦版：左＝這個月花了多少、右＝這個月的明細（電腦版版面規格 §4）。
			    本來的順序就是先摘要後明細，手機版照樣往下排。 */}
			<div className={layout.columns}>
				<div>
					<h2>
						{otherMonth === null ? "這個月花了多少" : `${otherMonth}花了多少`}
					</h2>
					<Card testId="expense-summary">
						<div
							data-testid="month-summary"
							{...staleProps(isShowingPreviousMonth(summaryQuery))}
						>
							<MonthSummary query={summaryQuery} otherMonth={otherMonth} />
						</div>
					</Card>
				</div>

				<div>
					<h2>{otherMonth ?? "這個月"}</h2>
					<Card>
						<div
							data-testid="month-list"
							{...staleProps(isShowingPreviousMonth(expensesQuery))}
						>
							{isUnavailable(expensesQuery) ? (
								// 失敗不能落到「這個月還沒有記錄花費」——這是報表畫面，
								// 空清單的措辭會引誘使用者重打一筆，造成重複記帳
								// （跟 MealList.tsx 的 isError 分支同一個理由）。
								// 離線而且沒看過這個月也走這裡：不把上一個月的列留在新的標題底下。
								<p>無法載入花費清單</p>
							) : expensesQuery.isPending ? (
								<p>載入中…</p>
							) : expenses.length === 0 ? (
								<p>
									{otherMonth === null
										? "這個月還沒有記錄花費"
										: `${otherMonth}沒有記錄花費`}
								</p>
							) : (
								<ul className={styles.list}>
									{expenses.map((expense) => (
										<ExpenseRow
											key={expense.id}
											expense={expense}
											onChanged={() =>
												// 前綴比對：每個月的清單與報表、總覽的今天支出一起失效
												// ——改的是過去的月份也一樣。
												void queryClient.invalidateQueries({
													queryKey: queryKeys.expensesAll,
												})
											}
										/>
									))}
								</ul>
							)}
						</div>
					</Card>
				</div>
			</div>
		</section>
	);
}
