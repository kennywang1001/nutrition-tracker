import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { useParams } from "react-router";
import { apiFetch } from "../api/client";
import { ApiError } from "../api/errors";
import { useFood, useFoodRevisions } from "../api/foods";
import { queryKeys } from "../api/queries";
import type { components } from "../api/schema";
import { formatMacro } from "../lib/decimal";
import {
	BASE_UNITS,
	describeFieldErrors,
	NUMERIC_FIELDS,
	type NumericField,
} from "./NewFood";

type Revision = components["schemas"]["RevisionResponse"];
type Portion = components["schemas"]["PortionResponse"];
type BaseUnit = components["schemas"]["BaseUnit"];
type RevisionStatus = components["schemas"]["RevisionStatus"];

const STATUS_LABEL: Record<RevisionStatus, string> = {
	pending: "審核中",
	approved: "已通過",
	rejected: "已駁回",
};

/** 食物詳情、編輯歷史、提議修改（規格 §5.3）。
 *
 *  三個 query 都掛在 `queryKeys.food(id)` 這個前綴族底下（`food` /
 *  `foodRevisions` / 這裡內嵌的 `portions`）——提議修改成功後只失效
 *  `queryKeys.food(id)` 一個 key，三個就會一起重取（`api/queries.ts` 的
 *  註解、規格 §7.1）。 */
export function FoodDetail() {
	// useParams() 回傳的是 string | undefined——Number(undefined) 是 NaN，
	// 會讓 useFood / useFoodRevisions 打出 /api/foods/NaN。foods.ts 的
	// useFood / useFoodRevisions 已經用 enabled: Number.isFinite() 擋掉了
	// 實際發請求；這裡還是要另外處理畫面該顯示什麼（不能讓三個 query
	// 永遠停在 loading，那看起來像是壞掉了，不是「網址不對」）。
	const params = useParams<{ id: string }>();
	const foodId = params.id !== undefined ? Number(params.id) : Number.NaN;
	const validId = Number.isFinite(foodId);

	const foodQuery = useFood(foodId);
	const revisionsQuery = useFoodRevisions(foodId);
	const portionsQuery = useQuery({
		queryKey: queryKeys.portions(foodId),
		queryFn: () => apiFetch<Portion[]>(`/api/foods/${foodId}/portions`),
		enabled: validId,
	});

	const queryClient = useQueryClient();
	const food = foodQuery.data ?? null;

	const [baseUnit, setBaseUnit] = useState<BaseUnit>("g");
	const [values, setValues] = useState<Record<NumericField, string>>({
		kcal: "",
		protein_g: "",
		fat_g: "",
		carb_g: "",
	});
	const [changeNote, setChangeNote] = useState("");
	const [clientError, setClientError] = useState<string | null>(null);
	const [conflictError, setConflictError] = useState<string | null>(null);
	const [fieldErrors, setFieldErrors] = useState<string[]>([]);
	const [successMessage, setSuccessMessage] = useState<string | null>(null);

	const proposeRevision = useMutation({
		mutationFn: async () =>
			apiFetch<Revision>(`/api/foods/${foodId}/revisions`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					nutrition: {
						base_unit: baseUnit,
						// 四個數值一律以字串送出（規格 §5.1），刻意不 Number() 轉一手。
						kcal: values.kcal,
						protein_g: values.protein_g,
						fat_g: values.fat_g,
						carb_g: values.carb_g,
					},
					change_note: changeNote.trim() === "" ? null : changeNote.trim(),
				}),
			}),
		onSuccess: () => {
			// **刻意只失效這一個 key。** queryKeys.food(id) 是 portions 與
			// foodRevisions 的前綴，一次 invalidate 打到三個是刻意的
			// （api/queries.ts 的註解、規格 §7.1）：私人食物立刻生效，
			// 目前數值要換；全域食物送審，編輯歷史要多一筆「審核中」。
			queryClient.invalidateQueries({ queryKey: queryKeys.food(foodId) });
			setValues({ kcal: "", protein_g: "", fat_g: "", carb_g: "" });
			setChangeNote("");
			setClientError(null);
			setConflictError(null);
			setFieldErrors([]);
			// is_global 到「這是我的」這一步的推導見下面表單區塊的註解——
			// 這裡直接用同一個布林值決定送出之後要講哪一種結果。
			setSuccessMessage(
				food?.is_global
					? "已送出，正在等待管理員審核（送審），審核通過前畫面上的數值不會改變。"
					: "已更新，立刻生效。",
			);
		},
		onError: (caught: unknown) => {
			setSuccessMessage(null);
			setConflictError(null);
			setFieldErrors([]);
			if (caught instanceof ApiError) {
				if (caught.code === "REVISION_PENDING") {
					// 訊息直接用後端回的——後端已經是那句要求的文字
					// 「這個食物已經有一筆待審的編輯，請等審核完成」，
					// 前端重寫一份只會有兩份文字互相飄走的風險。
					setConflictError(caught.message);
					return;
				}
				if (caught.code === "VALIDATION_ERROR") {
					setFieldErrors(describeFieldErrors(caught));
					return;
				}
			}
			setClientError("送出失敗，請再試一次");
		},
	});

	if (!validId) {
		return (
			<section>
				<p>找不到這個食物</p>
			</section>
		);
	}

	function validate(): string | null {
		for (const { field, label, max } of NUMERIC_FIELDS) {
			const raw = values[field];
			if (raw.trim() === "") return `請輸入${label}`;
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
		setSuccessMessage(null);
		const validationError = validate();
		if (validationError !== null) {
			setClientError(validationError);
			return;
		}
		proposeRevision.mutate();
	}

	const revisions = revisionsQuery.data ?? [];
	const portions = portionsQuery.data ?? [];

	return (
		<section>
			{foodQuery.isLoading && <p>載入中…</p>}

			{food !== null && (
				<>
					<h1>{food.name}</h1>
					{food.brand !== null && <p>{food.brand}</p>}

					<section>
						<h2>目前生效的營養素</h2>
						{food.nutrition === null ? (
							// 規格 §5.5：後端明寫的合法狀態（全域食物的初版被駁回）。
							// 空白一片或 NaN 會讓人以為畫面壞了，所以明講。
							<p>這個食物還沒有生效的營養素資料</p>
						) : (
							<dl>
								<dt>熱量</dt>
								<dd>
									{formatMacro(food.nutrition.kcal)} kcal / 100
									{food.nutrition.base_unit}
								</dd>
								<dt>蛋白質</dt>
								<dd>{formatMacro(food.nutrition.protein_g)} g</dd>
								<dt>脂肪</dt>
								<dd>{formatMacro(food.nutrition.fat_g)} g</dd>
								<dt>碳水化合物</dt>
								<dd>{formatMacro(food.nutrition.carb_g)} g</dd>
							</dl>
						)}
					</section>

					<section>
						<h2>份量</h2>
						{/* 唯讀：只顯示 GET /api/foods/{id}/portions 的結果，沒有新增或
							修改的表單——份量管理 UI 不在 P3-B 範圍（規格 §1.4、§5.3）。 */}
						{portions.length === 0 ? (
							<p>這個食物還沒有份量資料</p>
						) : (
							<ul>
								{portions.map((portion) => (
									<li key={portion.id}>
										{portion.label}（{formatMacro(portion.grams)} g）
										{portion.is_default && "・預設"}
									</li>
								))}
							</ul>
						)}
					</section>

					<section>
						<h2>編輯歷史</h2>
						{revisions.length === 0 ? (
							<p>還沒有編輯歷史</p>
						) : (
							<ul>
								{revisions.map((revision) => (
									<li key={revision.id}>
										<p>
											{/* status 與「目前生效」各自包一層 <span>，不要讓兩個文字
											   節點黏在同一個 <p> 裡變成一串連續字——那樣
											   `getByText("已通過")` 找不到東西：is_current 的那一筆組出來的
											   文字是「已通過・目前生效」，不是「已通過」本身（RTL 預設是精確
											   比對整個節點的 textContent，實測踩過）。 */}
											<span>{STATUS_LABEL[revision.status]}</span>
											{revision.is_current && <span>・目前生效</span>}
										</p>
										{revision.change_note !== null && (
											<p>{revision.change_note}</p>
										)}
										<p>{revision.created_at}</p>
										{/* reject_reason 不是裝飾：沒有它，送審就是一個回了 201
											之後永遠沒有下文的黑洞——使用者不知道提案被駁回了，
											更不知道為什麼（規格 §5.3）。 */}
										{revision.status === "rejected" &&
											revision.reject_reason !== null && (
												<p>駁回原因：{revision.reject_reason}</p>
											)}
									</li>
								))}
							</ul>
						)}
					</section>

					<section>
						<h2>提議修改</h2>

						{/* is_global 到「這是我的」這一步的推導不是自明的，寫進註解：
							FoodResponse 沒有 owner_id 欄位，只有 is_global。
							is_global === false ⟹ owner_id 不是 null
							                    ⟹ 而可見性過濾保證你只看得到
							                       owner_id IS NULL 或 owner_id = 你
							                    ⟹ 所以 owner_id 就是你。
							這一步依賴的是可見性過濾這個【外部保證】，不是這個回應
							本身帶的資訊（規格 §5.3、後端 app/api/routes/foods.py
							的 propose_revision）。

							不講清楚的後果是具體的：使用者改了一個全域食物的數值，
							按下送出，回到詳情看到的還是舊數字（提案在 PENDING，
							current_revision_id 沒動），於是認為功能壞了，再送一次，
							然後撞上 409 REVISION_PENDING。 */}
						{food.is_global ? (
							<p>
								這是公開食物，送出後需要管理員審核（送審），審核通過前畫面上的數值不會改變。
							</p>
						) : (
							<p>這是你自己的食物，送出後立刻生效。</p>
						)}

						<form onSubmit={handleSubmit}>
							<label htmlFor="revision-base-unit">單位</label>
							<select
								id="revision-base-unit"
								value={baseUnit}
								onChange={(event) =>
									setBaseUnit(event.target.value as BaseUnit)
								}
							>
								{BASE_UNITS.map((option) => (
									<option key={option.value} value={option.value}>
										{option.label}
									</option>
								))}
							</select>

							{NUMERIC_FIELDS.map(({ field, label }) => (
								<div key={field}>
									<label htmlFor={`revision-${field}`}>{label}</label>
									<input
										id={`revision-${field}`}
										type="text"
										inputMode="decimal"
										value={values[field]}
										onChange={(event) =>
											setValues((prev) => ({
												...prev,
												[field]: event.target.value,
											}))
										}
										required
									/>
								</div>
							))}

							<label htmlFor="revision-change-note">備註（選填）</label>
							<textarea
								id="revision-change-note"
								maxLength={500}
								value={changeNote}
								onChange={(event) => setChangeNote(event.target.value)}
							/>

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
							{successMessage !== null && <p>{successMessage}</p>}

							<button type="submit" disabled={proposeRevision.isPending}>
								送出
							</button>
						</form>
					</section>
				</>
			)}
		</section>
	);
}
