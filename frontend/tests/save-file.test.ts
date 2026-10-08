import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REVOKE_DELAY_MS, saveBlob } from "../src/lib/save-file";

const CSV = new Blob(["\uFEFF日期,金額\r\n2026-10-09,123.45\r\n"], {
	type: "text/csv;charset=utf-8",
});

type Clicked = { href: string; download: string; attached: boolean };

/** 攔下 `<a>` 的點擊（jsdom 的 click 會去「導覽」到 blob: 網址，那沒有實作），
 *  並記下點的當下連結長什麼樣子。 */
function spyOnAnchorClicks(): Clicked[] {
	const clicked: Clicked[] = [];
	vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
		this: HTMLAnchorElement,
	) {
		clicked.push({
			href: this.href,
			download: this.download,
			attached: this.isConnected,
		});
	});
	return clicked;
}

/** 假裝是 iOS「加入主畫面」的模式，並給它一組分享的 API。 */
function pretendIosStandalone(options: {
	canShare: boolean;
	share: () => Promise<void>;
}) {
	const share = vi.fn(options.share);
	const canShare = vi.fn(() => options.canShare);
	Object.defineProperty(navigator, "standalone", {
		value: true,
		configurable: true,
	});
	Object.defineProperty(navigator, "canShare", {
		value: canShare,
		configurable: true,
	});
	Object.defineProperty(navigator, "share", {
		value: share,
		configurable: true,
	});
	return { share, canShare };
}

beforeEach(() => {
	vi.restoreAllMocks();
	vi.useFakeTimers();
	vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:test-1");
	vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
});

afterEach(() => {
	vi.useRealTimers();
	// jsdom 的 navigator 本來沒有這三個屬性：拿掉，下一條測試從乾淨的狀態開始。
	for (const key of ["standalone", "canShare", "share"]) {
		Reflect.deleteProperty(navigator, key);
	}
});

describe("saveBlob：一般的瀏覽器", () => {
	it("用暫時的 object URL 與 <a download> 下載，連結不留在畫面上，過一陣子才釋放 URL", async () => {
		const clicked = spyOnAnchorClicks();

		const result = await saveBlob(CSV, "expenses-2026-10-09.csv", "text/csv");

		expect(result).toBe("downloaded");
		expect(URL.createObjectURL).toHaveBeenCalledWith(CSV);
		expect(clicked).toEqual([
			{
				href: "blob:test-1",
				download: "expenses-2026-10-09.csv",
				attached: true,
			},
		]);
		expect(document.querySelector("a[download]")).toBeNull();
		// 還沒釋放：馬上釋放會讓某些瀏覽器的下載還沒開始讀就失敗。
		expect(URL.revokeObjectURL).not.toHaveBeenCalled();
		vi.advanceTimersByTime(REVOKE_DELAY_MS - 1);
		expect(URL.revokeObjectURL).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
		expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:test-1");
	});

	it("有分享 API 但不是 iOS 主畫面模式（桌面 Chrome、Android）：照樣下載，不跳分享面板", async () => {
		const clicked = spyOnAnchorClicks();
		const { share, canShare } = pretendIosStandalone({
			canShare: true,
			share: async () => {},
		});
		Reflect.deleteProperty(navigator, "standalone");

		const result = await saveBlob(CSV, "meals.csv", "text/csv");

		expect(result).toBe("downloaded");
		expect(clicked).toHaveLength(1);
		expect(share).not.toHaveBeenCalled();
		expect(canShare).not.toHaveBeenCalled();
	});
});

describe("saveBlob：iOS 主畫面模式", () => {
	it("系統分享得了檔案：把同一份內容包成 File 交給分享面板，不建 object URL、不點連結", async () => {
		const clicked = spyOnAnchorClicks();
		const { share, canShare } = pretendIosStandalone({
			canShare: true,
			share: async () => {},
		});

		const result = await saveBlob(CSV, "meals-2026-10-09.csv", "text/csv");

		expect(result).toBe("shared");
		expect(share).toHaveBeenCalledTimes(1);
		const shared = (share.mock.calls[0] as unknown as [{ files: File[] }])[0]
			.files;
		expect(shared).toHaveLength(1);
		const file = shared[0];
		expect(file).toBeInstanceOf(File);
		expect(file?.name).toBe("meals-2026-10-09.csv");
		expect(file?.type).toBe("text/csv");
		expect(file?.size).toBe(CSV.size);
		// canShare 問的就是要分享的那一個檔案。
		expect(canShare).toHaveBeenCalledWith({ files: [file] });
		expect(clicked).toEqual([]);
		expect(URL.createObjectURL).not.toHaveBeenCalled();
	});

	it("使用者把分享面板關掉（AbortError）：不算錯誤，也不再跳下載", async () => {
		const clicked = spyOnAnchorClicks();
		pretendIosStandalone({
			canShare: true,
			share: () => Promise.reject(new DOMException("取消", "AbortError")),
		});

		await expect(saveBlob(CSV, "meals.csv", "text/csv")).resolves.toBe(
			"cancelled",
		);
		expect(clicked).toEqual([]);
	});

	it("分享被拒絕（手勢過期的 NotAllowedError）：退回連結下載", async () => {
		const clicked = spyOnAnchorClicks();
		pretendIosStandalone({
			canShare: true,
			share: () =>
				Promise.reject(new DOMException("手勢過期", "NotAllowedError")),
		});

		await expect(saveBlob(CSV, "meals.csv", "text/csv")).resolves.toBe(
			"downloaded",
		);
		expect(clicked).toHaveLength(1);
		expect(clicked[0]?.download).toBe("meals.csv");
	});

	it("系統說分享不了檔案：連結下載，不呼叫 share", async () => {
		const clicked = spyOnAnchorClicks();
		const { share } = pretendIosStandalone({
			canShare: false,
			share: async () => {},
		});

		await expect(saveBlob(CSV, "meals.csv", "text/csv")).resolves.toBe(
			"downloaded",
		);
		expect(clicked).toHaveLength(1);
		expect(share).not.toHaveBeenCalled();
	});

	it("舊的 iOS 沒有 canShare：連結下載", async () => {
		const clicked = spyOnAnchorClicks();
		Object.defineProperty(navigator, "standalone", {
			value: true,
			configurable: true,
		});

		await expect(saveBlob(CSV, "meals.csv", "text/csv")).resolves.toBe(
			"downloaded",
		);
		expect(clicked).toHaveLength(1);
	});
});
