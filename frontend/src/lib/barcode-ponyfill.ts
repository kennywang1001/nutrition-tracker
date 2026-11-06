import {
	BarcodeDetector,
	type BarcodeFormat,
	prepareZXingModule,
} from "barcode-detector/ponyfill";
import wasmUrl from "zxing-wasm/reader/zxing_reader.wasm?url";
import type { Detector } from "./barcode-detector";

/** 沒有原生 `BarcodeDetector` 的瀏覽器（iOS、桌機的 Windows／Linux Chrome、Firefox）用的偵測器。
 *
 *  **只能用 `import()` 載入**（`lib/barcode-detector.ts`）：它會把 `barcode-detector` 的 ponyfill
 *  （約 43 KB）與 zxing 的 `.wasm`（1.09 MB）拉進來，主程式不該付這個成本。
 *
 *  `.wasm` 自己服務（規格 D15）：套件預設從 jsDelivr 抓，那等於每個人掃條碼時都告訴第三方一次，
 *  離線也不能用。`?url` 讓 Vite 把它當成一個雜湊過檔名的資源放進 `dist/assets/`。
 *  `zxing-wasm` 在 package.json 裡釘的版本要跟 `barcode-detector` 依賴的完全一樣（3.1.3），
 *  不然這個 URL 指到的是另一份 wasm。 */

/** zxing（emscripten）載入時印的錯誤，最近幾行。串流編譯失敗的原因**只印、不丟**——丟出來的只有
 *  退路（整包抓下來再編譯）那一次的原因。掃描層的「技術細節」要兩個都有：iPhone 上看不到主控台。
 *  不在每次載入前清掉：zxing 記住失敗的那次，之後再載直接拿同一個失敗、不再印。 */
const LOAD_LOG_LINES = 6;
const loadLog: string[] = [];

// 同一個物件：`prepareZXingModule` 用淺比較決定要不要沿用已經載好的模組。
const OVERRIDES = {
	locateFile: (path: string, prefix: string) =>
		path.endsWith(".wasm") ? wasmUrl : prefix + path,
	printErr: (text: string) => {
		console.warn(text);
		loadLog.push(text);
		if (loadLog.length > LOAD_LOG_LINES) loadLog.shift();
	},
};

/** **先真的把 wasm 載起來**（`fireImmediately: true`），才建偵測器（審查 M1）。以前只設定
 *  overrides、第一次 `detect()` 才載：wasm 抓不到時偵測器照樣建起來，每一次 `detect()` 都被
 *  拒絕，迴圈開著相機一直轉。現在載不起來就在這裡丟——`loadDetector` 的呼叫端顯示
 *  `no-detector`（只剩手動輸入）。丟的錯誤後面接著 zxing 印的那幾行。 */
export async function createPonyfillDetector(
	formats: readonly BarcodeFormat[],
): Promise<Detector> {
	try {
		await prepareZXingModule({ overrides: OVERRIDES, fireImmediately: true });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const wrapped = new Error([message, ...loadLog].join("\n"), {
			cause: error,
		});
		if (error instanceof Error) wrapped.name = error.name;
		throw wrapped;
	}
	return new BarcodeDetector({ formats: [...formats] });
}
