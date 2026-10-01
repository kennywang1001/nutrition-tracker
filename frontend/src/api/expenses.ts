import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "./client";
import { queryKeys } from "./queries";
import type { components } from "./schema";

export type Expense = components["schemas"]["ExpenseResponse"];
export type ExpenseCategory = components["schemas"]["ExpenseCategory"];
export type ExpenseSummary = components["schemas"]["ExpenseSummaryResponse"];
export type CategoryTotal = components["schemas"]["CategoryTotal"];

/** 分類的中文標籤。**七個值必須全部列出。**
 *
 *  型別是 `Record<ExpenseCategory, string>`（不是 `Partial`）——漏一個
 *  就是 TypeScript 編譯錯誤。後端加分類時（規格 §3.4 明說這份清單會改），
 *  重新產生 `schema.d.ts` 之後這裡會立刻紅，而不是在畫面上顯示一個
 *  英文代碼。 */
export const CATEGORY_LABELS: Record<ExpenseCategory, string> = {
	food: "飲食",
	transport: "交通",
	daily: "日用",
	entertainment: "娛樂",
	medical: "醫療",
	housing: "居住",
	other: "其他",
};

/** 顯示用的分類順序。跟 `CATEGORY_LABELS` 一樣是七個全列。
 *
 *  新增表單的下拉選單用這個順序，**不是 `Object.keys()`** ——
 *  物件的鍵順序雖然在實務上穩定，但那不是我們想依賴的保證，
 *  而「飲食排第一」是刻意的（它是最常用的那個）。 */
export const CATEGORY_ORDER: readonly ExpenseCategory[] = [
	"food",
	"transport",
	"daily",
	"entertainment",
	"medical",
	"housing",
	"other",
];

/** 這個月（或指定月份）的花費清單。
 *
 *  `month` 為 `null` 時**不帶 `?month=`**，讓後端用使用者時區決定這個月
 *  （`this_month_in_timezone`）。前端不自己算月份——跟 `Today.tsx` 的
 *  `dailyStats` 查詢不自己算今天是同一條規矩（`queryKeys.dailyStats`
 *  不帶日期參數，見 `api/queries.ts` 檔頭註解）。 */
export function useExpenses(month: string | null) {
	return useQuery({
		queryKey: queryKeys.expenses(month),
		queryFn: () =>
			apiFetch<Expense[]>(
				month === null ? "/api/expenses" : `/api/expenses?month=${month}`,
			),
	});
}

/** 月報表：總額 + 分類佔比。`month` 的語意同 `useExpenses`。 */
export function useExpenseSummary(month: string | null) {
	return useQuery({
		queryKey: queryKeys.expenseSummary(month),
		queryFn: () =>
			apiFetch<ExpenseSummary>(
				month === null
					? "/api/expenses/summary"
					: `/api/expenses/summary?month=${month}`,
			),
	});
}
