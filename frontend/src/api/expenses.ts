import { useQuery } from "@tanstack/react-query";
import {
	Bus,
	Ellipsis,
	Gamepad2,
	House,
	type LucideIcon,
	Pill,
	ShoppingBag,
	Utensils,
} from "lucide-react";
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

/** 金額格式錯誤的訊息。**`Expenses.tsx` 的 amount 與 `LogMeal.tsx` 的
 *  cost 共用同一條後端規則**（`gt=0`、最多兩位小數——後者的
 *  `max_digits=10, decimal_places=2` 就是對齊 `expenses.amount` 訂的），
 *  所以兩個畫面共用同一句訊息，不要各寫一份、任由兩邊的說法飄走。 */
export const AMOUNT_FORMAT_ERROR =
	"金額格式不對，請輸入大於 0、最多兩位小數的數字";

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

/** 分類的顏色（規格 §4.2）。`Record` 不是 `Partial`，理由同 `CATEGORY_LABELS`。
 *
 *  **色碼寫在這裡、不寫在 CSS 變數**：這是「資料」（每個分類一個固定的
 *  識別色），不是主題——深淺色模式都一樣。`IconBadge` 用 inline style 套上。
 *
 *  白色圖示壓在這些顏色上的對比度大多不到 3:1，**這是刻意接受的**：
 *  徽章旁邊一定有文字標籤，圖示是裝飾（`aria-hidden`），不是唯一的資訊來源。 */
export const CATEGORY_COLORS: Record<ExpenseCategory, string> = {
	food: "#ff9f43",
	transport: "#54a0ff",
	daily: "#1dd1a1",
	entertainment: "#a29bfe",
	medical: "#ff6b6b",
	housing: "#feca57",
	other: "#8395a7",
};

/** 分類的圖示。名稱以 lucide-react 1.49 實際匯出的為準（`PieChart` 這種
 *  舊名已經不存在了——寫計畫時解開套件確認過）。 */
export const CATEGORY_ICONS: Record<ExpenseCategory, LucideIcon> = {
	food: Utensils,
	transport: Bus,
	daily: ShoppingBag,
	entertainment: Gamepad2,
	medical: Pill,
	housing: House,
	other: Ellipsis,
};

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

/** 某一天的支出。`date` 由呼叫端從 `useDailyStats()` 的回應拿——
 *  **前端不自己算今天**。`null` 時不發請求（`enabled: false`）。
 *
 *  注意：`enabled: false` 的 query 在 TanStack Query v5 是
 *  `isPending: true`。呼叫端要自己處理「拿不到 date」的情況（例如
 *  `stats/daily` 失敗），不然畫面會永遠停在「載入中」。 */
export function useExpensesByDate(date: string | null) {
	return useQuery({
		queryKey: queryKeys.expensesByDate(date),
		queryFn: () => apiFetch<Expense[]>(`/api/expenses?date=${date}`),
		enabled: date !== null,
	});
}
