import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
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
import { CategoryBar } from "../components/CategoryBar";
import { formatMoney } from "../lib/decimal";

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
 *
 *  **不能改日期。** `spent_at` 不在可改欄位裡——改日期需要一個
 *  `<input type="datetime-local">`，而它產出的是沒有時區 offset 的字串，
 *  後端的 `AwareDatetime` 會回 422。真的要做時必須先轉成帶 offset 的格式
 *  （見計畫開頭「刻意避開的地雷」）。
 */
function ExpenseRow({ expense, onChanged }: RowProps) {
	const [editing, setEditing] = useState(false);
	const [confirmingDelete, setConfirmingDelete] = useState(false);
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
		<li data-testid={`expense-${expense.id}`}>
			<span>{CATEGORY_LABELS[expense.category]}</span>
			<span>{formatMoney(expense.amount)}</span>
			{expense.note !== null && <span>{expense.note}</span>}
			{/* meal_id 有值＝這筆是記一餐時順手建立的餐費（規格 §4.1）。
			    刪掉那一餐時後端是 SET NULL（app/models/expense.py）：標示會
			    消失，但錢保留。**將來前端加刪除餐點時，要一併失效
			    queryKeys.expensesAll**，不然快取裡還會顯示（餐費）。 */}
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
						disabled={remove.isPending}
						onClick={() => {
							setRowError(null);
							remove.mutate();
						}}
					>
						確定刪除
					</button>
					<button
						type="button"
						onClick={() => {
							setConfirmingDelete(false);
							setRowError(null);
						}}
					>
						取消
					</button>
				</div>
			) : (
				<button
					type="button"
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

type MonthSummaryProps = {
	query: ReturnType<typeof useExpenseSummary>;
};

/** 這個月的總額與分類佔比。用 early return 取代巢狀三元——跟 `ExpenseRow`
 *  同一個理由，分支一多，巢狀三元就比依序判斷難讀。
 *
 *  **本地 const 是讓窄化撐過 `.map()` callback 的關鍵**：TS 確實會窄化
 *  `query.data` 本身，但窄化不會跟著閉包進到 callback 裡——指到同一個
 *  本地變數就會。 */
function MonthSummary({ query }: MonthSummaryProps) {
	if (query.isPending) return <p>載入中…</p>;
	const summary = query.data;
	// 失敗不能卡在「載入中…」——那會讓使用者以為還在等，而不是知道要重試。
	if (query.isError || summary == null) return <p>無法載入本月報表</p>;
	return (
		<div>
			<p>
				總計 <span>{formatMoney(summary.total)}</span>
			</p>
			{summary.by_category.map((row) => (
				<CategoryBar key={row.category} row={row} monthTotal={summary.total} />
			))}
		</div>
	);
}

/** 報表：這個月的總額、分類佔比與花費清單（可改金額、刪除）。
 *
 *  新增改由「＋」→ 記帳（`AddExpense.tsx`）；入口是 tab bar 的「報表」
 *  （`/reports`，舊網址 `/expenses` 會轉址過來）。
 *
 *  **`month` 固定傳 `null`**：讓後端用使用者時區決定「這個月」
 *  （`this_month_in_timezone`）。前端沒有月份選擇器——規格 §1.1 要回答的
 *  是「**這個**月花了多少」，看別的月份不在範圍內（規格 §8）。
 */
export function Expenses() {
	const queryClient = useQueryClient();
	const expensesQuery = useExpenses(null);
	const expenses = expensesQuery.data ?? [];
	const summaryQuery = useExpenseSummary(null);

	return (
		<section>
			<h1>報表</h1>

			<h2>這個月花了多少</h2>
			<div data-testid="expense-summary">
				<MonthSummary query={summaryQuery} />
			</div>

			<h2>這個月</h2>
			{expensesQuery.isPending ? (
				<p>載入中…</p>
			) : expensesQuery.isError ? (
				// 失敗不能落到「這個月還沒有記錄花費」——這是記帳畫面，
				// 空清單的措辭會引誘使用者重打一筆，造成重複記帳
				// （跟 MealList.tsx 的 isError 分支同一個理由）。
				<p>無法載入花費清單</p>
			) : expenses.length === 0 ? (
				<p>這個月還沒有記錄花費</p>
			) : (
				<ul>
					{expenses.map((expense) => (
						<ExpenseRow
							key={expense.id}
							expense={expense}
							onChanged={() =>
								void queryClient.invalidateQueries({
									queryKey: queryKeys.expensesAll,
								})
							}
						/>
					))}
				</ul>
			)}
		</section>
	);
}
