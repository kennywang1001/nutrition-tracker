import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 引擎的生命週期（標示 OCR 規格 D14–D16）：Tesseract.js 換成一個 `createWorker` 什麼時候 settle 由
// 測試決定的假的（`errorHandler` 也記下來），`wasm-feature-detect` 也換掉；真的 worker 與 wasm
// jsdom 都沒有。假的 `createWorker` 跟 7.0.0 一樣**在呼叫的當下同步** `new Worker(...)`
// （`src/createWorker.js` 在第一個 await 之前叫 `spawnWorker`），所以抓不抓得到那個 Web Worker
// 在這裡測得到。
const h = vi.hoisted(() => {
	type Deferred<T> = {
		promise: Promise<T>;
		resolve: (value: T) => void;
		reject: (error: unknown) => void;
	};
	function deferred<T>(): Deferred<T> {
		let resolve: (value: T) => void = () => {};
		let reject: (error: unknown) => void = () => {};
		const promise = new Promise<T>((res, rej) => {
			resolve = res;
			reject = rej;
		});
		return { promise, resolve, reject };
	}
	function makeWorker() {
		return {
			setParameters: vi.fn(async (_params: Record<string, string>) => ({})),
			recognize: vi.fn(async (_image: unknown, _options: unknown) => ({
				data: { text: "熱量 514 大卡" },
			})),
			terminate: vi.fn(async () => ({})),
		};
	}
	type Options = {
		workerPath: string;
		corePath: string;
		langPath: string;
		cachePath: string;
		workerBlobURL: boolean;
		errorHandler: (error: unknown) => void;
	};
	const state = {
		creating: deferred<ReturnType<typeof makeWorker>>(),
		worker: makeWorker(),
		options: null as Options | null,
		simd: deferred<boolean>(),
	};
	const createWorker = vi.fn(
		(_langs: string, _oem: number, options: Options) => {
			// spawnWorker（同步）：`globalThis.Worker` 是測試的 FakeDomWorker（或引擎包的那一層）。
			new Worker("/assets/worker.min.js");
			state.options = options;
			return state.creating.promise;
		},
	);
	const simd = vi.fn(() => state.simd.promise);
	return { state, deferred, makeWorker, createWorker, simd };
});

vi.unmock("../src/lib/label-ocr-engine");
vi.mock("tesseract.js", () => ({
	createWorker: h.createWorker,
	OEM: { LSTM_ONLY: 1 },
	PSM: { SINGLE_BLOCK: "6" },
}));
vi.mock("wasm-feature-detect", () => ({ simd: h.simd }));

import { OcrUnavailableError } from "../src/lib/label-ocr";
import {
	OCR_LANG_PATH,
	OCR_TIMEOUT_MS,
	recognizeText,
} from "../src/lib/label-ocr-engine";

/** 測試裡的 Web Worker：記下每一個建出來的、`terminate` 是 `vi.fn`。 */
class FakeDomWorker {
	static instances: FakeDomWorker[] = [];
	readonly url: string;
	terminate = vi.fn();
	constructor(url: string) {
		this.url = url;
		FakeDomWorker.instances.push(this);
	}
}

const PHOTO_BYTES = [0xff, 0xd8, 0xff, 0xe0, 1, 2, 3];
const photo = () => new Blob([new Uint8Array(PHOTO_BYTES)]);

/** 不靠計時器（假的計時器下也能用）：讓排著的 microtask 都跑完。 */
async function flush() {
	for (let i = 0; i < 20; i++) await Promise.resolve();
}

function track<T>(promise: Promise<T>) {
	const outcome: {
		state: "pending" | "resolved" | "rejected";
		value?: T;
		error?: unknown;
	} = { state: "pending" };
	promise.then(
		(value) => {
			outcome.state = "resolved";
			outcome.value = value;
		},
		(error: unknown) => {
			outcome.state = "rejected";
			outcome.error = error;
		},
	);
	return outcome;
}

beforeEach(() => {
	h.state.creating = h.deferred();
	h.state.worker = h.makeWorker();
	h.state.options = null;
	h.state.simd = h.deferred();
	h.state.simd.resolve(true);
	h.createWorker.mockClear();
	h.simd.mockClear();
	FakeDomWorker.instances = [];
	vi.stubGlobal("Worker", FakeDomWorker);
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

/** 開始辨識、等到 `createWorker` 被叫（還沒建好）。 */
async function startCreating(signal = new AbortController().signal) {
	const outcome = track(recognizeText(photo(), signal));
	await flush();
	expect(h.createWorker).toHaveBeenCalledTimes(1);
	return outcome;
}

describe("recognizeText：建 worker、辨識、收掉（標示 OCR 規格 D14–D16）", () => {
	it("是真的引擎模組，不是 setup 的 mock", () => {
		expect(vi.isMockFunction(recognizeText)).toBe(false);
		expect(OCR_TIMEOUT_MS).toBe(90_000);
	});

	it("成功：字交回來、照片先讀成 bytes 再給 recognize、worker 收掉一次", async () => {
		const outcome = await startCreating();
		const options = h.state.options;

		expect(options?.workerBlobURL).toBe(false);
		expect(options?.langPath).toBe(
			new URL(OCR_LANG_PATH, window.location.origin).href,
		);
		expect(options?.corePath).toContain("tesseract-core-simd-lstm.wasm.js");
		expect(options?.errorHandler).toBeTypeOf("function");
		h.state.creating.resolve(h.state.worker);
		await flush();

		expect(outcome.state).toBe("resolved");
		expect(outcome.value).toBe("熱量 514 大卡");
		expect(h.state.worker.setParameters).toHaveBeenCalledWith({
			tessedit_pageseg_mode: "6",
			preserve_interword_spaces: "1",
		});
		const [image, recognizeOptions] =
			h.state.worker.recognize.mock.calls[0] ?? [];
		// 不是 Blob：Tesseract.js 讀 Blob 要 FileReader（一個 task），那段時間被收掉的話它的
		// `send` 對 null 的 worker postMessage，變成沒有人接的 rejection。
		expect(image).toBeInstanceOf(Uint8Array);
		expect(Array.from(image as Uint8Array)).toEqual(PHOTO_BYTES);
		expect(recognizeOptions).toEqual({ rotateAuto: true });
		expect(h.state.worker.terminate).toHaveBeenCalledTimes(1);
	});

	it("沒有 SIMD：用不是 SIMD 的 core", async () => {
		h.state.simd = h.deferred();
		h.state.simd.resolve(false);

		await startCreating();

		expect(h.state.options?.corePath).toContain("tesseract-core-lstm.wasm.js");
	});

	it("成功之後不留計時器", async () => {
		vi.useFakeTimers();
		const outcome = await startCreating();
		h.state.creating.resolve(h.state.worker);
		await flush();

		expect(outcome.state).toBe("resolved");
		expect(vi.getTimerCount()).toBe(0);
	});

	it("包 `Worker` 只包建 worker 的那一下：createWorker 一回來就換回原本的", async () => {
		await startCreating();

		expect(globalThis.Worker).toBe(FakeDomWorker);
		expect(FakeDomWorker.instances).toHaveLength(1);
	});

	it("在 simd() 的時候中止：AbortError、不建 worker", async () => {
		h.state.simd = h.deferred();
		const controller = new AbortController();
		const outcome = track(recognizeText(photo(), controller.signal));
		await flush();
		expect(h.simd).toHaveBeenCalledTimes(1);

		controller.abort();
		h.state.simd.resolve(true);
		await flush();

		expect(outcome.state).toBe("rejected");
		expect((outcome.error as Error).name).toBe("AbortError");
		expect(h.createWorker).not.toHaveBeenCalled();
		expect(FakeDomWorker.instances).toHaveLength(0);
	});

	it("建 worker 的時候中止：馬上 AbortError、Web Worker 馬上收掉，建好了也收掉", async () => {
		const controller = new AbortController();
		const outcome = await startCreating(controller.signal);
		const [spawned] = FakeDomWorker.instances;

		controller.abort();
		await flush();

		expect(outcome.state).toBe("rejected");
		expect((outcome.error as Error).name).toBe("AbortError");
		expect(spawned?.terminate).toHaveBeenCalledTimes(1);
		expect(h.state.worker.terminate).not.toHaveBeenCalled();

		h.state.creating.resolve(h.state.worker);
		await flush();

		expect(h.state.worker.terminate).toHaveBeenCalledTimes(1);
	});

	it("辨識的時候中止：馬上 AbortError、worker 收掉", async () => {
		h.state.worker.recognize.mockImplementation(() => new Promise(() => {}));
		const controller = new AbortController();
		const outcome = await startCreating(controller.signal);
		h.state.creating.resolve(h.state.worker);
		await flush();
		expect(h.state.worker.recognize).toHaveBeenCalledTimes(1);

		controller.abort();
		await flush();

		expect(outcome.state).toBe("rejected");
		expect((outcome.error as Error).name).toBe("AbortError");
		expect(h.state.worker.terminate).toHaveBeenCalledTimes(1);
	});

	it("初始化失敗（createWorker 不 settle、只叫 errorHandler）：馬上 OcrUnavailableError、Web Worker 收掉", async () => {
		const outcome = await startCreating();
		const [spawned] = FakeDomWorker.instances;

		h.state.options?.errorHandler("initialization failed");
		await flush();

		expect(outcome.state).toBe("rejected");
		expect(outcome.error).toBeInstanceOf(OcrUnavailableError);
		expect((outcome.error as Error).cause).toBe("initialization failed");
		expect(spawned?.terminate).toHaveBeenCalledTimes(1);
	});

	it("90 秒還沒好：OcrUnavailableError（逾時）、Web Worker 收掉", async () => {
		vi.useFakeTimers();
		const outcome = await startCreating();
		const [spawned] = FakeDomWorker.instances;

		await vi.advanceTimersByTimeAsync(OCR_TIMEOUT_MS - 1);
		expect(outcome.state).toBe("pending");
		await vi.advanceTimersByTimeAsync(1);
		await flush();

		expect(outcome.state).toBe("rejected");
		expect(outcome.error).toBeInstanceOf(OcrUnavailableError);
		expect((outcome.error as Error).cause).toBe("逾時");
		expect(spawned?.terminate).toHaveBeenCalledTimes(1);
	});
});
