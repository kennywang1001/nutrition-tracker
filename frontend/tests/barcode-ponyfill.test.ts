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

	it("載不起來時，丟出去的錯誤帶著 zxing 載入時印的那幾行（串流編譯失敗的原因只在那裡）", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		zxing.prepareZXingModule.mockImplementation(
			async (options: { overrides: { printErr: (text: string) => void } }) => {
				options.overrides.printErr(
					"wasm streaming compile failed: TypeError: Load failed",
				);
				options.overrides.printErr("falling back to ArrayBuffer instantiation");
				// emscripten 的 abort 丟的是 WebAssembly.RuntimeError（jsdom 沒有，換個名字的 Error）。
				throw Object.assign(
					new Error("Aborted(both async and sync fetching of the wasm failed)"),
					{ name: "RuntimeError" },
				);
			},
		);
		const { createPonyfillDetector } = await realPonyfill();

		const error = await createPonyfillDetector(["ean_13"]).catch(
			(caught: unknown) => caught,
		);

		expect(error).toBeInstanceOf(Error);
		expect((error as Error).name).toBe("RuntimeError");
		expect((error as Error).message).toMatch(
			/^Aborted\(both async and sync fetching of the wasm failed\)\n/,
		);
		expect((error as Error).message).toContain(
			"wasm streaming compile failed: TypeError: Load failed",
		);
		expect((error as Error).message).toContain(
			"falling back to ArrayBuffer instantiation",
		);
		// 主控台照樣看得到（接著 Mac 的 Safari 看的時候）。
		expect(warn).toHaveBeenCalledWith(
			"wasm streaming compile failed: TypeError: Load failed",
		);
		warn.mockRestore();
	});

	it("zxing 記住了失敗、第二次沒有再印：第二次的錯誤照樣帶著第一次印的那幾行", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const failure = new Error("Aborted(boom)");
		let printed = false;
		zxing.prepareZXingModule.mockImplementation(
			async (options: { overrides: { printErr: (text: string) => void } }) => {
				if (!printed) {
					options.overrides.printErr("only printed once");
					printed = true;
				}
				throw failure;
			},
		);
		const { createPonyfillDetector } = await realPonyfill();

		await createPonyfillDetector(["ean_13"]).catch(() => {});
		await expect(createPonyfillDetector(["ean_13"])).rejects.toThrow(
			"only printed once",
		);
		vi.mocked(console.warn).mockRestore();
	});
});
