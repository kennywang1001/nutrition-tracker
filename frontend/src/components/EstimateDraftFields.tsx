import type { Ref } from "react";
import type { EstimateDraft } from "../lib/ai-food";

type Props = {
	/** 六個欄位的 id 前綴（呼叫端的 `useId()`）——同一頁只會開一組。 */
	idPrefix: string;
	/** 一份重量的單位（g 或 ml）。 */
	unit: string;
	draft: EstimateDraft;
	onChange: (patch: Partial<EstimateDraft>) => void;
	/** 表單打開時焦點要到「食物名稱」：呼叫端自己決定什麼時候 focus。 */
	nameInputRef?: Ref<HTMLInputElement>;
};

/** 修改 AI 估算的六個欄位：名稱、一份的重量、一份的四個營養素。
 *
 *  單樣面板（`AiEstimatePanel`）與多樣面板（`AiMealPanel`）共用——欄位、標籤、
 *  `maxLength` 只有這一份。驗證與換算在 `lib/ai-food.ts` 的 `editedFoodRequest`，
 *  兩邊也是同一個。回 fragment：欄位直接落在呼叫端的 `<form>` 版面裡。 */
export function EstimateDraftFields({
	idPrefix,
	unit,
	draft,
	onChange,
	nameInputRef,
}: Props) {
	return (
		<>
			<label htmlFor={`${idPrefix}-name`}>食物名稱</label>
			<input
				ref={nameInputRef}
				id={`${idPrefix}-name`}
				type="text"
				maxLength={100}
				value={draft.name}
				onChange={(event) => onChange({ name: event.target.value })}
			/>
			<label
				htmlFor={`${idPrefix}-serving-grams`}
			>{`一份的重量（${unit}）`}</label>
			<input
				id={`${idPrefix}-serving-grams`}
				type="text"
				inputMode="decimal"
				value={draft.servingGrams}
				onChange={(event) => onChange({ servingGrams: event.target.value })}
			/>
			<label htmlFor={`${idPrefix}-kcal`}>一份的熱量（kcal）</label>
			<input
				id={`${idPrefix}-kcal`}
				type="text"
				inputMode="decimal"
				value={draft.kcal}
				onChange={(event) => onChange({ kcal: event.target.value })}
			/>
			<label htmlFor={`${idPrefix}-protein`}>一份的蛋白質（g）</label>
			<input
				id={`${idPrefix}-protein`}
				type="text"
				inputMode="decimal"
				value={draft.protein_g}
				onChange={(event) => onChange({ protein_g: event.target.value })}
			/>
			<label htmlFor={`${idPrefix}-fat`}>一份的脂肪（g）</label>
			<input
				id={`${idPrefix}-fat`}
				type="text"
				inputMode="decimal"
				value={draft.fat_g}
				onChange={(event) => onChange({ fat_g: event.target.value })}
			/>
			<label htmlFor={`${idPrefix}-carb`}>一份的碳水化合物（g）</label>
			<input
				id={`${idPrefix}-carb`}
				type="text"
				inputMode="decimal"
				value={draft.carb_g}
				onChange={(event) => onChange({ carb_g: event.target.value })}
			/>
		</>
	);
}
