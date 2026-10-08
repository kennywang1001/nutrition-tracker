const REFRESH_TOKEN_KEY = "refresh_token";

/** access token 放記憶體（規格 §6.1）。
 *
 *  15 分鐘就死，不值得持久化。**這不是 XSS 防護** —— 正在執行的 XSS
 *  讀得到這個模組變數；差別只在它不留存到下一次開啟。
 *
 *  誠實記下代價：refresh token 在 localStorage，XSS 就拿得到。
 *  唯一的緩解是後端的重用偵測——攻擊者用了偷來的票之後，合法裝置下一次
 *  換票就會踩到偵測，整條鏈被撤銷、使用者被登出。**那是一個會被察覺的
 *  攻擊，而不是一個安靜的攻擊。** */
let accessToken: string | null = null;

export type Tokens = { access_token: string; refresh_token: string };

export function setTokens(tokens: Tokens): void {
	accessToken = tokens.access_token;
	localStorage.setItem(REFRESH_TOKEN_KEY, tokens.refresh_token);
}

export function getAccessToken(): string | null {
	return accessToken;
}

/** 每次都重新讀 localStorage，不快取。
 *
 *  Task 7 的跨分頁鎖依賴這件事：等到鎖的時候，另一個分頁可能已經換好票了，
 *  這時要用**新的**票，不是自己手上那張舊的（那張已經 used_at 了，
 *  送出去就是自己觸發重用偵測）。 */
export function getRefreshToken(): string | null {
	return localStorage.getItem(REFRESH_TOKEN_KEY);
}

/** `forced`：不是使用者在這個分頁按的登出（換票被拒、另一個分頁登出了）。 */
export type LoggedOutEvent = { forced: boolean };

const loggedOutListeners = new Set<(event: LoggedOutEvent) => void>();

/** 訂閱「這個分頁被登出了」，回傳取消訂閱的函式。`App` 用它切回登入畫面。
 *
 *  **只通知登出，不通知登入**（帳號設定審查 I2）。以前 `App` 的 `loggedIn` 只在開頁時讀一次
 *  localStorage：換票被拒時 `refresh.ts` 清掉了票，登入後的外框卻留在原地，之後每個請求都
 *  失敗，要自己重新整理才看得到登入畫面——別的裝置改了密碼，這台 15 分鐘內就會走到那裡。
 *
 *  登入的方向刻意**不**從 `setTokens` 通知：`Join.tsx` 是 `login()` → 把網址換成 `/` →
 *  `onSuccess()`，在 `setTokens` 那一刻就切過去的話，路由會掛在 `/join#邀請碼` 上。
 *  改密碼、換票也都呼叫 `setTokens`，那些不是「登入了」。 */
export function onLoggedOut(
	listener: (event: LoggedOutEvent) => void,
): () => void {
	loggedOutListeners.add(listener);
	return () => {
		loggedOutListeners.delete(listener);
	};
}

/** `keepStorage`：只丟記憶體裡的 access token（測試用來模擬重新載入），不是登出，不通知。
 *  `forced`：見 `LoggedOutEvent`。 */
export function clearTokens(
	options: { keepStorage?: boolean; forced?: boolean } = {},
): void {
	accessToken = null;
	if (options.keepStorage) return;
	localStorage.removeItem(REFRESH_TOKEN_KEY);
	const event: LoggedOutEvent = { forced: options.forced === true };
	// 先複製：訂閱者可能在被通知的當下取消訂閱（元件卸載）。
	for (const listener of [...loggedOutListeners]) listener(event);
}

/** 這個 `storage` 事件是不是「另一個分頁把 refresh token 拿掉了」（登出，或換票被拒）。
 *  `storage` 事件只送給**其他**分頁，動手的那個分頁收不到。
 *
 *  - 鍵是 refresh token、新值是 `null` → 是。新值不是 `null`（另一個分頁換了票、改了密碼）
 *    → 不是：票還在，下一次換票會讀到新的那張。
 *  - 鍵是 `null`（對方呼叫了 `localStorage.clear()`）→ 是，票也在裡面。
 *
 *  鍵的名字只有這個檔案知道，所以判斷放在這裡；要做什麼由 `auth/session.ts` 決定。 */
export function refreshTokenWasRemoved(event: StorageEvent): boolean {
	if (event.storageArea !== localStorage) return false;
	if (event.key === null) return true;
	return event.key === REFRESH_TOKEN_KEY && event.newValue === null;
}

// 只在 dev 建置裡存在的測試後門（`import.meta.env.DEV` 在 production
// 建置時是 false，整段會被 tree-shake 掉）。
//
// E2E 需要製造「access token 過期但 refresh token 還活著」的狀態，
// 而等 15 分鐘不是選項。用 Playwright 的 route 攔截捏造一個 401 也不行——
// 那攔的是我們自己寫的回應，這條 E2E 就退化成 MSW 了。
if (import.meta.env.DEV) {
	(globalThis as unknown as Record<string, unknown>).__forceExpireAccessToken =
		() => {
			accessToken = "expired.invalid.token";
		};
}
