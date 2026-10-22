import styles from "./CalorieRing.module.css";

/** viewBox 的邊長與線寬：半徑＝(120 − 10) / 2 = 55。畫出來多大由 CSS 決定。 */
const SIZE = 120;
const STROKE = 10;
const RADIUS = (SIZE - STROKE) / 2;
const CENTER = SIZE / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/** `normal`：照比例畫弧；`over`：超過額度，整圈、危險色；`none`：沒有額度，只有底圈。 */
export type RingTone = "normal" | "over" | "none";

/** `ratioOf()` 的比例 → `stroke-dasharray`（「弧長 圓周」，兩位小數）。null 與負的畫 0、超過 1 夾在 1。
 *  `number` 只用在座標（同 `TrendChart` 的 `positionIn`）：Decimal 字串在 `ratioOf` 那一步就換好了。 */
export function ringDasharray(ratio: number | null): string {
	const fraction = ratio === null ? 0 : Math.min(Math.max(ratio, 0), 1);
	return `${(CIRCUMFERENCE * fraction).toFixed(2)} ${CIRCUMFERENCE.toFixed(2)}`;
}

type Props = {
	/** `ratioOf(實際, 額度)`；沒有額度是 null。`tone` 是 `over` 時不看它（畫滿）。 */
	ratio: number | null;
	tone: RingTone;
};

/** 熱量圓環（首頁改版規格 D4、D5）。**整張是裝飾**（`aria-hidden`）：數字是呼叫端放在中間的文字，
 *  圓環不是 progressbar——念出來的是「還能吃 843 kcal」，不是一個百分比。
 *  弧從 12 點鐘方向順時針畫（`rotate(-90)`）。 */
export function CalorieRing({ ratio, tone }: Props) {
	return (
		<svg
			className={styles.ring}
			viewBox={`0 0 ${SIZE} ${SIZE}`}
			aria-hidden="true"
			focusable="false"
		>
			<circle
				className={styles.track}
				cx={CENTER}
				cy={CENTER}
				r={RADIUS}
				strokeWidth={STROKE}
			/>
			{tone !== "none" && (
				<circle
					data-testid="calorie-ring-arc"
					data-tone={tone}
					className={
						tone === "over" ? `${styles.arc} ${styles.over}` : styles.arc
					}
					cx={CENTER}
					cy={CENTER}
					r={RADIUS}
					strokeWidth={STROKE}
					strokeDasharray={ringDasharray(tone === "over" ? 1 : ratio)}
					transform={`rotate(-90 ${CENTER} ${CENTER})`}
				/>
			)}
		</svg>
	);
}
