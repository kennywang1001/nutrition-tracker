import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { apiFetch } from "../api/client";
import { ApiError } from "../api/errors";
import { queryKeys } from "../api/queries";
import type { components } from "../api/schema";
import { perServingToPer100 } from "../lib/decimal";
import { describeFieldErrors } from "../screens/NewFood";

type Portion = components["schemas"]["PortionResponse"];
type BaseUnit = components["schemas"]["BaseUnit"];

type Props = {
	foodId: number;
	/** 食物的單位——重量欄位跟著它（液體是 ml）。 */
	unit: BaseUnit;
	/** 這個食物目前看得到的份量裡有沒有預設的。決定勾選框的初始值。 */
	hasDefault: boolean;
};

/** 食物詳情頁的「新增份量」（食物份量規格 §5）。
 *
 *  一律建**私人**份量（`is_global: false`）：任何人都能替看得到的食物加自己
 *  的「一碗」——「一碗」因人而異（`tests/test_foods_portions.py` 的第一條）。
 *
 *  「預設」勾選框的初始值：目前沒有任何預設份量時勾起來。使用者動過
 *  勾選框之後以使用者為準（`defaultChoice` 不是 null）；送出成功後回到
 *  跟著 `hasDefault` 走。 */
export function AddPortionForm({ foodId, unit, hasDefault }: Props) {
	const queryClient = useQueryClient();
	const [label, setLabel] = useState("");
	const [grams, setGrams] = useState("");
	const [defaultChoice, setDefaultChoice] = useState<boolean | null>(null);
	const isDefault = defaultChoice ?? !hasDefault;
	const [error, setError] = useState<string | null>(null);
	const [fieldErrors, setFieldErrors] = useState<string[]>([]);

	const create = useMutation({
		mutationFn: () =>
			apiFetch<Portion>(`/api/foods/${foodId}/portions`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					label: label.trim(),
					// 字串送出，不經過 Number()。
					grams: grams.trim(),
					is_default: isDefault,
				}),
			}),
		onSuccess: () => {
			void queryClient.invalidateQueries({
				queryKey: queryKeys.portions(foodId),
			});
			setLabel("");
			setGrams("");
			setDefaultChoice(null);
			setError(null);
			setFieldErrors([]);
		},
		onError: (caught: unknown) => {
			setFieldErrors([]);
			if (caught instanceof ApiError) {
				if (caught.code === "PORTION_EXISTS") {
					// 後端的訊息就是要給使用者看的那句，不重寫一份。
					setError(caught.message);
					return;
				}
				if (caught.code === "VALIDATION_ERROR") {
					setError(null);
					setFieldErrors(describeFieldErrors(caught));
					return;
				}
			}
			setError("新增份量失敗，請再試一次");
		},
	});

	function handleSubmit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		setFieldErrors([]);
		if (label.trim() === "") {
			setError("請輸入份量名稱");
			return;
		}
		// 跟 NewFood 同一條規則：trim、只收一般小數寫法、要大於 0。
		if (perServingToPer100("0", grams) === null) {
			setError("重量要大於 0");
			return;
		}
		setError(null);
		create.mutate();
	}

	return (
		<form onSubmit={handleSubmit} aria-label="新增份量">
			<label htmlFor="add-portion-label">份量名稱</label>
			<input
				id="add-portion-label"
				type="text"
				maxLength={50}
				placeholder="例如：碗、片、包"
				value={label}
				onChange={(event) => setLabel(event.target.value)}
			/>
			<label htmlFor="add-portion-grams">重量（{unit}）</label>
			<input
				id="add-portion-grams"
				type="text"
				inputMode="decimal"
				value={grams}
				onChange={(event) => setGrams(event.target.value)}
			/>
			<label>
				<input
					type="checkbox"
					checked={isDefault}
					onChange={(event) => setDefaultChoice(event.target.checked)}
				/>
				記一餐時預設用這個份量
			</label>
			{error !== null && <p role="alert">{error}</p>}
			{fieldErrors.length > 0 && (
				<ul role="alert">
					{fieldErrors.map((message, index) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: 後端的欄位錯誤陣列沒有天然的唯一鍵，且同一次送出裡不會重排序。
						<li key={`${message}-${index}`}>{message}</li>
					))}
				</ul>
			)}
			<button type="submit" disabled={create.isPending}>
				新增份量
			</button>
		</form>
	);
}
