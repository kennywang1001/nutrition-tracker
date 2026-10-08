import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useIsDesktop } from "../src/lib/use-is-desktop";
import { listenerCount, setDesktop } from "../src/test/media";

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

	it("卸載之後監聽者拿掉了（在掛上去的那個 MediaQueryList 上拿）", () => {
		// 假 matchMedia 每個物件各自記監聽者（src/test/media.ts），在別的物件上
		// removeEventListener 的話，這裡的數字不會回去。
		const before = listenerCount();
		const { unmount } = renderHook(() => useIsDesktop());
		expect(listenerCount()).toBe(before + 1);
		unmount();
		expect(listenerCount()).toBe(before);
	});

	it("整個 app 只建一個 MediaQueryList，不是每次 render 都 matchMedia", () => {
		const spy = vi.spyOn(window, "matchMedia");
		try {
			const first = renderHook(() => useIsDesktop());
			const second = renderHook(() => useIsDesktop());
			first.rerender();
			second.rerender();
			act(() => setDesktop(true));
			expect(first.result.current).toBe(true);
			expect(second.result.current).toBe(true);
			expect(spy).toHaveBeenCalledTimes(1);
		} finally {
			spy.mockRestore();
		}
	});

	it("沒有 matchMedia 的環境：false，不會丟錯", () => {
		// 先切成寬螢幕：如果 hook 拿到的是上一條測試快取下來的假物件（而不是
		// 真的發現沒有 matchMedia），會回 true，這條就紅。
		setDesktop(true);
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
