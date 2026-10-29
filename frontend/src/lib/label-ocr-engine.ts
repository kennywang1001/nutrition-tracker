import { createWorker, OEM, PSM, type Worker } from "tesseract.js";
import workerUrl from "tesseract.js/dist/worker.min.js?url";
import corePlainUrl from "tesseract.js-core/tesseract-core-lstm.wasm.js?url";
import coreSimdUrl from "tesseract.js-core/tesseract-core-simd-lstm.wasm.js?url";
import { simd } from "wasm-feature-detect";
import { OcrUnavailableError } from "./label-ocr";

/** 手機辨識的引擎（標示 OCR 規格 §6）。**只能用 `import()` 載入**（`lib/label-ocr.ts`）。
 *
 *  三樣東西都從自己的網域來（規格 D12）：worker 與 core 用 `?url`（雜湊檔名，同 zxing 的 wasm），
 *  語言資料在 `vite.config.ts` 的 plugin 放的固定路徑。Tesseract.js 預設會去 jsDelivr 抓，所以
 *  `workerPath`、`corePath`、`langPath` 三個都要給。`workerBlobURL: false`：同源的 worker 直接用
 *  網址，不用 blob 包一層。
 *
 *  core 用單檔版（wasm 以 base64 包在 `.wasm.js` 裡）：分開的 `.wasm` 要靠固定的相對路徑找，跟
 *  雜湊檔名合不來。有 SIMD 用 `simd-lstm`，沒有用 `lstm`（一台裝置只會下載其中一個）。 */

/** 跟 `vite.config.ts` 的 `OCR_LANG_DIR` 同一個（前面多一個 `/`）。 */
export const OCR_LANG_PATH = "/ocr/tessdata-4.0.0_best_int";
/** Tesseract.js 的 IndexedDB 快取的鍵的前綴：帶版本，換資料就是新的鍵（規格 D13）。 */
const OCR_CACHE_PATH = "ocr-tessdata-4.0.0_best_int";
/** 下載＋辨識的上限（規格 D16）。 */
export const OCR_TIMEOUT_MS = 90_000;

/** 圖片 → 字。PSM 6（單一區塊）＋自動轉正（規格 D11）。每次建一個 worker、用完收掉（D14）。
 *
 *  **Tesseract.js 7.0.0 的毛病（規格 D16、寫計畫時實測）**：語言資料抓不到、初始化失敗時，
 *  `createWorker` 的 promise 永遠不 settle，只有 `errorHandler` 會被叫——所以自己跟它、逾時、
 *  中止三個賽跑。失敗時拿不到那個 worker（計畫「與規格的差異」第 3 點）。 */
export async function recognizeText(
	image: Blob,
	signal: AbortSignal,
): Promise<string> {
	signal.throwIfAborted();
	let timer = 0;
	let reportFailure: (error: unknown) => void = () => {};
	const stopped = new Promise<never>((_, reject) => {
		timer = window.setTimeout(
			() => reject(new OcrUnavailableError("逾時")),
			OCR_TIMEOUT_MS,
		);
		signal.addEventListener("abort", () => reject(signal.reason), {
			once: true,
		});
		reportFailure = (error) => reject(new OcrUnavailableError(error));
	});
	// 沒有人在等的時候 reject 也不要變成 unhandled rejection。
	stopped.catch(() => undefined);

	const creating = createWorker("chi_tra", OEM.LSTM_ONLY, {
		workerPath: workerUrl,
		corePath: (await simd()) ? coreSimdUrl : corePlainUrl,
		langPath: new URL(OCR_LANG_PATH, window.location.origin).href,
		cachePath: OCR_CACHE_PATH,
		workerBlobURL: false,
		errorHandler: (error: unknown) => reportFailure(error),
	});
	let worker: Worker | null = null;
	try {
		worker = await Promise.race([creating, stopped]);
		await Promise.race([
			worker.setParameters({
				tessedit_pageseg_mode: PSM.SINGLE_BLOCK,
				preserve_interword_spaces: "1",
			}),
			stopped,
		]);
		const { data } = await Promise.race([
			worker.recognize(image, { rotateAuto: true }),
			stopped,
		]);
		return data.text;
	} finally {
		window.clearTimeout(timer);
		if (worker !== null) {
			await worker.terminate();
		} else {
			// 中止或逾時時 worker 可能還在建：建好了就收掉，不留一個在背景。
			creating.then(
				(late) => late.terminate(),
				() => undefined,
			);
		}
	}
}
