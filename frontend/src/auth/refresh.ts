import { clearTokens, getRefreshToken, setTokens } from "./store";

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

	const response = await fetch("/api/auth/refresh", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ refresh_token: refreshToken }),
	});

	if (!response.ok) {
		// INVALID_TOKEN 可能是「票過期了」，也可能是「重用偵測撤銷了整條鏈」。
		// 前端分不出來，而處理一律相同（規格 §6.5）。
		clearTokens();
		return false;
	}

	const tokens = (await response.json()) as {
		access_token: string;
		refresh_token: string;
	};
	setTokens(tokens);
	return true;
}

/** 換一組新的 token。成功回 `true`；失敗（沒有票、或後端拒絕）回 `false` 並清空本地狀態。
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
			return navigator.locks.request("token-refresh", performRefresh);
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
