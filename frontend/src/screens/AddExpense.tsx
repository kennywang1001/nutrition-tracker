import { useMutation, useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";
import { type FormEvent, useState } from "react";
import { apiFetch } from "../api/client";
import { ApiError } from "../api/errors";
import {
	AMOUNT_FORMAT_ERROR,
	CATEGORY_LABELS,
	CATEGORY_ORDER,
	type Expense,
	type ExpenseCategory,
} from "../api/expenses";
import { queryKeys } from "../api/queries";
import { CategoryIcon } from "../components/IconBadge";
import { MoneyKeypad } from "../components/MoneyKeypad";
import { isPositiveAmount } from "../lib/decimal";
import { normalizeAmount } from "../lib/keypad";
import styles from "./AddExpense.module.css";

type Props = {
	/** 送出成功或按關閉之後。路由層決定去哪裡（`App.tsx` 導回 `/`）。 */
	onDone: () => void;
};

/** 記帳（介面改版規格 §5.3）：大字金額、分類圖示格、備註、數字鍵盤。
 *
 *  **時間固定是「現在」**，沒有日期選擇器：`<input type="datetime-local">`
 *  產出沒有時區 offset 的字串，後端的 `AwareDatetime` 會回 422
 *  （P5 計畫二開頭的地雷）。
 *
 *  整個畫面是一個 `<form>`：鍵盤的 ✓ 是 `type="submit"`，備註欄按 Enter
 *  也走同一條 `handleSubmit`。 */
export function AddExpense({ onDone }: Props) {
	const queryClient = useQueryClient();
	const [amount, setAmount] = useState("");
	const [category, setCategory] = useState<ExpenseCategory>("food");
	const [note, setNote] = useState("");
	const [error, setError] = useState<string | null>(null);

	const save = useMutation({
		mutationFn: () =>
			apiFetch<Expense>("/api/expenses", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					// 字串送出，不經過 Number()（規格 §2.4）；"5." 去掉小數點。
					amount: normalizeAmount(amount),
					category,
					// **一律 toISOString()，永遠帶 Z**——見上面的 docstring。
					spent_at: new Date().toISOString(),
					note: note.trim() === "" ? null : note.trim(),
				}),
			}),
		onSuccess: () => {
			// 報表與總覽的今天支出都掛在 expensesAll 底下，一次失效全部打到。
			void queryClient.invalidateQueries({ queryKey: queryKeys.expensesAll });
			onDone();
		},
		onError: (caught: unknown) => {
			// 失敗時金額與分類**不清掉**（規格 §5.3）：使用者修正之後再按一次就好。
			if (caught instanceof ApiError && caught.code === "VALIDATION_ERROR") {
				setError(AMOUNT_FORMAT_ERROR);
				return;
			}
			setError("記帳失敗，請再試一次");
		},
	});

	function handleSubmit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		// ✓ 停用時按 Enter 仍然會觸發 submit——這裡是第二道防線。
		if (!isPositiveAmount(amount) || save.isPending) return;
		setError(null);
		save.mutate();
	}

	return (
		<form className={styles.screen} onSubmit={handleSubmit}>
			<header className={styles.header}>
				<button
					type="button"
					className={styles.close}
					aria-label="關閉"
					onClick={onDone}
				>
					<X aria-hidden="true" />
				</button>
				<h1>記帳</h1>
			</header>

			<output aria-label="金額" className={styles.amount}>
				<span className={styles.currency} aria-hidden="true">
					$
				</span>
				{amount === "" ? "0" : amount}
			</output>

			<fieldset className={styles.categories}>
				<legend>分類</legend>
				<div className={styles.categoryGrid}>
					{CATEGORY_ORDER.map((value) => (
						<button
							key={value}
							type="button"
							className={styles.category}
							aria-pressed={category === value}
							onClick={() => setCategory(value)}
						>
							<CategoryIcon category={value} />
							{CATEGORY_LABELS[value]}
						</button>
					))}
				</div>
			</fieldset>

			<label className={styles.note}>
				備註
				<input
					type="text"
					maxLength={500}
					value={note}
					onChange={(event) => setNote(event.target.value)}
				/>
			</label>

			{error !== null && (
				<p role="alert" className={styles.error}>
					{error}
				</p>
			)}

			<MoneyKeypad
				value={amount}
				onChange={setAmount}
				submitDisabled={!isPositiveAmount(amount) || save.isPending}
			/>
		</form>
	);
}
