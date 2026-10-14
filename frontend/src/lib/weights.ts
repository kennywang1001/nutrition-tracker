import { shiftDays } from "./civil-date";
import { averageOf, differenceOf, type Numeric } from "./decimal";

/** 體重的純函式（身體資料規格 §6.2、§6.4）。數字運算全部經過 `lib/decimal.ts`，
 *  日期加減全部經過 `lib/civil-date.ts`——這個檔案只決定「哪幾筆」。 */

/** 一筆體重（`WeightEntryResponse` 的形狀；這裡不 import schema，讓純函式好測）。 */
export type WeightPoint = { date: string; weight_kg: Numeric };

export const MOVING_AVERAGE_DAYS = 7;

/** 日期字串（YYYY-MM-DD）可以直接比大小：字典序就是時間序。 */
function within(entry: WeightPoint, start: string, end: string): boolean {
	return entry.date >= start && entry.date <= end;
}

/** 7 天移動平均（身體資料規格 §6.4）：**7 個日曆天，不是 7 筆**——每一筆的值是日期在
 *  [這天 − 6, 這天] 之間所有紀錄的平均。沒記的日子不補、不當 0；只有自己一筆就是自己。
 *  `entries` 由舊到新（後端的順序）。最多 800 筆，O(n²) 也只是幾十萬次比較。 */
export function movingAverage(entries: readonly WeightPoint[]): WeightPoint[] {
	return entries.map((entry) => {
		const start = shiftDays(entry.date, -(MOVING_AVERAGE_DAYS - 1));
		const window = entries.filter((other) => within(other, start, entry.date));
		// 至少有自己，averageOf 不會是 null；`??` 只是讓型別收窄。
		return {
			date: entry.date,
			weight_kg: averageOf(window.map((w) => w.weight_kg)) ?? entry.weight_kg,
		};
	});
}

/** 「跟 7 天前比」：最新一筆，跟日期 ≤ 最新 − 7 天的最新一筆比。沒有那一筆就是 null
 *  （不拿 6 天前的湊——「比 7 天前」就要真的是 7 天以前）。 */
export function weekChange(
	entries: readonly WeightPoint[],
): { latest: WeightPoint; since: WeightPoint; change: Numeric } | null {
	const latest = entries.at(-1);
	if (latest === undefined) return null;
	const cutoff = shiftDays(latest.date, -7);
	const since = entries.filter((entry) => entry.date <= cutoff).at(-1);
	if (since === undefined) return null;
	return {
		latest,
		since,
		change: differenceOf(latest.weight_kg, since.weight_kg),
	};
}

export type WeightSpan = 30 | 90 | "all";

/** 圖表要畫的那一段與它的起點。30／90 天是 [今天 − (天數 − 1), 今天]；「全部」從第一筆開始
 *  （沒有紀錄就從今天）。`today` 是後端給的（`GET /api/weights` 的 `today`），前端不算今天。 */
export function entriesInSpan(
	entries: readonly WeightPoint[],
	today: string,
	span: WeightSpan,
): { start: string; entries: WeightPoint[] } {
	if (span === "all")
		return { start: entries[0]?.date ?? today, entries: [...entries] };
	const start = shiftDays(today, -(span - 1));
	return {
		start,
		entries: entries.filter((entry) => within(entry, start, today)),
	};
}

/** 「最近 7 天平均」：[今天 − 6, 今天] 的紀錄的平均；沒有就是 null。 */
export function recentAverage(
	entries: readonly WeightPoint[],
	today: string,
): Numeric | null {
	const start = shiftDays(today, -(MOVING_AVERAGE_DAYS - 1));
	return averageOf(
		entries
			.filter((entry) => within(entry, start, today))
			.map((w) => w.weight_kg),
	);
}
