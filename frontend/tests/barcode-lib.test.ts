import { describe, expect, it } from "vitest";
import { cleanBarcodeInput } from "../src/lib/barcode";

// 全形空白、全形數字用字元碼組——原始碼裡不放看起來跟半形一樣的字（handover §7）。
const IDEOGRAPHIC_SPACE = String.fromCharCode(0x3000);
const FULLWIDTH_DIGITS = "4710088432094"
	.split("")
	.map((digit) => String.fromCharCode(0xff10 + Number(digit)))
	.join("");
const FULLWIDTH_HYPHEN = String.fromCharCode(0xff0d);

describe("cleanBarcodeInput：只去分隔符號、看長度（掃條碼規格 D3）", () => {
	it.each([
		["4710088432094", "4710088432094"],
		[" 4710088-432094 ", "4710088432094"],
		[`${IDEOGRAPHIC_SPACE}4710088 432094${IDEOGRAPHIC_SPACE}`, "4710088432094"],
		["036000291452", "036000291452"],
		["96385074", "96385074"],
		// 不驗檢查碼：演算法只在後端一份，這個交給後端回 422。
		["4710088432096", "4710088432096"],
		// 審查 M6：中文輸入法的全形數字先用 NFKC 折成 ASCII（後端也折，兩邊一致）。
		[FULLWIDTH_DIGITS, "4710088432094"],
		[`4710088${FULLWIDTH_HYPHEN}432094`, "4710088432094"],
	])("%j → %j", (raw, expected) => {
		expect(cleanBarcodeInput(raw)).toBe(expected);
	});

	it.each([
		["12345"],
		["47100884320941"],
		["abc"],
		[""],
		// NFKC 不折其他文字的數字（阿拉伯－印度數字）：照舊不送。
		[`4710088${String.fromCharCode(0x0663)}32094`],
	])("%j → null", (raw) => {
		expect(cleanBarcodeInput(raw)).toBeNull();
	});
});
