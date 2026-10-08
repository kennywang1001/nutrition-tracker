import { useSyncExternalStore } from "react";
import { DESKTOP_MEDIA_QUERY } from "./layout";

// 整個 app 共用一個 MediaQueryList，第一次用到才建。
//
// - getSnapshot 每次 render 都會被呼叫；每次都 matchMedia 的話，每次 render 都
//   建一個新物件。
// - subscribe 掛監聽、退訂拿掉監聽，必須是**同一個物件**——在另一個物件上
//   removeEventListener 什麼都不會發生，監聽器就漏掉了。只有一個物件，這種錯
//   寫不出來（tests/use-is-desktop.test.tsx 也守著，假實作是每個物件各自記監聽者）。
//
// 不在模組載入時就建：測試的假 matchMedia 是 setup 檔裝的，要在那之後才呼叫。
let desktopQuery: MediaQueryList | null = null;

// 沒有 matchMedia 的環境（很舊的瀏覽器、沒有裝假實作的測試）當成手機版，
// 不丟錯：手機版是所有寬度都能用的那一種。這種情況不快取，下次再看一次。
function query(): MediaQueryList | null {
	if (desktopQuery === null && typeof window.matchMedia === "function") {
		desktopQuery = window.matchMedia(DESKTOP_MEDIA_QUERY);
	}
	return desktopQuery;
}

/** 只給測試用：丟掉快取的 MediaQueryList，下一次用到時重新 matchMedia。
 *  src/test/setup.ts 每個測試前呼叫，測「沒有 matchMedia」的那條才不會拿到
 *  上一條測試留下的物件。 */
export function resetDesktopQueryForTests(): void {
	desktopQuery = null;
}

function subscribe(onChange: () => void): () => void {
	const list = query();
	if (list === null) return () => {};
	list.addEventListener("change", onChange);
	return () => list.removeEventListener("change", onChange);
}

function getSnapshot(): boolean {
	return query()?.matches ?? false;
}

/** 寬度 ≥ 1024px（電腦版版面規格 §2）。`useSyncExternalStore`：第一次
 *  render 就是正確的值（不會先畫手機版再跳成電腦版），視窗拉寬拉窄即時更新。 */
export function useIsDesktop(): boolean {
	return useSyncExternalStore(subscribe, getSnapshot, () => false);
}
