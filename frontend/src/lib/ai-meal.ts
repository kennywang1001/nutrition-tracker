import type {
	AnalyzedMealItem,
	AnalyzeMealResponse,
	AnalyzeResponse,
	LibraryFoodMatch,
} from "../api/ai";
import type { EstimateDraft } from "./ai-food";
import { formatMacro } from "./decimal";

/** 一樣 ＋ 外層的 `analysis_id`／`remaining_today` → 單樣流程的 `AnalyzeResponse`。
 *
 *  為了**原樣重用** `lib/ai-food.ts`：`confirmedFoodRequest`、`draftFromEstimate`、
 *  `editedFoodRequest` 吃的都是它（AI 多樣估算規格 D3）。`food_id` 一律 null——
 *  食物庫同名的那一筆在清單項目的 `library`，不混進這個物件
 *  （它會被整個存成食物的 `ai_raw_response`）。 */
export function toEstimate(
	result: AnalyzeMealResponse,
	item: AnalyzedMealItem,
): AnalyzeResponse {
	return {
		analysis_id: result.analysis_id,
		food_id: null,
		name: item.name,
		brand: item.brand,
		nutrition: item.nutrition,
		confidence: item.confidence,
		consistency: item.consistency,
		remaining_today: result.remaining_today,
	};
}

/** 要使用者決定才能繼續的那一樣。 */
export type ItemConflict = {
	/** `own`：建食物時撞到自己的同名食物（409 FOOD_EXISTS）。
	 *  `library`：改過名稱之後，跟看得到的食物同名。 */
	source: "own" | "library";
	foodId: number;
	name: string;
};

/** 勾選清單的一列。**狀態只往前走**：`added` 一旦是 true 就不會再被處理——
 *  「同一樣不會加兩次」靠的是這個，不是按鈕停用（規格 D18）。 */
export type ChecklistItem = {
	/** 回應裡的第幾樣；整個清單的生命週期裡不變。 */
	key: number;
	estimate: AnalyzeResponse;
	/** 預設用食物庫的這一筆；按了「改用 AI 的數字」之後是 null。 */
	library: LibraryFoodMatch | null;
	checked: boolean;
	/** 「套用」過的修改（一份的值，還沒建任何東西）。 */
	draft: EstimateDraft | null;
	/** 衝突時選了「用食物庫的／用現有的」：加入時直接拿這個食物。 */
	pickedFoodId: number | null;
	/** 衝突時選了「還是建一個」：這一樣不再查同名。 */
	skipSameNameCheck: boolean;
	added: boolean;
	error: string | null;
	conflict: ItemConflict | null;
};

export function initialChecklist(result: AnalyzeMealResponse): ChecklistItem[] {
	return result.items.map((item, index) => ({
		key: index,
		estimate: toEstimate(result, item),
		library: item.library_food,
		checked: true,
		draft: null,
		pickedFoodId: null,
		skipSameNameCheck: false,
		added: false,
		error: null,
		conflict: null,
	}));
}

/** 清單上顯示的名稱＝會記下去的那個食物的名稱。 */
export function itemName(item: ChecklistItem): string {
	if (item.draft !== null) return item.draft.name.trim();
	return item.library?.name ?? item.estimate.name;
}

/** 清單上顯示的量、單位、熱量——**會記下去的那一組**：改過的看草稿；用食物庫的
 *  看後端算好的 `library.serving_kcal`（食物庫的每 100 × AI 估的量）；其餘是 AI 的。
 *  這裡不做任何乘除（小數運算只在 `lib/decimal.ts`）。
 *
 *  `quantity` 同時是放進這一餐的量（g 或 ml）。 */
export function itemAmount(item: ChecklistItem): {
	quantity: string;
	unit: string;
	kcal: string;
} {
	const nutrition = item.estimate.nutrition;
	if (item.draft !== null) {
		return {
			quantity: item.draft.servingGrams.trim(),
			unit: nutrition.base_unit,
			kcal: item.draft.kcal.trim(),
		};
	}
	if (item.library !== null) {
		return {
			quantity: formatMacro(nutrition.serving_grams),
			unit: item.library.base_unit,
			kcal: formatMacro(item.library.serving_kcal),
		};
	}
	return {
		quantity: formatMacro(nutrition.serving_grams),
		unit: nutrition.base_unit,
		kcal: formatMacro(nutrition.serving_kcal),
	};
}

/** 「加入這 N 樣」的 N：勾著而且還沒加入的。 */
export function pendingItems(items: readonly ChecklistItem[]): ChecklistItem[] {
	return items.filter((item) => item.checked && !item.added);
}

/** 比名稱用的鍵：去頭尾空白、不分大小寫（同 `findSameNameFood` 與後端的比對）。 */
export function nameKey(name: string): string {
	return name.trim().toLowerCase();
}

/** 改過而且名稱跟 AI 給的不同：後端的食物庫比對用的是 AI 的名稱，改名之後不算數，
 *  加入前要再查一次（規格「與原始決定的差異」第 7 點）。 */
export function wasRenamed(item: ChecklistItem): boolean {
	return (
		item.draft !== null &&
		nameKey(item.draft.name) !== nameKey(item.estimate.name)
	);
}
