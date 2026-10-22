import { polylinePoints, weightScale } from "../lib/weight-plot";
import { entriesInSpan, type WeightPoint } from "../lib/weights";
import styles from "./WeightSparkline.module.css";

/** viewBox：寬 100、高 32，上下左右各留 2（線的圓頭不被切掉）。畫出來的寬度跟著卡片、高度固定 32px。 */
const VIEW_WIDTH = 100;
const VIEW_HEIGHT = 32;
const INSET = 2;
/** y 範圍各往外 0.5 公斤：比 `/weight` 的 1 公斤緊，32px 高的線才看得出起伏。 */
const PAD_KG = "0.5";
export const SPARKLINE_DAYS = 30;

type Props = {
	/** `GET /api/weights` 的紀錄（由舊到新）。 */
	entries: readonly WeightPoint[];
	/** 後端給的今天：「最近 30 天」從它往回算（前端不算今天）。 */
	today: string;
};

/** 總覽體重小卡片的迷你折線（首頁改版規格 D22）。**整張是裝飾**（`aria-hidden`）：最新一筆與比 7 天前是旁邊的字。
 *
 *  - 最近 30 天（`entriesInSpan`）少於 2 筆不畫——一筆畫不成線。
 *  - x 從這 30 天裡的**第一筆到最後一筆**（不是從 30 天前）：只記了最近幾天時線不會擠在右邊；它沒有軸、沒有刻度。
 *  - 座標換算跟 `/weight` 的圖同一份（`lib/weight-plot.ts`，D21）。
 *  - `preserveAspectRatio="none"`：寬度跟著卡片拉伸；線寬用 `vector-effect: non-scaling-stroke`，拉伸不會變粗。 */
export function WeightSparkline({ entries, today }: Props) {
	const recent = entriesInSpan(entries, today, SPARKLINE_DAYS).entries;
	const first = recent[0];
	const last = recent.at(-1);
	if (recent.length < 2 || first === undefined || last === undefined) {
		return null;
	}
	const scale = weightScale(
		recent.map((entry) => entry.weight_kg),
		PAD_KG,
		first.date,
		last.date,
		{
			left: INSET,
			right: VIEW_WIDTH - INSET,
			top: INSET,
			bottom: VIEW_HEIGHT - INSET,
		},
	);
	if (scale === null) return null;

	return (
		<svg
			className={styles.sparkline}
			viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
			preserveAspectRatio="none"
			aria-hidden="true"
			focusable="false"
			data-testid="weight-sparkline"
		>
			<polyline
				data-testid="weight-sparkline-line"
				className={styles.line}
				points={polylinePoints(recent, scale)}
			/>
		</svg>
	);
}
