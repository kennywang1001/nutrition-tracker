import { createAsyncStoragePersister } from "@tanstack/query-async-storage-persister";
import type {
	PersistedClient,
	PersistQueryClientProviderProps,
} from "@tanstack/react-query-persist-client";

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

/** 一天前的「今日營養素」已經不是今日了。與其顯示一個標著「最後更新於
 *  昨天」的今日營養素，不如顯示空的——超過這個時間的持久化快取直接不
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
 *  **`supplement-search`（P3-C Task 2）：跟 `food-search` 一模一樣的理由**——
 *  `Supplements.tsx` 的搜尋框也是每敲一個字就一組新 key（`useSupplementSearch`，
 *  `api/supplements.ts`），會在 `localStorage` 裡累積出跟食物搜尋一樣的
 *  失敗模式，所以比照辦理排除。
 *
 *  三者塞爆的症狀一樣惡劣：`setItem` 丟 `QuotaExceededError`，於是**整份
 *  離線快取都寫不進去** —— 不是「搜尋結果存不了」，是連今日營養素也一起沒了。
 *  而那個失敗發生在背景的節流寫入裡，畫面上完全看不出來。
 *
 *  三個 key 都刻意用獨立的第一段命名空間（不掛在 `"meals"` / `"foods"` /
 *  `"supplements"` 底下，見 `api/queries.ts`），所以這裡直接認 `queryKey[0]`。 */
const NOT_PERSISTED: ReadonlySet<unknown> = new Set([
	"meal-photo",
	// 好友的資料不是我的：對方可以解除好友、可以把一餐改成「只有我看得到」，
	// 陳舊的好友資料不該在這台裝置上離線留下來。名單、動態、某一天都在
	// `["friends", …]` 底下（見 `api/queries.ts`）。
	"friends",
	// 同 `meal-photo` 的理由，加上同 `friends` 的理由。
	"friend-photo",
	"food-search",
	"supplement-search",
	// 管理員的清單，全部在 `["admin", …]` 底下（見 `api/queries.ts`）：所有帳號（每個人的
	// email 與名字）、邀請清單、待審提案。別人的個資不該以明文留在這台裝置的 localStorage
	// 裡；而這三個畫面本來就只在線上有用（產生連結、撤銷、審核都要打後端，兩份清單還是
	// `staleTime: 0`、每次掛載都重抓），離線快取對它們沒有好處（帳號設定審查 M4）。
	// 新增 `["admin", …]` 的 query 時自動比照辦理；要離線可用的請放別的命名空間。
	"admin",
]);

/** 寫進 localStorage 前，把「有資料的失敗查詢」改寫成「有資料、待重抓」。
 *
 *  `shouldDehydrateQuery` 讓有資料的 `status: "error"` 也寫進來（見下面）。
 *  如果原樣寫，TanStack restore 回來的就是 error 狀態，而重抓開始時 query
 *  的 `fetch` 只在**沒有資料**時把 status 改回 pending——有資料就一路維持
 *  error，直到重抓回來。於是下一次**在線上**重新載入，重抓還在路上的那段
 *  時間，畫面以為剛剛失敗了：今日總覽顯示「離線資料，最後更新於…」，報表
 *  顯示「無法載入本月報表」／「無法載入花費清單」。上一次的失敗屬於上一次
 *  載入，不屬於這一次。（而且 `error` 經過 JSON 只剩 `{}`——`ApiError` 的
 *  `code`、`status` 都不在了，留著也沒有用。）
 *
 *  改成 success、清掉 error 與失敗次數，`isInvalidated` 留著（失敗時 query
 *  已經把它設成 true）——restore 回來的 query 一律算 stale，掛載就重抓；
 *  重抓再失敗（還是離線），才會重新變成 error、顯示離線標示。`data` 與
 *  `dataUpdatedAt` 不動：那仍是上一次**真的成功**的資料與時間。
 *
 *  回傳新的物件，不改傳進來的那份（`dehydrate` 的 state 雖然是複本，仍不
 *  依賴這件事）。之後跟預設一樣 `JSON.stringify`。 */
function serializePersistedClient(client: PersistedClient): string {
	return JSON.stringify({
		...client,
		clientState: {
			...client.clientState,
			queries: client.clientState.queries.map((query) =>
				query.state.status === "error" && query.state.data !== undefined
					? {
							...query,
							state: {
								...query.state,
								status: "success",
								error: null,
								fetchFailureCount: 0,
								fetchFailureReason: null,
								isInvalidated: true,
							},
						}
					: query,
			),
		},
	});
}

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
			serialize: serializePersistedClient,
		}),
		maxAge: MAX_AGE_MS,
		dehydrateOptions: {
			// **不用 `defaultShouldDehydrateQuery`**：它只寫 `status === "success"`。
			// 離線重新載入時資料從這份快取來、背景重抓失敗，query 變成
			// `status: "error"` 但 `data` 還在（畫面也還顯示著）——預設規則讓下一次
			// 節流寫入把它從 localStorage 拿掉，第二次離線重新載入就什麼都沒有了
			// （實測過，`tests/offline.test.tsx`「離線重新載入兩次」）。有資料的失敗
			// 保留最後一份成功的資料與它的 `dataUpdatedAt`；沒有資料的失敗照舊不寫。
			// 寫進去之前會先被 `serializePersistedClient` 改回 success（見那裡）。
			shouldDehydrateQuery: (query) =>
				(query.state.status === "success" ||
					(query.state.status === "error" && query.state.data !== undefined)) &&
				!NOT_PERSISTED.has(query.queryKey[0]),
		},
	};
}

/** app 唯一使用的 persist 設定——跟 `api/queries.ts` 的 `queryClient` 一樣
 *  是模組層單例。`App.tsx` 用它包 `PersistQueryClientProvider`。 */
export const offlinePersistOptions: OfflinePersistOptions =
	createOfflinePersistOptions();
