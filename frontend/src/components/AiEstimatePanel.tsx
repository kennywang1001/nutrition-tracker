import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Camera } from "lucide-react";
import { type ChangeEvent, type FormEvent, useId, useState } from "react";
import { type AnalyzeResponse, analyzeImage, analyzeText } from "../api/ai";
import { apiFetch } from "../api/client";
import { ApiError, describeFieldErrors } from "../api/errors";
import type { Food } from "../api/foods";
import { describePhotoUploadError, PhotoTooLargeError } from "../api/photos";
import { queryKeys } from "../api/queries";
import {
	type AiFoodBody,
	confirmedFoodRequest,
	draftFromEstimate,
	type EstimateDraft,
	editedFoodRequest,
} from "../lib/ai-food";
import { formatMacro } from "../lib/decimal";
import styles from "./AiEstimatePanel.module.css";

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
 *  的畫面（AI 估算前端規格 §4）。記一餐與新增食物共用。
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

	function clearResult() {
		setEstimate(null);
		setImage(null);
		setDraft(null);
		setFormError(null);
		setExistingFoodId(null);
		// 舊的存檔／讀取失敗訊息不能跟到新的結果卡片上。
		save.reset();
		pickExisting.reset();
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

	function saveFood(body: AiFoodBody) {
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

	const busy = analyze.isPending || save.isPending || pickExisting.isPending;

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
		save.reset();
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
				<label htmlFor={photoInputId} className={styles.photoButton}>
					<Camera aria-hidden="true" size={18} />
					拍照估算
				</label>
				<input
					id={photoInputId}
					type="file"
					accept="image/*"
					className={styles.fileInput}
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
					<h3>{estimate.name}</h3>
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

					{existingFoodId !== null ? (
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
								{save.isPending ? "存成食物中…" : "確認"}
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
						id={`${id}-name`}
						type="text"
						maxLength={100}
						value={draft.name}
						onChange={(event) =>
							setDraft({ ...draft, name: event.target.value })
						}
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
							setDraft({ ...draft, servingGrams: event.target.value })
						}
					/>
					<label htmlFor={`${id}-kcal`}>一份的熱量（kcal）</label>
					<input
						id={`${id}-kcal`}
						type="text"
						inputMode="decimal"
						value={draft.kcal}
						onChange={(event) =>
							setDraft({ ...draft, kcal: event.target.value })
						}
					/>
					<label htmlFor={`${id}-protein`}>一份的蛋白質（g）</label>
					<input
						id={`${id}-protein`}
						type="text"
						inputMode="decimal"
						value={draft.protein_g}
						onChange={(event) =>
							setDraft({ ...draft, protein_g: event.target.value })
						}
					/>
					<label htmlFor={`${id}-fat`}>一份的脂肪（g）</label>
					<input
						id={`${id}-fat`}
						type="text"
						inputMode="decimal"
						value={draft.fat_g}
						onChange={(event) =>
							setDraft({ ...draft, fat_g: event.target.value })
						}
					/>
					<label htmlFor={`${id}-carb`}>一份的碳水化合物（g）</label>
					<input
						id={`${id}-carb`}
						type="text"
						inputMode="decimal"
						value={draft.carb_g}
						onChange={(event) =>
							setDraft({ ...draft, carb_g: event.target.value })
						}
					/>
					{formError !== null && <p role="alert">{formError}</p>}
					{existingFoodId !== null && (
						<p role="alert">你已經有同名的食物了，換個名稱</p>
					)}
					{saveFailed && <p role="alert">{describeSaveError(save.error)}</p>}
					<div className={styles.actions}>
						<button type="submit" className={styles.primary} disabled={busy}>
							{save.isPending ? "存成食物中…" : "存成食物"}
						</button>
						<button
							type="button"
							className={styles.secondary}
							disabled={busy}
							onClick={() => {
								setDraft(null);
								setFormError(null);
								setExistingFoodId(null);
								save.reset();
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
