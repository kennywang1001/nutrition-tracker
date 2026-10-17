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
// 同一個物件：`prepareZXingModule` 用淺比較決定要不要沿用已經載好的模組。
const OVERRIDES = {
	locateFile: (path: string, prefix: string) =>
		path.endsWith(".wasm") ? wasmUrl : prefix + path,
};

/** **先真的把 wasm 載起來**（`fireImmediately: true`），才建偵測器（審查 M1）。以前只設定
 *  overrides、第一次 `detect()` 才載：wasm 抓不到時偵測器照樣建起來，每一次 `detect()` 都被
 *  拒絕，迴圈開著相機一直轉。現在載不起來就在這裡丟——`loadDetector` 的呼叫端顯示
 *  `no-detector`（只剩手動輸入）。 */
export async function createPonyfillDetector(
	formats: readonly BarcodeFormat[],
): Promise<Detector> {
	await prepareZXingModule({ overrides: OVERRIDES, fireImmediately: true });
	return new BarcodeDetector({ formats: [...formats] });
}
