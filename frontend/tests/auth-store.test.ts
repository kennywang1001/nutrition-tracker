import { beforeEach, describe, expect, it } from "vitest";
import {
	clearTokens,
	getAccessToken,
	getRefreshToken,
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
