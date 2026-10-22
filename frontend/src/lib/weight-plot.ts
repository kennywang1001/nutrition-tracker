import { daysBetween } from "./civil-date";
import { type Numeric, paddedExtent, positionIn } from "./decimal";
import type { WeightPoint } from "./weights";

/** 畫圖的那一塊（viewBox 座標）：`left`／`right` 是 x 的起訖，`top`／`bottom` 是 y 的上下。 */
export type PlotArea = {
	left: number;
	right: number;
	top: number;
	bottom: number;
};

export type WeightScale = {
	lo: Numeric;
	hi: Numeric;
	x: (date: string) => number;
	y: (value: Numeric) => number;
};

/** 體重圖的座標換算（首頁改版規格 D21）：`/weight` 的 `WeightChart` 與總覽的迷你折線共用——
 *  兩張圖各寫一份的話，「照日期排」與「y 經過 Decimal」就有兩套寫法，哪天其中一份改了另一份不會跟著。
 *
 *  - **x 照日期**（`daysBetween`），不是照第幾筆：記錄的日子不連續，照索引平均分配會把一週的空白畫成跟一天一樣寬。
 *    起點就是終點時除數是 1——點畫在左邊界，不除以零。
 *  - **y 經過 `lib/decimal.ts`**：範圍是 `paddedExtent(values, pad)`（各往外 `pad`、取整），比例是 `positionIn`；這裡只把 0–1 的比例
 *    換成座標（`number` 只用在座標，同 `TrendChart`）。重的在上面。
 *  - `values` 是空的回 `null`（沒有東西可畫）。
 *
 *  算式的順序跟 `WeightChart` 原本的兩個閉包一樣（`left + (d / days) * width`、`top + height * (1 - p)`）：
 *  抽出來之後浮點數逐位元相同，既有的座標斷言不受影響。 */
export function weightScale(
	values: readonly Numeric[],
	pad: Numeric,
	start: string,
	end: string,
	area: PlotArea,
): WeightScale | null {
	const extent = paddedExtent(values, pad);
	if (extent === null) return null;
	const days = Math.max(daysBetween(start, end), 1);
	const width = area.right - area.left;
	const height = area.bottom - area.top;
	return {
		lo: extent.lo,
		hi: extent.hi,
		x: (date) => area.left + (daysBetween(start, date) / days) * width,
		y: (value) =>
			area.top + height * (1 - positionIn(value, extent.lo, extent.hi)),
	};
}

/** `<polyline points>`：照傳進來的順序（由舊到新），每一點「x,y」。 */
export function polylinePoints(
	points: readonly WeightPoint[],
	scale: Pick<WeightScale, "x" | "y">,
): string {
	return points
		.map((point) => `${scale.x(point.date)},${scale.y(point.weight_kg)}`)
		.join(" ");
}
