import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ElapsedSeconds } from "../src/components/ElapsedSeconds";

describe("ElapsedSeconds", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("從 0 秒開始、每秒加一；讀屏不念（aria-hidden）", () => {
		const { container } = render(<ElapsedSeconds />);
		expect(container.textContent).toBe("0 秒");
		act(() => {
			vi.advanceTimersByTime(1000);
		});
		expect(container.textContent).toBe("1 秒");
		act(() => {
			vi.advanceTimersByTime(2000);
		});
		expect(container.textContent).toBe("3 秒");
		expect(container.firstElementChild).toHaveAttribute("aria-hidden", "true");
		// 不在任何 live region 裡：呼叫端把它放在 role="status" 外面（規格 D11）。
		expect(screen.queryByRole("status")).not.toBeInTheDocument();
	});

	it("卸載就停（不留計時器）", () => {
		const { unmount } = render(<ElapsedSeconds />);
		expect(vi.getTimerCount()).toBe(1);
		unmount();
		expect(vi.getTimerCount()).toBe(0);
	});
});
