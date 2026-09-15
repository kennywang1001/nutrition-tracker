/** 所有 query key 的唯一事實來源。
 *
 *  **為什麼集中放：** 記一餐要讓今日總覽失效，那代表兩個畫面共用同一個 key。
 *  分散寫的話兩邊各拼一次字串，某天其中一邊改了，失效就**靜默失靈** ——
 *  而症狀是「記完一餐，總覽的數字沒變」，使用者會以為沒記進去。
 *
 *  **`dailyStats` 刻意不帶日期參數。** 後端省略 `?date=` 時會用
 *  `today_in_timezone(user.timezone)`（規格 §5.3、後端 `app/days.py`）——
 *  前端**不該自己算今天是哪一天**。所以這個 query 沒有參數，
 *  key 也就沒有參數。
 */
export const queryKeys = {
	dailyStats: ["stats", "daily"] as const,
	supplementsToday: ["supplements", "today"] as const,
	frequentFoods: ["foods", "frequent"] as const,
	recentFoods: ["foods", "recent"] as const,
} as const;
