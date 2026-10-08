import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
	type ChangeEvent,
	type FormEvent,
	useEffect,
	useId,
	useRef,
	useState,
} from "react";
import { type AnalyzeResponse, analyzeImage, analyzeText } from "../api/ai";
import { apiFetch } from "../api/client";
import { ApiError, describeFieldErrors } from "../api/errors";
import { type Food, searchFoods } from "../api/foods";
import { describePhotoUploadError, PhotoTooLargeError } from "../api/photos";
import { queryKeys } from "../api/queries";
import {
	type AiFoodBody,
	confirmedFoodRequest,
	draftFromEstimate,
	type EstimateDraft,
	editedFoodRequest,
	findSameNameFood,
} from "../lib/ai-food";
import { formatMacro } from "../lib/decimal";
import styles from "./AiEstimatePanel.module.css";
import { PhotoPickerButton } from "./PhotoPickerButton";

type AnalyzeInput =
	| { kind: "text"; text: string }
	| { kind: "image"; file: File };

type Props = {
	/** 文字估算要用的字（記一餐是搜尋框的字，新增食物是「描述這個食物」）。
	 *  trim 之後是空字串時只顯示拍照估算。 */
	text: string;
	/** 交回一個可以用的食物。`image` 是估算用的照片（文字估算是 null）——
	 *  記一餐用它當這一餐的照片（AI 估算前端規格 §5.1）。 */
	onFoodReady: (food: Food, source: { image: File | null }) => void;
	/** 文字估算按鈕的字。 */
	textButtonLabel?: (text: string) => string;
};

/** 同名檢查搜尋的筆數：搜尋是子字串比對、依名稱排序，短的名稱（「飯」）會
 *  對到很多筆，後端預設的 50 筆可能排不到完全同名的那一筆。用後端的上限。 */
const SAME_NAME_SEARCH_LIMIT = 200;

function defaultTextButtonLabel(text: string): string {
	return `用 AI 估算「${text}」`;
}

function describeAnalyzeError(error: unknown): string {
	if (error instanceof PhotoTooLargeError) return error.message;
	if (error instanceof ApiError) {
		switch (error.code) {
			case "AI_DAILY_LIMIT":
				// 後端的訊息含「今天用了 N/20」。
				return error.message;
			case "AI_NOT_CONFIGURED":
				// 後端的訊息說缺什麼（「AI 分析未設定：缺 GEMINI_API_KEY」），
				// 部署手冊叫操作者照著它補。
				return error.message;
			case "AI_MISCONFIGURED":
			case "AI_UPSTREAM_ERROR":
				// 後端把供應商的錯誤分成兩類（AI 與編輯畫面的收尾規格 §2 第 2 項）：
				// 「設定有問題，請管理員檢查」與「暫時無法使用，請稍後再試」——
				// 該做的事不同，通用的「再試一次」對前者是錯的指示。
				return error.message;
			case "AI_BAD_RESPONSE":
				return "AI 這次的回答看不懂，可以再試一次";
			case "PHOTO_TOO_LARGE":
			case "INVALID_PHOTO":
				return describePhotoUploadError(error);
		}
	}
	return "AI 估算失敗，請再試一次";
}

function describeSaveError(error: unknown): string {
	if (error instanceof ApiError && error.code === "FOOD_EXISTS") {
		return error.message;
	}
	if (error instanceof ApiError && error.code === "VALIDATION_ERROR") {
		return describeFieldErrors(error).join("；");
	}
	return "存成食物失敗，請再試一次";
}

/** 從文字或照片估算一份的營養素，確認或修改後存成自己的食物，交回給所在
 *  的畫面（AI 估算前端規格 §4）。記一餐、新增食物、編輯這一餐的「加一項」共用。
 *
 *  **存之前先查同名**（AI 與編輯畫面的收尾規格 §2 第 3 項）：看得到的食物裡
 *  有名稱完全相同的，先問「用食物庫的」還是「還是用 AI 的數字建一個」——
 *  不然 AI 存出的私人食物會跟公開的同名，之後文字估算命中食物庫時優先回
 *  自己那一筆，等於 AI 的數字蓋過公開的。
 *
 *  **不顯示 `confidence`**：那是模型自己說的，不是量出來的（P2 規格 §4.1）。
 *  畫面上的可靠度訊號是 `consistency`——算得出來的那個。 */
export function AiEstimatePanel({
	text,
	onFoodReady,
	textButtonLabel = defaultTextButtonLabel,
}: Props) {
	const queryClient = useQueryClient();
	const id = useId();
	const photoInputId = `${id}-photo`;
	const trimmed = text.trim();

	const [estimate, setEstimate] = useState<AnalyzeResponse | null>(null);
	// 估算用的照片——確認之後跟食物一起交回。
	const [image, setImage] = useState<File | null>(null);
	// null＝看結果卡片；有值＝修改模式。
	const [draft, setDraft] = useState<EstimateDraft | null>(null);
	const [formError, setFormError] = useState<string | null>(null);
	// 存的時候撞名（409 FOOD_EXISTS 附的 food_id）。
	const [existingFoodId, setExistingFoodId] = useState<number | null>(null);
	// 這一次畫面上已經知道 AI 沒設定：只停用拍照（一定要 AI）。文字估算仍可按——
	// 後端先查食物庫，命中就不用 AI。
	const [aiUnavailable, setAiUnavailable] = useState(false);
	// 存之前在看得到的食物裡找到同名的（規格 §2 第 3 項）：先問要用食物庫的，
	// 還是照樣用 AI 的數字建一個。`body` 是被攔下來的那一次要存的內容。
	const [sameName, setSameName] = useState<{
		food: Food;
		body: AiFoodBody;
	} | null>(null);

	// 結果卡片 ↔ 修改表單切換時，按下去的那顆按鈕會消失、焦點掉到 body。
	// 切到表單 → 焦點到第一個欄位；切回卡片 → 焦點到卡片的標題（規格 §2
	// 第 4 項）。只在切換那一次移（旗標），不是每次 render——剛估算完不搶焦點。
	const focusNextRef = useRef<"form" | "card" | null>(null);
	const nameInputRef = useRef<HTMLInputElement>(null);
	const cardHeadingRef = useRef<HTMLHeadingElement>(null);
	useEffect(() => {
		const target =
			focusNextRef.current === "form"
				? nameInputRef.current
				: focusNextRef.current === "card"
					? cardHeadingRef.current
					: null;
		if (target !== null) {
			focusNextRef.current = null;
			target.focus();
		}
	});

	// 問同名的時候，「確認」那顆按鈕被換成提問（卡片），或「存成食物」剛按下去、
	// 停用過（表單）——焦點會掉到 body。移到提問的第一顆按鈕「用食物庫的」，鍵盤
	// 與讀屏的使用者才知道畫面在等他回答。依 `sameName` 這個物件：每問一次移一次。
	const useLibraryButtonRef = useRef<HTMLButtonElement>(null);
	useEffect(() => {
		if (sameName !== null) useLibraryButtonRef.current?.focus();
	}, [sameName]);

	function clearResult() {
		setEstimate(null);
		setImage(null);
		setDraft(null);
		setFormError(null);
		setExistingFoodId(null);
		setSameName(null);
		// 舊的存檔／讀取失敗訊息不能跟到新的結果卡片上。
		save.reset();
		pickExisting.reset();
		lookup.reset();
	}

	const analyze = useMutation({
		mutationFn: (input: AnalyzeInput) =>
			input.kind === "text"
				? analyzeText(input.text)
				: analyzeImage(input.file),
		onMutate: () => clearResult(),
		onSuccess: (result, input) => {
			setEstimate(result);
			setImage(input.kind === "image" ? input.file : null);
		},
		onError: (error) => {
			if (error instanceof ApiError && error.code === "AI_NOT_CONFIGURED") {
				setAiUnavailable(true);
			}
		},
	});

	function finish(food: Food) {
		const used = image;
		clearResult();
		analyze.reset();
		onFoodReady(food, { image: used });
	}

	const save = useMutation({
		mutationFn: (body: AiFoodBody) =>
			apiFetch<Food>("/api/foods", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			}),
		// 這裡只放「不論畫面還在不在都該做」的事。交回食物（`finish`）放在每次呼叫
		// 的 `mutate(…, { onSuccess })`：TanStack v5 在元件卸載後不會跑那一種，
		// 才不會在使用者離開畫面之後才呼叫 `onFoodReady`（例如 NewFood 會跳頁）。
		onSuccess: () => {
			// 新食物要出現在食物庫與之後的搜尋裡。
			queryClient.invalidateQueries({ queryKey: queryKeys.foodSearchAll });
		},
		onError: (error) => {
			if (error instanceof ApiError && error.code === "FOOD_EXISTS") {
				const id = error.details.food_id;
				if (typeof id === "number") setExistingFoodId(id);
			}
		},
	});

	const pickExisting = useMutation({
		mutationFn: (foodId: number) => apiFetch<Food>(`/api/foods/${foodId}`),
	});

	// 存之前先用要存的名稱查一次看得到的食物（公開的＋自己的）。
	const lookup = useMutation({
		mutationFn: async (name: string) =>
			findSameNameFood(
				await searchFoods(name.trim(), "all", SAME_NAME_SEARCH_LIMIT),
				name,
			),
	});

	/** 「確認」與「存成食物」都走這裡：先查同名，沒有才建。 */
	function saveFood(body: AiFoodBody) {
		setSameName(null);
		lookup.mutate(body.name, {
			onSuccess: (match) => {
				if (match === null) createFood(body);
				else setSameName({ food: match, body });
			},
			// 同名檢查只是提醒：查不到（多半是暫時的）不擋使用者存。真的撞到
			// 自己的食物，後端的 409 FOOD_EXISTS 仍然會接住。
			onError: () => createFood(body),
		});
	}

	function createFood(body: AiFoodBody) {
		save.mutate(body, {
			onSuccess: (food) => {
				if (food) finish(food);
			},
		});
	}

	function takeFood(foodId: number) {
		pickExisting.mutate(foodId, {
			onSuccess: (food) => {
				if (food) finish(food);
			},
		});
	}

	const busy =
		analyze.isPending ||
		lookup.isPending ||
		save.isPending ||
		pickExisting.isPending;
	const saving = lookup.isPending || save.isPending;

	function handlePhoto(event: ChangeEvent<HTMLInputElement>) {
		const file = event.target.files?.[0];
		// 清掉 input 的值：同一張再選一次，change 才會再觸發。
		event.target.value = "";
		if (file === undefined) return;
		analyze.mutate({ kind: "image", file });
	}

	function startEditing(current: AnalyzeResponse) {
		setDraft(draftFromEstimate(current));
		setFormError(null);
		setExistingFoodId(null);
		setSameName(null);
		save.reset();
		focusNextRef.current = "form";
	}

	function updateDraft(patch: Partial<EstimateDraft>) {
		if (draft === null) return;
		setDraft({ ...draft, ...patch });
		// 改過就不是剛才問的那一份了：「還是建一個」不能送出改之前的內容。
		setSameName(null);
	}

	function submitDraft(event: FormEvent, current: AnalyzeResponse) {
		event.preventDefault();
		if (draft === null) return;
		const result = editedFoodRequest(current, draft);
		if (!result.ok) {
			setFormError(result.error);
			return;
		}
		setFormError(null);
		setExistingFoodId(null);
		saveFood(result.body);
	}

	const unit = estimate?.nutrition.base_unit ?? "g";

	const sameNamePrompt = sameName !== null && (
		<>
			<p role="alert">食物庫裡已經有「{sameName.food.name}」</p>
			<div className={styles.actions}>
				<button
					ref={useLibraryButtonRef}
					type="button"
					className={styles.primary}
					disabled={busy}
					onClick={() => finish(sameName.food)}
				>
					用食物庫的
				</button>
				<button
					type="button"
					className={styles.secondary}
					disabled={busy}
					onClick={() => {
						setSameName(null);
						createFood(sameName.body);
					}}
				>
					還是用 AI 的數字建一個
				</button>
			</div>
		</>
	);
	// 撞名而且附了 food_id 時，畫面用「用現有的／改名」處理；沒附 food_id 就當一般
	// 失敗，顯示後端的訊息。
	const saveFailed =
		save.isError &&
		!(
			save.error instanceof ApiError &&
			save.error.code === "FOOD_EXISTS" &&
			existingFoodId !== null
		);

	return (
		<div className={styles.panel}>
			<div className={styles.entry}>
				{trimmed !== "" && (
					<button
						type="button"
						className={styles.aiButton}
						disabled={busy}
						onClick={() => analyze.mutate({ kind: "text", text: trimmed })}
					>
						{textButtonLabel(trimmed)}
					</button>
				)}
				<PhotoPickerButton
					id={photoInputId}
					label="拍照估算"
					accept="image/*"
					variant="accent"
					disabled={busy || aiUnavailable}
					onChange={handlePhoto}
				/>
			</div>

			{/* 一直掛著、只換文字：動態插入的 live region 常被讀屏軟體略過。 */}
			<p role="status">{analyze.isPending ? "AI 估算中…" : ""}</p>
			{analyze.isError && (
				<p role="alert">{describeAnalyzeError(analyze.error)}</p>
			)}

			{estimate !== null && estimate.food_id !== null && (
				<section aria-label="食物庫裡的食物" className={styles.card}>
					<p>食物庫裡已經有「{estimate.name}」</p>
					<p className={styles.muted}>
						{`每 100 ${unit}：${formatMacro(estimate.nutrition.kcal)} kcal`}
					</p>
					<div className={styles.actions}>
						<button
							type="button"
							className={styles.primary}
							disabled={busy}
							onClick={() => {
								if (estimate.food_id !== null) takeFood(estimate.food_id);
							}}
						>
							用這個
						</button>
					</div>
					{pickExisting.isError && <p role="alert">讀取食物失敗，請再試一次</p>}
				</section>
			)}

			{estimate !== null && estimate.food_id === null && draft === null && (
				<section aria-label="AI 估算結果" className={styles.card}>
					<h3 ref={cardHeadingRef} tabIndex={-1}>
						{estimate.name}
					</h3>
					{estimate.brand !== null && (
						<p className={styles.muted}>{estimate.brand}</p>
					)}
					<p>
						{`一份 ${formatMacro(estimate.nutrition.serving_grams)} ${unit} · ${formatMacro(estimate.nutrition.serving_kcal)} kcal`}
					</p>
					<p className={styles.muted}>
						{`蛋白質 ${formatMacro(estimate.nutrition.serving_protein_g)} g　脂肪 ${formatMacro(estimate.nutrition.serving_fat_g)} g　碳水 ${formatMacro(estimate.nutrition.serving_carb_g)} g`}
					</p>
					{estimate.consistency.flagged ? (
						<p className={styles.warning}>
							⚠ 熱量跟三大營養素對不太起來，建議看一眼
						</p>
					) : (
						<p className={styles.muted}>✓ 熱量與三大營養素對得起來</p>
					)}
					<p
						className={styles.muted}
					>{`今天還能用 ${estimate.remaining_today} 次`}</p>

					{sameName !== null ? (
						sameNamePrompt
					) : existingFoodId !== null ? (
						<>
							<p role="alert">你已經有「{estimate.name}」了</p>
							<div className={styles.actions}>
								<button
									type="button"
									className={styles.primary}
									disabled={busy}
									onClick={() => takeFood(existingFoodId)}
								>
									用現有的
								</button>
								<button
									type="button"
									className={styles.secondary}
									disabled={busy}
									onClick={() => startEditing(estimate)}
								>
									改名
								</button>
							</div>
						</>
					) : (
						<div className={styles.actions}>
							<button
								type="button"
								className={styles.primary}
								disabled={busy}
								onClick={() => saveFood(confirmedFoodRequest(estimate))}
							>
								{saving ? "存成食物中…" : "確認"}
							</button>
							<button
								type="button"
								className={styles.secondary}
								disabled={busy}
								onClick={() => startEditing(estimate)}
							>
								需要修改
							</button>
						</div>
					)}
					{saveFailed && <p role="alert">{describeSaveError(save.error)}</p>}
					{pickExisting.isError && <p role="alert">讀取食物失敗，請再試一次</p>}
				</section>
			)}

			{estimate !== null && estimate.food_id === null && draft !== null && (
				<form
					aria-label="修改 AI 估算"
					className={`${styles.card} ${styles.form}`}
					onSubmit={(event) => submitDraft(event, estimate)}
				>
					<label htmlFor={`${id}-name`}>食物名稱</label>
					<input
						ref={nameInputRef}
						id={`${id}-name`}
						type="text"
						maxLength={100}
						value={draft.name}
						onChange={(event) => updateDraft({ name: event.target.value })}
					/>
					<label
						htmlFor={`${id}-serving-grams`}
					>{`一份的重量（${unit}）`}</label>
					<input
						id={`${id}-serving-grams`}
						type="text"
						inputMode="decimal"
						value={draft.servingGrams}
						onChange={(event) =>
							updateDraft({ servingGrams: event.target.value })
						}
					/>
					<label htmlFor={`${id}-kcal`}>一份的熱量（kcal）</label>
					<input
						id={`${id}-kcal`}
						type="text"
						inputMode="decimal"
						value={draft.kcal}
						onChange={(event) => updateDraft({ kcal: event.target.value })}
					/>
					<label htmlFor={`${id}-protein`}>一份的蛋白質（g）</label>
					<input
						id={`${id}-protein`}
						type="text"
						inputMode="decimal"
						value={draft.protein_g}
						onChange={(event) => updateDraft({ protein_g: event.target.value })}
					/>
					<label htmlFor={`${id}-fat`}>一份的脂肪（g）</label>
					<input
						id={`${id}-fat`}
						type="text"
						inputMode="decimal"
						value={draft.fat_g}
						onChange={(event) => updateDraft({ fat_g: event.target.value })}
					/>
					<label htmlFor={`${id}-carb`}>一份的碳水化合物（g）</label>
					<input
						id={`${id}-carb`}
						type="text"
						inputMode="decimal"
						value={draft.carb_g}
						onChange={(event) => updateDraft({ carb_g: event.target.value })}
					/>
					{formError !== null && <p role="alert">{formError}</p>}
					{existingFoodId !== null && (
						<p role="alert">你已經有同名的食物了，換個名稱</p>
					)}
					{saveFailed && <p role="alert">{describeSaveError(save.error)}</p>}
					{sameNamePrompt}
					<div className={styles.actions}>
						<button type="submit" className={styles.primary} disabled={busy}>
							{saving ? "存成食物中…" : "存成食物"}
						</button>
						<button
							type="button"
							className={styles.secondary}
							disabled={busy}
							onClick={() => {
								setDraft(null);
								setFormError(null);
								setExistingFoodId(null);
								setSameName(null);
								save.reset();
								focusNextRef.current = "card";
							}}
						>
							放棄修改
						</button>
					</div>
				</form>
			)}
		</div>
	);
}
