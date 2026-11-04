import type { LabelReadResponse } from "../api/ai";
import type { LabelTextParse } from "../api/label-text";
import type { components } from "../api/schema";
import { formatMacro } from "./decimal";

type BaseUnit = components["schemas"]["BaseUnit"];
type Nutrient = LabelTextParse["missing"][number];

/** 要填進新增食物表單的東西（`NewFood` 的 `applyLabelFill`）。數字是**每 100**；讀不到的是 ""。
 *  `name` 只有 AI 會給（手機辨識不讀名稱，規格 §1.2）。 */
export type LabelFill = {
	baseUnit: BaseUnit;
	values: Record<Nutrient, string>;
	serving: string | null;
	name: string | null;
};

const ORDER: readonly Nutrient[] = ["kcal", "protein_g", "fat_g", "carb_g"];
const NAMES: Record<Nutrient, string> = {
	kcal: "熱量",
	protein_g: "蛋白質",
	fat_g: "脂肪",
	carb_g: "碳水化合物",
};
const UNITS: Record<Nutrient, string> = {
	kcal: "kcal",
	protein_g: "g",
	fat_g: "g",
	carb_g: "g",
};

export function fillFromAi(result: LabelReadResponse): LabelFill {
	const { nutrition } = result;
	return {
		baseUnit: nutrition.base_unit,
		values: {
			kcal: nutrition.kcal,
			protein_g: nutrition.protein_g,
			fat_g: nutrition.fat_g,
			carb_g: nutrition.carb_g,
		},
		serving: result.serving?.amount ?? null,
		name: result.name,
	};
}

/** 完整的與不完整的都用 `found`（完整時跟 `nutrition` 是同一組數字）。 */
export function fillFromParse(parse: LabelTextParse): LabelFill {
	const { found } = parse;
	return {
		baseUnit: parse.base_unit,
		values: {
			kcal: found.kcal ?? "",
			protein_g: found.protein_g ?? "",
			fat_g: found.fat_g ?? "",
			carb_g: found.carb_g ?? "",
		},
		serving: parse.serving?.amount ?? null,
		name: null,
	};
}

export function hasFoundValues(parse: LabelTextParse): boolean {
	return ORDER.some((nutrient) => parse.found[nutrient] !== null);
}

/** 讀不完整時怎麼說（規格 §3.1；`no_values` 的說法見計畫「與規格的差異」第 1 點）。 */
export function describeLabelParse(parse: LabelTextParse): string {
	const implausible = "讀到的數字不太合理（可能少了小數點）";
	switch (parse.reason) {
		case "needs_serving_size":
			return "只有每份的數字，但讀不到每一份量";
		case "columns_unknown":
			return "看不出是每份還是每 100 的數字";
		case "implausible":
			return implausible;
		case "missing_fields": {
			// 後端的 missing_fields 只拿掉不合理的值（超過物理上限、兩欄對不起來）：一項都沒留下
			// 就是讀到了數字、但都不合理，不說「讀到：」空的那一句。
			if (!hasFoundValues(parse)) return implausible;
			const read: string[] = [];
			for (const nutrient of ORDER) {
				const value = parse.found[nutrient];
				if (value !== null) {
					read.push(
						`${NAMES[nutrient]} ${formatMacro(value)} ${UNITS[nutrient]}`,
					);
				}
			}
			const missing = parse.missing.map((nutrient) => NAMES[nutrient]);
			return `讀到：${read.join("、")}（每 100 ${parse.base_unit}）；讀不到：${missing.join("、")}`;
		}
		default:
			return "讀不出營養標示的數字";
	}
}
