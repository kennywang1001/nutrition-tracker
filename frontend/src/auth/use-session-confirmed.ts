import { useEffect, useState } from "react";
import { apiFetch } from "../api/client";

/** 這個分頁的登入是不是**剛剛被後端確認過**：掛載時打一次 `GET /api/me`，成功才是 `true`。
 *
 *  `App` 開頁時只看「localStorage 裡有沒有 refresh token」就當成登入中，而那張票可能早就過期
 *  或被撤銷了——忘記密碼的人手上的裝置常常正是這樣。`/join`、`/reset-password` 的「已登入」
 *  畫面要等這裡回 `true` 才把碼從網址列拿掉（理由在 `ResetPasswordWhileLoggedIn`）。
 *
 *  三種結果：
 *  - 成功（必要時先換票）→ `true`。
 *  - 票無效：`/api/me` 401 → 換票 401 → `auth/refresh.ts` 清掉票並通知 `App`，這個畫面被卸載。
 *    這裡什麼都不用做。
 *  - 其他（斷線、429、5xx）：不知道——維持 `false`。寧可碼多留一會兒，也不要在不確定的時候拿掉。
 *
 *  **直接 `apiFetch`，不用 `useMe()`**：`useMe().isSuccess` 說的是「快取裡有一份」，離線快取
 *  還原回來的也算，60 秒內的也不會重抓——那不是「這張票現在還能用」（同 `/me/targets` 踩過的
 *  `isFetchedAfterMount`，帳號設定審查 M5）。這裡要的是一次真的打到後端的請求。 */
export function useSessionConfirmed(): boolean {
	const [confirmed, setConfirmed] = useState(false);

	useEffect(() => {
		let cancelled = false;
		apiFetch("/api/me").then(
			() => {
				if (!cancelled) setConfirmed(true);
			},
			() => {
				// 見上面：被登出的話 `App` 會處理；其他失敗就是「不知道」。
			},
		);
		return () => {
			cancelled = true;
		};
	}, []);

	return confirmed;
}
