/** **月份字串（`YYYY-MM`）的加減與顯示。這個模組不問「現在是哪個月」。**
 *
 *  跟 `lib/civil-date.ts` 同一條規矩：輸入是一個**已經決定好的**月份——後端報表
 *  回應裡的 `month`（`this_month_in_timezone(user.timezone)` 算的），或網址上的
 *  `?month=`——輸出是另一個月份字串。「這個月是哪個月」只有後端知道
 *  （`lib/dates.ts` 檔頭）；這裡純粹做字串與整數運算，完全不碰裝置的時鐘
 *  （`tests/months.test.ts` 有一條原始碼掃描守著）。
 */

/** 後端 `YEAR_MONTH_PATTERN`（`app/schemas/expense.py`）的同一條規則：19xx／20xx 年、
 *  01–12 月。範圍外的值送出去會是 422，所以在這裡就當成「不是月份」。 */
const YEAR_MONTH = /^(19|20)\d{2}-(0[1-9]|1[0-2])$/;

export function isYearMonth(value: string): boolean {
	return YEAR_MONTH.test(value);
}

/** 往前或往後推 `delta` 個月。推出後端收的範圍（1900-01 到 2099-12）回 `null`——
 *  呼叫端據此停用按鈕，而不是送一個會被 422 的月份。 */
export function shiftMonth(month: string, delta: number): string | null {
	if (!isYearMonth(month)) {
		throw new Error(
			`shiftMonth 只接受 YYYY-MM，收到：${JSON.stringify(month)}`,
		);
	}
	// 從西元 0 年 1 月起算的月數：加減之後再拆回年與月，跨年不用特別處理。
	const index =
		Number(month.slice(0, 4)) * 12 + (Number(month.slice(5, 7)) - 1) + delta;
	const year = Math.floor(index / 12);
	const shifted = `${String(year).padStart(4, "0")}-${String((index % 12) + 1).padStart(2, "0")}`;
	return isYearMonth(shifted) ? shifted : null;
}

/** `"2026-09"` → `"2026年9月"`。純字串切割，`Number()` 去掉前導零。 */
export function formatYearMonth(month: string): string {
	if (!isYearMonth(month)) {
		throw new Error(
			`formatYearMonth 只接受 YYYY-MM，收到：${JSON.stringify(month)}`,
		);
	}
	return `${Number(month.slice(0, 4))}年${Number(month.slice(5, 7))}月`;
}
