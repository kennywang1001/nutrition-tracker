import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { apiFetch } from "../api/client";
import { ApiError } from "../api/errors";
import { queryKeys } from "../api/queries";
import {
	type Supplement,
	useSupplementSearch,
	useTodaySupplements,
} from "../api/supplements";
import { useDebounced } from "../lib/use-debounced";
import { describeFieldErrors } from "./NewFood";

type NumericField = "kcal" | "protein_g" | "fat_g" | "carb_g";

// 上下限抄自 app/schemas/supplement.py 的 SupplementCreateRequest：kcal
// 0–10000，其餘三個巨量營養素 0–1000（跟食物的 NutritionInput 同一組數字，
// 但這裡「留空」是合法輸入——不像食物，補劑本來就有「只想記錄吃了沒、
// 不記熱量」的用法（例如魚油），四個欄位都是選填。
const NUMERIC_FIELDS: ReadonlyArray<{
	field: NumericField;
	label: string;
	max: number;
}> = [
	{ field: "kcal", label: "熱量（每份 kcal，選填）", max: 10000 },
	{ field: "protein_g", label: "蛋白質（g，選填）", max: 1000 },
	{ field: "fat_g", label: "脂肪（g，選填）", max: 1000 },
	{ field: "carb_g", label: "碳水化合物（g，選填）", max: 1000 },
];

/** 記一筆臨時攝取：`POST /api/supplement-intakes` 帶 **`plan_id: null`**。
 *
 *  這是使用者原話唯一要的第二件事——「當天有吃就點一份進去就好」。
 *  `plan_id` 是 `null`（不是省略）：`SupplementIntakeCreateRequest.plan_id`
 *  有預設值 `None`，省略跟明講 `null` 在這個欄位上是等價的，但這裡刻意
 *  寫出來，讓「這是臨時記錄，不屬於任何計畫」這件事在程式碼裡看得見，
 *  不必回頭查 pydantic 的預設值才知道。
 *
 *  `dose` 固定 `"1"`：使用者的原話是「點一份進去」，不是「填一個數字」——
 *  這個畫面完全不提供改份數的欄位，範圍就是「就好」的一部分。
 *
 *  `taken_at` 是「現在這一刻」——跟 `Today.tsx` 的 `checkInSupplement` 同一個
 *  理由：後端用它落在哪個 `day_bounds()` 半開區間判斷屬於哪一天，前端
 *  不用、也不該自己判斷日界線。 */
async function recordAdHocIntake(supplementId: number): Promise<void> {
	await apiFetch("/api/supplement-intakes", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			supplement_id: supplementId,
			plan_id: null,
			dose: "1",
			taken_at: new Date().toISOString(),
		}),
	});
}

/** 今日清單裡一個項目的狀態文字。
 *
 *  `plan_id === null` 一定是臨時記錄（`TodaySupplementItem` 的 docstring：
 *  「這種項目一定是 done=True」），跟「打卡」是兩件不同的事——這個畫面
 *  完全不做固定計畫，所以特地用「已記錄」而不是「已打卡」，不要讓使用者
 *  誤以為自己設了一個計畫。 */
function statusLabel(item: { plan_id: number | null; done: boolean }): string {
	if (item.plan_id === null) return "已記錄";
	return item.done ? "已打卡" : "待打卡";
}

/** 補劑：新增「我有在使用的」＋「當天有吃就點一份進去」（規格來源：
 *  2026-09-26 使用者原話，見計畫 P3-C）。
 *
 *  **刻意不做的事**：固定計畫（`supplement-plans`）的任何介面、每日排程、
 *  `time_of_day`。使用者明講「就好」，那些都是範圍之外。這個畫面能做的
 *  只有兩件事：`POST /api/supplements` 建一筆補劑、`POST
 *  /api/supplement-intakes`（`plan_id: null`）記一筆臨時攝取。
 *
 *  **入口在 `Today.tsx` 的「今日補劑」區塊，不是第六個 tab**——tab bar
 *  現在 4 格，320px 寬度下每格只剩 53px，中文標籤會擠爆（計畫 Task 2
 *  的說明）。 */
export function Supplements() {
	const queryClient = useQueryClient();

	const todayQuery = useTodaySupplements();
	const todayItems = todayQuery.data ?? [];

	const [input, setInput] = useState("");
	const debouncedQuery = useDebounced(input, 300);
	const searchQuery = useSupplementSearch(debouncedQuery);
	const hasQuery = debouncedQuery.trim() !== "";

	const [name, setName] = useState("");
	const [brand, setBrand] = useState("");
	const [servingUnit, setServingUnit] = useState("");
	const [servingSize, setServingSize] = useState("");
	const [values, setValues] = useState<Record<NumericField, string>>({
		kcal: "",
		protein_g: "",
		fat_g: "",
		carb_g: "",
	});

	const [clientError, setClientError] = useState<string | null>(null);
	const [conflictError, setConflictError] = useState<string | null>(null);
	const [fieldErrors, setFieldErrors] = useState<string[]>([]);

	const createSupplement = useMutation({
		mutationFn: async () =>
			apiFetch<Supplement>("/api/supplements", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					name: name.trim(),
					// brand 留空轉成 null，不是空字串——理由跟 NewFood.tsx 一樣：
					// 唯一約束（uq_supplements_owner_id_name_brand）對 "" 與 null
					// 是兩個不同的值，留空不轉的話會建出兩筆看起來一樣的補劑。
					brand: brand.trim() === "" ? null : brand.trim(),
					serving_unit: servingUnit.trim(),
					serving_size: servingSize,
					// **四個營養素留空時送字串 "0"，不是省略、也不是 null。**
					// 這是這個 task 兩個要自己判斷的點之一，理由：
					// - **不省略**：後端 `SupplementCreateRequest` 的這四個欄位
					//   雖然有預設值（`Field(default=0)`），但欄位本身仍然是
					//   `Decimal`（必填型別，不是 `Decimal | None`）——這裡的
					//   openapi 產生型別（schema.d.ts 的 `SupplementCreateRequest`）
					//   對這四個欄位也沒有標 `?`，結構上就沒有「可以不帶」這個
					//   選項可用，省略等於自己手動繞過型別給的形狀。
					// - **不送 null**：型別是 `Decimal`、不是 `Decimal | None`，
					//   送 null 會被 Pydantic 擋成 422 VALIDATION_ERROR，不會被
					//   解讀成「沒有」——這是三個選項裡唯一不合法的。
					// - **送 "0"**：跟後端的預設值完全一致，也跟使用者「留空＝
					//   不想記錄熱量」的意圖一致（魚油那類「只想記錄吃了沒」的
					//   補劑，0 就是使用者要的語意）。
					kcal: values.kcal.trim() === "" ? "0" : values.kcal,
					protein_g: values.protein_g.trim() === "" ? "0" : values.protein_g,
					fat_g: values.fat_g.trim() === "" ? "0" : values.fat_g,
					carb_g: values.carb_g.trim() === "" ? "0" : values.carb_g,
				}),
			}),
		onSuccess: (created) => {
			// apiFetch<T> 回的是 T | null（204 → null），201 不會是 null，
			// 但型別上仍要 narrow——truthy 判斷，不是 === undefined
			// （`api/client.ts` 的慣例，`Promise<T | null>` 用 === undefined
			// narrow 不掉 null）。
			if (created) {
				setName("");
				setBrand("");
				setServingUnit("");
				setServingSize("");
				setValues({ kcal: "", protein_g: "", fat_g: "", carb_g: "" });
				// 新增成功後把搜尋框設成新補劑的名字——「新增」跟「當天吃了
				// 點一份進去」在使用者原話裡是同一個動作的兩個步驟，這裡讓它們
				// 在同一個畫面裡一氣呵成：新增完不必再手動打一次名字才找得到
				// 剛建好的補劑。
				setInput(created.name);
			}
		},
		onError: (caught: unknown) => {
			setConflictError(null);
			setFieldErrors([]);
			if (caught instanceof ApiError) {
				if (caught.code === "SUPPLEMENT_EXISTS") {
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

	const checkIn = useMutation({
		mutationFn: recordAdHocIntake,
		onSuccess: () => {
			// 打卡會改變今天吃了多少（補劑也算熱量）——跟 Today.tsx 的
			// invalidateAfterChange 同一個理由，兩個 key 都要失效，只失效
			// supplementsToday 的話總覽的巨量營養素數字不會跟著更新。
			void queryClient.invalidateQueries({
				queryKey: queryKeys.supplementsToday,
			});
			void queryClient.invalidateQueries({ queryKey: queryKeys.dailyStats });
		},
	});

	function validate(): string | null {
		if (name.trim() === "") return "請輸入名稱";
		if (servingUnit.trim() === "") return "請輸入單位";
		if (servingSize.trim() === "") return "請輸入每份份量";
		const size = Number(servingSize);
		if (!Number.isFinite(size) || size <= 0 || size > 10000) {
			return "每份份量必須介於 0 到 10000 之間";
		}
		for (const { field, label, max } of NUMERIC_FIELDS) {
			const raw = values[field];
			if (raw.trim() === "") continue; // 留空合法，送出時轉成 "0"。
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
		createSupplement.mutate();
	}

	return (
		<section>
			<h1>補劑</h1>

			<h2>今日狀態</h2>
			{todayItems.length === 0 ? (
				<p>今天還沒有任何補劑記錄</p>
			) : (
				<ul>
					{todayItems.map((item) => (
						<li
							key={`${item.plan_id ?? "adhoc"}-${item.supplement_id}-${item.intake_id ?? "none"}`}
						>
							<span>{item.supplement_name}</span>
							<span>{statusLabel(item)}</span>
						</li>
					))}
				</ul>
			)}

			<h2>新增補劑</h2>
			<form onSubmit={handleSubmit}>
				<label htmlFor="supplement-name">名稱</label>
				<input
					id="supplement-name"
					type="text"
					maxLength={100}
					value={name}
					onChange={(event) => setName(event.target.value)}
					required
				/>

				<label htmlFor="supplement-brand">品牌（選填）</label>
				<input
					id="supplement-brand"
					type="text"
					maxLength={100}
					value={brand}
					onChange={(event) => setBrand(event.target.value)}
				/>

				<label htmlFor="supplement-serving-unit">單位（例如：顆、粒、g）</label>
				<input
					id="supplement-serving-unit"
					type="text"
					maxLength={50}
					value={servingUnit}
					onChange={(event) => setServingUnit(event.target.value)}
					required
				/>

				<label htmlFor="supplement-serving-size">每份份量</label>
				<input
					id="supplement-serving-size"
					type="text"
					inputMode="decimal"
					value={servingSize}
					onChange={(event) => setServingSize(event.target.value)}
					required
				/>

				{NUMERIC_FIELDS.map(({ field, label }) => (
					<div key={field}>
						<label htmlFor={`supplement-${field}`}>{label}</label>
						<input
							id={`supplement-${field}`}
							type="text"
							inputMode="decimal"
							value={values[field]}
							onChange={(event) =>
								setValues((prev) => ({ ...prev, [field]: event.target.value }))
							}
						/>
					</div>
				))}

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

				<button type="submit" disabled={createSupplement.isPending}>
					新增補劑
				</button>
			</form>

			<h2>找補劑，今天吃了就點一份</h2>
			<label htmlFor="supplement-search-input">搜尋補劑</label>
			<input
				id="supplement-search-input"
				type="text"
				value={input}
				onChange={(event) => setInput(event.target.value)}
			/>

			{hasQuery && (
				<>
					{searchQuery.isLoading && <p>搜尋中…</p>}
					{!searchQuery.isLoading && (searchQuery.data ?? []).length === 0 && (
						<p>找不到符合的補劑</p>
					)}
					<ul>
						{(searchQuery.data ?? []).map((supplement) => (
							<li key={supplement.id}>
								<span>{supplement.name}</span>
								{supplement.brand !== null && <span>{supplement.brand}</span>}
								<button
									type="button"
									disabled={checkIn.isPending}
									onClick={() => checkIn.mutate(supplement.id)}
								>
									今天吃了
								</button>
							</li>
						))}
					</ul>
				</>
			)}
		</section>
	);
}
