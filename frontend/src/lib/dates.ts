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

/** 日期加時間，用瀏覽器的時區與語系——zh-TW、台北時區下
 *  `"2026-09-01T00:00:00Z"` 是「2026/9/1 上午08:00」（有上午／下午，沒有秒）。
 *
 *  **只做顯示格式化**，跟 `formatTime` 一樣，不算日界線（見檔頭）。
 *  給「這件事是什麼時候發生的」用——例如食物詳情的編輯歷史。 */
export function formatDateTime(timestamp: string | number): string {
	return new Date(timestamp).toLocaleString(undefined, {
		year: "numeric",
		month: "numeric",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
}

function pad(value: number): string {
	return String(value).padStart(2, "0");
}

/** 一個時刻在**這台裝置時區**的日期（`YYYY-MM-DD`）與時間（`HH:mm`）——給
 *  `<input type="date">`／`<input type="time">` 用（改時間規格 §2）。只是格式轉換，
 *  不決定「算哪一天」——那照舊是後端依帳號時區的事。 */
export function localDateTime(timestamp: string): {
	date: string;
	time: string;
} {
	const moment = new Date(timestamp);
	return {
		date: `${moment.getFullYear()}-${pad(moment.getMonth() + 1)}-${pad(moment.getDate())}`,
		time: `${pad(moment.getHours())}:${pad(moment.getMinutes())}`,
	};
}

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_PATTERN = /^(\d{2}):(\d{2})$/;

/** `localDateTime` 的反方向：`<input type="date">` 的 `YYYY-MM-DD` 加
 *  `<input type="time">` 的 `HH:mm`，在**這台裝置時區**組成一個時刻。不是有效的
 *  日期與時間（空的、格式不對、2 月 30 日、24:00）回 `null`。
 *
 *  **用數字組，不交給字串解析器。** `new Date("YYYY-MM-DDTHH:mm")` 算本地還是
 *  UTC 取決於字串長什麼樣子（只有日期的形式是 UTC）——差一個字就差八小時。
 *  年份另外用 `setFullYear` 設：`new Date(y, …)` 會把 0–99 年當成 19xx 年。
 *
 *  夏令時間跳過或重複的那一段由 `Date` 默默決定（台北沒有夏令時間）。 */
export function fromLocalDateTime(date: string, time: string): Date | null {
	const dateMatch = DATE_PATTERN.exec(date);
	const timeMatch = TIME_PATTERN.exec(time);
	if (dateMatch === null || timeMatch === null) return null;
	const year = Number(dateMatch[1]);
	const month = Number(dateMatch[2]);
	const day = Number(dateMatch[3]);
	const hours = Number(timeMatch[1]);
	const minutes = Number(timeMatch[2]);
	if (hours > 23 || minutes > 59) return null;
	const moment = new Date(year, month - 1, day, hours, minutes);
	moment.setFullYear(year, month - 1, day);
	// 2 月 30 日、13 月之類會被 Date 進位成別的日子：對不回去就不是有效日期。
	if (
		moment.getFullYear() !== year ||
		moment.getMonth() !== month - 1 ||
		moment.getDate() !== day
	) {
		return null;
	}
	return moment;
}
