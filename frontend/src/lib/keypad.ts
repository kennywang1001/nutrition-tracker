/** 記帳鍵盤的規則（規格 §5.1）。**純函式，不碰畫面**——每一條規則都在
 *  `tests/keypad.test.ts` 有一條測試。
 *
 *  只有數字、小數點、刪除（使用者選的，沒有加減運算）。 */

export type KeypadKey =
	| "0"
	| "1"
	| "2"
	| "3"
	| "4"
	| "5"
	| "6"
	| "7"
	| "8"
	| "9"
	| "."
	| "backspace";

/** 後端 `amount` 是 `numeric(10,2)`：整數最多 8 位、小數最多 2 位。 */
const MAX_INTEGER_DIGITS = 8;
const MAX_FRACTION_DIGITS = 2;

export function applyKey(current: string, key: KeypadKey): string {
	if (key === "backspace") return current.slice(0, -1);

	if (key === ".") {
		if (current.includes(".")) return current;
		return current === "" ? "0." : `${current}.`;
	}

	const [integerPart = "", fractionPart] = current.split(".");
	if (fractionPart !== undefined) {
		return fractionPart.length >= MAX_FRACTION_DIGITS ? current : current + key;
	}
	// 整數部分只有一個 0 時，新的數字取代它——不會出現 "007"。
	if (integerPart === "0") return key;
	if (integerPart.length >= MAX_INTEGER_DIGITS) return current;
	return current + key;
}

/** 送出前的正規化：去掉結尾的小數點（`"5."` → `"5"`）。 */
export function normalizeAmount(value: string): string {
	return value.endsWith(".") ? value.slice(0, -1) : value;
}
