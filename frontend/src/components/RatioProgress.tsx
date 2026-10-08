import styles from "./RatioProgress.module.css";

type Props = {
	/** `ratioOf()` 的結果（`lib/decimal.ts`）。這裡不自己算比例。 */
	ratio: number | null;
	/** 進度條的可及名稱（例如「熱量進度」）。 */
	label: string;
	/** 呼叫端的間距（margin、display）：兩個畫面的條跟上面那行字的距離不一樣。 */
	className?: string;
};

/** 攝取／目標的細進度條：總覽「今天熱量」卡片與飲食頁的 MacroBar 共用。
 *
 *  - **比例是 null 就不畫**（沒設目標，或目標是 0）：空條會被讀成「0%」，
 *    把「沒有標準」講成「完全沒吃」（規格 §5.7）。
 *  - **超過目標時夾在滿格**（`Math.min(ratio, 1)`）：超過多少看旁邊的數字，
 *    條本身只表達「到了沒」。比例本身仍然來自 `ratioOf()`。 */
export function RatioProgress({ ratio, label, className }: Props) {
	if (ratio === null) return null;

	return (
		<progress
			className={
				className === undefined
					? styles.progress
					: `${styles.progress} ${className}`
			}
			max={1}
			value={Math.min(ratio, 1)}
			aria-label={label}
		/>
	);
}
