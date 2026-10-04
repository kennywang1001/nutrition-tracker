import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { apiFetch } from "../api/client";
import type { Portion } from "../api/foods";
import { queryKeys } from "../api/queries";
import { pickDefaultPortion } from "../lib/portions";
import styles from "./PortionQuantityFields.module.css";

/** 份量的選擇（食物份量規格 §6）：
 *    null     → 使用者還沒動過，用推導出來的預設份量（有的話）
 *    "manual" → 使用者選了「直接輸入數量」
 *    number   → 使用者選了某個份量
 *
 *  **不用 effect 在份量清單到的時候寫 state**：預設份量是從清單推導的，
 *  使用者一旦手動選過就以使用者為準，不會被重新抓到的清單蓋回去。
 *
 *  編輯一個已經記下的項目時，初始值直接給 `item.portion_id ?? "manual"`
 *  （不是 null）——那一項當初怎麼記就是怎麼記，食物後來才設的預設份量
 *  不能把「直接輸入 80 g」變成 80 碗。 */
export type PortionChoice = number | "manual" | null;

/** 份量下拉與數量的狀態。放在 hook 而不是元件裡：送出時呼叫端要拿
 *  `portionId` 與 `quantity` 組 body（記一餐、編輯餐點都是）。
 *
 *  `foodId` 是 `null` 時不抓份量清單。換食物（`foodId` 變了）時份量的選擇
 *  自己回到「還沒動過」，數量不動。
 *
 *  回傳的物件每次 render 都是新的，不要放進依賴陣列。 */
export function usePortionQuantity(
	foodId: number | null,
	initial?: { choice: PortionChoice; quantity: string },
) {
	const [portionChoice, setPortionChoice] = useState<PortionChoice>(
		initial?.choice ?? null,
	);
	const [quantity, setQuantityValue] = useState(initial?.quantity ?? "1");

	// 換食物就把份量的選擇清掉：上一個食物的「直接輸入」鎖定或份量 id
	// 不能帶到新食物——別的食物的 portion_id 送出去會被後端 422
	// （PORTION_FOOD_MISMATCH）。用「把上一個 prop 存在 state 裡、render
	// 當下比對」的寫法，不用 effect（effect 會多一次帶著舊選擇的 render）。
	const [previousFoodId, setPreviousFoodId] = useState(foodId);
	if (foodId !== previousFoodId) {
		setPreviousFoodId(foodId);
		setPortionChoice(null);
	}

	const portionsQuery = useQuery({
		queryKey: queryKeys.portions(foodId ?? 0),
		queryFn: () => apiFetch<Portion[]>(`/api/foods/${foodId}/portions`),
		enabled: foodId !== null,
	});
	const portions = portionsQuery.data ?? [];

	const defaultPortion = pickDefaultPortion(portions);
	const portionId =
		portionChoice === "manual"
			? null
			: (portionChoice ?? defaultPortion?.id ?? null);

	return {
		portions,
		portionId,
		quantity,
		setQuantity(value: string) {
			// 使用者一動數量，就把「此刻看到的單位」鎖住：份量清單可能晚到
			// （或是快取裡過期的空清單被換掉），若還是 null，晚到的預設份量
			// 會把使用者輸入的「200」（當時提示是 g）變成 200 份。
			if (portionChoice === null) {
				setPortionChoice(portionId ?? "manual");
			}
			setQuantityValue(value);
		},
		choosePortion(choice: number | "manual") {
			setPortionChoice(choice);
		},
		/** 存好之後：回到沒動過——份量選擇 null、數量 "1"。 */
		reset() {
			setPortionChoice(null);
			setQuantityValue("1");
		},
	};
}

export type PortionQuantity = ReturnType<typeof usePortionQuantity>;

type Props = {
	state: PortionQuantity;
	/** 直接輸入時數量的單位（食物的 `base_unit`，`g` 或 `ml`）。 */
	unit: string;
	/** 加在每個 id 前面。記一餐不帶——id 要跟原本一字不差，
	 *  `e2e/portions.spec.ts` 用 `#portion option:checked` 找下拉。 */
	idPrefix?: string;
};

/** 份量下拉＋數量＋單位提示。**回 fragment**：欄位直接落在呼叫端的
 *  `<form>` 裡，版面與樣式（`.form input`、`.form select`）跟抽出來之前
 *  一樣。 */
export function PortionQuantityFields({ state, unit, idPrefix = "" }: Props) {
	const portionInputId = `${idPrefix}portion`;
	const quantityInputId = `${idPrefix}quantity`;
	const unitId = `${idPrefix}quantity-unit`;

	return (
		<>
			{state.portions.length > 0 && (
				<>
					<label htmlFor={portionInputId}>份量選項</label>
					<select
						id={portionInputId}
						value={state.portionId ?? ""}
						onChange={(event) =>
							state.choosePortion(
								event.target.value === ""
									? "manual"
									: Number(event.target.value),
							)
						}
					>
						<option value="">直接輸入數量</option>
						{state.portions.map((portion) => (
							<option key={portion.id} value={portion.id}>
								{portion.label}
							</option>
						))}
					</select>
				</>
			)}

			<label htmlFor={quantityInputId}>份量</label>
			<input
				id={quantityInputId}
				type="text"
				inputMode="decimal"
				value={state.quantity}
				aria-describedby={unitId}
				onChange={(event) => state.setQuantity(event.target.value)}
				required
			/>
			{/* 選了份量時數量是「幾份」；直接輸入時是公克（或毫升）——
			    預設的「1」在直接輸入模式下是 1 g，這個提示讓它看得出來。 */}
			<span id={unitId} className={styles.unit} data-testid={unitId}>
				{state.portionId !== null ? "份" : unit}
			</span>
		</>
	);
}
