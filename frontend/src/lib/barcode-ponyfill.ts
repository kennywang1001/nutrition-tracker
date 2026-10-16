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
prepareZXingModule({
	overrides: {
		locateFile: (path: string, prefix: string) =>
			path.endsWith(".wasm") ? wasmUrl : prefix + path,
	},
});

export function createPonyfillDetector(
	formats: readonly BarcodeFormat[],
): Detector {
	return new BarcodeDetector({ formats: [...formats] });
}
