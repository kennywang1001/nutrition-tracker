import type { ActivityCode, EstimateParams } from "../api/exercises";
import { fromLocalDateTime } from "./dates";
import { checkRangeInput } from "./decimal";

/** 記運動與編輯運動的表單（運動規格 §7.2）：純函式的檢查，畫面在 `components/ExerciseForm.tsx`。 */

export type ExerciseFormValues = {
	activity: ActivityCode | "";
	name: string;
	minutes: string;
	/** 使用者勾了「手動輸入熱量」。「其他」與沒有體重時畫面會強制打開（不改這個值）。 */
	manual: boolean;
	kcal: string;
	date: string;
	time: string;
	note: string;
};

/** 跟後端同一組範圍（D5）：分鐘 1–600 的整數、熱量 1–5000 兩位小數。 */
export const MINUTES_RULE = { min: "1", max: "600", places: 0 } as const;
export const KCAL_RULE = { min: "1", max: "5000", places: 2 } as const;
export const NAME_MAX = 50;
export const NOTE_MAX = 200;

/** 「字」用 code point 算（後端的 `char_length` 也是）；`"😀".length` 是 2。 */
export function charCount(value: string): number {
	return [...value].length;
}

/** 送出前的檢查。`manual` 是畫面上**實際**的狀態（含強制打開）；`now` 是 `Date.now()`。
 *  回一串給人看的句子，空的＝可以送。先在前端擋，是為了用人話說是哪一格（後端的 422
 *  只有欄位路徑與英文訊息）。 */
export function exerciseProblems(
	values: ExerciseFormValues,
	manual: boolean,
	now: number,
): string[] {
	const problems: string[] = [];
	if (values.activity === "") problems.push("請選活動");
	if (values.activity === "other") {
		const name = values.name.trim();
		if (name === "") problems.push("請填名稱");
		else if (charCount(name) > NAME_MAX) problems.push("名稱最多 50 字");
	}
	if (checkRangeInput(values.minutes, MINUTES_RULE) !== null)
		problems.push("分鐘要是 1 到 600 的整數");
	if (manual && checkRangeInput(values.kcal, KCAL_RULE) !== null)
		problems.push("熱量要在 1 到 5000 之間，最多兩位小數");
	const moment = fromLocalDateTime(values.date, values.time);
	if (moment === null) problems.push("請選日期與時間");
	// 同 `EditMeal`：前端只擋「比現在晚」；後端另外留 5 分鐘給時鐘誤差（D18）。
	else if (moment.getTime() > now) problems.push("不能選未來的時間");
	if (charCount(values.note.trim()) > NOTE_MAX)
		problems.push("備註最多 200 字");
	return problems;
}

/** 可以預覽估算的時候回參數，不行回 `null`（活動沒選、是「其他」、手動、分鐘或時間不對）。
 *  不對的值不送：後端會回 422，畫面上卻只是「還在打」。 */
export function estimateParams(
	values: ExerciseFormValues,
	manual: boolean,
	now: number,
): EstimateParams | null {
	if (values.activity === "" || values.activity === "other" || manual)
		return null;
	if (checkRangeInput(values.minutes, MINUTES_RULE) !== null) return null;
	const moment = fromLocalDateTime(values.date, values.time);
	if (moment === null || moment.getTime() > now) return null;
	return {
		activity: values.activity,
		minutes: values.minutes.trim(),
		performedAt: moment.toISOString(),
	};
}
