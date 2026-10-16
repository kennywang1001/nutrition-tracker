import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	analyzeImage,
	analyzeMealImage,
	analyzeMealText,
	analyzeText,
	describeAnalyzeError,
	readLabel,
	suggestMeal,
} from "../src/api/ai";
import { ApiError } from "../src/api/errors";
import { MAX_PHOTO_BYTES, PhotoTooLargeError } from "../src/api/photos";
import { resetRefreshStateForTests } from "../src/auth/refresh";
import { clearTokens, setTokens } from "../src/auth/store";
import { preparePhoto } from "../src/lib/photo";
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

function sentUrl(fetchMock: ReturnType<typeof mockApi>): string {
	return String(fetchMock.mock.calls[0]?.[0]);
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

	// mockApi 用 includes 比對：`/api/ai/analyze` 這條路由也會接住 `/api/ai/analyze-meal`。
	// 所以下面每一條都另外斷言**實際打的網址**——只給路由分不出打的是哪一支。
	it("文字（單樣）：打的是 /api/ai/analyze，不是多樣的那一支", async () => {
		const fetchMock = mockApi([
			{ method: "POST", path: "/api/ai/analyze", handler: () => json({}) },
		]);

		await analyzeText("一碗牛肉麵");

		expect(sentUrl(fetchMock)).toBe("/api/ai/analyze");
	});

	it("一餐的文字：POST /api/ai/analyze-meal，送 kind=text", async () => {
		const fetchMock = mockApi([
			{
				method: "POST",
				path: "/api/ai/analyze-meal",
				handler: () => json({ description: "便當", items: [] }),
			},
		]);

		const result = await analyzeMealText("雞腿便當");

		expect(sentUrl(fetchMock)).toBe("/api/ai/analyze-meal");
		expect(sentBody(fetchMock)).toEqual({ kind: "text", text: "雞腿便當" });
		expect(result.description).toBe("便當");
	});

	it("一餐的照片：同一套前處理（先擋大小、縮到 1280），送 kind=image 與 base64", async () => {
		vi.mocked(shrinkToLongestEdge).mockClear();
		const fetchMock = mockApi([
			{
				method: "POST",
				path: "/api/ai/analyze-meal",
				handler: () => json({ description: "便當", items: [] }),
			},
		]);
		const file = new File(["fake-jpeg"], "lunch.jpg", { type: "image/jpeg" });

		await analyzeMealImage(file);

		expect(sentUrl(fetchMock)).toBe("/api/ai/analyze-meal");
		expect(sentBody(fetchMock)).toEqual({
			kind: "image",
			image_base64: btoa("fake-jpeg"),
		});
		expect(vi.mocked(shrinkToLongestEdge)).toHaveBeenCalledWith(file, 1280);
	});

	it("一餐的照片太大：送出前就擋，不打網路", async () => {
		const fetchMock = mockApi([]);
		const file = new File(["x"], "big.jpg", { type: "image/jpeg" });
		Object.defineProperty(file, "size", { value: MAX_PHOTO_BYTES + 1 });

		await expect(analyzeMealImage(file)).rejects.toBeInstanceOf(
			PhotoTooLargeError,
		);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe("AI 配一餐（營養素配餐規格 §5）", () => {
	// `/api/ai/suggest-meal` 跟 `/api/ai/analyze…` 互不包含；照樣斷言實際的網址（同上面的理由）。
	it("POST /api/ai/suggest-meal，偏好去掉前後空白", async () => {
		const fetchMock = mockApi([
			{
				method: "POST",
				path: "/api/ai/suggest-meal",
				handler: () => json({ description: "便當", items: [] }),
			},
		]);

		const result = await suggestMeal("  不吃牛 ");

		expect(sentUrl(fetchMock)).toBe("/api/ai/suggest-meal");
		expect(sentBody(fetchMock)).toEqual({ preference: "不吃牛" });
		expect(result.description).toBe("便當");
	});

	it("只有空白的偏好就不帶（body 是空物件）", async () => {
		const fetchMock = mockApi([
			{
				method: "POST",
				path: "/api/ai/suggest-meal",
				handler: () => json({ description: "便當", items: [] }),
			},
		]);

		await suggestMeal("   ");

		expect(String(fetchMock.mock.calls[0]?.[1]?.body)).toBe("{}");
	});

	it.each([
		[422, "NO_KCAL_TARGET", "先設定每日熱量目標，才知道今天還能吃多少"],
		[422, "DAY_ALREADY_FULL", "今天的熱量差不多用完了，沒有可以配的"],
		[
			502,
			"AI_NO_SUGGESTION",
			"AI 這次配不出合適的一餐，換個偏好再試（這一次也算在今天的次數裡）",
		],
	])("describeAnalyzeError：%i %s 顯示後端那句", (status, code, message) => {
		expect(describeAnalyzeError(new ApiError(status, code, message))).toBe(
			message,
		);
	});
});

describe("讀營養標示（掃條碼規格 §8）", () => {
	it("POST /api/ai/read-label，body 只有 image_base64（同一套前處理）", async () => {
		vi.mocked(shrinkToLongestEdge).mockClear();
		const fetchMock = mockApi([
			{
				method: "POST",
				path: "/api/ai/read-label",
				handler: () => json({ analysis_id: 1 }),
			},
		]);
		const file = new File(["fake-jpeg"], "label.jpg", { type: "image/jpeg" });

		await readLabel(file);

		expect(sentUrl(fetchMock)).toBe("/api/ai/read-label");
		expect(sentBody(fetchMock)).toEqual({ image_base64: btoa("fake-jpeg") });
		expect(vi.mocked(shrinkToLongestEdge)).toHaveBeenCalledWith(file, 1280);
	});

	it("照片太大：送出前就擋，不打網路", async () => {
		const fetchMock = mockApi([]);
		const file = new File(["x"], "big.jpg", { type: "image/jpeg" });
		Object.defineProperty(file, "size", { value: MAX_PHOTO_BYTES + 1 });

		await expect(readLabel(file)).rejects.toBeInstanceOf(PhotoTooLargeError);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("502 AI_LABEL_UNREADABLE：原樣顯示後端那一句（不是「再試一次」）", () => {
		const message =
			"AI 讀不出這張營養標示的數字，換一張清楚一點、整個表格都在畫面裡的照片再試（這一次也算在今天的次數裡）";

		expect(
			describeAnalyzeError(new ApiError(502, "AI_LABEL_UNREADABLE", message)),
		).toBe(message);
	});
});

describe("preparePhoto：先擋大小，再縮到 1280", () => {
	it("太大：丟跟今天一樣的 PhotoTooLargeError，不花 CPU 縮圖", async () => {
		vi.mocked(shrinkToLongestEdge).mockClear();
		const file = new File(["x"], "big.jpg", { type: "image/jpeg" });
		Object.defineProperty(file, "size", { value: MAX_PHOTO_BYTES + 1 });

		const result = preparePhoto(file);

		await expect(result).rejects.toBeInstanceOf(PhotoTooLargeError);
		await expect(result).rejects.toThrow(
			"照片超過 10MB 上限，請換一張較小的照片",
		);
		expect(vi.mocked(shrinkToLongestEdge)).not.toHaveBeenCalled();
	});

	it("剛好在上限：縮到 1280，回縮過的那一張", async () => {
		const file = new File(["x"], "edge.jpg", { type: "image/jpeg" });
		Object.defineProperty(file, "size", { value: MAX_PHOTO_BYTES });
		// 縮圖回另一個 File：用 toBe 比同一性（handover §6 第 51 種）。
		const small = new File(["small"], "small.jpg", { type: "image/jpeg" });
		vi.mocked(shrinkToLongestEdge).mockResolvedValueOnce(small);

		await expect(preparePhoto(file)).resolves.toBe(small);
		expect(vi.mocked(shrinkToLongestEdge)).toHaveBeenCalledWith(file, 1280);
	});
});
