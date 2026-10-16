import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BarcodeScanner } from "../src/components/BarcodeScanner";
import type { DetectedBarcode, Detector } from "../src/lib/barcode-detector";

const CODE: DetectedBarcode = { rawValue: "4710088432094", format: "ean_13" };

/** 假的相機：一條 track，記下 `stop` 與 `applyConstraints`。 */
function fakeCamera({ torch = false } = {}) {
	const track = {
		stop: vi.fn(),
		getCapabilities: () => (torch ? { torch: true } : {}),
		applyConstraints: vi.fn(async (_constraints: MediaTrackConstraints) => {}),
	};
	const stream = {
		getTracks: () => [track],
		getVideoTracks: () => [track],
	} as unknown as MediaStream;
	return {
		track,
		stream,
		getUserMedia: vi.fn(async (_constraints: MediaStreamConstraints) => stream),
	};
}

/** 假的偵測器：先回空的（還沒對準），之後一直回條碼。 */
function findsAfterOneMiss(): Detector & { detect: ReturnType<typeof vi.fn> } {
	return {
		detect: vi.fn().mockResolvedValueOnce([]).mockResolvedValue([CODE]),
	};
}

/** 永遠讀不到東西的偵測器（相機開著、一直在掃）。 */
function neverFinds(): Detector & { detect: ReturnType<typeof vi.fn> } {
	return { detect: vi.fn(async () => []) };
}

function renderScanner(
	options: {
		detector?: Detector;
		loadDetector?: () => Promise<Detector>;
		getUserMedia?: (c: MediaStreamConstraints) => Promise<MediaStream>;
	} = {},
) {
	const onCode = vi.fn();
	const onCancel = vi.fn();
	const detector = options.detector ?? neverFinds();
	const result = render(
		<BarcodeScanner
			onCode={onCode}
			onCancel={onCancel}
			loadDetector={options.loadDetector ?? (async () => detector)}
			getUserMedia={options.getUserMedia}
			intervalMs={5}
		/>,
	);
	return { ...result, onCode, onCancel, detector };
}

beforeEach(() => {
	// jsdom 沒有實作 play()。
	HTMLMediaElement.prototype.play = vi.fn(async () => undefined);
});

afterEach(() => {
	// 「換到背景」那一條改過 visibilityState；刪掉自己的屬性，回到 jsdom 原型上的那個。
	Reflect.deleteProperty(document, "visibilityState");
});

describe("BarcodeScanner：相機", () => {
	it("掃到：交出條碼一次、相機停掉；要的是後鏡頭、不要聲音", async () => {
		const camera = fakeCamera();
		const { onCode } = renderScanner({
			detector: findsAfterOneMiss(),
			getUserMedia: camera.getUserMedia,
		});

		expect(screen.getByRole("status")).toHaveTextContent("正在開啟相機…");
		expect(await screen.findByText("把條碼對準框框")).toBeInTheDocument();
		await waitFor(() => expect(onCode).toHaveBeenCalledWith("4710088432094"));
		expect(onCode).toHaveBeenCalledTimes(1);
		expect(camera.track.stop).toHaveBeenCalled();
		expect(camera.getUserMedia).toHaveBeenCalledWith({
			video: { facingMode: { ideal: "environment" } },
			audio: false,
		});
	});

	it("不是商品條碼的結果被略過", async () => {
		const camera = fakeCamera();
		const detector = {
			detect: vi
				.fn()
				.mockResolvedValueOnce([
					{ rawValue: "https://example.com", format: "qr_code" },
				])
				.mockResolvedValue([CODE]),
		};
		const { onCode } = renderScanner({
			detector,
			getUserMedia: camera.getUserMedia,
		});

		await waitFor(() => expect(onCode).toHaveBeenCalled());
		expect(onCode.mock.calls).toEqual([["4710088432094"]]);
	});

	it("「取消」：onCancel、相機停掉", async () => {
		const camera = fakeCamera();
		const { onCancel } = renderScanner({ getUserMedia: camera.getUserMedia });
		await screen.findByText("把條碼對準框框");

		await userEvent.click(screen.getByRole("button", { name: "取消" }));

		expect(onCancel).toHaveBeenCalledTimes(1);
		expect(camera.track.stop).toHaveBeenCalled();
	});

	it("Escape 等於「取消」", async () => {
		const camera = fakeCamera();
		const { onCancel } = renderScanner({ getUserMedia: camera.getUserMedia });
		await screen.findByText("把條碼對準框框");

		await userEvent.keyboard("{Escape}");

		expect(onCancel).toHaveBeenCalledTimes(1);
		expect(camera.track.stop).toHaveBeenCalled();
	});

	it("卸載：相機停掉", async () => {
		const camera = fakeCamera();
		const { unmount } = renderScanner({ getUserMedia: camera.getUserMedia });
		await screen.findByText("把條碼對準框框");
		expect(camera.track.stop).not.toHaveBeenCalled();

		unmount();

		expect(camera.track.stop).toHaveBeenCalled();
	});

	it("卸載之後才拿到的相機：拿到就停掉（相機的燈不能亮著）", async () => {
		const camera = fakeCamera();
		let resolve: (stream: MediaStream) => void = () => {};
		const getUserMedia = vi.fn(
			() =>
				new Promise<MediaStream>((done) => {
					resolve = done;
				}),
		);
		const { unmount } = renderScanner({ getUserMedia });
		await waitFor(() => expect(getUserMedia).toHaveBeenCalled());

		unmount();
		resolve(camera.stream);

		await waitFor(() => expect(camera.track.stop).toHaveBeenCalled());
	});

	it("換到背景：當作取消（相機在背景不該開著）", async () => {
		const camera = fakeCamera();
		const { onCancel } = renderScanner({ getUserMedia: camera.getUserMedia });
		await screen.findByText("把條碼對準框框");

		Object.defineProperty(document, "visibilityState", {
			configurable: true,
			value: "hidden",
		});
		document.dispatchEvent(new Event("visibilitychange"));

		expect(onCancel).toHaveBeenCalledTimes(1);
		expect(camera.track.stop).toHaveBeenCalled();
	});
});

describe("BarcodeScanner：相機不能用的說明", () => {
	it("權限被拒：說明怎麼開，兩條退路都在", async () => {
		const getUserMedia = vi.fn(async () => {
			throw new DOMException("x", "NotAllowedError");
		});
		renderScanner({ getUserMedia });

		expect(
			await screen.findByText(
				"沒有相機權限。到瀏覽器（或手機設定）允許這個網站使用相機，或改用手動輸入、從照片讀。",
			),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "手動輸入條碼" }),
		).toBeInTheDocument();
		expect(screen.getByLabelText("從照片讀條碼")).toBeInTheDocument();
	});

	it("找不到相機（NotFoundError）", async () => {
		const getUserMedia = vi.fn(async () => {
			throw new DOMException("x", "NotFoundError");
		});
		renderScanner({ getUserMedia });

		expect(
			await screen.findByText(
				"找不到可以用的相機。可以手動輸入條碼，或從照片讀。",
			),
		).toBeInTheDocument();
	});

	it("沒有 navigator.mediaDevices（不是安全連線、或 jsdom）：同一句", async () => {
		// 前提：jsdom 真的沒有它——哪天有了，這條就不再測「沒有」的那條路。
		expect(navigator.mediaDevices).toBeUndefined();
		renderScanner();

		expect(
			await screen.findByText(
				"找不到可以用的相機。可以手動輸入條碼，或從照片讀。",
			),
		).toBeInTheDocument();
		expect(screen.getByLabelText("從照片讀條碼")).toBeInTheDocument();
	});

	it("偵測器載不起來：只剩手動輸入（照片也用同一個偵測器），相機停掉", async () => {
		const camera = fakeCamera();
		renderScanner({
			getUserMedia: camera.getUserMedia,
			loadDetector: () => Promise.reject(new Error("wasm 抓不到")),
		});

		expect(
			await screen.findByText("這台裝置不能用相機掃條碼，請手動輸入。"),
		).toBeInTheDocument();
		expect(screen.queryByLabelText("從照片讀條碼")).not.toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "手動輸入條碼" }),
		).toBeInTheDocument();
		expect(camera.track.stop).toHaveBeenCalled();
	});

	it("偵測器載不起來、相機也沒有：說的是偵測器那一句（照片那條也不能用）", async () => {
		renderScanner({
			loadDetector: () => Promise.reject(new Error("wasm 抓不到")),
		});

		expect(
			await screen.findByText("這台裝置不能用相機掃條碼，請手動輸入。"),
		).toBeInTheDocument();
		expect(screen.queryByLabelText("從照片讀條碼")).not.toBeInTheDocument();
	});
});

describe("BarcodeScanner：手電筒", () => {
	it("相機有手電筒：開、關", async () => {
		const camera = fakeCamera({ torch: true });
		renderScanner({ getUserMedia: camera.getUserMedia });

		const on = await screen.findByRole("button", { name: "開手電筒" });
		expect(on).toHaveAttribute("aria-pressed", "false");
		await userEvent.click(on);

		expect(camera.track.applyConstraints).toHaveBeenCalledWith({
			advanced: [{ torch: true }],
		});
		expect(
			await screen.findByRole("button", { name: "關手電筒" }),
		).toHaveAttribute("aria-pressed", "true");
	});

	it("沒有手電筒：沒有這顆", async () => {
		const camera = fakeCamera({ torch: false });
		renderScanner({ getUserMedia: camera.getUserMedia });
		await screen.findByText("把條碼對準框框");

		expect(
			screen.queryByRole("button", { name: "開手電筒" }),
		).not.toBeInTheDocument();
	});
});

describe("BarcodeScanner：手動輸入", () => {
	it("太短不送；去掉「-」之後交出，相機停掉", async () => {
		const camera = fakeCamera();
		const { onCode } = renderScanner({ getUserMedia: camera.getUserMedia });
		await screen.findByText("把條碼對準框框");

		await userEvent.click(screen.getByRole("button", { name: "手動輸入條碼" }));
		const input = screen.getByLabelText("條碼");
		expect(input).toHaveFocus();
		expect(input).toHaveAttribute("inputmode", "numeric");
		expect(input).toHaveAttribute("autocomplete", "off");

		await userEvent.type(input, "123");
		await userEvent.click(screen.getByRole("button", { name: "查詢" }));
		expect(screen.getByRole("alert")).toHaveTextContent(
			"條碼要是 8、12 或 13 位數字",
		);
		expect(onCode).not.toHaveBeenCalled();
		expect(camera.track.stop).not.toHaveBeenCalled();

		await userEvent.clear(input);
		await userEvent.type(input, "4710088-432094");
		await userEvent.click(screen.getByRole("button", { name: "查詢" }));

		expect(onCode.mock.calls).toEqual([["4710088432094"]]);
		expect(camera.track.stop).toHaveBeenCalled();
	});

	it("「手動輸入條碼」是可以收合的（aria-expanded）", async () => {
		renderScanner();
		const toggle = screen.getByRole("button", { name: "手動輸入條碼" });
		expect(toggle).toHaveAttribute("aria-expanded", "false");

		await userEvent.click(toggle);

		expect(toggle).toHaveAttribute("aria-expanded", "true");
		expect(
			screen.getByRole("form", { name: "手動輸入條碼" }),
		).toBeInTheDocument();
	});
});

describe("BarcodeScanner：從照片讀", () => {
	it("偵測器讀那個檔案、交出條碼；選相簿的照片（不帶 capture）", async () => {
		const detector = {
			detect: vi.fn(async (source: ImageBitmapSource) =>
				source instanceof Blob ? [CODE] : [],
			),
		};
		const { onCode } = renderScanner({ detector });
		const input = screen.getByLabelText("從照片讀條碼");
		expect(input).not.toHaveAttribute("capture");
		const file = new File(["jpeg"], "box.jpg", { type: "image/jpeg" });

		await userEvent.upload(input, file);

		await waitFor(() => expect(onCode).toHaveBeenCalledWith("4710088432094"));
		expect(detector.detect).toHaveBeenCalledWith(file);
	});

	it("讀不到：說明，不交出東西；同一張可以再選一次（value 清掉）", async () => {
		const { onCode } = renderScanner();
		const input = screen.getByLabelText<HTMLInputElement>("從照片讀條碼");
		const file = new File(["jpeg"], "box.jpg", { type: "image/jpeg" });

		await userEvent.upload(input, file);

		expect(await screen.findByText("這張照片裡找不到條碼")).toBeInTheDocument();
		expect(onCode).not.toHaveBeenCalled();
		expect(input.value).toBe("");
	});
});

describe("BarcodeScanner：對話框與焦點", () => {
	it("一打開焦點在「取消」；dialog、aria-modal、名稱「掃條碼」", () => {
		renderScanner();

		const dialog = screen.getByRole("dialog", { name: "掃條碼" });
		expect(dialog).toHaveAttribute("aria-modal", "true");
		expect(screen.getByRole("button", { name: "取消" })).toHaveFocus();
	});

	it("Tab 不會跑出對話框：最後一個 → 第一個、第一個 Shift+Tab → 最後一個", async () => {
		renderScanner();
		const cancel = screen.getByRole("button", { name: "取消" });
		const manual = screen.getByRole("button", { name: "手動輸入條碼" });

		await userEvent.tab();
		expect(manual).toHaveFocus();

		await userEvent.tab({ shift: true });
		expect(cancel).toHaveFocus();
	});
});
