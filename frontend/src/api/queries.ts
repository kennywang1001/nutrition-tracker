import { QueryClient } from "@tanstack/react-query";
import type { components } from "./schema";

type FoodScope = components["schemas"]["FoodScope"];

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
	/** 補劑搜尋的結果。**獨立命名空間，理由跟下面的 `foodSearch` 一樣**：
	 *  掛在 `supplementsToday`（或任何補劑相關 key）底下的話，打卡／取消
	 *  之後的 `invalidateQueries({ queryKey: supplementsToday })` 會因為
	 *  前綴比對連帶打掉每一組已掛載的搜尋結果——那不是這次要的行為
	 *  （打卡不會改變「哪些補劑找得到」）。
	 *
	 *  **也因為同一個理由不進離線持久化**（`api/persist.ts` 的
	 *  `NOT_PERSISTED`）：使用者每敲一個字就是一組新 key，堆在
	 *  `localStorage` 裡的失敗模式跟 `food-search` 完全一樣——
	 *  `setItem` 丟 `QuotaExceededError` 時炸的是整份離線快取，不只是
	 *  補劑搜尋本身。
	 *
	 *  **跟 `foodSearch` 不同的地方：這裡沒有 `scope` 參數。**
	 *  `Supplements.tsx`（Task 2）不做食物庫那種「全部／公開／我建立的」
	 *  三選一——使用者只要求「新增我有在使用的」＋「當天有吃就點一份」，
	 *  沒有要求依擁有權篩選，後端 `scope` 省略時預設 `all` 已經夠用。 */
	supplementSearch: (q: string) => ["supplement-search", q] as const,
	/** 今日餐點清單。跟 `dailyStats` 一樣刻意不帶日期參數——後端的
	 *  `list_meals` 省略 `?date=` 時也是走 `today_in_timezone(user.timezone)`
	 *  （`app/days.py`，跟 `/api/stats/daily`、`/api/supplements/today`
	 *  同一個函式）。記一餐成功後要讓這個 key 失效，清單才會顯示新的一餐。 */
	meals: ["meals"] as const,
	/** 趨勢：一段期間的逐日統計。
	 *
	 *  **帶 from / to 兩個參數，而它們來自 `stats/daily` 回應裡的 `date`**
	 *  （規格 §4.1）——`GET /api/stats/range` 的 from/to 都是必填，跟
	 *  `stats/daily` 不一樣，而「今天是哪一天」只有伺服器知道。
	 *
	 *  跟 `dailyStats` 同在 `["stats"]` 底下是刻意的：記一餐之後要一次
	 *  失效掉所有期間的趨勢（見下面的 `rangeStatsAll`），而那個前綴
	 *  不會碰到 `dailyStats`。 */
	rangeStats: (from: string, to: string) =>
		["stats", "range", from, to] as const,
	/** 「所有期間的趨勢」這個前綴，給 `invalidateQueries` 用。
	 *
	 *  寫成一個具名的 key 而不是在呼叫端手打 `["stats", "range"]`，
	 *  理由跟這個檔案頂端說的一樣：兩邊各拼一次字串，某天其中一邊改了，
	 *  失效就靜默失靈。 */
	rangeStatsAll: ["stats", "range"] as const,
	frequentFoods: ["foods", "frequent"] as const,
	recentFoods: ["foods", "recent"] as const,
	/** 單一食物的份量清單。不像上面四個 key，這個不需要跨畫面失效——
	 *  份量清單只在「記一餐」選了某個食物之後才查，沒有其他畫面會讀它。
	 *  放進這個檔案不是因為要共用失效，而是延續「query key 只有一個
	 *  事實來源」這條規矩，不要有些 key 在這裡、有些散在各畫面裡。 */
	portions: (foodId: number) => ["foods", foodId, "portions"] as const,
	/** 目前登入者。Task 7 的 tab bar 要用它的 `role` 決定第五格出不出現。 */
	me: ["me"] as const,
	/** 單一食物。**刻意是 `portions` 與 `foodRevisions` 的前綴。**
	 *
	 *  審核通過之後，那個食物的目前數值、份量、編輯歷史都該重取 ——
	 *  一次 `invalidateQueries({ queryKey: queryKeys.food(id) })` 打到三個
	 *  正是要的行為（規格 §7.1）。 */
	food: (foodId: number) => ["foods", foodId] as const,
	foodRevisions: (foodId: number) => ["foods", foodId, "revisions"] as const,
	/** 全庫搜尋的結果。**刻意不掛在 `["foods"]` 底下**，沿用
	 *  `mealPhoto` 的前例（見下面那段註解）。
	 *
	 *  掛下去的話，任何一次 `invalidateQueries({ queryKey: ["foods"] })` 都會
	 *  連帶炸掉**每一組已掛載的搜尋結果與份量清單**。獨立命名空間之後，
	 *  前綴比對自然就做對的事，而且沒有「忘記加 `exact: true`」這個失敗模式。
	 *
	 *  它也**不進離線持久化**（`api/persist.ts`）—— 理由見那個檔案。 */
	foodSearch: (q: string, scope: FoodScope) =>
		["food-search", q, scope] as const,
	/** 待審提案清單（管理員）。 */
	pendingRevisions: ["admin", "food-revisions"] as const,
	/** 單一餐的照片 blob（`useMealPhoto`，計畫三 Task 2）。跟 `portions` 一樣
	 *  放這裡是為了「query key 只有一個事實來源」，不是因為現在就需要跨畫面
	 *  失效——但上傳照片（Task 3）之後會需要讓這個 key 失效，先放在這裡
	 *  而不是散在 `photos.ts` 裡，屆時只改一處。 */
	// **刻意不掛在 "meals" 底下。** TanStack Query 的 invalidateQueries 是
	// **前綴比對** —— 如果這個 key 是 ["meals", id, "photo"]，那麼任何一次
	// invalidateQueries({ queryKey: ["meals"] }) 都會連帶失效【每一張
	// 已掛載的照片】，於是記一餐會順便重新下載清單上所有的照片。
	//
	// 在手機上走 Tailscale、每張照片約 500KB 時，那不是「無害的多打幾個
	// 請求」。實作 Task 3 時用測試抓到的（3 次照片 GET 而不是 2 次）。
	//
	// 當時的修法是在呼叫端加 exact: true，但那是靠每個呼叫端記得 ——
	// 漏一個就靜默回到過度失效。換成獨立的命名空間之後，前綴比對自然
	// 就做對的事，而且沒有「忘記加 exact」這個失敗模式。
	mealPhoto: (mealId: number) => ["meal-photo", mealId] as const,
} as const;

/** 整個 app 共用的單一 `QueryClient`。
 *
 *  放在這裡（而不是 `App.tsx` 的模組層）是為了讓 `auth/session.ts` 的
 *  `logout()` 與 `auth/refresh.ts` 的 refresh 失敗路徑都能拿到同一個
 *  instance 去清快取，又不必讓那兩個模組回頭 import `App.tsx`
 *  （那會兜出一個循環依賴：`App.tsx` 本來就 import 它們）。
 *
 *  **`staleTime: 60_000`（Task 6 的突變驗證發現、實測補上）：** 沒有這一行時
 *  `staleTime` 預設是 0，代表任何 query 一 fetch 完就立刻「過期」。React
 *  Router 把「今日總覽」與「記一餐」放在不同路由，切換路由時前者會整個
 *  unmount／remount —— 而 remount 時只要資料是「過期」的，TanStack Query
 *  就會自動重新 fetch，跟有沒有呼叫 `invalidateQueries` 無關。結果是：
 *  `LogMeal.tsx` 那個 `invalidateQueries({ queryKey: queryKeys.dailyStats })`
 *  （記完一餐讓今日總覽重取的那一行，程式碼注解說它是「這份計畫的核心」）
 *  即使被整行刪掉，「記一餐 → 導回今日總覽 → 數字變了」這個 E2E 斷言依然會
 *  綠燈——remount 觸發的自動重取蓋掉了它。拿掉這一行的當下用突變驗證親自
 *  確認過（見 `e2e/daily-loop.spec.ts` 附近的說明與 Task 6 的完成報告）。
 *
 *  給一個非零的 `staleTime`，remount 時「資料還新鮮」就不會自動重取，
 *  那條路徑的正確性才真的只剩 `invalidateQueries` 在守——程式碼裡的注解
 *  講的保證，跟它實際測得到的保證，這樣才是同一件事。60 秒是刻意抓寬的
 *  數字：使用者在頁面之間切換、打卡幾秒內完成都遠低於這個值，不會讓
 *  「資料新鮮度」變成使用者感覺得到的問題；同時它也遠遠蓋過任何 E2E
 *  測試單一操作的耗時，不會讓這裡的修正反過來讓別的測試變得脆弱。 */
export const queryClient = new QueryClient({
	defaultOptions: { queries: { staleTime: 60_000 } },
});

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
