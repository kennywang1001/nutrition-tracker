import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { apiFetch } from "../api/client";
import { ApiError, describeFieldErrors } from "../api/errors";
import type { Portion } from "../api/foods";
import { queryKeys } from "../api/queries";
import { formatMacro, isPlainPositiveDecimal } from "../lib/decimal";
import ui from "./ui.module.css";

/** 份量重量的後端上限（`PortionUpdateRequest.grams` 的 `le=10000`）。 */
const MAX_GRAMS = 10000;

type Props = {
	foodId: number;
	portion: Portion;
	unit: string;
	/** 這一列的修改表單是不是開著——同一時間只開一個，由食物詳情管。 */
	editing: boolean;
	onEdit: () => void;
	onClose: () => void;
};

function describeError(error: unknown, fallback: string): string {
	if (error instanceof ApiError) {
		if (error.code === "PORTION_EXISTS") return error.message;
		if (error.code === "VALIDATION_ERROR")
			return describeFieldErrors(error).join("；");
	}
	return fallback;
}

/** 食物詳情的一列份量：顯示、修改、刪除（小項目包規格 §3.3）。
 *
 *  **只有私人份量能動**（`!portion.is_global`）：公開份量的修改、刪除只開放
 *  API 給管理員（計畫「與規格的差異」第 1 點）。後端仍然是授權的唯一依據。
 *
 *  **已經記下的餐不受影響**——改重量不動舊紀錄的公克數；刪除後舊紀錄那一項
 *  變成直接輸入的公克數。確認文字把這件事講出來。
 *
 *  名稱與重量那一段包在自己的 `<span>` 裡：`e2e/portions.spec.ts` 用
 *  `getByText(/碗（150 g）/)` 找這一列，按鈕的文字不能混進同一個文字節點。 */
export function PortionRow({
	foodId,
	portion,
	unit,
	editing,
	onEdit,
	onClose,
}: Props) {
	const queryClient = useQueryClient();
	const canManage = !portion.is_global;
	const [label, setLabel] = useState(portion.label);
	const [grams, setGrams] = useState(formatMacro(portion.grams));
	const [isDefault, setIsDefault] = useState(portion.is_default);
	const [confirming, setConfirming] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const path = `/api/foods/${foodId}/portions/${portion.id}`;
	const refresh = () =>
		queryClient.invalidateQueries({ queryKey: queryKeys.portions(foodId) });

	/** 關掉修改表單：錯誤訊息跟著收掉（同 Expenses 的「放棄」）。 */
	function closeEditor() {
		setError(null);
		onClose();
	}

	const save = useMutation({
		mutationFn: (body: Record<string, unknown>) =>
			apiFetch<Portion>(path, {
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			}),
		onSuccess: () => {
			refresh();
			onClose();
		},
		onError: (caught) =>
			setError(describeError(caught, "儲存失敗，請再試一次")),
	});

	const remove = useMutation({
		mutationFn: () => apiFetch(path, { method: "DELETE" }),
		onSuccess: () => {
			setConfirming(false);
			refresh();
			// 後端把用過這個份量的餐點項目 `portion_id` 設成 null（ON DELETE
			// SET NULL）——快取裡的餐點（清單與單一餐，都在 `meals` 底下）
			// 還帶著舊的 id，一起失效。
			queryClient.invalidateQueries({ queryKey: queryKeys.meals });
		},
		onError: (caught) =>
			setError(describeError(caught, "刪除失敗，請再試一次")),
	});

	function openEditor() {
		// 每次打開都從目前的值帶入——清單可能在背景重抓過。
		setLabel(portion.label);
		setGrams(formatMacro(portion.grams));
		setIsDefault(portion.is_default);
		setError(null);
		setConfirming(false);
		onEdit();
	}

	function handleSubmit(event: FormEvent) {
		event.preventDefault();
		const trimmedLabel = label.trim();
		const trimmedGrams = grams.trim();
		if (trimmedLabel === "") {
			setError("請輸入份量名稱");
			return;
		}
		if (!isPlainPositiveDecimal(trimmedGrams)) {
			setError("重量要大於 0");
			return;
		}
		if (Number(trimmedGrams) > MAX_GRAMS) {
			setError(`重量不能超過 ${MAX_GRAMS}`);
			return;
		}
		// 只送改過的欄位（PATCH 是 exclude_unset：不帶＝不動）。
		const body: Record<string, unknown> = {};
		if (trimmedLabel !== portion.label) body.label = trimmedLabel;
		if (trimmedGrams !== formatMacro(portion.grams)) body.grams = trimmedGrams;
		if (isDefault !== portion.is_default) body.is_default = isDefault;
		if (Object.keys(body).length === 0) {
			closeEditor();
			return;
		}
		setError(null);
		save.mutate(body);
	}

	const busy = save.isPending || remove.isPending;
	const idPrefix = `portion-${portion.id}`;

	return (
		<li>
			<span>
				{portion.label}（{formatMacro(portion.grams)} {unit}）
				{portion.is_default && (
					<>
						・<span className={ui.tag}>預設</span>
					</>
				)}
			</span>

			{canManage && !editing && !confirming && (
				<span className={ui.rowActions}>
					<button
						type="button"
						aria-label={`修改${portion.label}`}
						onClick={openEditor}
					>
						修改
					</button>
					<button
						type="button"
						className={ui.danger}
						aria-label={`刪除${portion.label}`}
						onClick={() => {
							setError(null);
							setConfirming(true);
						}}
					>
						刪除
					</button>
				</span>
			)}

			{editing && (
				<form
					aria-label={`修改${portion.label}`}
					className={ui.inlineEditor}
					onSubmit={handleSubmit}
				>
					<label htmlFor={`${idPrefix}-label`}>份量名稱</label>
					<input
						id={`${idPrefix}-label`}
						type="text"
						maxLength={50}
						value={label}
						onChange={(event) => setLabel(event.target.value)}
					/>
					<label htmlFor={`${idPrefix}-grams`}>重量（{unit}）</label>
					<input
						id={`${idPrefix}-grams`}
						type="text"
						inputMode="decimal"
						value={grams}
						onChange={(event) => setGrams(event.target.value)}
					/>
					<label>
						<input
							type="checkbox"
							checked={isDefault}
							onChange={(event) => setIsDefault(event.target.checked)}
						/>
						記一餐時預設用這個份量
					</label>
					{error !== null && <p role="alert">{error}</p>}
					<button type="submit" disabled={busy}>
						{save.isPending ? "儲存中…" : "儲存"}
					</button>
					<button type="button" onClick={closeEditor}>
						放棄
					</button>
				</form>
			)}

			{confirming && (
				<div
					role="alertdialog"
					aria-label={`確認刪除${portion.label}`}
					className={ui.inlineEditor}
				>
					<p>
						確定要刪除「{portion.label}」嗎？已經記下的餐不受影響，公克數照舊。
					</p>
					<button
						type="button"
						className={ui.danger}
						disabled={busy}
						onClick={() => remove.mutate()}
					>
						確定刪除
					</button>
					<button
						type="button"
						onClick={() => {
							setConfirming(false);
							setError(null);
						}}
					>
						取消
					</button>
				</div>
			)}

			{/* 只有刪除的錯誤顯示在這裡，而且只在確認框開著時：修改的錯誤在表單
			    裡面；表單被別的列的「修改」關掉時（editing 由食物詳情改成 false，
			    這一列沒有機會跑 closeEditor），留下來的修改錯誤不能掉到這裡。 */}
			{confirming && error !== null && <p role="alert">{error}</p>}
		</li>
	);
}
