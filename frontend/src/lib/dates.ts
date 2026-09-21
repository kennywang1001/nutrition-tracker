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

/** 把後端回的 ISO 8601 timestamptz，或一個 epoch 毫秒數，格式化成給人看的
 *  時間。
 *
 *  **接受 `number` 是為了離線 L2 的「最後更新於」標示**（計畫三 Task 4）：
 *  TanStack Query 的 `dataUpdatedAt` 是 epoch 毫秒數，不是 ISO
 *  字串——這不是「算日界線」，跟頂端那條規矩無關，純粹是把一個已經
 *  存在的時間值轉成人看得懂的格式。 */
export function formatTime(timestamp: string | number): string {
	return new Date(timestamp).toLocaleTimeString(undefined, {
		hour: "2-digit",
		minute: "2-digit",
	});
}
