import { useSyncExternalStore } from "react";
import { DESKTOP_MEDIA_QUERY } from "./layout";

// 沒有 matchMedia 的環境（很舊的瀏覽器、沒有裝假實作的測試）當成手機版，
// 不丟錯：手機版是所有寬度都能用的那一種。
function query(): MediaQueryList | null {
	return typeof window.matchMedia === "function"
		? window.matchMedia(DESKTOP_MEDIA_QUERY)
		: null;
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
