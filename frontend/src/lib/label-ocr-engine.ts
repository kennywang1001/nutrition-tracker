import {
	createWorker,
	type ImageLike,
	OEM,
	PSM,
	type Worker,
	type WorkerOptions,
} from "tesseract.js";
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

/** 瀏覽器的 Web Worker（`Worker` 這個名字在這個檔案裡是 Tesseract.js 的）。 */
type WebWorker = InstanceType<typeof globalThis.Worker>;

/** 叫 `createWorker`，同時抓住它建的那一個 Web Worker。
 *
 *  初始化失敗時 `createWorker` 不 settle，Tesseract.js 的 worker 物件拿不到，它開的 Web Worker
 *  （已經下載了 core、可能還在抓語言資料）就一直留著（計畫「Task 3–4 審查後的修正」M2）。7.0.0 的
 *  `src/createWorker.js` 在第一個 await 之前就 `spawnWorker()`（瀏覽器版是 `new Worker(workerPath)`），
 *  所以只在這個**同步**的呼叫裡把全域的 `Worker` 換成一個會記下實例的子類別，呼叫一回來（還沒有
 *  任何 await）就換回去：別的程式碼看不到被換過的 `Worker`。 */
function createWorkerCapturing(options: Partial<WorkerOptions>): {
	creating: Promise<Worker>;
	spawned: WebWorker | null;
} {
	const Native = globalThis.Worker;
	const captured: { worker: WebWorker | null } = { worker: null };
	globalThis.Worker = class extends Native {
		constructor(...args: ConstructorParameters<typeof Native>) {
			super(...args);
			captured.worker = this;
		}
	};
	try {
		return {
			creating: createWorker("chi_tra", OEM.LSTM_ONLY, options),
			spawned: captured.worker,
		};
	} finally {
		globalThis.Worker = Native;
	}
}

/** 圖片 → 字。PSM 6（單一區塊）＋自動轉正（規格 D11）。每次建一個 worker、用完收掉（D14）。
 *
 *  **Tesseract.js 7.0.0 的毛病（規格 D16、寫計畫時實測）**：語言資料抓不到、初始化失敗時，
 *  `createWorker` 的 promise 永遠不 settle，只有 `errorHandler` 會被叫——所以自己跟它、逾時、
 *  中止三個賽跑。沒建好就停下來時，直接收掉它開的 Web Worker（`createWorkerCapturing`）。 */
export async function recognizeText(
	image: Blob,
	signal: AbortSignal,
): Promise<string> {
	signal.throwIfAborted();
	// 照片先讀成 bytes 再交給 Tesseract.js：給它 Blob 的話它自己用 FileReader 讀（一個 task），
	// 那段時間被收掉，它接著對已經是 null 的 worker `postMessage`，變成沒有人接的 rejection。
	// 7.0.0 的 `loadImage` 收 Uint8Array（不是字串、元素、Blob 的照原樣包成 Uint8Array），型別沒寫。
	const bytes = new Uint8Array(await image.arrayBuffer());
	const corePath = (await simd()) ? coreSimdUrl : corePlainUrl;
	// 中止落在上面兩個 await 裡：不要再開一個 Web Worker、下載 core。
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

	let creating: Promise<Worker> | null = null;
	let spawned: WebWorker | null = null;
	let worker: Worker | null = null;
	try {
		({ creating, spawned } = createWorkerCapturing({
			workerPath: workerUrl,
			corePath,
			langPath: new URL(OCR_LANG_PATH, window.location.origin).href,
			cachePath: OCR_CACHE_PATH,
			workerBlobURL: false,
			errorHandler: (error: unknown) => reportFailure(error),
		}));
		worker = await Promise.race([creating, stopped]);
		await Promise.race([
			worker.setParameters({
				tessedit_pageseg_mode: PSM.SINGLE_BLOCK,
				preserve_interword_spaces: "1",
			}),
			stopped,
		]);
		const { data } = await Promise.race([
			worker.recognize(bytes as unknown as ImageLike, { rotateAuto: true }),
			stopped,
		]);
		return data.text;
	} finally {
		window.clearTimeout(timer);
		if (worker !== null) {
			await worker.terminate();
		} else {
			// 沒建好就停了（中止、逾時、初始化失敗）：它開的 Web Worker 現在就收掉（下載、
			// 初始化跟著停，也不會再送訊息過來）。萬一沒抓到，建好了再收。
			spawned?.terminate();
			creating?.then(
				(late) => late.terminate(),
				() => undefined,
			);
		}
	}
}
