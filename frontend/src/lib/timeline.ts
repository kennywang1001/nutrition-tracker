import type { Exercise } from "../api/exercises";
import type { Expense } from "../api/expenses";
import type { Meal } from "../api/meals";

export type TimelineRow =
	| {
			kind: "meal";
			key: string;
			time: string;
			meal: Meal;
			/** 這一餐的餐費（`expenses.meal_id` 指過來的那一筆）；沒有就是 `null`。 */
			cost: string | null;
	  }
	| { kind: "expense"; key: string; time: string; expense: Expense }
	| { kind: "exercise"; key: string; time: string; exercise: Exercise };

/** 總覽的今天時間線（規格 §6.2）：今天的餐、今天的支出、今天的運動排在同一條線上。
 *
 *  1. 支出的 `meal_id` 對得上今天某一餐 → 金額併進那一餐，不另列。
 *     外食記一餐會在後端建「一餐＋一筆指回來的支出」，不併的話同一頓飯
 *     出現兩次。
 *  2. 其他支出各自一列——包括 `meal_id` 有值但那一餐不在清單裡的。
 *     **錢不能因為對不上就消失。**同一餐第二筆支出也照這條規則單獨一列。
 *  3. 依時間由新到舊。這是排序兩個時刻，不是算日界線
 *     （`lib/dates.ts` 頂端那條規矩管的是後者）。
 *  4. 運動各自一列（運動規格 §7.4），用運動的時間（`performed_at`，不是記下的時間）。
 *     預設 `[]`：只有總覽有運動，其他呼叫端不用改。 */
export function buildTimeline(
	meals: readonly Meal[],
	expenses: readonly Expense[],
	exercises: readonly Exercise[] = [],
): TimelineRow[] {
	const mealIds = new Set(meals.map((meal) => meal.id));
	const costByMeal = new Map<number, string>();
	const rows: TimelineRow[] = [];

	for (const expense of expenses) {
		if (
			expense.meal_id !== null &&
			mealIds.has(expense.meal_id) &&
			!costByMeal.has(expense.meal_id)
		) {
			costByMeal.set(expense.meal_id, expense.amount);
			continue;
		}
		rows.push({
			kind: "expense",
			key: `expense-${expense.id}`,
			time: expense.spent_at,
			expense,
		});
	}

	for (const meal of meals) {
		rows.push({
			kind: "meal",
			key: `meal-${meal.id}`,
			time: meal.eaten_at,
			meal,
			cost: costByMeal.get(meal.id) ?? null,
		});
	}

	// 運動不跟餐或支出合併（運動規格 §7.4）。
	for (const exercise of exercises) {
		rows.push({
			kind: "exercise",
			key: `exercise-${exercise.id}`,
			time: exercise.performed_at,
			exercise,
		});
	}

	return rows.sort((a, b) => Date.parse(b.time) - Date.parse(a.time));
}
