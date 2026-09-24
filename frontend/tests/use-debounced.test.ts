import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDebounced } from "../src/lib/use-debounced";

describe("useDebounced", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	// **一定要還原**，否則假時鐘會污染同檔案（甚至同一輪跑起來的其他檔案）
	// 後續的測試——沒有真的計時器，任何用到 setTimeout/Promise 排程的斷言
	// 都可能卡住或行為怪異。
	afterEach(() => {
		vi.useRealTimers();
	});

	it("一開始回傳的是初始值，不是 undefined", () => {
		const { result } = renderHook(() => useDebounced("a", 300));
		expect(result.current).toBe("a");
	});

	it("值變了之後、時間還沒到之前，回傳的還是舊值", () => {
		const { result, rerender } = renderHook(
			({ value }) => useDebounced(value, 300),
			{ initialProps: { value: "a" } },
		);

		rerender({ value: "b" });
		act(() => {
			vi.advanceTimersByTime(299);
		});

		expect(result.current).toBe("a");
	});

	it("時間到了之後回傳新值", () => {
		const { result, rerender } = renderHook(
			({ value }) => useDebounced(value, 300),
			{ initialProps: { value: "a" } },
		);

		rerender({ value: "b" });
		act(() => {
			vi.advanceTimersByTime(300);
		});

		expect(result.current).toBe("b");
	});

	it("連續改三次只會安定一次——這是 debounce 的定義，不是 throttle", () => {
		// 只驗 1–3 的話，一個「每次都延遲 300ms 但每一次都送出」的 delay
		// 實作也會全綠。這一條要抓的是：三次改動之間的間隔都小於 delay 時，
		// 中間那兩個值（"b"、"c"）永遠不該被回傳過，只有最後的 "d" 會、
		// 而且要等滿一個 delay。
		const { result, rerender } = renderHook(
			({ value }) => useDebounced(value, 300),
			{ initialProps: { value: "a" } },
		);

		rerender({ value: "b" });
		act(() => {
			vi.advanceTimersByTime(100);
		});
		rerender({ value: "c" });
		act(() => {
			vi.advanceTimersByTime(100);
		});
		rerender({ value: "d" });
		act(() => {
			vi.advanceTimersByTime(100);
		});
		// 從第一次改動（"b"）到現在正好過了 300ms，但每一次改動都把計時器
		// 重設過，所以還沒有任何一次安定發生——值仍然是最初的 "a"。
		// 如果這裡讀到 "b" 或 "c"，代表實作是 delay 不是 debounce
		// （沒有在值變動時清掉前一個 timer）。
		expect(result.current).toBe("a");

		act(() => {
			vi.advanceTimersByTime(200);
		});
		expect(result.current).toBe("d");
	});
});
