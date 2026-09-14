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

export function clearTokens(options: { keepStorage?: boolean } = {}): void {
	accessToken = null;
	if (!options.keepStorage) {
		localStorage.removeItem(REFRESH_TOKEN_KEY);
	}
}
