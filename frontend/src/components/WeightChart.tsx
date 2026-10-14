import { daysBetween, formatCivilDate } from "../lib/civil-date";
import {
	formatMacro,
	type Numeric,
	paddedExtent,
	positionIn,
} from "../lib/decimal";
import { dateLabel, type WeightPoint } from "../lib/weights";

/** SVG 的座標系。**固定值，不量容器**（同 `TrendChart`）：jsdom 不做版面計算，依賴實際寬度的
 *  東西在測試裡都會讀到 0。viewBox 讓瀏覽器自己縮放。 */
export const VIEW_WIDTH = 280;
export const VIEW_HEIGHT = 160;
/** 右邊留一點，最後一點的圓不會被 viewBox 切掉一半。 */
export const PAD_X = 6;
/** 左邊留給 y 軸的刻度（「81」），第一點不會壓在刻度上。 */
export const PLOT_LEFT = 22;
/** 圖下面給起訖日期的一條。點的計算範圍仍然是 VIEW_HEIGHT。 */
const DATE_BAND = 16;
const AXIS_PAD_KG = "1";
const POINT_RADIUS = 3;

type Props = {
	/** 這段期間要畫的紀錄（由舊到新）。 */
	entries: readonly WeightPoint[];
	/** 移動平均——**用全部的紀錄算**，這裡只畫 `entries` 那幾天的（範圍開頭的平均要用到範圍外的紀錄）。 */
	average: readonly WeightPoint[];
	/** x 軸的起點與終點（終點是後端給的今天；圖表不自己算今天）。 */
	start: string;
	end: string;
	/** 後端給的今天：終點是今天時日期寫「今天」。 */
	today: string;
	targetKg: Numeric | null;
};

/** 體重圖（身體資料規格 §6.4）。**純渲染，不取資料**。
 *
 *  三條跟 `TrendChart` 一樣的規矩：
 *  - **幾何一律算成屬性**（`cx`、`cy`、`points`），不交給 CSS——測試量得到的才是真的。
 *  - **每個點是 `role="img"`＋`aria-label`**：拿掉 role 的話，`<circle>` 的 aria-label 多半被輔助技術
 *    忽略，點對螢幕閱讀器整個消失。Biome 的兩條規則在這裡是誤判。
 *  - **數字比大小、算比例全部經過 `lib/decimal.ts`**（`paddedExtent`、`positionIn`）；這裡只把
 *    0–1 的比例換成座標。
 *
 *  x 照**日期**（`daysBetween`），不是照第幾筆：記錄的日子不連續，照索引平均分配會把一週的
 *  空白畫成跟一天一樣寬。y 軸範圍包含點、畫出來的平均、目標體重，各往外留 1 公斤。 */
export function WeightChart({
	entries,
	average,
	start,
	end,
	today,
	targetKg,
}: Props) {
	const shownDates = new Set(entries.map((entry) => entry.date));
	const shownAverage = average.filter((point) => shownDates.has(point.date));
	const values = [
		...entries.map((entry) => entry.weight_kg),
		// 平均可能用到範圍外更重或更輕的紀錄，不包進來的話線會畫出圖外。
		...shownAverage.map((point) => point.weight_kg),
		...(targetKg === null ? [] : [targetKg]),
	];
	const extent = paddedExtent(values, AXIS_PAD_KG);
	if (extent === null) return null;
	// 起點就是終點（只有今天一筆）時除數是 1：點畫在左邊界，不除以零。
	const days = Math.max(daysBetween(start, end), 1);
	const plotWidth = VIEW_WIDTH - PAD_X - PLOT_LEFT;
	const x = (date: string) =>
		PLOT_LEFT + (daysBetween(start, date) / days) * plotWidth;
	const y = (value: Numeric) =>
		VIEW_HEIGHT * (1 - positionIn(value, extent.lo, extent.hi));
	const line = shownAverage
		.map((point) => `${x(point.date)},${y(point.weight_kg)}`)
		.join(" ");

	return (
		// biome-ignore lint/a11y/useSemanticElements: 同 TrendChart：它建議的 <fieldset> 對一張 SVG 圖沒有意義
		<svg
			viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT + DATE_BAND}`}
			className="trend-chart"
			role="group"
			aria-label="體重"
			data-testid="weight-chart"
		>
			{/* biome-ignore lint/a11y/noAriaHiddenOnFocusable: SVG <text> 不能聚焦（同 TrendChart）；刻度是裝飾，每個點的名稱已經有體重 */}
			<text
				data-testid="weight-axis-hi"
				x={0}
				y={10}
				className="weight-axis"
				aria-hidden="true"
			>
				{extent.hi}
			</text>
			{/* biome-ignore lint/a11y/noAriaHiddenOnFocusable: 同上 */}
			<text
				data-testid="weight-axis-lo"
				x={0}
				y={VIEW_HEIGHT - 2}
				className="weight-axis"
				aria-hidden="true"
			>
				{extent.lo}
			</text>
			<line
				className="weight-baseline"
				x1={PLOT_LEFT}
				x2={VIEW_WIDTH}
				y1={VIEW_HEIGHT}
				y2={VIEW_HEIGHT}
			/>
			{targetKg !== null && (
				<line
					data-testid="weight-target"
					className="trend-target"
					x1={PLOT_LEFT}
					x2={VIEW_WIDTH}
					y1={y(targetKg)}
					y2={y(targetKg)}
				/>
			)}
			{line !== "" && (
				// biome-ignore lint/a11y/noAriaHiddenOnFocusable: SVG <polyline> 不能聚焦（同 <text> 的誤判）；平均線是裝飾，圖下面有「最近 7 天平均」的文字
				<polyline
					data-testid="weight-average"
					className="weight-average"
					points={line}
					aria-hidden="true"
				/>
			)}
			{entries.map((entry) => (
				// biome-ignore lint/a11y/noInteractiveElementToNoninteractiveRole: circle 不是互動元素（同 TrendChart 的 rect）；拿掉 role 點會對螢幕閱讀器消失
				<circle
					key={entry.date}
					data-testid={`weight-point-${entry.date}`}
					role="img"
					aria-label={`${dateLabel(entry.date, today)}，${formatMacro(entry.weight_kg)} 公斤`}
					cx={x(entry.date)}
					cy={y(entry.weight_kg)}
					r={POINT_RADIUS}
					className="weight-point"
				/>
			))}
			{/* biome-ignore lint/a11y/noAriaHiddenOnFocusable: 同上；起訖日期是裝飾 */}
			<text
				data-testid="weight-date-start"
				x={PLOT_LEFT}
				y={VIEW_HEIGHT + DATE_BAND - 4}
				className="trend-date"
				aria-hidden="true"
			>
				{formatCivilDate(start)}
			</text>
			{/* biome-ignore lint/a11y/noAriaHiddenOnFocusable: 同上 */}
			<text
				data-testid="weight-date-end"
				x={VIEW_WIDTH}
				y={VIEW_HEIGHT + DATE_BAND - 4}
				textAnchor="end"
				className="trend-date"
				aria-hidden="true"
			>
				{end === today ? "今天" : formatCivilDate(end)}
			</text>
		</svg>
	);
}
