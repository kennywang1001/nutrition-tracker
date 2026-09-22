import type { components } from "../api/schema";
import { formatCivilDate } from "../lib/civil-date";
import { formatMacro, maxOf, ratioOf } from "../lib/decimal";

export type TrendDay = components["schemas"]["DayTrendResponse"];

/** SVG 的座標系。**固定值，不量容器** —— jsdom 不做版面計算，
 *  任何依賴實際寬度的東西在測試裡都會讀到 0。用 viewBox + preserveAspectRatio
 *  讓瀏覽器自己縮放，程式碼裡的座標永遠是這組數字。 */
const VIEW_WIDTH = 280;
const VIEW_HEIGHT = 160;
const BAR_WIDTH_RATIO = 0.6;

/** 最近幾天的熱量長條圖（規格 §4.4–§4.6）。
 *
 *  **純渲染，不取資料。** 呼叫端負責查詢、載入中、錯誤。
 *
 *  ## 幾何一律算成屬性，不交給 CSS
 *
 *  `height`、`y` 都是在這裡算好寫進 SVG 屬性的。**不可以改成用 CSS 控制
 *  柱子高度** —— jsdom 不做版面計算，`getBoundingClientRect()` 回 0，
 *  規格 §4.6 那條「高度比例等於數值比例」的斷言就會退化成在比兩個空值。
 *
 *  ## 兩層 null
 *
 *  `target` 整個是 `null`（那天沒有生效目標）與 `target.kcal` 是 `null`
 *  （有目標但這一項沒設）是**兩個不同的事實**，雖然畫面結果都是不畫目標線。
 *  **不要寫成 `day.target?.kcal ?? 0`** —— 那會把兩層壓成一層，然後畫出
 *  一條貼地的線，讀起來是「今天的目標是 0 大卡」。
 *
 *  ## 沒有 `role="group"` / `role="img"`
 *
 *  計畫草稿原本在 `<svg>` 上寫 `role="group"`、在每根 `<rect>` 上寫
 *  `role="img"`。Biome 的 `lint/a11y/useSemanticElements` 與
 *  `lint/a11y/noInteractiveElementToNoninteractiveRole` 兩條規則會擋下這個
 *  寫法。既有測試只斷言 `aria-label`／`data-testid`／幾何屬性，不斷言
 *  `role`，所以拿掉這兩個屬性、只留 `aria-label`。
 */
export function TrendChart({ days }: { days: readonly TrendDay[] }) {
	// y 軸上限：期間內實際值與目標值的最大值。目標可能整組是 null，
	// 也可能 kcal 那一項是 null——兩種都不參與比較。
	const targetValues = days
		.map((day) => day.target?.kcal ?? null)
		.filter((value): value is string => value !== null);
	const ceiling = maxOf([
		...days.map((day) => day.actual.kcal),
		...targetValues,
	]);

	const slot = VIEW_WIDTH / Math.max(days.length, 1);
	const barWidth = slot * BAR_WIDTH_RATIO;
	const inset = (slot - barWidth) / 2;

	/** 把一個數值換算成 SVG 的 y 座標。
	 *
	 *  `ratioOf` 在 ceiling 是 "0" 時回 `null`（除以 0 沒有意義），
	 *  這裡把它當成「高度 0」—— 規格 §4.5（三）：全都是 0 又沒目標的期間，
	 *  所有柱子貼地，不是炸掉。 */
	const heightOf = (value: string): number => {
		const ratio = ratioOf(value, ceiling);
		return ratio === null ? 0 : ratio * VIEW_HEIGHT;
	};

	return (
		<svg
			viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
			className="trend-chart"
			data-testid="trend-chart"
			aria-label="最近幾天的熱量"
		>
			{days.map((day, index) => {
				const height = heightOf(day.actual.kcal);
				const x = index * slot + inset;
				// 第一層 null（整天沒目標）與第二層 null（這一項沒設）在這裡
				// 一起被收斂成「沒有可畫的目標值」——但收斂發生在讀完兩層之後，
				// 不是用 ?? 0 把它們壓成同一個數字。
				const targetKcal = day.target === null ? null : day.target.kcal;
				const label =
					targetKcal === null
						? `${formatCivilDate(day.date)}，${formatMacro(day.actual.kcal)} 大卡，沒有目標`
						: `${formatCivilDate(day.date)}，${formatMacro(day.actual.kcal)} 大卡，目標 ${formatMacro(targetKcal)} 大卡`;

				return (
					<g key={day.date}>
						<rect
							data-testid={`trend-bar-${day.date}`}
							aria-label={label}
							x={x}
							y={VIEW_HEIGHT - height}
							width={barWidth}
							height={height}
							className="trend-bar"
						/>
						{targetKcal !== null && (
							<line
								data-testid={`trend-target-${day.date}`}
								x1={index * slot}
								x2={(index + 1) * slot}
								y1={VIEW_HEIGHT - heightOf(targetKcal)}
								y2={VIEW_HEIGHT - heightOf(targetKcal)}
								className="trend-target"
							/>
						)}
					</g>
				);
			})}
		</svg>
	);
}
