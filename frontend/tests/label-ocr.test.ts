import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	isAbortError,
	OCR_MAX_EDGE,
	OcrUnavailableError,
	recognizeLabel,
} from "../src/lib/label-ocr";
import { recognizeText } from "../src/lib/label-ocr-engine";
import { shrinkToLongestEdge } from "../src/lib/resize-image";

const PHOTO = new File(["big-jpeg"], "label.jpg", { type: "image/jpeg" });
const SMALL = new File(["small-jpeg"], "label.jpg", { type: "image/jpeg" });

// 縮圖要 canvas（jsdom 沒有）：回一張固定的小圖，看它有沒有交給引擎。
vi.mock("../src/lib/resize-image", () => ({
	shrinkToLongestEdge: vi.fn(async () => SMALL),
}));

// 引擎是 `src/test/setup.ts` 的 mock（`vi.fn`）；這裡拿到的就是那一個。
const engine = vi.mocked(recognizeText);

beforeEach(() => {
	vi.mocked(shrinkToLongestEdge).mockClear();
	engine.mockReset();
	engine.mockResolvedValue("熱量 514 大卡");
});

async function caughtFrom(promise: Promise<unknown>): Promise<unknown> {
	try {
		await promise;
	} catch (error) {
		return error;
	}
	throw new Error("應該要丟例外");
}

describe("recognizeLabel：縮圖、延遲載入引擎（標示 OCR 規格 D11、D18）", () => {
	it("長邊縮到 2000、小的也重畫一次（EXIF 方向）再交給引擎，回辨識出來的字", async () => {
		const controller = new AbortController();

		const text = await recognizeLabel(PHOTO, controller.signal);

		expect(text).toBe("熱量 514 大卡");
		// Tesseract.js 自己解 JPEG 不看 EXIF 的方向：長邊 ≤ 2000 的照片原檔直接給它，手機直拍的
		// （Orientation 6）就是橫躺的。一律經過 canvas（createImageBitmap 會照 EXIF 轉正）。
		expect(vi.mocked(shrinkToLongestEdge)).toHaveBeenCalledWith(PHOTO, 2000, {
			alwaysRedraw: true,
		});
		expect(engine).toHaveBeenCalledWith(SMALL, controller.signal);
		expect(OCR_MAX_EDGE).toBe(2000);
	});

	it("已經中止：丟 AbortError、不叫引擎", async () => {
		const controller = new AbortController();
		controller.abort();

		const caught = await caughtFrom(recognizeLabel(PHOTO, controller.signal));

		expect(isAbortError(caught)).toBe(true);
		expect(engine).not.toHaveBeenCalled();
	});

	it("引擎失敗：包成「這台裝置現在不能用手機辨識」，原因留著", async () => {
		const failure = new TypeError("worker 起不來");
		engine.mockRejectedValue(failure);

		const caught = await caughtFrom(
			recognizeLabel(PHOTO, new AbortController().signal),
		);

		expect(caught).toBeInstanceOf(OcrUnavailableError);
		expect((caught as Error).message).toBe("這台裝置現在不能用手機辨識");
		expect((caught as Error).cause).toBe(failure);
	});

	it("引擎被中止：AbortError 原樣丟出", async () => {
		const aborted = new DOMException("已取消", "AbortError");
		engine.mockRejectedValue(aborted);

		const caught = await caughtFrom(
			recognizeLabel(PHOTO, new AbortController().signal),
		);

		expect(caught).toBe(aborted);
		expect(isAbortError(caught)).toBe(true);
	});
});
