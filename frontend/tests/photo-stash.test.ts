import { describe, expect, it } from "vitest";
import {
	releaseStashedPhoto,
	stashedPhoto,
	stashPhoto,
} from "../src/lib/photo-stash";

function photo(name: string) {
	return new File(["x"], name, { type: "image/jpeg" });
}

describe("照片暫存（改名規格 D3；同總覽「拍照記」）", () => {
	it("號碼換回同一個 File；讀了不清掉（StrictMode 的初值函式跑兩次）", () => {
		const file = photo("a.jpg");
		const id = stashPhoto(file);
		expect(stashedPhoto(id)).toBe(file);
		expect(stashedPhoto(id)).toBe(file);
	});

	it("一次只留一張：舊的號碼換不到新的照片", () => {
		const first = stashPhoto(photo("a.jpg"));
		const second = photo("b.jpg");
		const secondId = stashPhoto(second);
		expect(secondId).not.toBe(first);
		expect(stashedPhoto(first)).toBeNull();
		expect(stashedPhoto(secondId)).toBe(second);
	});

	it("放掉之後換不到；號碼不是數字就是 null", () => {
		const id = stashPhoto(photo("a.jpg"));
		releaseStashedPhoto();
		expect(stashedPhoto(id)).toBeNull();
		const next = stashPhoto(photo("b.jpg"));
		for (const bad of [null, undefined, String(next), {}, Number.NaN]) {
			expect(stashedPhoto(bad)).toBeNull();
		}
	});
});
