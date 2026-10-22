import { describe, expect, it } from "vitest";
import {
	quickPhotoFrom,
	quickScanFrom,
	releaseQuickPhoto,
	SCAN_STATE,
	stashQuickPhoto,
	WEIGHT_FORM_STATE,
	weightFormFrom,
} from "../src/lib/quick-actions";

function photo(name: string) {
	return new File(["x"], name, { type: "image/jpeg" });
}

describe("快速記錄的 router state（首頁改版規格 §4）", () => {
	it("掃條碼與記體重：只認自己的形狀", () => {
		expect(quickScanFrom(SCAN_STATE)).toBe(true);
		expect(weightFormFrom(WEIGHT_FORM_STATE)).toBe(true);
		// 兩個形狀互不相認：掃條碼的 state 不會讓 /weight 搶焦點，反之亦然。
		expect(quickScanFrom(WEIGHT_FORM_STATE)).toBe(false);
		expect(weightFormFrom(SCAN_STATE)).toBe(false);
		for (const bad of [
			null,
			undefined,
			"x",
			{},
			{ quickScan: "true" },
			{ weightForm: 1 },
		]) {
			expect(quickScanFrom(bad)).toBe(false);
			expect(weightFormFrom(bad)).toBe(false);
		}
	});

	it("照片：state 只有號碼，換回同一個 File；讀了不清掉（StrictMode 的初值函式跑兩次）", () => {
		const file = photo("a.jpg");
		const state = stashQuickPhoto(file);
		expect(Object.keys(state)).toEqual(["quickPhoto"]);
		expect(typeof state.quickPhoto).toBe("number");
		expect(quickPhotoFrom(state)).toBe(file);
		expect(quickPhotoFrom(state)).toBe(file);
	});

	it("一次只留一張：舊的號碼換不到新的照片", () => {
		const first = stashQuickPhoto(photo("a.jpg"));
		const second = photo("b.jpg");
		const secondState = stashQuickPhoto(second);
		expect(secondState.quickPhoto).not.toBe(first.quickPhoto);
		expect(quickPhotoFrom(first)).toBeNull();
		expect(quickPhotoFrom(secondState)).toBe(second);
	});

	it("release 之後換不到；形狀不對是 null", () => {
		const state = stashQuickPhoto(photo("a.jpg"));
		releaseQuickPhoto();
		expect(quickPhotoFrom(state)).toBeNull();
		stashQuickPhoto(photo("b.jpg"));
		for (const bad of [null, undefined, {}, { quickPhoto: "1" }, SCAN_STATE]) {
			expect(quickPhotoFrom(bad)).toBeNull();
		}
	});
});
