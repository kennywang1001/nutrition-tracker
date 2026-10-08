import { formatMacro, type Numeric, ratioOf } from "../lib/decimal";
import styles from "./MacroBar.module.css";
import { RatioProgress } from "./RatioProgress";

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

	// 上一行：名稱在左、數字在右；下面一條進度條（同總覽「今天熱量」卡片）。
	// 數字與百分比各自留在自己的 <span>：測試用 getByText(/1800/) 找數字，
	// 一個 span 只裝一種東西，比對才不會黏到旁邊的字。
	return (
		<div data-testid={`macro-${field}`} className={styles.row}>
			<div className={styles.line}>
				<span className={styles.label}>{label}</span>
				<span className={styles.figures}>
					<span>
						{formatMacro(actual)}
						{target !== null && ` / ${formatMacro(target)}`}
					</span>
					{target === null ? (
						<span className={styles.muted}>未設定</span>
					) : (
						ratio !== null && (
							<span className={styles.muted}>
								{ratio.toLocaleString(undefined, {
									style: "percent",
									maximumFractionDigits: 0,
								})}
							</span>
						)
					)}
				</span>
			</div>
			{/* 沒有比例（這一項沒設目標，或目標是 0）就不畫條、超過目標畫滿：
			    都在 RatioProgress 裡，跟總覽的 TodayKcalCard 同一個元件。 */}
			<RatioProgress
				ratio={ratio}
				label={`${label}進度`}
				className={styles.progress}
			/>
		</div>
	);
}
