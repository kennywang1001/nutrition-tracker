import { clearQueryCacheOnForcedLogout, queryClient } from "../api/queries";
import { clearTokens, getRefreshToken, setTokens } from "./store";

/** 跨分頁的鎖的名字（`navigator.locks`）。**所有會把 localStorage 裡的 refresh token
 *  換成另一張的動作都要握著它**：換票（下面的 `refreshTokens`）與改密碼
 *  （`withTokenLock`，`auth/session.ts` 的 `changePassword` 用）。 */
const TOKEN_LOCK = "token-refresh";

/** 分頁**內**的 single-flight：並行的呼叫者共用同一個 promise。 */
let inFlight: Promise<boolean> | null = null;

/** 只給測試用 —— 模組層的狀態在測試之間會殘留。 */
export function resetRefreshStateForTests(): void {
	inFlight = null;
}

async function performRefresh(): Promise<boolean> {
	// **取得鎖之後要重新讀 localStorage。**
	// 等鎖的期間，另一個分頁可能已經換好票了；這時要用新的那一張，
	// 不是自己進來時手上那張舊的 —— 那張已經被標記 used_at，
	// 送出去就是自己觸發後端的重用偵測，整條 family 會被撤銷（規格 §6.4）。
	const refreshToken = getRefreshToken();
	if (refreshToken === null) return false;

	let response: Response;
	try {
		response = await fetch("/api/auth/refresh", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ refresh_token: refreshToken }),
		});
	} catch {
		// 網路斷線：連不上不代表票無效。保留登入，這次請求就是失敗。
		return false;
	}

	if (response.status === 401) {
		// INVALID_TOKEN 可能是「票過期了」，也可能是「重用偵測撤銷了整條鏈」。
		// 前端分不出來，而處理一律相同（規格 §6.5）：清 token、清 query 快取。
		// `forced`：不是使用者按的登出——`App` 訂閱了 store 的通知，會切回登入畫面並
		// 顯示「已被登出，請重新登入」（帳號設定審查 I2）。
		clearTokens({ forced: true });
		clearQueryCacheOnForcedLogout(queryClient);
		return false;
	}

	if (!response.ok) {
		// 429（限速）、5xx（部署重啟、代理的錯誤頁）：票沒有被判定無效，
		// **保留登入**（安全補強規格 §4.1）。下一次請求會再試換票。
		return false;
	}

	const tokens = (await response.json()) as {
		access_token: string;
		refresh_token: string;
	};
	setTokens(tokens);
	return true;
}

/** 換一組新的 token。成功回 `true`；失敗回 `false`；只有 401 才清空本地狀態。
 *
 *  **同一時間只會有一個請求在飛**，兩層保證：
 *
 *  1. 分頁內：共用 `inFlight` 的 promise。
 *  2. 跨分頁：`navigator.locks`。這一層不是多餘的 —— 手機上把 app 加到
 *     主畫面之後，PWA 視窗與瀏覽器分頁是兩個 context，共用同一個 localStorage。
 *
 *  `navigator.locks` 需要 secure context，所以它在 `http://100.x.y.z` 上
 *  不存在 —— 那正是 Task 1 的 HTTPS 排在所有前端工作之前的原因之一。 */
export function refreshTokens(): Promise<boolean> {
	if (inFlight !== null) return inFlight;

	const run = async (): Promise<boolean> => {
		if (typeof navigator !== "undefined" && navigator.locks !== undefined) {
			return navigator.locks.request(TOKEN_LOCK, performRefresh);
		}
		// jsdom 沒有 navigator.locks。退回只有分頁內的保護 ——
		// 在測試環境裡這是對的（只有一個 context），在真機上永遠走不到這條
		// （secure context 是 Task 1 的前置條件）。
		return performRefresh();
	};

	inFlight = run().finally(() => {
		// 一定要清掉，否則第一次的結果會被永遠快取住 ——
		// 失敗之後使用者重新登入也不會有用。
		inFlight = null;
	});

	return inFlight;
}

/** 握著換票的那把鎖做一件**會換掉 refresh token** 的事（目前只有改密碼）。
 *
 *  改密碼時後端撤銷所有 refresh session、回一組新的。請求在路上的時候，如果另一個請求
 *  （或另一個分頁）拿舊票去換：
 *  - 換票先到 → 換到的那張被改密碼一起撤銷，卻可能比新票**晚**寫進 localStorage，把它
 *    蓋掉——下一次換票 401，剛改完密碼的這台反而被登出；
 *  - 換票後到 → 舊票已經撤銷，直接 401，同樣被登出。
 *  握著鎖，換票就排在後面；等到鎖的時候 `performRefresh` 重新讀 localStorage，用的是
 *  新的那張（帳號設定審查 M6）。
 *
 *  **`task` 拿到一個「已經在鎖裡」的換票函式，裡面的請求要用它**（`apiFetch` 的第三個
 *  參數），不能用平常的 `refreshTokens()`：Web Locks 不能重入，握著鎖再要同一把鎖會
 *  永遠等不到自己放手——access token 過期時（整頁重新載入之後一定是）就會走到。
 *
 *  沒有 `navigator.locks`（非 secure context、jsdom）時沒有鎖可握：退回原本的行為，
 *  裡面的換票用 `refreshTokens()`，至少跟同一個分頁裡正在飛的換票共用同一個 promise。 */
export function withTokenLock<T>(
	task: (refreshWhileLocked: () => Promise<boolean>) => Promise<T>,
): Promise<T> {
	if (typeof navigator !== "undefined" && navigator.locks !== undefined) {
		return navigator.locks.request(TOKEN_LOCK, () => task(performRefresh));
	}
	return task(refreshTokens);
}
