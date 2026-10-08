import type { Numeric } from "./decimal";

/** 每日目標的四格（帳號設定規格 §5.1、§5.2）：「我的」的卡片與 `/me/targets` 共用，
 *  標籤、單位、上限只有這一份——兩處各寫一份，某天改了一邊，卡片跟表單就對不上。
 *  上限跟後端 `app/schemas/target.py` 的 `_MAX_KCAL`／`_MAX_GRAMS` 一致。 */
export const TARGET_FIELDS = [
	{ key: "kcal", label: "熱量", unit: "kcal", max: "20000" },
	{ key: "protein_g", label: "蛋白質", unit: "g", max: "2000" },
	{ key: "fat_g", label: "脂肪", unit: "g", max: "2000" },
	{ key: "carb_g", label: "碳水", unit: "g", max: "2000" },
] as const satisfies readonly {
	key: string;
	label: string;
	unit: string;
	max: Numeric;
}[];

export type TargetKey = (typeof TARGET_FIELDS)[number]["key"];
