import { DESKTOP_MEDIA_QUERY } from "../lib/layout";

// jsdom 沒有 window.matchMedia。這裡裝一個可以控制的版本：預設不符合
//（＝手機版），所以既有的測試全部照舊；要測電腦版的測試呼叫
// `act(() => setDesktop(true))`，會通知所有 change 監聽者，跟瀏覽器把視窗
// 拉寬時一樣。只有 DESKTOP_MEDIA_QUERY 會符合，其他查詢一律 false。
//
// **每個回傳的物件各自記自己的監聽者**，跟瀏覽器一樣：在 A 物件上掛、在 B
// 物件上拿掉，A 的監聽者還在。共用一個全域集合的話，這種漏掉監聽器的錯在
// 測試裡看不出來（`listenerCount()` 量得到）。
let desktop = false;
const lists: Set<() => void>[] = [];

export function setDesktop(value: boolean): void {
	desktop = value;
	for (const listeners of lists) {
		for (const listener of [...listeners]) listener();
	}
}

/** 每個測試前呼叫：回到手機版，不通知（上一個測試的元件已經卸載了）。 */
export function resetDesktop(): void {
	desktop = false;
}

/** 所有 matchMedia 物件上還掛著的 change 監聽者總數。 */
export function listenerCount(): number {
	return lists.reduce((total, listeners) => total + listeners.size, 0);
}

export function installMatchMedia(): void {
	window.matchMedia = (query: string): MediaQueryList => {
		const listeners = new Set<() => void>();
		lists.push(listeners);
		return {
			get matches() {
				return query === DESKTOP_MEDIA_QUERY && desktop;
			},
			media: query,
			onchange: null,
			addEventListener: (_type: string, listener: () => void) => {
				listeners.add(listener);
			},
			removeEventListener: (_type: string, listener: () => void) => {
				listeners.delete(listener);
			},
			addListener: (listener: () => void) => listeners.add(listener),
			removeListener: (listener: () => void) => listeners.delete(listener),
			dispatchEvent: () => false,
		} as unknown as MediaQueryList;
	};
}
