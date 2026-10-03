import { useMutation } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { useNavigate } from "react-router";
import { apiFetch } from "../api/client";
import { ApiError } from "../api/errors";
import type { components } from "../api/schema";
import { isPlainPositiveDecimal, perServingToPer100 } from "../lib/decimal";

type Food = components["schemas"]["FoodResponse"];
type BaseUnit = components["schemas"]["BaseUnit"];

// 匯出給 FoodDetail.tsx（提議修改，Task 5）重用——兩個表單填的都是同一個
// NutritionInput，欄位、label、上下限沒有理由各寫一份。
export const BASE_UNITS: ReadonlyArray<{ value: BaseUnit; label: string }> = [
	{ value: "g", label: "克（g）" },
	{ value: "ml", label: "毫升（ml）" },
];

export type NumericField = "kcal" | "protein_g" | "fat_g" | "carb_g";

// NutritionInput 的上下限（app/schemas/food.py）：kcal 0–10000，其餘三個
// 巨量營養素 0–1000，都是 max_digits=8, decimal_places=2。這裡只對齊
// 上下限（少一個往返），**刻意不重做 decimal_places 檢查**——後端的 422
// 仍然要能顯示，前端驗證不是拿來取代它的（規格 §5.2）。
export const NUMERIC_FIELDS: ReadonlyArray<{
	field: NumericField;
	label: string;
	max: number;
}> = [
	{ field: "kcal", label: "熱量（每 100 單位 kcal）", max: 10000 },
	{ field: "protein_g", label: "蛋白質（g）", max: 1000 },
	{ field: "fat_g", label: "脂肪（g）", max: 1000 },
	{ field: "carb_g", label: "碳水化合物（g）", max: 1000 },
];

/** 「每一份」模式的欄位標籤。**只有 NewFood 用**——`NUMERIC_FIELDS` 的
 *  標籤不能動（FoodDetail 共用、e2e 用它找欄位）。 */
const PER_SERVING_LABELS: Record<NumericField, string> = {
	kcal: "熱量（每份 kcal）",
	protein_g: "蛋白質（每份 g）",
	fat_g: "脂肪（每份 g）",
	carb_g: "碳水化合物（每份 g）",
};

/** 份量重量的後端上限（`DefaultPortionInput.grams` 的 `le=10000`）。 */
const MAX_PORTION_GRAMS = 10000;

type NutritionBasis = "per100" | "perServing";

/** 把 `VALIDATION_ERROR` 的 `details.errors`（規格 §5.4：每一筆有
 *  `loc` / `msg` / `type`）轉成人看得懂的一行行文字。
 *
 *  `ApiError.details` 的型別是 `Record<string, unknown>`——後端的信封
 *  沒有另外給欄位錯誤一個專屬型別，這裡要自己做執行期窄化，不能假設形狀。
 *
 *  匯出給 `FoodDetail.tsx`（Task 5）重用——422 的欄位錯誤信封是同一個
 *  `RevisionCreateRequest.nutrition` 形狀，沒有理由重寫一份窄化邏輯。 */
export function describeFieldErrors(error: ApiError): string[] {
	const raw = error.details.errors;
	if (!Array.isArray(raw) || raw.length === 0) return [error.message];
	return raw.map((item) => {
		if (typeof item !== "object" || item === null) return error.message;
		const entry = item as { loc?: unknown; msg?: unknown };
		const msg = typeof entry.msg === "string" ? entry.msg : error.message;
		const loc = Array.isArray(entry.loc)
			? entry.loc.filter((part) => part !== "body").join(".")
			: "";
		return loc === "" ? msg : `${loc}：${msg}`;
	});
}

/** 新增食物（規格 §5.2）。**私人食物**——`POST /api/foods` 建立的一律是
 *  `owner_id = user.id`，立刻生效，不用送審（送審是 §5.3 對「既有的全域
 *  食物」提議修改，Task 5 的事）。
 *
 *  成功後直接導到新食物的詳情頁（`/foods/:id`，Task 5 才存在——導過去
 *  現在會是空白畫面，那是刻意的，不放佔位畫面）。用 `useNavigate` 自己做，
 *  不透過 App.tsx 的 route wrapper 傳 callback：新食物的 id 來自 mutation
 *  的回應本體，導去哪裡是這個畫面自己才知道的事，不是像 `LogMeal` 的
 *  `onSaved` 那樣「導回一個固定路徑」。 */
export function NewFood() {
	const navigate = useNavigate();

	const [name, setName] = useState("");
	const [brand, setBrand] = useState("");
	const [baseUnit, setBaseUnit] = useState<BaseUnit>("g");
	const [values, setValues] = useState<Record<NumericField, string>>({
		kcal: "",
		protein_g: "",
		fat_g: "",
		carb_g: "",
	});

	// 「一份」（選填，食物份量規格 §4.1）。兩個要一起填。
	const [portionLabel, setPortionLabel] = useState("");
	const [portionGrams, setPortionGrams] = useState("");
	const [basisChoice, setBasisChoice] = useState<NutritionBasis>("per100");
	// 重量合法與否用跟換算同一條嚴格規則（isPlainPositiveDecimal：會 trim、
	// 只收一般小數、要大於 0）。
	// isPositiveAmount 不 trim 又接受 "1e3"，會讓「 45」停用每一份、"1e3" 卻啟用
	// 它，再因為換算失敗而把錯誤怪到熱量欄位。
	const servingGramsValid = isPlainPositiveDecimal(portionGrams);
	// 實際生效的模式。重量無法換算時退回每 100（規格：不能停在無法換算的狀態），
	// 重量重新合法後回到使用者的選擇。舊的單向切換會在重量清掉又重打之後
	// 停在每 100，把每份的數字默默當成每 100 存進去。
	const basis: NutritionBasis =
		basisChoice === "perServing" && servingGramsValid ? "perServing" : "per100";

	const [clientError, setClientError] = useState<string | null>(null);
	const [conflictError, setConflictError] = useState<string | null>(null);
	const [fieldErrors, setFieldErrors] = useState<string[]>([]);

	// 送出與預覽用的「每 100」值。「每一份」模式下換算不了的欄位是 null。
	const per100: Record<NumericField, string | null> =
		basis === "per100"
			? values
			: {
					kcal: perServingToPer100(values.kcal, portionGrams),
					protein_g: perServingToPer100(values.protein_g, portionGrams),
					fat_g: perServingToPer100(values.fat_g, portionGrams),
					carb_g: perServingToPer100(values.carb_g, portionGrams),
				};
	const hasPortion = portionLabel.trim() !== "" && portionGrams.trim() !== "";

	const createFood = useMutation({
		mutationFn: async () =>
			apiFetch<Food>("/api/foods", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					name: name.trim(),
					// brand 是 str | None（app/schemas/food.py）。空字串一樣能通過
					// 後端驗證並存成 ""——「同名同品牌」的唯一約束對 "" 與 null
					// 是兩個不同的值，留空不轉成 null 的話，使用者會建出兩筆
					// 看起來一模一樣的食物（開工前查證過的事實）。
					brand: brand.trim() === "" ? null : brand.trim(),
					nutrition: {
						base_unit: baseUnit,
						// 四個數值一律以字串送出（規格 §5.1）。「每一份」模式送的是
						// 換算後的每 100 值——後端只存每 100（食物份量規格 §4.2）。
						// validate() 已經保證走到這裡時不會是 null。
						kcal: per100.kcal,
						protein_g: per100.protein_g,
						fat_g: per100.fat_g,
						carb_g: per100.carb_g,
					},
					...(hasPortion
						? {
								default_portion: {
									label: portionLabel.trim(),
									grams: portionGrams.trim(),
								},
							}
						: {}),
				}),
			}),
		onSuccess: (created) => {
			// apiFetch<T> 回的是 T | null（204 → null），201 不會是 null，
			// 但型別上仍要 narrow——truthy 判斷，不是 === undefined。
			if (created) {
				navigate(`/foods/${created.id}`);
			}
		},
		onError: (caught: unknown) => {
			setConflictError(null);
			setFieldErrors([]);
			if (caught instanceof ApiError) {
				if (caught.code === "FOOD_EXISTS") {
					setConflictError(caught.message);
					return;
				}
				if (caught.code === "VALIDATION_ERROR") {
					setFieldErrors(describeFieldErrors(caught));
					return;
				}
			}
			setClientError("建立失敗，請再試一次");
		},
	});

	function validate(): string | null {
		if (name.trim() === "") return "請輸入名稱";

		const labelFilled = portionLabel.trim() !== "";
		const gramsFilled = portionGrams.trim() !== "";
		if (labelFilled !== gramsFilled) return "份量名稱與重量要一起填";
		if (gramsFilled) {
			if (!servingGramsValid) return "每份重量要大於 0";
			if (Number(portionGrams) > MAX_PORTION_GRAMS) {
				return `每份重量不能超過 ${MAX_PORTION_GRAMS}`;
			}
		}

		for (const { field, label, max } of NUMERIC_FIELDS) {
			const raw = values[field];
			const shownLabel =
				basis === "perServing" ? PER_SERVING_LABELS[field] : label;
			if (raw.trim() === "") return `請輸入${shownLabel}`;
			if (basis === "perServing") {
				const converted = per100[field];
				if (converted === null) return `${shownLabel}必須是 0 以上的數字`;
				// 換算後超過上限，通常代表每份重量少打一位數。
				if (Number(converted) > max) return "換算後超過上限，請確認每份重量";
				continue;
			}
			const parsed = Number(raw);
			if (!Number.isFinite(parsed) || parsed < 0 || parsed > max) {
				return `${label}必須介於 0 到 ${max} 之間`;
			}
		}
		return null;
	}

	function handleSubmit(event: FormEvent) {
		event.preventDefault();
		setClientError(null);
		setConflictError(null);
		setFieldErrors([]);
		const validationError = validate();
		if (validationError !== null) {
			setClientError(validationError);
			return;
		}
		createFood.mutate();
	}

	return (
		<section>
			<h1>新增食物</h1>
			<form onSubmit={handleSubmit}>
				<label htmlFor="food-name">名稱</label>
				<input
					id="food-name"
					type="text"
					maxLength={100}
					value={name}
					onChange={(event) => setName(event.target.value)}
					required
				/>

				<label htmlFor="food-brand">品牌（選填）</label>
				<input
					id="food-brand"
					type="text"
					maxLength={100}
					value={brand}
					onChange={(event) => setBrand(event.target.value)}
				/>

				<label htmlFor="food-base-unit">單位</label>
				<select
					id="food-base-unit"
					value={baseUnit}
					onChange={(event) => setBaseUnit(event.target.value as BaseUnit)}
				>
					{BASE_UNITS.map((option) => (
						<option key={option.value} value={option.value}>
							{option.label}
						</option>
					))}
				</select>

				<fieldset>
					<legend>一份（選填）</legend>
					<label htmlFor="portion-label">份量名稱</label>
					<input
						id="portion-label"
						type="text"
						maxLength={50}
						placeholder="例如：碗、片、包"
						value={portionLabel}
						onChange={(event) => setPortionLabel(event.target.value)}
					/>
					<label htmlFor="portion-grams">每份重量（{baseUnit}）</label>
					<input
						id="portion-grams"
						type="text"
						inputMode="decimal"
						value={portionGrams}
						onChange={(event) => setPortionGrams(event.target.value)}
					/>
				</fieldset>

				<fieldset>
					<legend>營養標示是</legend>
					<label>
						<input
							type="radio"
							name="nutrition-basis"
							value="per100"
							checked={basis === "per100"}
							onChange={() => setBasisChoice("per100")}
						/>
						每 100 {baseUnit}
					</label>
					<label>
						<input
							type="radio"
							name="nutrition-basis"
							value="perServing"
							checked={basis === "perServing"}
							disabled={!servingGramsValid}
							aria-describedby={servingGramsValid ? undefined : "serving-hint"}
							onChange={() => setBasisChoice("perServing")}
						/>
						每一份
					</label>
					{!servingGramsValid && <span id="serving-hint">先填每份的重量</span>}
				</fieldset>

				{NUMERIC_FIELDS.map(({ field, label }) => (
					<div key={field}>
						<label htmlFor={`food-${field}`}>
							{basis === "perServing" ? PER_SERVING_LABELS[field] : label}
						</label>
						<input
							id={`food-${field}`}
							type="text"
							inputMode="decimal"
							value={values[field]}
							onChange={(event) =>
								setValues((prev) => ({ ...prev, [field]: event.target.value }))
							}
							required
						/>
					</div>
				))}

				{basis === "perServing" && (
					<p data-testid="per100-preview">
						換算成每 100 {baseUnit}：熱量 {per100.kcal ?? "—"} kcal、蛋白質{" "}
						{per100.protein_g ?? "—"} g、脂肪 {per100.fat_g ?? "—"} g、碳水{" "}
						{per100.carb_g ?? "—"} g
					</p>
				)}

				{clientError !== null && <p role="alert">{clientError}</p>}
				{conflictError !== null && <p role="alert">{conflictError}</p>}
				{fieldErrors.length > 0 && (
					<ul role="alert">
						{fieldErrors.map((message, index) => (
							// biome-ignore lint/suspicious/noArrayIndexKey: 後端的欄位錯誤陣列沒有天然的唯一鍵，且同一次送出裡不會重排序。
							<li key={`${message}-${index}`}>{message}</li>
						))}
					</ul>
				)}

				<button type="submit" disabled={createFood.isPending}>
					建立食物
				</button>
			</form>
		</section>
	);
}
