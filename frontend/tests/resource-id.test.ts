import { describe, expect, it } from "vitest";
import { parseResourceId } from "../src/lib/resource-id";

describe("parseResourceId：網址的 :id → 資源的 id", () => {
	it.each([
		["1", 1],
		["42", 42],
		["1000000", 1000000],
		// JS 能精確表示的最大整數（2^53 − 1）。
		["9007199254740991", 9007199254740991],
	])("%s 是一個 id", (raw, id) => {
		expect(parseResourceId(raw)).toBe(id);
	});

	it.each([
		// 不是正整數的寫法。
		"abc",
		"",
		"0",
		"-3",
		"+3",
		"1.5",
		"1e3",
		"0x10",
		"01",
		" 1",
		"1 ",
		"1/2",
		// 超過 2^53 − 1：`Number()` 會悄悄四捨五入成**另一個** id（…993 變成 …992）。
		"9007199254740992",
		"9007199254740993",
		// 後端 bigint 的上限（2^63 − 1）與它的下一個：前者後端收，但這裡表示不了；
		// 後者後端回 422（社群審查 M6）。
		"9223372036854775807",
		"9223372036854775808",
		// 長到變成科學記號（`String(1e21)` 是 "1e+21"）或 Infinity 的。
		"999999999999999999999",
		"9".repeat(400),
	])("%s 不是一個 id", (raw) => {
		expect(parseResourceId(raw)).toBeNaN();
	});

	it("沒有這個參數（undefined）也不是", () => {
		expect(parseResourceId(undefined)).toBeNaN();
	});
});
