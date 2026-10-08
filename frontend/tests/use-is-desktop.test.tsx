import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useIsDesktop } from "../src/lib/use-is-desktop";
import { setDesktop } from "../src/test/media";

describe("useIsDesktop", () => {
	it("預設（測試環境＝手機版）是 false", () => {
		const { result } = renderHook(() => useIsDesktop());
		expect(result.current).toBe(false);
	});

	it("一開始就是寬螢幕：第一次 render 就是 true", () => {
		setDesktop(true);
		const { result } = renderHook(() => useIsDesktop());
		expect(result.current).toBe(true);
	});

	it("視窗拉寬、再拉窄：跟著變", () => {
		const { result } = renderHook(() => useIsDesktop());
		act(() => setDesktop(true));
		expect(result.current).toBe(true);
		act(() => setDesktop(false));
		expect(result.current).toBe(false);
	});

	it("沒有 matchMedia 的環境：false，不會丟錯", () => {
		const original = window.matchMedia;
		// @ts-expect-error 模擬沒有 matchMedia 的瀏覽器
		delete window.matchMedia;
		try {
			const { result } = renderHook(() => useIsDesktop());
			expect(result.current).toBe(false);
		} finally {
			window.matchMedia = original;
		}
	});
});
