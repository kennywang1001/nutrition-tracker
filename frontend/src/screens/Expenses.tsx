import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { apiFetch } from "../api/client";
import { ApiError } from "../api/errors";
import {
	AMOUNT_FORMAT_ERROR,
	CATEGORY_LABELS,
	CATEGORY_ORDER,
	type Expense,
	type ExpenseCategory,
	useExpenseSummary,
	useExpenses,
} from "../api/expenses";
import { queryKeys } from "../api/queries";
import { CategoryBar } from "../components/CategoryBar";
import { formatMoney } from "../lib/decimal";

type RowProps = {
	expense: Expense;
	onEdited: () => void;
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
function ExpenseRow({ expense, onEdited }: RowProps) {
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
			onEdited();
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
			onEdited();
		},
		onError: () => setRowError("刪除失敗，請再試一次"),
	});

	function handleSave(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		// 跟新增表單同一個理由：空字串擋在前端，不要白打一次請求。
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
			{/* meal_id 有值代表這筆是記一餐時順手填的餐費（規格 §4.1）。
			    標示出來，使用者才知道為什麼刪掉那一餐之後這筆錢還在。 */}
			{expense.meal_id !== null && <span>（餐費）</span>}

			{editing ? (
				// 用 <form> 不是 onClick：Enter / 手機鍵盤的「前往」都該能儲存，
				// 跟新增表單同一個作法。**故意不給 amount 加 required**——
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

/** 記帳：這個月的花費清單 + 新增。
 *
 *  **入口在 `Today.tsx`，不是第六個 tab**（規格 §6.1、§6.2 方向 1）——
 *  tab bar 現在 4 格（管理員 5 格），320px 寬度下第六格只剩 53.3px，
 *  而「今日總覽」四個字約 56px，塞不進去。
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

	const [amount, setAmount] = useState("");
	const [category, setCategory] = useState<ExpenseCategory>("food");
	const [note, setNote] = useState("");
	const [error, setError] = useState<string | null>(null);

	const createExpense = useMutation({
		mutationFn: () =>
			apiFetch<Expense>("/api/expenses", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					// 金額一律以字串送出，不要 Number()（規格 §2.4）。
					amount,
					category,
					// **一律用 toISOString()，永遠帶 Z。**
					// 後端是 AwareDatetime，沒有 offset 的 datetime 會回 422
					// （P5 計畫一最終審查修掉的那個 bug）。這也是這個畫面
					// 刻意沒有日期選擇器的原因之一——<input type="datetime-local">
					// 產出的就是沒有 offset 的格式。
					spent_at: new Date().toISOString(),
					note: note.trim() === "" ? null : note.trim(),
				}),
			}),
		onSuccess: () => {
			setAmount("");
			setNote("");
			setError(null);
			// 一次失效打到清單與報表兩者（queryKeys.expensesAll 是兩者的前綴）。
			void queryClient.invalidateQueries({ queryKey: queryKeys.expensesAll });
		},
		onError: (caught: unknown) => {
			if (caught instanceof ApiError && caught.code === "VALIDATION_ERROR") {
				setError(AMOUNT_FORMAT_ERROR);
				return;
			}
			setError("記帳失敗，請再試一次");
		},
	});

	function handleSubmit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		// 擋在前端，不是靠後端回 422——空字串送出去只會換來一個
		// 使用者看不懂的驗證錯誤，而且白打一次請求。
		if (amount.trim() === "") {
			setError("請輸入金額");
			return;
		}
		setError(null);
		createExpense.mutate();
	}

	return (
		<section>
			<h1>記帳</h1>

			<h2>記一筆</h2>
			{/* 用 <form> 不是 onClick：手機鍵盤的「前往」/ Enter 都該能送出，
			    跟其他每一個新增表單（Supplements.tsx 等）同一個作法。
			    **故意不給 amount 加 required**——原生驗證會搶在「請輸入金額」
			    這條 JS 擋欄之前擋下送出，讓那條測試失去鑑別力。 */}
			<form onSubmit={handleSubmit}>
				<div>
					<label htmlFor="expense-amount">金額</label>
					{/* inputMode="decimal" 讓手機跳數字鍵盤。
					    font-size 由 index.css 的全域規則保證 ≥16px（iOS Safari
					    在 <16px 時會自動放大整個頁面，P3-C 踩過）——
					    **不要在這裡覆寫成更小的字**。 */}
					<input
						id="expense-amount"
						type="text"
						inputMode="decimal"
						value={amount}
						onChange={(event) => setAmount(event.target.value)}
					/>
				</div>
				<div>
					<label htmlFor="expense-category">分類</label>
					<select
						id="expense-category"
						value={category}
						onChange={(event) =>
							setCategory(event.target.value as ExpenseCategory)
						}
					>
						{CATEGORY_ORDER.map((value) => (
							<option key={value} value={value}>
								{CATEGORY_LABELS[value]}
							</option>
						))}
					</select>
				</div>
				<div>
					<label htmlFor="expense-note">備註</label>
					{/* maxLength 對齊後端 ExpenseCreateRequest.note 的
					    Field(max_length=500)（app/schemas/expense.py）。 */}
					<input
						id="expense-note"
						type="text"
						maxLength={500}
						value={note}
						onChange={(event) => setNote(event.target.value)}
					/>
				</div>
				{/* disabled while pending——跟每一個手足畫面一樣（Supplements.tsx
				    的「新增補劑」按鈕）：連點兩下不該把同一筆錢記兩次。 */}
				<button type="submit" disabled={createExpense.isPending}>
					記一筆
				</button>
				{error !== null && <p role="alert">{error}</p>}
			</form>

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
							onEdited={() =>
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
