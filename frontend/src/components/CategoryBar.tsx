import {
	CATEGORY_COLORS,
	CATEGORY_LABELS,
	type CategoryTotal,
} from "../api/expenses";
import { formatMoney, ratioOf } from "../lib/decimal";
import styles from "./CategoryBar.module.css";

type Props = {
	row: CategoryTotal;
	/** 這個月的總額，用來算佔比。`"0.00"` 時 `ratioOf` 會回 `null`。 */
	monthTotal: string;
};

/** 一列分類佔比：分類名稱、金額、佔這個月的百分比。
 *
 *  **刻意不重用 `MacroBar`**（規格 §6.3）。`MacroBar` 的模型是
 *  「實際 vs 目標」，而且有「有目標但這一項沒設」這個第二層 null 的
 *  概念——花費沒有目標（預算不在範圍內，規格 §8），硬套會多出一個
 *  永遠是 null 的欄位，那是在說謊。
 *
 *  **佔比一律走 `ratioOf()`**（`lib/decimal.ts`），這裡不做任何
 *  `Number(a) / Number(b)`——那是把浮點誤差請回來，而
 *  `tests/decimal-containment.test.ts` 也會擋下直接 `new Decimal()`。
 *
 *  百分比用 `toLocaleString` 的 `style: "percent"`，不自己 `* 100`——
 *  跟 `MacroBar` 同一個理由：轉換留給 Intl，不是手寫算術。
 */
export function CategoryBar({ row, monthTotal }: Props) {
	const share = ratioOf(row.total, monthTotal);

	return (
		<div data-testid={`category-${row.category}`} className={styles.row}>
			<span
				className={styles.dot}
				style={{ background: CATEGORY_COLORS[row.category] }}
				aria-hidden="true"
			/>
			<span className={styles.label}>{CATEGORY_LABELS[row.category]}</span>
			{/* share 為 null 代表總額是 0（ratioOf 對 0 回 null，不是
			    Infinity 也不是 NaN）——那時候沒有佔比可言，不畫。 */}
			{share !== null && (
				<span className={styles.meta}>
					{share.toLocaleString(undefined, {
						style: "percent",
						maximumFractionDigits: 0,
					})}
				</span>
			)}
			<span className={styles.meta}>{row.count} 筆</span>
			<span className={styles.amount}>{formatMoney(row.total)}</span>
		</div>
	);
}
