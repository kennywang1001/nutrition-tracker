/** **日曆日的加減與顯示。這個模組不得使用任何本地時間的 `Date` accessor。**
 *
 *  `tests/civil-date.test.ts` 有一條原始碼掃描測試在守這條規則。
 *
 *  ## 為什麼這不違反「前端不算日界線」
 *
 *  `lib/dates.ts` 頂端那條規矩禁止的是**「問現在幾點，然後判斷那是哪一天」**
 *  —— 那件事需要知道使用者的時區，而唯一的事實來源是後端的
 *  `today_in_timezone(user.timezone)`（`app/days.py`）。
 *
 *  這個模組做的是別的事：輸入是一個**伺服器已經決定好的**日曆日字串
 *  （`GET /api/stats/daily` 回應裡的 `date`），輸出是另一個日曆日字串。
 *  **它從頭到尾不問裝置今天幾號。**
 *
 *  所以 `today()` / `startOfDay()` 依然不該存在（在這裡或任何地方）；
 *  `shiftDays` 可以存在。
 *
 *  ## 為什麼一定要 UTC
 *
 *  `new Date("2026-09-21")` 依規範解析成 **UTC 午夜**。接著若用本地
 *  accessor，在 UTC 以西會整個差一天：
 *
 *  ```ts
 *  const d = new Date("2026-09-21");
 *  d.setDate(d.getDate() - 6);          // ❌ 本地 accessor
 *  ```
 *
 *  在 `America/New_York`，那一刻是當地的 9/20 20:00，所以 `getDate()`
 *  回 **20**，不是 21 —— 整條計算差一天。正確的寫法是 `Date.UTC(...)`
 *  加 `toISOString()`，見下面的 `shiftDays`。
 *
 *  **而在 `Asia/Taipei`（UTC+8、無日光節約）與 CI（UTC）都看不到這個 bug** ——
 *  錯誤的寫法在這兩個環境都給出正確答案。行為測試因此擋不住它，
 *  只有 `tests/civil-date.test.ts` 那條原始碼掃描測試擋得住。
 *
 *  （這段文字裡出現的 `getDate` / `setDate` 字面不會讓掃描紅：那條測試
 *  會先把註解剝掉再看。第一版沒剝，於是這個模組沒辦法寫出自己禁止什麼 ——
 *  一個分不出「程式碼在呼叫它」與「註解在解釋不要呼叫它」的守衛。）
 */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** 把一個 `YYYY-MM-DD` 往前或往後推 `delta` 天，回傳同樣格式的字串。
 *
 *  用 `slice` 取三段數字而不是解構 `RegExp.exec()` 的結果：在
 *  `noUncheckedIndexedAccess` 之下後者是 `string | undefined`，會逼出一串
 *  跟這個函式的意義無關的 undefined 判斷。`slice` 回的是 `string`。
 *
 *  `Date.UTC` 自己處理溢位（第 0 天是上個月的最後一天、第 32 天是下個月），
 *  所以跨月、跨年、閏日都不需要特別處理。 */
export function shiftDays(isoDate: string, delta: number): string {
	if (!ISO_DATE.test(isoDate)) {
		throw new Error(
			`shiftDays 只接受 YYYY-MM-DD，收到：${JSON.stringify(isoDate)}`,
		);
	}
	const year = Number(isoDate.slice(0, 4));
	const month = Number(isoDate.slice(5, 7));
	const day = Number(isoDate.slice(8, 10));
	return new Date(Date.UTC(year, month - 1, day + delta))
		.toISOString()
		.slice(0, 10);
}

/** `"2026-09-05"` → `"9/5"`。
 *
 *  純字串切割，不經過 `Date` —— 同樣是為了讓這個模組整體對時區免疫。
 *  `Number()` 是用來去掉前導零的。 */
export function formatCivilDate(isoDate: string): string {
	if (!ISO_DATE.test(isoDate)) {
		throw new Error(
			`formatCivilDate 只接受 YYYY-MM-DD，收到：${JSON.stringify(isoDate)}`,
		);
	}
	return `${Number(isoDate.slice(5, 7))}/${Number(isoDate.slice(8, 10))}`;
}
