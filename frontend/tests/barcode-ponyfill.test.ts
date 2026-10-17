import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as PonyfillModule from "../src/lib/barcode-ponyfill";

// `src/test/setup.ts` 把 `lib/barcode-ponyfill` 換成假的；這裡要測**真的**那一個，所以用
// `importActual`。它底下的 `barcode-detector/ponyfill`（會去抓 wasm）換成假的。
const zxing = vi.hoisted(() => ({
	prepareZXingModule: vi.fn(),
	constructed: [] as string[][],
}));

vi.mock("barcode-detector/ponyfill", () => ({
	prepareZXingModule: zxing.prepareZXingModule,
	BarcodeDetector: class {
		constructor(options: { formats: string[] }) {
			zxing.constructed.push(options.formats);
		}
		async detect() {
			return [];
		}
	},
}));

async function realPonyfill() {
	return vi.importActual<typeof PonyfillModule>("../src/lib/barcode-ponyfill");
}

beforeEach(() => {
	zxing.prepareZXingModule.mockReset();
	zxing.constructed.length = 0;
});

describe("createPonyfillDetector（審查 M1）", () => {
	it("先真的把 wasm 載起來（fireImmediately）、wasm 指向自己服務的那一份，才建偵測器", async () => {
		zxing.prepareZXingModule.mockResolvedValue({});
		const { createPonyfillDetector } = await realPonyfill();

		const detector = await createPonyfillDetector(["ean_13", "ean_8"]);

		expect(zxing.prepareZXingModule).toHaveBeenCalledTimes(1);
		const [options] = zxing.prepareZXingModule.mock.calls[0] ?? [];
		expect(options.fireImmediately).toBe(true);
		const wasm = options.overrides.locateFile(
			"zxing_reader.wasm",
			"https://cdn/",
		);
		expect(wasm).not.toContain("https://cdn/");
		expect(wasm).toContain("zxing_reader");
		expect(options.overrides.locateFile("x.js", "/p/")).toBe("/p/x.js");
		expect(zxing.constructed).toEqual([["ean_13", "ean_8"]]);
		await expect(detector.detect(new Blob())).resolves.toEqual([]);
	});

	it("wasm 載不起來：丟出去（loadDetector 的呼叫端顯示 no-detector），不建偵測器", async () => {
		// 以前只設定 overrides、不等載入：偵測器照樣建起來，每一次 detect() 都被拒絕，
		// 迴圈開著相機一直轉。
		zxing.prepareZXingModule.mockRejectedValue(new Error("wasm 抓不到"));
		const { createPonyfillDetector } = await realPonyfill();

		await expect(createPonyfillDetector(["ean_13"])).rejects.toThrow(
			"wasm 抓不到",
		);
		expect(zxing.constructed).toEqual([]);
	});
});
