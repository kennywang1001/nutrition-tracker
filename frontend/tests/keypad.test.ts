import { describe, expect, it } from "vitest";
import { applyKey, type KeypadKey, normalizeAmount } from "../src/lib/keypad";

function press(keys: readonly KeypadKey[], start = ""): string {
	return keys.reduce<string>((current, key) => applyKey(current, key), start);
}

describe("applyKey", () => {
	it("數字依序接上", () => {
		expect(press(["1", "2", "3"])).toBe("123");
	});

	it("只能有一個小數點", () => {
		expect(press(["1", ".", "5", "."])).toBe("1.5");
	});

	it("小數最多兩位，第三位直接忽略", () => {
		expect(press(["1", ".", "2", "3", "4"])).toBe("1.23");
	});

	it("整數最多 8 位（後端 numeric(10,2)）", () => {
		expect(press(["1", "2", "3", "4", "5", "6", "7", "8", "9"])).toBe(
			"12345678",
		);
	});

	it("整數滿 8 位之後仍然可以打小數", () => {
		expect(press(["1", "2", "3", "4", "5", "6", "7", "8", ".", "9", "9"])).toBe(
			"12345678.99",
		);
	});

	it("開頭的 0 會被取代，不會出現 007", () => {
		expect(press(["0", "0", "7"])).toBe("7");
	});

	it("0.5 是合法的", () => {
		expect(press(["0", ".", "5"])).toBe("0.5");
	});

	it("空字串時按小數點變成 0.", () => {
		expect(press(["."])).toBe("0.");
	});

	it("刪除鍵刪最後一個字元", () => {
		expect(press(["1", "2", "backspace"])).toBe("1");
	});

	it("空字串時按刪除不做事", () => {
		expect(press(["backspace"])).toBe("");
	});
});

describe("normalizeAmount", () => {
	it("去掉結尾的小數點", () => {
		// 鍵盤允許打出 "5."（使用者正要打小數），但送出時不該帶著它。
		expect(normalizeAmount("5.")).toBe("5");
	});

	it("其他情況原樣回傳", () => {
		expect(normalizeAmount("5.5")).toBe("5.5");
		expect(normalizeAmount("")).toBe("");
	});
});
