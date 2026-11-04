import { shrinkToLongestEdge } from "./resize-image";

/** 手機辨識前縮圖的長邊（標示 OCR 規格 D11）：4000 px 的原圖慢一倍、還讀錯字；比這小的不放大。 */
export const OCR_MAX_EDGE = 2000;

/** 手機不能辨識：引擎載不起來、逾時、裝置不支援、縮圖失敗。畫面說這一句、給 AI 按鈕。 */
export class OcrUnavailableError extends Error {
	constructor(cause?: unknown) {
		super("這台裝置現在不能用手機辨識", { cause });
		this.name = "OcrUnavailableError";
	}
}

/** 中止丟的是 `signal.reason`（預設是 `AbortError` 的 `DOMException`）。只看名字（同
 *  `lib/save-file.ts`）、不看 `instanceof`：Vitest 的 jsdom 環境裡 `AbortController` 是 Node 的、
 *  全域的 `DOMException` 是 jsdom 的，前者的 reason 不是後者的實例，後者也不是 Node 的 `Error`。 */
export function isAbortError(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		(error as { name?: unknown }).name === "AbortError"
	);
}

/** 營養標示的照片 → 辨識出來的字（可能是空字串）。**照片不離開裝置**（規格 §7）。
 *
 *  引擎（Tesseract.js、wasm、語言資料）只在這裡 `import()`：主程式不付這個成本（規格 D18）。
 *  中止（`signal`）丟 `AbortError`；其他失敗一律包成 `OcrUnavailableError`。 */
export async function recognizeLabel(
	file: File,
	signal: AbortSignal,
): Promise<string> {
	try {
		// 小的也重畫：Tesseract.js 不看 EXIF 的方向，經過 canvas 才是轉正的（resize-image.ts）。
		const image = await shrinkToLongestEdge(file, OCR_MAX_EDGE, {
			alwaysRedraw: true,
		});
		signal.throwIfAborted();
		const engine = await import("./label-ocr-engine");
		signal.throwIfAborted();
		return await engine.recognizeText(image, signal);
	} catch (error) {
		if (isAbortError(error) || error instanceof OcrUnavailableError)
			throw error;
		throw new OcrUnavailableError(error);
	}
}
