import { formatMacro, type Numeric, ratioOf } from "../lib/decimal";

type MacroField = "kcal" | "protein_g" | "fat_g" | "carb_g";

type Props = {
	field: MacroField;
	label: string;
	actual: Numeric;
	/** 這個營養素的目標值。`null` 代表「有目標，但這一項沒設」
	 *  （規格 §5.7 的第二層 null）—— 跟「整天沒有目標」是不同的畫面狀態，
	 *  由呼叫端（`Today.tsx`）決定要不要整個顯示成「尚未設定目標」。 */
	target: Numeric | null;
};

/** 一列營養素：實際攝取 vs 目標、加上比例。
 *
 *  **比例一律走 `ratioOf()`**（`lib/decimal.ts`）——這裡不做任何
 *  `Number(actual) / Number(target)` 之類的算術。百分比顯示用
 *  `Number.prototype.toLocaleString` 的 `style: "percent"`，不是自己
 *  `* 100`：轉換邏輯留給內建的 Intl，不是手寫的算術。 */
export function MacroBar({ field, label, actual, target }: Props) {
	const ratio = ratioOf(actual, target);

	return (
		<div data-testid={`macro-${field}`}>
			<span>{label}</span>
			<span>
				{formatMacro(actual)}
				{target !== null && ` / ${formatMacro(target)}`}
			</span>
			{target === null ? (
				<span>未設定</span>
			) : (
				ratio !== null && (
					<span>
						{ratio.toLocaleString(undefined, {
							style: "percent",
							maximumFractionDigits: 0,
						})}
					</span>
				)
			)}
		</div>
	);
}
