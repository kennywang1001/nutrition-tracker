import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	clearTokens,
	getAccessToken,
	getRefreshToken,
	onLoggedOut,
	refreshTokenWasRemoved,
	setTokens,
} from "../src/auth/store";

beforeEach(() => {
	localStorage.clear();
	clearTokens();
});

describe("token store", () => {
	it("存得進去也讀得回來", () => {
		setTokens({ access_token: "a", refresh_token: "r" });
		expect(getAccessToken()).toBe("a");
		expect(getRefreshToken()).toBe("r");
	});

	it("access token 不進 localStorage", () => {
		// 規格 §6.1：access token 15 分鐘就死，不值得持久化。
		// 這**不是** XSS 防護——正在執行的 XSS 讀得到模組變數；
		// 差別只在它不留存到下一次開啟。
		setTokens({ access_token: "a", refresh_token: "r" });
		expect(JSON.stringify(localStorage)).not.toContain("a");
	});

	it("refresh token 進 localStorage，重新載入後還在", () => {
		setTokens({ access_token: "a", refresh_token: "r" });
		// 模擬重新載入：清掉記憶體狀態，但 localStorage 留著
		clearTokens({ keepStorage: true });
		expect(getRefreshToken()).toBe("r");
		expect(getAccessToken()).toBeNull();
	});

	it("clearTokens 兩邊都清", () => {
		setTokens({ access_token: "a", refresh_token: "r" });
		clearTokens();
		expect(getAccessToken()).toBeNull();
		expect(getRefreshToken()).toBeNull();
		expect(localStorage.getItem("refresh_token")).toBeNull();
	});
});

describe("登出的通知（onLoggedOut）", () => {
	it("clearTokens 真的清掉儲存時通知每一個訂閱者，預設不是強制登出", () => {
		const first = vi.fn();
		const second = vi.fn();
		const stopFirst = onLoggedOut(first);
		const stopSecond = onLoggedOut(second);
		setTokens({ access_token: "a", refresh_token: "r" });

		clearTokens();

		expect(first).toHaveBeenCalledTimes(1);
		expect(first).toHaveBeenCalledWith({ forced: false });
		expect(second).toHaveBeenCalledTimes(1);
		stopFirst();
		stopSecond();
	});

	it("強制登出（換票被拒）帶著 forced: true", () => {
		const listener = vi.fn();
		const stop = onLoggedOut(listener);
		setTokens({ access_token: "a", refresh_token: "r" });

		clearTokens({ forced: true });

		expect(listener).toHaveBeenCalledWith({ forced: true });
		stop();
	});

	it("keepStorage（只丟記憶體裡的 access token）不是登出，不通知", () => {
		const listener = vi.fn();
		const stop = onLoggedOut(listener);
		setTokens({ access_token: "a", refresh_token: "r" });

		clearTokens({ keepStorage: true });

		expect(listener).not.toHaveBeenCalled();
		// 同一個訂閱者接下來收得到真的登出——上面那個「沒被呼叫」不是因為沒訂閱上。
		clearTokens();
		expect(listener).toHaveBeenCalledTimes(1);
		stop();
	});

	it("取消訂閱之後不再收到", () => {
		const listener = vi.fn();
		const stop = onLoggedOut(listener);
		stop();

		clearTokens();

		expect(listener).not.toHaveBeenCalled();
	});

	it("設定新的票不是登出（登入的方向不由 store 通知）", () => {
		const listener = vi.fn();
		const stop = onLoggedOut(listener);

		setTokens({ access_token: "a", refresh_token: "r" });

		expect(listener).not.toHaveBeenCalled();
		stop();
	});
});

describe("另一個分頁的 storage 事件（refreshTokenWasRemoved）", () => {
	function storageEvent(init: StorageEventInit): StorageEvent {
		return new StorageEvent("storage", { storageArea: localStorage, ...init });
	}

	it("refresh token 的鍵被拿掉（newValue 是 null）→ 是", () => {
		expect(
			refreshTokenWasRemoved(
				storageEvent({ key: "refresh_token", oldValue: "r", newValue: null }),
			),
		).toBe(true);
	});

	it("refresh token 被換成另一張（另一個分頁換了票、改了密碼）→ 不是", () => {
		expect(
			refreshTokenWasRemoved(
				storageEvent({ key: "refresh_token", oldValue: "r", newValue: "r2" }),
			),
		).toBe(false);
	});

	it("別的鍵被拿掉（離線快取被清）→ 不是", () => {
		expect(
			refreshTokenWasRemoved(
				storageEvent({
					key: "nutrition-tracker-offline-cache",
					oldValue: "{}",
					newValue: null,
				}),
			),
		).toBe(false);
	});

	it("localStorage.clear()（key 是 null）→ 是：票也在裡面", () => {
		expect(refreshTokenWasRemoved(storageEvent({ key: null }))).toBe(true);
	});

	it("sessionStorage 的事件 → 不是", () => {
		expect(
			refreshTokenWasRemoved(
				new StorageEvent("storage", {
					storageArea: sessionStorage,
					key: "refresh_token",
					newValue: null,
				}),
			),
		).toBe(false);
	});
});
