/** 把一個已經在記憶體裡的 `Blob` 交給使用者存成檔案。
 *
 *  **一般情況：暫時的 object URL ＋ `<a download>`。** 建一個看不到的連結、點它、
 *  拿掉，過一陣子再 `revokeObjectURL`。
 *
 *  **iOS「加入主畫面」的 PWA 例外。** 那個模式沒有瀏覽器的外框，也沒有下載管理員；
 *  `<a download>` 指到 `blob:` 網址在不同的 iOS 版本上可能什麼都不發生，或是整個
 *  畫面被換成檔案預覽、沒有路可以回來。所以只在那個模式、而且系統說它分享得了
 *  檔案（`navigator.canShare({ files })`）時，改開系統的分享面板
 *  （「儲存到檔案」、AirDrop、傳給別的 app）。
 *
 *  **為什麼不是「只要有 `canShare` 就用分享」：** 桌面的 Chrome／Edge、Android 的
 *  Chrome 也有 `canShare`，而它們的下載是好的——在那裡跳分享面板是退步。
 *  `navigator.standalone` 只有 iOS Safari 有，從主畫面打開時才是 `true`。
 *
 *  **已知限制：**
 *  - 分享要「使用者手勢」還有效。檔案是按了按鈕之後才去抓的，抓太久手勢會過期，
 *    `share()` 以 `NotAllowedError` 拒絕——那時退回連結的作法（盡力而為）。
 *  - iOS 的這兩條路都沒有在實機上自動測（Playwright 的 WebKit 不是主畫面模式）；
 *    單元測試守的是「走哪一條路」，不是 iOS 真的把檔案存下來。
 *  - 分享面板被使用者關掉（`AbortError`）不算錯誤，也不會再跳下載。
 */

/** 點完連結之後多久才釋放 object URL。馬上釋放在某些瀏覽器（Safari）會讓下載
 *  還沒開始讀就失敗；40 秒是 FileSaver.js 沿用多年的數字。 */
export const REVOKE_DELAY_MS = 40_000;

/** `downloaded`：點了下載連結。`shared`：交給了系統的分享面板。
 *  `cancelled`：使用者把分享面板關掉了。 */
export type SaveResult = "downloaded" | "shared" | "cancelled";

function isIosStandalone(): boolean {
	return (
		(navigator as Navigator & { standalone?: boolean }).standalone === true
	);
}

function errorName(caught: unknown): string | null {
	if (typeof caught !== "object" || caught === null) return null;
	const name = (caught as { name?: unknown }).name;
	return typeof name === "string" ? name : null;
}

export async function saveBlob(
	blob: Blob,
	filename: string,
	mimeType: string,
): Promise<SaveResult> {
	if (isIosStandalone() && typeof navigator.canShare === "function") {
		const file = new File([blob], filename, { type: mimeType });
		if (navigator.canShare({ files: [file] })) {
			try {
				await navigator.share({ files: [file] });
				return "shared";
			} catch (caught) {
				if (errorName(caught) === "AbortError") return "cancelled";
				// 其他的拒絕（多半是手勢過期的 NotAllowedError）：往下走連結那條路。
			}
		}
	}

	const url = URL.createObjectURL(blob);
	const anchor = document.createElement("a");
	anchor.href = url;
	anchor.download = filename;
	// 掛進文件再點：舊版 Firefox 不理會沒有掛在文件上的連結。
	anchor.style.display = "none";
	document.body.append(anchor);
	anchor.click();
	anchor.remove();
	window.setTimeout(() => URL.revokeObjectURL(url), REVOKE_DELAY_MS);
	return "downloaded";
}
