import type { AnalyzeResponse } from "../api/ai";
import type { components } from "../api/schema";
import {
	formatMacro,
	isPlainPositiveDecimal,
	perServingToPer100,
} from "./decimal";

/** `is_global` 在產生的型別裡是必填（openapi-typescript 把有 default 的欄位
 *  當成必填），但後端預設 `false`，而 AI 估算存的一律是私人食物——不送。 */
export type AiFoodBody = Omit<
	components["schemas"]["FoodCreateRequest"],
	"is_global"
>;

/** AI 估出來的食物會帶一個預設份量，就叫「一份」——記一餐選上它時，
 *  份量自動是「一份 × 1」。 */
export const AI_PORTION_LABEL = "一份";

/** 一份重量的後端上限（`DefaultPortionInput.grams` 的 `le=10000`）。 */
const MAX_SERVING_GRAMS = 10000;

/** 修改表單的四個營養素。上限是**換算成每 100 之後**的上限——跟
 *  `NewFood` 的 `NUMERIC_FIELDS` 同一組（後端 `NutritionInput`）。 */
const NUTRIENTS = [
	{ field: "kcal", label: "一份的熱量", max: 10000 },
	{ field: "protein_g", label: "一份的蛋白質", max: 1000 },
	{ field: "fat_g", label: "一份的脂肪", max: 1000 },
	{ field: "carb_g", label: "一份的碳水化合物", max: 1000 },
] as const;

type Nutrient = (typeof NUTRIENTS)[number]["field"];

/** 修改表單的值：都是「一份」的，不是每 100（使用者看到的卡片就是一份）。 */
export type EstimateDraft = {
	name: string;
	servingGrams: string;
} & Record<Nutrient, string>;

/** 修改表單的初始值：卡片上那組一份的數字（`formatMacro` 去掉多餘的零）。 */
export function draftFromEstimate(estimate: AnalyzeResponse): EstimateDraft {
	const n = estimate.nutrition;
	return {
		name: estimate.name,
		servingGrams: formatMacro(n.serving_grams),
		kcal: formatMacro(n.serving_kcal),
		protein_g: formatMacro(n.serving_protein_g),
		fat_g: formatMacro(n.serving_fat_g),
		carb_g: formatMacro(n.serving_carb_g),
	};
}

/** 「確認」：直接用後端算好的每 100 值（P2 規格 §4.1：換算在後端做一次，
 *  前端不重算）。`ai_raw_response` 存整個估算回應——P2 規格 §5：之後才
 *  問得出「AI 常常錯很多嗎」。 */
export function confirmedFoodRequest(estimate: AnalyzeResponse): AiFoodBody {
	const n = estimate.nutrition;
	return {
		name: estimate.name,
		brand: estimate.brand,
		nutrition: {
			base_unit: n.base_unit,
			kcal: n.kcal,
			protein_g: n.protein_g,
			fat_g: n.fat_g,
			carb_g: n.carb_g,
		},
		default_portion: { label: AI_PORTION_LABEL, grams: n.serving_grams },
		source: "ai",
		ai_confidence: estimate.confidence,
		ai_raw_response: estimate,
	};
}

export type EditedResult =
	| { ok: true; body: AiFoodBody }
	| { ok: false; error: string };

/** 「需要修改」之後存：使用者改的是一份的值，換算成每 100 用
 *  `perServingToPer100`（新增食物「每一份」模式同一個函式）。
 *
 *  **`source: "user"`，但 `ai_confidence` 與 `ai_raw_response` 照樣送 AI 原本的**
 *  （P2 規格 §5）——改過之後仍然留著 AI 說了什麼。 */
export function editedFoodRequest(
	estimate: AnalyzeResponse,
	draft: EstimateDraft,
): EditedResult {
	const name = draft.name.trim();
	if (name === "") return { ok: false, error: "請輸入名稱" };

	const grams = draft.servingGrams.trim();
	if (!isPlainPositiveDecimal(grams)) {
		return { ok: false, error: "一份的重量要大於 0" };
	}
	if (Number(grams) > MAX_SERVING_GRAMS) {
		return { ok: false, error: `一份的重量不能超過 ${MAX_SERVING_GRAMS}` };
	}

	// 先放占位值，迴圈每個欄位驗過才覆寫；任何一個失敗就直接 return，
	// 占位值不會外流。這樣型別是完整的 Record，不必用 `as`。
	const per100: Record<Nutrient, string> = {
		kcal: "",
		protein_g: "",
		fat_g: "",
		carb_g: "",
	};
	for (const { field, label, max } of NUTRIENTS) {
		const raw = draft[field].trim();
		if (raw === "") return { ok: false, error: `請輸入${label}` };
		const converted = perServingToPer100(raw, grams);
		if (converted === null) {
			return { ok: false, error: `${label}必須是 0 以上的數字` };
		}
		// 換算後超過上限，通常代表一份的重量少打一位數。
		if (Number(converted) > max) {
			return { ok: false, error: "換算後超過上限，請確認一份的重量" };
		}
		per100[field] = converted;
	}

	return {
		ok: true,
		body: {
			name,
			brand: estimate.brand,
			nutrition: { base_unit: estimate.nutrition.base_unit, ...per100 },
			default_portion: { label: AI_PORTION_LABEL, grams },
			source: "user",
			ai_confidence: estimate.confidence,
			ai_raw_response: estimate,
		},
	};
}
