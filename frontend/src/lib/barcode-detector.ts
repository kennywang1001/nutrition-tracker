/** 掃條碼用的偵測器：有原生的 `BarcodeDetector` 就用原生的，沒有就延遲載入 ponyfill（規格 D15、§7.2）。
 *
 *  兩種都是同一個介面（`detect(影像) → [{rawValue, format}]`），呼叫端分不出來。`lib.dom` 沒有這個
 *  API 的型別，這裡只宣告用得到的那一面。 */

export type DetectedBarcode = { rawValue: string; format: string };

export type Detector = {
	detect(source: ImageBitmapSource): Promise<DetectedBarcode[]>;
};

/** 商品條碼的四種格式。少掃幾種格式也比較快、比較不會誤判。 */
export const PRODUCT_FORMATS = ["ean_13", "ean_8", "upc_a", "upc_e"] as const;

type NativeDetectorClass = {
	new (options: { formats: string[] }): Detector;
	getSupportedFormats(): Promise<string[]>;
};

function nativeDetectorClass(): NativeDetectorClass | null {
	const candidate = (globalThis as { BarcodeDetector?: unknown })
		.BarcodeDetector;
	return typeof candidate === "function"
		? (candidate as NativeDetectorClass)
		: null;
}

/** 偵測器。原生的存在、而且支援 EAN-13 → 原生；否則 ponyfill。
 *
 *  ponyfill 的模組載不起來（離線、wasm 抓不到）會丟例外——呼叫端說明「這台裝置不能用相機掃」。
 *  `getSupportedFormats()` 丟例外當作不支援（有的實作在沒有偵測後端時會丟）。 */
export async function loadDetector(): Promise<Detector> {
	const Native = nativeDetectorClass();
	if (Native !== null) {
		const supported = await Native.getSupportedFormats().catch(
			() => [] as string[],
		);
		if (supported.includes("ean_13")) {
			return new Native({
				formats: PRODUCT_FORMATS.filter((format) => supported.includes(format)),
			});
		}
	}
	const { createPonyfillDetector } = await import("./barcode-ponyfill");
	// 會等 wasm 真的載起來（審查 M1）：載不起來在這裡丟，不是之後每一次 detect() 才丟。
	return await createPonyfillDetector(PRODUCT_FORMATS);
}

/** 偵測結果裡第一個「看起來像商品條碼」的值（8／12／13 位數字）。檢查碼不在這裡驗（規格 D3）。 */
export function firstProductCode(
	results: readonly DetectedBarcode[],
): string | null {
	for (const result of results) {
		if (/^(\d{8}|\d{12}|\d{13})$/.test(result.rawValue)) return result.rawValue;
	}
	return null;
}
