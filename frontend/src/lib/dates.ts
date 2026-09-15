/** **這個模組只做顯示格式化，不做任何日界線計算。**
 *
 *  「今天是哪一天」由伺服器決定：後端的 `app/days.py` 的
 *  `today_in_timezone(user.timezone)` 是唯一的事實來源，而
 *  `/api/stats/daily`、`/api/meals?date=`、`/api/supplements/today`
 *  三個端點共用它（後端有專門的跨端點一致性測試守著）。
 *
 *  **前端算一次就是第二個事實來源**，而且錯的方式很惡劣：使用者時區
 *  跟瀏覽器時區相同時完全正確，不同時只在午夜前後錯 —— 一個大部分時候
 *  看起來沒問題的 bug。
 *
 *  所以這裡沒有 `today()`、沒有 `startOfDay()`，將來也不該有。
 *  需要「今天」的時候，**不要傳 `date` 參數，讓後端決定**。
 */

/** 把後端回的 ISO 8601 timestamptz 格式化成給人看的時間。 */
export function formatTime(isoString: string): string {
	return new Date(isoString).toLocaleTimeString(undefined, {
		hour: "2-digit",
		minute: "2-digit",
	});
}
