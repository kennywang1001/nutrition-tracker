import type { components } from "../api/schema";

/** 身體資料的中文標籤（身體資料規格 §6.1）。**標籤只有這一份**：表單、卡片、建議區塊都從這裡拿。
 *  係數與公式在後端（`app/body_targets.py`），這裡只有字。 */

type Sex = components["schemas"]["Sex"];
type ActivityLevel = components["schemas"]["ActivityLevel"];
type Goal = components["schemas"]["Goal"];
export type MissingField =
	components["schemas"]["SuggestionMissing"]["missing"][number];

export const SEX_OPTIONS: readonly { value: Sex; label: string }[] = [
	{ value: "male", label: "男" },
	{ value: "female", label: "女" },
];

/** 五級活動量：說明讓人能對照自己（「中度」本身沒有意思）。 */
export const ACTIVITY_OPTIONS: readonly {
	value: ActivityLevel;
	label: string;
	hint: string;
}[] = [
	{ value: "sedentary", label: "久坐", hint: "幾乎不運動" },
	{ value: "light", label: "輕度", hint: "每週運動 1–3 天" },
	{ value: "moderate", label: "中度", hint: "每週運動 3–5 天" },
	{ value: "active", label: "高度", hint: "每週運動 6–7 天" },
	{ value: "very_active", label: "非常高", hint: "體力工作或一天兩練" },
];

export const GOAL_OPTIONS: readonly { value: Goal; label: string }[] = [
	{ value: "lose", label: "減重" },
	{ value: "maintain", label: "維持" },
	{ value: "gain", label: "增重" },
];

/** 速度的值是 `formatMacro` 正規化之後的寫法：後端回 "0.50"，比對前先變成 "0.5"。 */
export const RATE_OPTIONS = [
	{ value: "0.25", label: "每週 0.25 公斤" },
	{ value: "0.5", label: "每週 0.5 公斤" },
] as const;

export type Rate = (typeof RATE_OPTIONS)[number]["value"];

export const MISSING_LABELS: Record<MissingField, string> = {
	sex: "性別",
	birth_year: "出生年",
	height_cm: "身高",
	activity_level: "活動量",
	goal: "目標",
	rate_kg_per_week: "速度",
	weight: "體重",
};

/** 規格 D26 的原文。 */
export const SUGGESTION_DISCLAIMER =
	"依公式估算，僅供參考，不是醫療建議；懷孕、哺乳、慢性病或未滿 18 歲請諮詢專業人員。";
