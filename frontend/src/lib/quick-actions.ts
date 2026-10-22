/** 總覽的快速記錄帶給下一頁的 router state（首頁改版規格 §4）。state 是 unknown：任何頁面都可能 navigate 過來，
 *  history 裡也可能是舊版本存的形狀——不對就當作沒有（同 `plannerHandoffFrom`）。讀一次、清掉 history 的 state
 *  由 `App.tsx` 的 `LogMealRoute`／`WeightRoute` 做。 */

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** 掃條碼：記一餐一打開就開掃描層（D9）。 */
export const SCAN_STATE = { quickScan: true } as const;

export function quickScanFrom(state: unknown): boolean {
	return isRecord(state) && state.quickScan === true;
}

/** 記體重：`/weight` 一打開焦點就在體重欄位（D11）。總覽的快速記錄、沒有體重時的小卡片、「＋」的記體重共用。 */
export const WEIGHT_FORM_STATE = { weightForm: true } as const;

export function weightFormFrom(state: unknown): boolean {
	return isRecord(state) && state.weightForm === true;
}

/** 拍照記的照片（D8）。**`File` 不放進 history**：`history.state` 會被結構化複製（Firefox 有大小上限），重新整理
 *  還會把舊照片帶回來。state 只帶號碼，檔案留在這個模組的記憶體裡、一次只留一張——重新整理（模組重新載入）
 *  就沒有了，跟配餐的交接一樣，刻意。 */
let stash: { id: number; file: File } | null = null;
let nextId = 1;

export function stashQuickPhoto(file: File): { quickPhoto: number } {
	const id = nextId;
	nextId += 1;
	stash = { id, file };
	return { quickPhoto: id };
}

/** 號碼對得上才回檔案：舊的 history（上一頁回到更早的記一餐）帶著舊號碼，換不到後來那一張。
 *  **讀了不清掉**：`useState` 的初值函式在 StrictMode 會被呼叫兩次，清掉的話其中一次拿到 null。
 *  清的時機是 `LogMealRoute` 清 history 的 state 那一刻（`releaseQuickPhoto`）。 */
export function quickPhotoFrom(state: unknown): File | null {
	if (!isRecord(state) || typeof state.quickPhoto !== "number") return null;
	return stash !== null && stash.id === state.quickPhoto ? stash.file : null;
}

/** 放掉暫存的照片（照片已經交給記一餐自己的 state）：不留著一張可能好幾 MB 的檔案。 */
export function releaseQuickPhoto(): void {
	stash = null;
}
