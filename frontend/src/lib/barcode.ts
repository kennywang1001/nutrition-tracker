/** `cleanBarcodeInput` 回 null 時給人看的話（掃描層的手動輸入、新增食物、食物詳情共用）。 */
export const BARCODE_LENGTH_HINT = "條碼要是 8、12 或 13 位數字";

/** 輸入框、偵測器給的條碼 → 送給後端的字串（掃條碼規格 D3）。只去空白（含全形）與「-」、
 *  看是不是 8／12／13 位 ASCII 數字；不是就 null（不必送一個一定錯的請求）。
 *  **不驗檢查碼**——演算法只在後端一份，後端的 422 訊息照樣顯示。 */
export function cleanBarcodeInput(raw: string): string | null {
	const digits = raw.replace(/[\s-]+/g, "");
	return /^(\d{8}|\d{12}|\d{13})$/.test(digits) ? digits : null;
}
