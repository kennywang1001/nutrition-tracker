import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	firstProductCode,
	loadDetector,
	PRODUCT_FORMATS,
} from "../src/lib/barcode-detector";
import { createPonyfillDetector } from "../src/lib/barcode-ponyfill";

// `src/test/setup.ts` 把 ponyfill 換成假的（`vi.fn`）；這裡看它有沒有被叫到。
const ponyfill = vi.mocked(createPonyfillDetector);

/** 假的原生 `BarcodeDetector`：記下建構時的 `formats`。 */
function fakeNative(getSupportedFormats: () => Promise<string[]>) {
	const constructed: string[][] = [];
	class FakeBarcodeDetector {
		static getSupportedFormats = getSupportedFormats;
		readonly formats: string[];
		constructor(options: { formats: string[] }) {
			this.formats = options.formats;
			constructed.push(options.formats);
		}
		async detect() {
			return [];
		}
	}
	return { FakeBarcodeDetector, constructed };
}

beforeEach(() => {
	ponyfill.mockClear();
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("loadDetector：原生的優先，沒有就 ponyfill（掃條碼規格 D15、§7.2）", () => {
	it("原生存在、支援 ean_13 → 用原生，formats 只留商品條碼裡支援的", async () => {
		const { FakeBarcodeDetector, constructed } = fakeNative(async () => [
			"ean_13",
			"ean_8",
			"qr_code",
		]);
		vi.stubGlobal("BarcodeDetector", FakeBarcodeDetector);

		const detector = await loadDetector();

		expect(detector).toBeInstanceOf(FakeBarcodeDetector);
		expect(constructed).toEqual([["ean_13", "ean_8"]]);
		expect(ponyfill).not.toHaveBeenCalled();
	});

	it("原生存在但不支援 ean_13 → ponyfill", async () => {
		const { FakeBarcodeDetector, constructed } = fakeNative(async () => [
			"qr_code",
		]);
		vi.stubGlobal("BarcodeDetector", FakeBarcodeDetector);

		const detector = await loadDetector();

		expect(detector).not.toBeInstanceOf(FakeBarcodeDetector);
		expect(constructed).toEqual([]);
		expect(ponyfill).toHaveBeenCalledWith(PRODUCT_FORMATS);
		await expect(detector.detect(new Blob())).resolves.toEqual([]);
	});

	it("原生的 getSupportedFormats() 丟例外 → 當作不支援，ponyfill", async () => {
		const { FakeBarcodeDetector } = fakeNative(async () => {
			throw new Error("no backend");
		});
		vi.stubGlobal("BarcodeDetector", FakeBarcodeDetector);

		const detector = await loadDetector();

		expect(detector).not.toBeInstanceOf(FakeBarcodeDetector);
		expect(ponyfill).toHaveBeenCalledTimes(1);
	});

	it("沒有原生 → ponyfill（setup 的假的：永遠讀不到東西）", async () => {
		// jsdom 本來就沒有；明確設成 undefined，免得哪天 jsdom 加了它這條就不再測這條路。
		vi.stubGlobal("BarcodeDetector", undefined);

		const detector = await loadDetector();

		expect(ponyfill).toHaveBeenCalledWith(PRODUCT_FORMATS);
		await expect(detector.detect(new Blob())).resolves.toEqual([]);
	});
});

describe("loadDetector：ponyfill 的 wasm 載不起來（審查 M1）", () => {
	it("丟出去：掃描層顯示「只剩手動輸入」，不是開著相機一直轉", async () => {
		vi.stubGlobal("BarcodeDetector", undefined);
		ponyfill.mockRejectedValueOnce(new Error("wasm 抓不到"));

		await expect(loadDetector()).rejects.toThrow("wasm 抓不到");
	});
});

describe("firstProductCode：第一個看起來像商品條碼的值", () => {
	it("略過不是商品條碼的結果", () => {
		expect(
			firstProductCode([
				{ rawValue: "https://x", format: "qr_code" },
				{ rawValue: "4710088432094", format: "ean_13" },
			]),
		).toBe("4710088432094");
	});

	it.each([["036000291452"], ["96385074"], ["4710088432094"]])(
		"%s 照收（8、12、13 位）",
		(code) => {
			expect(firstProductCode([{ rawValue: code, format: "x" }])).toBe(code);
		},
	);

	it.each([
		["太短", [{ rawValue: "12345", format: "x" }]],
		[
			"全部不合",
			[
				{ rawValue: "abc", format: "x" },
				{ rawValue: "47100884320941", format: "x" },
			],
		],
		["沒有結果", []],
	])("%s → null", (_label, results) => {
		expect(firstProductCode(results)).toBeNull();
	});
});
