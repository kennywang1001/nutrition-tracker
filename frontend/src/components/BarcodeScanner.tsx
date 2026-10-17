import {
	type ChangeEvent,
	type FormEvent,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import { createPortal } from "react-dom";
import { BARCODE_LENGTH_HINT, cleanBarcodeInput } from "../lib/barcode";
import type { Detector } from "../lib/barcode-detector";
import { useBarcodeScanner } from "../lib/use-barcode-scanner";
import styles from "./BarcodeScanner.module.css";
import { PhotoPickerButton } from "./PhotoPickerButton";
import ui from "./ui.module.css";

type Props = {
	/** 拿到一個看起來像條碼的字串（相機、照片、手動輸入三條路都整理過）。相機已經停了。 */
	onCode: (code: string) => void;
	onCancel: () => void;
	// 測試注入（正式的呼叫端不傳）
	loadDetector?: () => Promise<Detector>;
	getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
	intervalMs?: number;
};

const STATUS_TEXT = {
	starting: "正在開啟相機…",
	scanning: "把條碼對準框框",
	denied:
		"沒有相機權限。到瀏覽器（或手機設定）允許這個網站使用相機，或改用手動輸入、從照片讀。",
	"no-camera": "找不到可以用的相機。可以手動輸入條碼，或從照片讀。",
	// 照片那條用的是同一個偵測器，所以不叫人「從照片讀」——那顆按鈕這時候也不畫。
	"no-detector": "這台裝置不能用相機掃條碼，請手動輸入。",
	failed: "相機打不開。可以手動輸入條碼，或從照片讀。",
	"detect-failed": "讀不了相機的畫面。可以手動輸入條碼，或從照片讀。",
} as const;

const FOCUSABLE =
	'button:not([disabled]), input:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

/** 全螢幕的掃描層（掃條碼規格 D16、D17、§7.3）。
 *
 *  - 掛到 `body` 底下（同 `ZoomablePhoto`）：呼叫端在卡片裡，祖先只要有一個建立了疊放範圍，
 *    z-index 再大也蓋不過分頁列。
 *  - 「手動輸入條碼」「從照片讀條碼」**一開就有**：相機在 iOS 的已安裝 PWA、桌機、權限被拒時都可能不能用。
 *  - Escape、Tab 的焦點圈住都掛在 `window`：焦點萬一掉到 body（按鈕消失的那一刻），鍵盤照樣關得掉。
 *  - 換到背景只停相機、掃描層留著，回來再開（`useBarcodeScanner`；審查 I3）：Android 選照片時
 *    頁面會變成 hidden，以前當作取消會把選好的照片丟掉。 */
export function BarcodeScanner({
	onCode,
	onCancel,
	loadDetector,
	getUserMedia,
	intervalMs,
}: Props) {
	const videoRef = useRef<HTMLVideoElement>(null);
	const dialogRef = useRef<HTMLDivElement>(null);
	const cancelRef = useRef<HTMLButtonElement>(null);
	const manualInputRef = useRef<HTMLInputElement>(null);
	const [manualOpen, setManualOpen] = useState(false);
	const [manual, setManual] = useState("");
	const [manualError, setManualError] = useState<string | null>(null);
	const [photoError, setPhotoError] = useState<string | null>(null);
	// 照片讀到一半又選一張：兩次都讀到的話 onCode 會被叫兩次。
	const readingRef = useRef(false);

	const { status, setTorch, detectFile, stop } = useBarcodeScanner({
		videoRef,
		onCode,
		loadDetector,
		getUserMedia,
		intervalMs,
	});

	const cancel = useCallback(() => {
		stop();
		onCancel();
	}, [stop, onCancel]);
	// window 的監聽器只掛一次，讀最新的 cancel。
	const cancelLatest = useRef(cancel);
	cancelLatest.current = cancel;

	useEffect(() => {
		cancelRef.current?.focus();
	}, []);

	useEffect(() => {
		function onKeyDown(event: KeyboardEvent) {
			if (event.key === "Escape") {
				event.preventDefault();
				cancelLatest.current();
				return;
			}
			if (event.key !== "Tab") return;
			const focusable = Array.from(
				dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [],
			);
			const first = focusable[0];
			const last = focusable[focusable.length - 1];
			if (first === undefined || last === undefined) return;
			const active = document.activeElement;
			const outside = !dialogRef.current?.contains(active);
			if (event.shiftKey && (active === first || outside)) {
				event.preventDefault();
				last.focus();
			} else if (!event.shiftKey && (active === last || outside)) {
				event.preventDefault();
				first.focus();
			}
		}
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, []);

	useEffect(() => {
		if (manualOpen) manualInputRef.current?.focus();
	}, [manualOpen]);

	function submitManual(event: FormEvent) {
		event.preventDefault();
		const code = cleanBarcodeInput(manual);
		if (code === null) {
			setManualError(BARCODE_LENGTH_HINT);
			return;
		}
		stop();
		onCode(code);
	}

	async function readPhoto(event: ChangeEvent<HTMLInputElement>) {
		const input = event.currentTarget;
		const file = input.files?.[0];
		// 清掉：同一張照片再選一次也要觸發 change。
		input.value = "";
		if (file === undefined || readingRef.current) return;
		readingRef.current = true;
		setPhotoError(null);
		let code: string | null = null;
		try {
			const raw = await detectFile(file);
			code = raw === null ? null : cleanBarcodeInput(raw);
		} catch {
			code = null;
		} finally {
			readingRef.current = false;
		}
		if (code === null) {
			setPhotoError("這張照片裡找不到條碼");
			return;
		}
		stop();
		onCode(code);
	}

	const broken = status.kind === "error";
	const statusText = broken
		? STATUS_TEXT[status.reason]
		: STATUS_TEXT[status.kind];
	const canReadPhoto = !(broken && status.reason === "no-detector");

	return createPortal(
		<div
			ref={dialogRef}
			className={`${ui.screen} ${styles.overlay}`}
			role="dialog"
			aria-modal="true"
			aria-labelledby="barcode-scanner-title"
		>
			<h2 id="barcode-scanner-title" className={styles.title}>
				掃條碼
			</h2>
			{!broken && (
				// 取景框整個是裝飾：狀態列已經用文字說了相機在做什麼。aria-hidden 放在外層的 div
				// （不能聚焦），不放在 video 上——有 controls 的 video 能聚焦，Biome 一律擋。
				<div className={styles.viewfinder} aria-hidden="true">
					{/* iOS：不帶 playsInline 會全螢幕播放、不帶 muted 不自動播。 */}
					<video
						ref={videoRef}
						className={styles.video}
						playsInline
						muted
						autoPlay
					/>
					<div className={styles.frame} />
				</div>
			)}
			<p role="status" className={broken ? styles.problem : styles.status}>
				{statusText}
			</p>
			<div className={styles.actions}>
				{status.kind === "scanning" && status.torch !== null && (
					<button
						type="button"
						aria-pressed={status.torch}
						onClick={() => void setTorch(!status.torch)}
					>
						{status.torch ? "關手電筒" : "開手電筒"}
					</button>
				)}
				<button
					type="button"
					aria-expanded={manualOpen}
					aria-controls="barcode-manual-form"
					onClick={() => setManualOpen((open) => !open)}
				>
					手動輸入條碼
				</button>
				{canReadPhoto && (
					<PhotoPickerButton
						id="barcode-photo"
						label="從照片讀條碼"
						accept="image/*"
						className={styles.photo}
						onChange={(event) => void readPhoto(event)}
					/>
				)}
				<button ref={cancelRef} type="button" onClick={cancel}>
					取消
				</button>
			</div>
			{photoError !== null && (
				<p role="alert" className={styles.problem}>
					{photoError}
				</p>
			)}
			{manualOpen && (
				<form
					id="barcode-manual-form"
					aria-label="手動輸入條碼"
					className={styles.manual}
					onSubmit={submitManual}
				>
					<label htmlFor="barcode-manual">條碼</label>
					<div className={styles.manualRow}>
						<input
							ref={manualInputRef}
							id="barcode-manual"
							inputMode="numeric"
							autoComplete="off"
							enterKeyHint="search"
							value={manual}
							onChange={(event) => {
								setManual(event.target.value);
								setManualError(null);
							}}
						/>
						<button type="submit">查詢</button>
					</div>
					{manualError !== null && <p role="alert">{manualError}</p>}
				</form>
			)}
		</div>,
		document.body,
	);
}
