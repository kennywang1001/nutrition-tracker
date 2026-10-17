import {
	type RefObject,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import {
	type Detector,
	loadDetector as defaultLoadDetector,
	firstProductCode,
} from "./barcode-detector";

/** 相機的狀態。`torch` 是 null＝這支相機沒有手電筒（按鈕不畫）。 */
export type ScannerStatus =
	| { kind: "starting" }
	| { kind: "scanning"; torch: boolean | null }
	| { kind: "error"; reason: CameraProblem };

/** - `denied`：使用者（或瀏覽器設定）不給相機權限。
 *  - `no-camera`：沒有相機、沒有 `mediaDevices`（不是安全連線也是這個）、約束滿足不了。
 *  - `no-detector`：偵測器載不起來（ponyfill 的 wasm 抓不到）——照片那條也不能用。
 *  - `failed`：其他。 */
export type CameraProblem = "denied" | "no-camera" | "no-detector" | "failed";

type GetUserMedia = (
	constraints: MediaStreamConstraints,
) => Promise<MediaStream>;

export type ScannerOptions = {
	videoRef: RefObject<HTMLVideoElement | null>;
	/** 掃到了。相機在呼叫之前已經停了。 */
	onCode: (code: string) => void;
	/** 測試注入假的；預設 `lib/barcode-detector.ts` 的 `loadDetector`。 */
	loadDetector?: () => Promise<Detector>;
	/** 測試注入假的；預設 `navigator.mediaDevices.getUserMedia`（不存在＝`no-camera`）。 */
	getUserMedia?: GetUserMedia;
	/** 兩次偵測之間的間隔（前一次回來才排下一次）。 */
	intervalMs?: number;
};

const DEFAULT_INTERVAL_MS = 250;

function defaultGetUserMedia(): GetUserMedia | null {
	const devices = globalThis.navigator?.mediaDevices;
	return devices?.getUserMedia ? devices.getUserMedia.bind(devices) : null;
}

function problemOf(error: unknown): CameraProblem {
	const name = error instanceof DOMException ? error.name : "";
	if (name === "NotAllowedError" || name === "SecurityError") return "denied";
	if (
		name === "NotFoundError" ||
		name === "OverconstrainedError" ||
		name === "NotReadableError"
	) {
		return "no-camera";
	}
	return "failed";
}

function stopStream(stream: MediaStream | null): void {
	for (const track of stream?.getTracks() ?? []) track.stop();
}

type TorchCapabilities = MediaTrackCapabilities & { torch?: boolean };

/** 開相機、一直偵測到掃到為止（規格 §7.3）。**卸載、`stop()`、掃到的時候一定停掉每一條 track**——
 *  相機的燈要熄。StrictMode 的「掛、卸、再掛」：第一次的 `getUserMedia` 晚回來時已經是取消的，
 *  拿到的 stream 直接停掉。
 *
 *  `detectFile` 是「從照片讀條碼」：同一個偵測器讀那個檔案（相機壞了也能用，偵測器壞了不能）。 */
export function useBarcodeScanner({
	videoRef,
	onCode,
	loadDetector = defaultLoadDetector,
	getUserMedia,
	intervalMs = DEFAULT_INTERVAL_MS,
}: ScannerOptions) {
	const [status, setStatus] = useState<ScannerStatus>({ kind: "starting" });
	const onCodeRef = useRef(onCode);
	onCodeRef.current = onCode;
	const detectorRef = useRef<Promise<Detector> | null>(null);
	const loadDetectorRef = useRef(loadDetector);
	const streamRef = useRef<MediaStream | null>(null);
	const stopRef = useRef<() => void>(() => {});
	// 換到背景／回來（審查 I3）。`finishedRef`：`stop()` 或掃到之後，回來也不再開相機。
	// `pausedRef`：這一次換到背景時停掉的是一台正在開（或開著）的相機——回來才重開。
	// `statusRef`：visibilitychange 的監聽器只掛一次，要讀現在的狀態。
	const finishedRef = useRef(false);
	const pausedRef = useRef(false);
	const statusRef = useRef(status);
	statusRef.current = status;
	// 每加一就重跑一次開相機的 effect（回到前景）。
	const [session, setSession] = useState(0);

	const detector = useCallback((): Promise<Detector> => {
		detectorRef.current ??= loadDetectorRef.current();
		return detectorRef.current;
	}, []);

	useEffect(() => {
		// `stop()` 或掃到之後回到前景（session 加一）：不再開相機。
		if (finishedRef.current) return;
		let cancelled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		// 回到前景的那一次：狀態列回到「正在開啟相機…」。
		if (session > 0) setStatus({ kind: "starting" });
		const stop = () => {
			cancelled = true;
			if (timer !== undefined) clearTimeout(timer);
			stopStream(streamRef.current);
			streamRef.current = null;
		};
		stopRef.current = stop;

		async function start() {
			const request = getUserMedia ?? defaultGetUserMedia();
			const detectorPromise = detector();
			// 相機那條提早結束（沒有相機、權限被拒）時沒有人 await 偵測器——先接住它，不然被拒絕就是
			// 一個 unhandled rejection。偵測器也載不起來的話「從照片讀」同樣不能用，說明換成只剩手動輸入。
			let cameraFailed = false;
			let detectorBroken = false;
			detectorPromise.catch(() => {
				detectorBroken = true;
				if (cameraFailed && !cancelled) {
					setStatus({ kind: "error", reason: "no-detector" });
				}
			});
			const fail = (reason: CameraProblem) => {
				cameraFailed = true;
				if (cancelled) return;
				setStatus({
					kind: "error",
					reason: detectorBroken ? "no-detector" : reason,
				});
			};

			if (request === null) {
				fail("no-camera");
				return;
			}
			let stream: MediaStream;
			try {
				stream = await request({
					video: { facingMode: { ideal: "environment" } },
					audio: false,
				});
			} catch (error) {
				fail(problemOf(error));
				return;
			}
			if (cancelled) {
				stopStream(stream);
				return;
			}
			streamRef.current = stream;

			let found: Detector;
			try {
				found = await detectorPromise;
			} catch {
				stop();
				setStatus({ kind: "error", reason: "no-detector" });
				return;
			}
			if (cancelled) return;

			const video = videoRef.current;
			if (video === null) return;
			video.srcObject = stream;
			// `autoPlay`＋`muted`＋`playsInline` 通常就會播；play() 的拒絕（例如省電模式）不算失敗，
			// 偵測讀的是目前的畫面，播不了就一直是空的結果。
			await Promise.resolve(video.play()).catch(() => undefined);
			if (cancelled) return;

			const [track] = stream.getVideoTracks();
			const capabilities = track?.getCapabilities?.() as
				| TorchCapabilities
				| undefined;
			setStatus({
				kind: "scanning",
				torch: capabilities?.torch === true ? false : null,
			});

			const tick = async () => {
				if (cancelled) return;
				let code: string | null = null;
				try {
					code = firstProductCode(await found.detect(video));
				} catch {
					// 影片還沒有畫面（InvalidStateError）之類：下一次再試。
				}
				if (cancelled) return;
				if (code !== null) {
					finishedRef.current = true;
					stop();
					onCodeRef.current(code);
					return;
				}
				timer = setTimeout(tick, intervalMs);
			};
			timer = setTimeout(tick, intervalMs);
		}

		void start();
		return stop;
	}, [detector, getUserMedia, intervalMs, videoRef, session]);

	// 換到背景：**只停相機，不關掃描層**（審查 I3）。Android 的檔案選擇器或相機 app 會讓這一頁
	// 變成 hidden——以前這時當作取消，掃描層和它的 <input type=file> 在 change 之前就卸載了，
	// 選好的照片被安靜地丟掉。相機在背景照樣不開著（規格 D16）；回到前景時，換到背景之前
	// 相機是好的（不是錯誤的說明）才重開。
	//
	// 不用「按了從照片讀才不取消」的旗標：選擇器可以用鍵盤打開、可以被取消而沒有 change、
	// 換到別的 app 也是同一個 hidden——旗標要猜什麼時候清，這裡不用猜。
	useEffect(() => {
		function onVisibilityChange() {
			if (document.visibilityState === "hidden") {
				if (statusRef.current.kind === "error") return;
				pausedRef.current = true;
				stopRef.current();
			} else if (pausedRef.current) {
				pausedRef.current = false;
				setSession((value) => value + 1);
			}
		}
		document.addEventListener("visibilitychange", onVisibilityChange);
		return () =>
			document.removeEventListener("visibilitychange", onVisibilityChange);
	}, []);

	const setTorch = useCallback(async (on: boolean) => {
		const [track] = streamRef.current?.getVideoTracks() ?? [];
		if (track === undefined) return;
		try {
			await track.applyConstraints({
				advanced: [{ torch: on } as MediaTrackConstraintSet],
			});
			setStatus((current) =>
				current.kind === "scanning" ? { ...current, torch: on } : current,
			);
		} catch {
			// 有的裝置宣稱有、開不起來：按鈕維持原狀。
		}
	}, []);

	const detectFile = useCallback(
		async (file: Blob): Promise<string | null> =>
			firstProductCode(await (await detector()).detect(file)),
		[detector],
	);

	const stop = useCallback(() => {
		finishedRef.current = true;
		stopRef.current();
	}, []);

	return { status, setTorch, detectFile, stop };
}
