import { QueryClient } from "@tanstack/react-query";

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

/** 整個 app 共用的單一 `QueryClient`。
 *
 *  放在這裡（而不是 `App.tsx` 的模組層）是為了讓 `auth/session.ts` 的
 *  `logout()` 與 `auth/refresh.ts` 的 refresh 失敗路徑都能拿到同一個
 *  instance 去清快取，又不必讓那兩個模組回頭 import `App.tsx`
 *  （那會兜出一個循環依賴：`App.tsx` 本來就 import 它們）。 */
export const queryClient = new QueryClient();

/** 強制登出（或使用者主動登出）時清空 query 快取（規格 §6.5）。
 *
 *  **必須清。** 不清的話下一個登入的人會先看到上一個人的今日總覽，
 *  然後才被重新 fetch 覆蓋掉 —— 那是使用者會親眼看到的跨使用者資料外洩，
 *  不是理論上的風險。
 *
 *  接在兩條路徑上：`auth/session.ts` 的 `logout()`（使用者主動登出）與
 *  `auth/refresh.ts` 的 refresh 失敗路徑（`INVALID_TOKEN` 導致的強制登出——
 *  可能是票過期，也可能是重用偵測撤銷了整條鏈，前端分不出來，處理一律相同）。 */
export function clearQueryCacheOnForcedLogout(client: QueryClient): void {
	client.clear();
}
