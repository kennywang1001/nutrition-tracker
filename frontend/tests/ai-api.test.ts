import { beforeEach, describe, expect, it, vi } from "vitest";
import { analyzeImage, analyzeText } from "../src/api/ai";
import { MAX_PHOTO_BYTES, PhotoTooLargeError } from "../src/api/photos";
import { resetRefreshStateForTests } from "../src/auth/refresh";
import { clearTokens, setTokens } from "../src/auth/store";
import { shrinkToLongestEdge } from "../src/lib/resize-image";
import { json, mockApi } from "./helpers/mock-api";

// 照片會先經過 shrinkToLongestEdge（canvas，jsdom 沒有）——原樣回傳。
vi.mock("../src/lib/resize-image", () => ({
	shrinkToLongestEdge: vi.fn((file: File) => Promise.resolve(file)),
}));

beforeEach(() => {
	localStorage.clear();
	clearTokens();
	resetRefreshStateForTests();
	vi.restoreAllMocks();
	setTokens({ access_token: "a", refresh_token: "r" });
});

function sentBody(fetchMock: ReturnType<typeof mockApi>): unknown {
	const call = fetchMock.mock.calls[0];
	return JSON.parse(String(call?.[1]?.body));
}

describe("AI 估算的 API", () => {
	it("文字：送 kind=text", async () => {
		const fetchMock = mockApi([
			{
				method: "POST",
				path: "/api/ai/analyze",
				handler: () => json({ name: "x" }),
			},
		]);

		await analyzeText("一碗牛肉麵");

		expect(sentBody(fetchMock)).toEqual({ kind: "text", text: "一碗牛肉麵" });
	});

	it("照片：送 kind=image 與 base64（不含 data: 前綴）", async () => {
		const fetchMock = mockApi([
			{
				method: "POST",
				path: "/api/ai/analyze",
				handler: () => json({ name: "x" }),
			},
		]);
		const file = new File(["fake-jpeg"], "lunch.jpg", { type: "image/jpeg" });

		await analyzeImage(file);

		expect(sentBody(fetchMock)).toEqual({
			kind: "image",
			image_base64: btoa("fake-jpeg"),
		});
		expect(vi.mocked(shrinkToLongestEdge)).toHaveBeenCalledWith(file, 1280);
	});

	it("照片太大：送出前就擋，不打網路", async () => {
		const fetchMock = mockApi([]);
		const file = new File(["x"], "big.jpg", { type: "image/jpeg" });
		Object.defineProperty(file, "size", { value: MAX_PHOTO_BYTES + 1 });

		await expect(analyzeImage(file)).rejects.toBeInstanceOf(PhotoTooLargeError);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
