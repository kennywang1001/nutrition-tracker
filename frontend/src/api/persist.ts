import { createAsyncStoragePersister } from "@tanstack/query-async-storage-persister";
import { defaultShouldDehydrateQuery } from "@tanstack/react-query";
import type { PersistQueryClientProviderProps } from "@tanstack/react-query-persist-client";

/** 離線 L2：把 TanStack Query 的 query 狀態（含 `dataUpdatedAt`）存進
 *  `localStorage`，app 啟動時 hydrate 回來。
 *
 *  **規格 §8 原文寫「TanStack Query 的持久化 + Workbox 的 runtime
 *  caching」，這裡刻意只做前者。** 理由：Workbox 在 service worker 層
 *  快取 HTTP 回應——離線時它把快取的回應交給 `fetch`，TanStack Query
 *  收到一個 200 就會當成**剛剛取得**的新鮮資料，`dataUpdatedAt` 變成
 *  「現在」。那正好讓陳舊資料看起來是新的，也就是規格自己警告的那件事
 *  （「顯示陳舊數字而不說明它是陳舊的，比不顯示更糟」）。
 *
 *  TanStack Query 的持久化存的是 query 的**狀態**，`dataUpdatedAt`
 *  hydrate 回來之後仍然是上一次**真的成功取得**的時間——那正是
 *  Today.tsx「最後更新於 X」需要的那個值。
 *
 *  Workbox 仍然負責 app shell（L1，見 `vite.config.ts` 的
 *  `VitePWA({ workbox: ... })`），只是不碰 `/api/*`——那份設定不受這個
 *  檔案影響，這裡也不去動它。
 *
 *  **用 `localStorage`，不用 IndexedDB**：要存的是幾個 KB 的 JSON 狀態，
 *  `localStorage` 同步讀寫，沒有 IndexedDB 那種 async 的啟動順序問題。
 *
 *  **`@tanstack/query-sync-storage-persister` 目前是 deprecated**（npm
 *  上該套件的型別標了 `@deprecated use createAsyncStoragePersister from
 *  @tanstack/query-async-storage-persister instead`，實測於 5.103.2）——
 *  即使底層還是同步的 `localStorage`，TanStack 現在統一走「storage 介面
 *  回傳值可能是 Promise（`MaybePromise`）」這條路，用 async 版本包同一個
 *  `localStorage` 完全等價：`Storage.getItem`/`setItem` 本身還是同步呼叫，
 *  只是回傳值被介面包成「可能是 Promise」，實際只差一個 microtask，不影響
 *  app 啟動時 hydrate 完成的時機——`PersistQueryClientProvider` 是用
 *  `isRestoring`（一個 React context）擋住真正的 `fetch`，不是用
 *  「storage 讀取是同步還是非同步」來擋（見 `useIsRestoring` 在
 *  `useBaseQuery` 裡的用法：`_optimisticResults = isRestoring ?
 *  "isRestoring" : ...`，跟 storage 介面無關）。
 *
 *  計畫原本寫的套件名是 `@tanstack/react-query-persist-client` 與
 *  `@tanstack/query-sync-storage-persister`——前者仍是對的，後者裝的當下
 *  就帶著 deprecated 警告，所以換成官方目前推薦的
 *  `@tanstack/query-async-storage-persister`。 */

/** 匯出給測試用（`tests/offline.test.tsx`）：測試需要直接讀
 *  `localStorage` 確認真的寫進去了，不該把這個字串在測試檔案裡重抄一次
 *  ——重抄就是又一個「兩處講同一件事」的漂移點。 */
export const OFFLINE_CACHE_STORAGE_KEY = "nutrition-tracker-offline-cache";

/** 一天前的「今日總覽」已經不是今日了。與其顯示一個標著「最後更新於
 *  昨天」的今日總覽，不如顯示空的——超過這個時間的持久化快取直接不
 *  hydrate（`persistQueryClientRestore` 會呼叫 `persister.removeClient()`
 *  丟棄它）。 */
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

type OfflinePersistOptions = PersistQueryClientProviderProps["persistOptions"];

/** 不進離線快取的 query 命名空間。
 *
 *  **`meal-photo`：** 照片 blob 是 IndexedDB 的量級。`localStorage` 有 5MB
 *  上限，一張照片（前端降尺寸後也還有幾百 KB）就可能把它塞爆，而且 Blob
 *  本身也無法有意義地 JSON.stringify。
 *
 *  **`food-search`：** 使用者每敲一個字都會產生一組新的 query key，結果在
 *  `localStorage` 裡越堆越多。
 *
 *  兩者塞爆的症狀一樣惡劣：`setItem` 丟 `QuotaExceededError`，於是**整份
 *  離線快取都寫不進去** —— 不是「搜尋結果存不了」，是連今日總覽也一起沒了。
 *  而那個失敗發生在背景的節流寫入裡，畫面上完全看不出來。
 *
 *  兩個 key 都刻意用獨立的第一段命名空間（不掛在 `"meals"` / `"foods"`
 *  底下，見 `api/queries.ts`），所以這裡直接認 `queryKey[0]`。 */
const NOT_PERSISTED: ReadonlySet<unknown> = new Set([
	"meal-photo",
	"food-search",
]);

/** 每次呼叫回一組**獨立**的 persist 設定，包含一個新的 persister
 *  instance（有自己的節流狀態）。
 *
 *  `App.tsx` 只呼叫一次、存成下面的 `offlinePersistOptions` 模組層單例。
 *  測試需要模擬「兩次分開的頁面載入」（先在線上讓資料成功並被 persist，
 *  再假裝離線、用一個全新的 `QueryClient` + 全新的 persister 去 restore）
 *  時，才會直接呼叫這個 factory——兩次呼叫共用同一個 `storage`（同一份
 *  `localStorage`），但不共用 persister 內部狀態，比較接近真的重新整理
 *  分頁。 */
export function createOfflinePersistOptions(
	storage: Storage = window.localStorage,
): OfflinePersistOptions {
	return {
		persister: createAsyncStoragePersister({
			storage,
			key: OFFLINE_CACHE_STORAGE_KEY,
		}),
		maxAge: MAX_AGE_MS,
		dehydrateOptions: {
			shouldDehydrateQuery: (query) =>
				defaultShouldDehydrateQuery(query) &&
				!NOT_PERSISTED.has(query.queryKey[0]),
		},
	};
}

/** app 唯一使用的 persist 設定——跟 `api/queries.ts` 的 `queryClient` 一樣
 *  是模組層單例。`App.tsx` 用它包 `PersistQueryClientProvider`。 */
export const offlinePersistOptions: OfflinePersistOptions =
	createOfflinePersistOptions();
