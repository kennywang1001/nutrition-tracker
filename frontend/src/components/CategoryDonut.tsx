import { CATEGORY_COLORS, type CategoryTotal } from "../api/expenses";
import { ratioOf } from "../lib/decimal";
import styles from "./CategoryDonut.module.css";

const SIZE = 120;
const CENTER = SIZE / 2;
const RADIUS = 45;
const STROKE_WIDTH = 20;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

type Props = {
	rows: readonly CategoryTotal[];
	/** 這個月的總額。呼叫端保證它 > 0（沒有支出時不畫這張圖）。 */
	total: string;
};

/** 報表的分類甜甜圈（介面改版第二階段 §4.1）。
 *
 *  **每一段的長度與起點算成 SVG 屬性**（`stroke-dasharray`／
 *  `stroke-dashoffset`），不交給 CSS——jsdom 不做版面計算，交給 CSS 的話
 *  「弧長比例等於金額比例」就測不到（同 `TrendChart` 的作法）。
 *
 *  佔比用 `ratioOf()`（`lib/decimal.ts`），不做浮點除法。弧從 12 點鐘方向
 *  順時針排（`rotate(-90)`），順序跟清單一樣。
 *
 *  **整張圖是裝飾**（`aria-hidden`）：下面的清單已經有每個分類的金額與
 *  百分比，螢幕閱讀器不需要再唸一次。 */
export function CategoryDonut({ rows, total }: Props) {
	const lengths = rows.map(
		(row) => (ratioOf(row.total, total) ?? 0) * CIRCUMFERENCE,
	);
	const starts = lengths.map((_, index) =>
		lengths.slice(0, index).reduce((sum, length) => sum + length, 0),
	);

	return (
		<svg
			viewBox={`0 0 ${SIZE} ${SIZE}`}
			className={styles.donut}
			aria-hidden="true"
			data-testid="category-donut"
		>
			<circle
				className={styles.track}
				cx={CENTER}
				cy={CENTER}
				r={RADIUS}
				strokeWidth={STROKE_WIDTH}
			/>
			{rows.map((row, index) => (
				<circle
					key={row.category}
					data-testid={`donut-${row.category}`}
					cx={CENTER}
					cy={CENTER}
					r={RADIUS}
					fill="none"
					stroke={CATEGORY_COLORS[row.category]}
					strokeWidth={STROKE_WIDTH}
					strokeDasharray={`${lengths[index]} ${CIRCUMFERENCE}`}
					strokeDashoffset={-(starts[index] ?? 0)}
					transform={`rotate(-90 ${CENTER} ${CENTER})`}
				/>
			))}
		</svg>
	);
}
