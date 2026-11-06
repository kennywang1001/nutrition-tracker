import { releaseStashedPhoto, stashedPhoto, stashPhoto } from "./photo-stash";

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

/** 拍照記的照片（D8）：檔案在 `lib/photo-stash` 的暫存裡，state 只帶號碼。 */
export function stashQuickPhoto(file: File): { quickPhoto: number } {
	return { quickPhoto: stashPhoto(file) };
}

/** 號碼對得上才回檔案（見 `stashedPhoto`）。 */
export function quickPhotoFrom(state: unknown): File | null {
	return isRecord(state) ? stashedPhoto(state.quickPhoto) : null;
}

/** 放掉暫存的照片（照片已經交給記一餐自己的 state）。 */
export function releaseQuickPhoto(): void {
	releaseStashedPhoto();
}
