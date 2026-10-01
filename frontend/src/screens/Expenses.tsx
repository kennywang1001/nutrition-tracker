import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { apiFetch } from "../api/client";
import { ApiError } from "../api/errors";
import {
	CATEGORY_LABELS,
	CATEGORY_ORDER,
	type Expense,
	type ExpenseCategory,
	useExpenses,
} from "../api/expenses";
import { queryKeys } from "../api/queries";
import { formatMoney } from "../lib/decimal";

/** 一筆花費的顯示列。 */
function ExpenseRow({ expense }: { expense: Expense }) {
	return (
		<li data-testid={`expense-${expense.id}`}>
			<span>{CATEGORY_LABELS[expense.category]}</span>
			<span>{formatMoney(expense.amount)}</span>
			{expense.note !== null && <span>{expense.note}</span>}
			{/* meal_id 有值代表這筆是記一餐時順手填的餐費（規格 §4.1）。
			    標示出來，使用者才知道為什麼刪掉那一餐之後這筆錢還在。 */}
			{expense.meal_id !== null && <span>（餐費）</span>}
		</li>
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
			queryClient.invalidateQueries({ queryKey: queryKeys.expensesAll });
		},
		onError: (caught: unknown) => {
			if (caught instanceof ApiError && caught.code === "VALIDATION_ERROR") {
				setError("金額格式不對，請輸入大於 0 的數字");
				return;
			}
			setError("記帳失敗，請再試一次");
		},
	});

	function handleSubmit() {
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
				<input
					id="expense-note"
					type="text"
					value={note}
					onChange={(event) => setNote(event.target.value)}
				/>
			</div>
			<button type="button" onClick={handleSubmit}>
				記一筆
			</button>
			{error !== null && <p role="alert">{error}</p>}

			<h2>這個月</h2>
			{expensesQuery.isPending ? (
				<p>載入中…</p>
			) : expenses.length === 0 ? (
				<p>這個月還沒有記錄花費</p>
			) : (
				<ul>
					{expenses.map((expense) => (
						<ExpenseRow key={expense.id} expense={expense} />
					))}
				</ul>
			)}
		</section>
	);
}
