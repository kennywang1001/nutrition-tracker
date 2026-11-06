import { useMutation } from "@tanstack/react-query";
import { type ChangeEvent, useEffect, useId, useRef, useState } from "react";
import {
	describeAnalyzeError,
	type LabelReadResponse,
	readLabel,
} from "../api/ai";
import {
	describeLabelTextError,
	LABEL_TEXT_MAX_LENGTH,
	type LabelTextParse,
	parseLabelText,
} from "../api/label-text";
import { MAX_PHOTO_BYTES, PhotoTooLargeError } from "../api/photos";
import { formatMacro } from "../lib/decimal";
import {
	isAbortError,
	OcrUnavailableError,
	recognizeLabel,
} from "../lib/label-ocr";
import {
	describeLabelParse,
	fillFromAi,
	fillFromParse,
	hasFoundValues,
	type LabelFill,
} from "../lib/label-text";
import base from "./AiEstimatePanel.module.css";
import { ElapsedSeconds } from "./ElapsedSeconds";
import { HintField } from "./HintField";
import styles from "./LabelReader.module.css";
import { focusStepAfterFileDialog } from "./PhotoHintStep";
import step from "./PhotoHintStep.module.css";
import { PhotoPickerButton } from "./PhotoPickerButton";
import ui from "./ui.module.css";

/** 選好的營養標示照片＋補充說明（說明只給 AI，規格 D2）。 */
type LabelPhoto = { file: File; hint: string };

/** 卡片裡手機辨識的狀態。`partial`：讀不完整時讀到的（「填入讀到的」用）。 */
type Ocr =
	| { status: "running" }
	| { status: "done"; message: string; partial: LabelTextParse | null };

/** 數字填進表單之後，結果那一段說什麼。 */
type Applied = {
	source: "ocr" | "paste" | "ai";
	partial: boolean;
	flagged: boolean;
	servingsPerPackage: string | null;
	remainingToday: number | null;
};

const NOTES: Record<Applied["source"], string> = {
	ocr: "手機辨識的數字，請對照包裝確認",
	paste: "從貼上的文字讀的數字，請對照包裝確認",
	ai: "AI 讀的數字，請對照包裝確認",
};
const PARTIAL_NOTE = "填入了讀到的數字，其餘請自己填";
const AI_LABEL = "改用 AI 讀（用 1 次額度）";
const WRONG_LABEL = "數字不對？改用 AI 讀（用 1 次額度）";
const NOTHING_READ = "手機讀不出這張營養標示";
const DOWNLOAD_NOTE = "第一次使用要下載辨識資料（約 3 MB）";
const PASTE_BUSY = "手機辨識或 AI 讀取中，完成或取消後再貼上";

function appliedFromParse(
	source: "ocr" | "paste",
	parse: LabelTextParse,
	partial: boolean,
): Applied {
	return {
		source,
		partial,
		flagged: parse.consistency?.flagged ?? false,
		servingsPerPackage: parse.servings_per_package,
		remainingToday: null,
	};
}

/** 營養標示的縮圖。物件 URL 換照片與卸載時釋放（同 `PhotoHintStep`）。 */
function LabelPreview({ file }: { file: File }) {
	const [url, setUrl] = useState<string | null>(null);
	useEffect(() => {
		const next = URL.createObjectURL(file);
		setUrl(next);
		return () => URL.revokeObjectURL(next);
	}, [file]);
	return url === null ? null : (
		<img src={url} alt="營養標示的照片" className={step.preview} />
	);
}

type Props = {
	/** 讀到的數字交給表單（`NewFood` 的 `applyLabelFill`）。 */
	onFill: (fill: LabelFill) => void;
	/** 一進來就辨識的照片：記一餐、食物庫的「拍營養標示」帶來的（改名規格 D7）。**只在掛載時讀**——
	 *  跟在這裡選了一張照片走同一段（太大就擋、否則出卡片、自動手機辨識）。 */
	initialPhoto?: File;
};

/** 新增食物的「拍營養標示」與「貼上營養標示文字」（標示 OCR 規格 §3）。
 *
 *  選了照片**自動先在手機上辨識**（不用額度、照片不離開裝置，D1）→ 文字送後端解析 → 完整就填表單；
 *  不完整才給「改用 AI 讀（用 1 次額度）」（同一張照片＋選填的說明打既有的 read-label）與「填入讀到的」。
 *  記一餐、食物庫的「拍營養標示」選好的照片從 `initialPhoto` 進來，掛上就辨識（改名規格 D7）。 */
export function LabelReader({ onFill, initialPhoto }: Props) {
	const pasteId = useId();
	const [pending, setPending] = useState<LabelPhoto | null>(null);
	// 讀完整（或填了讀到的）之後留著，給「數字不對？改用 AI 讀」（D4）。
	const [lastPhoto, setLastPhoto] = useState<LabelPhoto | null>(null);
	const [ocr, setOcr] = useState<Ocr | null>(null);
	const [applied, setApplied] = useState<Applied | null>(null);
	const [pickError, setPickError] = useState<string | null>(null);
	const [pasteOpen, setPasteOpen] = useState(false);
	const [pasteText, setPasteText] = useState("");
	const [pasteMessage, setPasteMessage] = useState<string | null>(null);
	const [pastePartial, setPastePartial] = useState<LabelTextParse | null>(null);

	// 包一層：TanStack Query 會把 mutation 的 context 當第二個參數傳進來（handover §7）。
	const readLabelMutation = useMutation({
		mutationFn: ({ file, hint }: LabelPhoto) => readLabel(file, hint),
	});
	const pasteMutation = useMutation({
		mutationFn: (text: string) => parseLabelText(text),
	});

	// 手機辨識的中止（D15）：取消、換照片、卸載。
	const ocrControllerRef = useRef<AbortController | null>(null);
	useEffect(() => () => ocrControllerRef.current?.abort(), []);

	// 讀完：卡片（或貼上那一塊）收起來，焦點本來在它裡面的話會掉到 body——那時才移到結果那一段。
	// 使用者已經在別的地方（例如辨識中去名稱打字）就不動：搶焦點會打斷輸入、手機會收起鍵盤（審查 I1）。
	// 旗標只在那一次看。
	const resultRef = useRef<HTMLDivElement>(null);
	const focusResultRef = useRef(false);
	useEffect(() => {
		if (focusResultRef.current && resultRef.current !== null) {
			focusResultRef.current = false;
			const active = document.activeElement;
			if (active === null || active === document.body) {
				resultRef.current.focus();
			}
		}
	});
	// 選了照片 → 卡片本身（晚一個 task，handover §7）；取消 → 照片按鈕。
	const inputRef = useRef<HTMLInputElement>(null);
	const pasteToggleRef = useRef<HTMLButtonElement>(null);
	const stepRef = useRef<HTMLElement>(null);
	const focusNextRef = useRef<"step" | "picker" | null>(null);
	useEffect(() => {
		const next = focusNextRef.current;
		if (next === "step" && stepRef.current !== null) {
			focusNextRef.current = null;
			focusStepAfterFileDialog(stepRef);
		} else if (next === "picker" && inputRef.current !== null) {
			focusNextRef.current = null;
			inputRef.current.focus();
		}
	});

	const ocrRunning = ocr?.status === "running";
	const busy = ocrRunning || readLabelMutation.isPending;
	const aiPending = readLabelMutation.isPending;
	// 讀照片的時候（手機辨識或 AI）貼上的不送、不填：照片的結果晚回來會把它蓋掉，而且讀的時候
	// 結果那一段是收起來的，使用者看不到貼上的讀到了什麼（審查 I2）。
	const pasteBlocked =
		busy || pasteMutation.isPending || pasteText.trim() === "";

	function show(fill: LabelFill, next: Applied) {
		onFill(fill);
		setApplied(next);
		focusResultRef.current = true;
	}

	function stopOcr() {
		ocrControllerRef.current?.abort();
		ocrControllerRef.current = null;
	}

	async function runOcr(photo: LabelPhoto) {
		stopOcr();
		const controller = new AbortController();
		ocrControllerRef.current = controller;
		setOcr({ status: "running" });
		let parse: LabelTextParse | null = null;
		let problem: string | null = null;
		try {
			const text = await recognizeLabel(photo.file, controller.signal);
			// 中止之後才回來的字（引擎沒把中止當錯誤丟）：不送後端。
			if (controller.signal.aborted) return;
			// 沒有字就不打後端（空字串是 422）。
			if (text.trim() === "") problem = NOTHING_READ;
			else parse = await parseLabelText(text);
		} catch (error) {
			if (controller.signal.aborted || isAbortError(error)) return;
			problem =
				error instanceof OcrUnavailableError
					? error.message
					: describeLabelTextError(error);
		}
		// 解析在路上時被取消、換了照片、卸載：結果不要了。
		if (controller.signal.aborted) return;
		ocrControllerRef.current = null;
		if (parse?.complete) {
			setPending(null);
			setOcr(null);
			setLastPhoto(photo);
			show(fillFromParse(parse), appliedFromParse("ocr", parse, false));
			return;
		}
		setOcr({
			status: "done",
			message:
				problem ?? (parse === null ? NOTHING_READ : describeLabelParse(parse)),
			partial: parse !== null && hasFoundValues(parse) ? parse : null,
		});
	}

	function startPhoto(file: File) {
		// 太大在選的當下就擋（照片說明規格 D9）；卡片開著時不動它，只說這一張太大（審查 M2）。
		if (file.size > MAX_PHOTO_BYTES) {
			setPickError(new PhotoTooLargeError().message);
			// 焦點回到按鈕（改名規格 D7）：從別的畫面帶著照片進來時，頁面可能停在下面（捲動位置會跟著導頁），
			// 按鈕下面的錯誤在視窗外、焦點又在 BODY。聚焦檔案輸入會把按鈕與緊跟著的錯誤捲進視窗；在頁面上選的也無害。
			focusNextRef.current = "picker";
			return;
		}
		setPickError(null);
		readLabelMutation.reset();
		setApplied(null);
		// 換一張照片：說明留著（多半是同一個包裝、只是拍糊了）。
		const photo = { file, hint: pending?.hint ?? "" };
		setPending(photo);
		focusNextRef.current = "step";
		void runOcr(photo);
	}

	function handlePick(event: ChangeEvent<HTMLInputElement>) {
		const file = event.target.files?.[0] ?? null;
		// 清掉：同一張照片再選一次也要觸發 change。
		event.target.value = "";
		if (file !== null) startPhoto(file);
	}

	// 帶來的照片（改名規格 D7、D8）：掛上就走「選了一張照片」那一段。StrictMode 的「掛、卸、再掛」：
	// 卸載時上面那個 effect 中止辨識，再掛時這裡重新開始（`runOcr` 一開始也會中止前一次），只有最後
	// 那一次的結果會用。ref：只在掛載時讀，之後 prop 變了也不重跑。
	const initialPhotoRef = useRef(initialPhoto);
	// biome-ignore lint/correctness/useExhaustiveDependencies: 只在掛載時讀帶來的照片（startPhoto 每次 render 都是新的函式）
	useEffect(() => {
		const file = initialPhotoRef.current;
		if (file !== undefined) startPhoto(file);
	}, []);

	function startAi(photo: LabelPhoto) {
		setPickError(null);
		// 填表單放在 mutate 的第二個參數：卸載之後不跑（handover §7）。失敗時卡片留著，再按一次就是重試。
		readLabelMutation.mutate(photo, {
			onSuccess: (result: LabelReadResponse) => {
				setPending(null);
				setOcr(null);
				setLastPhoto(null);
				show(fillFromAi(result), {
					source: "ai",
					partial: false,
					flagged: result.consistency.flagged,
					servingsPerPackage: result.servings_per_package,
					remainingToday: result.remaining_today,
				});
			},
		});
	}

	function fillPartial(parse: LabelTextParse, source: "ocr" | "paste") {
		show(fillFromParse(parse), appliedFromParse(source, parse, true));
	}

	function cancelCard() {
		stopOcr();
		setPending(null);
		setOcr(null);
		setPickError(null);
		readLabelMutation.reset();
		focusNextRef.current = "picker";
	}

	function reopenForAi() {
		if (lastPhoto === null) return;
		readLabelMutation.reset();
		setPending(lastPhoto);
		setOcr({
			status: "done",
			message: "用同一張照片改用 AI 讀",
			partial: null,
		});
		focusNextRef.current = "step";
	}

	function submitPaste() {
		if (pasteBlocked) return;
		const text = pasteText.trim();
		setPasteMessage(null);
		setPastePartial(null);
		pasteMutation.mutate(text, {
			onSuccess: (parse) => {
				if (parse.complete) {
					setPasteOpen(false);
					setPasteText("");
					show(fillFromParse(parse), appliedFromParse("paste", parse, false));
					return;
				}
				setPasteMessage(describeLabelParse(parse));
				setPastePartial(hasFoundValues(parse) ? parse : null);
			},
			onError: (error) => setPasteMessage(describeLabelTextError(error)),
		});
	}

	function closePaste() {
		// 送出中收起來：那一次的結果不要了（reset 之後 mutate 的 onSuccess／onError 不會跑）。
		pasteMutation.reset();
		setPasteOpen(false);
		setPasteMessage(null);
		setPastePartial(null);
	}

	return (
		<>
			<div className={styles.labelRow}>
				{/* 要拍，所以帶 capture（掃描層的「從照片讀條碼」不帶——那一顆要能選相簿）。 */}
				<PhotoPickerButton
					id="label-photo"
					label="拍營養標示"
					accept="image/*"
					capture="environment"
					variant="accent"
					disabled={busy}
					inputRef={inputRef}
					onChange={handlePick}
				/>
				<button
					type="button"
					className={base.aiButton}
					aria-expanded={pasteOpen}
					ref={pasteToggleRef}
					aria-controls={pasteId}
					onClick={() => (pasteOpen ? closePaste() : setPasteOpen(true))}
				>
					貼上營養標示文字
				</button>
			</div>
			{pickError !== null && <p role="alert">{pickError}</p>}
			{pending !== null && (
				<section
					ref={stepRef}
					tabIndex={-1}
					aria-label="確認照片"
					className={`${base.card} ${step.step}`}
				>
					<LabelPreview file={pending.file} />
					<p role="status" className={styles.ocrMessage}>
						{ocr?.status === "done" ? ocr.message : ""}
					</p>
					{ocr?.status === "done" && (
						<HintField
							hint={pending.hint}
							onHintChange={(hint) => setPending({ ...pending, hint })}
							placeholder="例：這是每 100 ml、一包 2 份"
							readOnly={aiPending}
						/>
					)}
					<div className={`${base.actions} ${styles.actions}`}>
						{ocr?.status === "done" && (
							<button
								type="button"
								className={base.primary}
								aria-disabled={aiPending}
								onClick={() => {
									if (!aiPending) startAi(pending);
								}}
							>
								{AI_LABEL}
							</button>
						)}
						{ocr?.status === "done" && ocr.partial !== null && (
							<button
								type="button"
								className={base.secondary}
								aria-disabled={aiPending}
								onClick={() => {
									if (aiPending || ocr.partial === null) return;
									const partial = ocr.partial;
									setPending(null);
									setOcr(null);
									setLastPhoto(pending);
									fillPartial(partial, "ocr");
								}}
							>
								填入讀到的
							</button>
						)}
						<button
							type="button"
							className={base.secondary}
							aria-disabled={aiPending}
							onClick={() => {
								if (!aiPending) cancelCard();
							}}
						>
							取消
						</button>
					</div>
				</section>
			)}
			{pasteOpen && (
				<section
					id={pasteId}
					aria-label="貼上營養標示文字"
					className={`${base.card} ${styles.paste}`}
				>
					<label htmlFor={`${pasteId}-text`} className={step.label}>
						營養標示文字
					</label>
					<textarea
						id={`${pasteId}-text`}
						className={styles.pasteText}
						rows={6}
						maxLength={LABEL_TEXT_MAX_LENGTH}
						placeholder="用手機的「原況文字」或 Google Lens 選取營養標示、拷貝，貼在這裡"
						value={pasteText}
						readOnly={pasteMutation.isPending}
						onChange={(event) => setPasteText(event.target.value)}
					/>
					{/* 讀照片的時候說為什麼不能送：live region（狀態一變就念）＋「讀取文字」的 aria-describedby
					    （讀照片中才打開這一塊時，live region 一出現就有字不一定會念；聚焦到按鈕時一定念）。 */}
					<p role="status" id={`${pasteId}-status`}>
						{busy ? PASTE_BUSY : (pasteMessage ?? "")}
					</p>
					<div className={`${base.actions} ${styles.actions}`}>
						<button
							type="button"
							className={base.primary}
							aria-disabled={pasteBlocked}
							aria-describedby={busy ? `${pasteId}-status` : undefined}
							onClick={submitPaste}
						>
							讀取文字
						</button>
						{pastePartial !== null && (
							<button
								type="button"
								className={base.secondary}
								aria-disabled={busy}
								onClick={() => {
									if (busy) return;
									const partial = pastePartial;
									closePaste();
									setPasteText("");
									fillPartial(partial, "paste");
								}}
							>
								填入讀到的
							</button>
						)}
						<button
							type="button"
							className={base.secondary}
							onClick={() => {
								closePaste();
								// 「取消」跟著這一塊消失：焦點回到展開它的那顆。
								pasteToggleRef.current?.focus();
							}}
						>
							取消
						</button>
					</div>
				</section>
			)}
			<div ref={resultRef} tabIndex={-1} className={styles.labelResult}>
				{/* 秒數在 role="status" 外面（照片說明規格 D11）：每秒變一次的字放進 live region，讀屏會每秒念一次。 */}
				<div className={styles.statusRow}>
					<div role="status">
						{ocrRunning && (
							<>
								<p>手機辨識中…</p>
								{/* 看得到的那一行在 .statusRow 底下（秒數才排得在「手機辨識中…」旁邊，審查 M4）；
								    讀屏從這裡念（同 LikeButton 的 aria-hidden＋srOnly）。 */}
								<p className={ui.srOnly}>{DOWNLOAD_NOTE}</p>
							</>
						)}
						{aiPending && <p>AI 讀取中…</p>}
						{applied !== null && !busy && (
							<>
								<p className={styles.labelCheck}>
									{applied.partial ? PARTIAL_NOTE : NOTES[applied.source]}
								</p>
								{applied.flagged && (
									<p className={styles.warning}>
										熱量跟三大營養素算起來對不太上，請特別確認
									</p>
								)}
								{applied.servingsPerPackage !== null && (
									<p>本包裝含 {formatMacro(applied.servingsPerPackage)} 份</p>
								)}
								{applied.remainingToday !== null && (
									<p className={styles.muted}>
										今天還能用 {applied.remainingToday} 次
									</p>
								)}
							</>
						)}
					</div>
					{busy && <ElapsedSeconds className={styles.muted} />}
				</div>
				{ocrRunning && (
					<p className={styles.muted} aria-hidden="true">
						{DOWNLOAD_NOTE}
					</p>
				)}
				{applied?.source === "ocr" &&
					!busy &&
					pending === null &&
					lastPhoto !== null && (
						<button
							type="button"
							className={base.aiButton}
							onClick={reopenForAi}
						>
							{applied.partial ? AI_LABEL : WRONG_LABEL}
						</button>
					)}
				{readLabelMutation.isError && (
					<p role="alert">{describeAnalyzeError(readLabelMutation.error)}</p>
				)}
			</div>
		</>
	);
}
