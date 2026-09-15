import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { apiFetch } from "../api/client";
import { queryKeys } from "../api/queries";
import type { components } from "../api/schema";
import { formatMacro } from "../lib/decimal";

type Food = components["schemas"]["FoodResponse"];
type Portion = components["schemas"]["PortionResponse"];
type MealResponse = components["schemas"]["MealResponse"];
type MealType = components["schemas"]["MealType"];

type Props = { onSaved: () => void };

const MEAL_TYPES: Array<{ value: MealType; label: string }> = [
	{ value: "breakfast", label: "早餐" },
	{ value: "lunch", label: "午餐" },
	{ value: "dinner", label: "晚餐" },
	{ value: "snack", label: "點心" },
];

/** 一個食物項目的營養素預覽。
 *
 *  **`nutrition` 可以是 `null`**（`FoodResponse.nutrition` 的註解：「沒有生效
 *  版本時為 None——全域食物的初版被駁回就會是這個狀態」）。這不是理論上的
 *  邊界情況，是後端明寫的合法狀態，所以這個食物仍然要能被選、只是不顯示
 *  預覽——不能 `nutrition!.kcal` 直接取值，那種食物會讓畫面直接炸掉。 */
function NutritionPreview({ nutrition }: { nutrition: Food["nutrition"] }) {
	if (nutrition === null) return null;
	return <span>{formatMacro(nutrition.kcal)} kcal</span>;
}

function dedupeById(lists: Food[][]): Food[] {
	const seen = new Set<number>();
	const result: Food[] = [];
	for (const list of lists) {
		for (const food of list) {
			if (seen.has(food.id)) continue;
			seen.add(food.id);
			result.push(food);
		}
	}
	return result;
}

export function LogMeal({ onSaved }: Props) {
	const queryClient = useQueryClient();
	const [selectedFood, setSelectedFood] = useState<Food | null>(null);
	const [portionId, setPortionId] = useState<number | null>(null);
	const [quantity, setQuantity] = useState("1");
	const [mealType, setMealType] = useState<MealType>("snack");
	const [error, setError] = useState<string | null>(null);

	// P1 規格第 11 節：這兩個端點的索引就是為了這個畫面顧的——
	// 「記一餐」是每天走最多次的路徑（規格 §7.1）。
	const frequentQuery = useQuery({
		queryKey: queryKeys.frequentFoods,
		queryFn: () => apiFetch<Food[]>("/api/foods/frequent"),
	});
	const recentQuery = useQuery({
		queryKey: queryKeys.recentFoods,
		queryFn: () => apiFetch<Food[]>("/api/foods/recent"),
	});

	const portionsQuery = useQuery({
		queryKey: queryKeys.portions(selectedFood?.id ?? 0),
		queryFn: () =>
			apiFetch<Portion[]>(`/api/foods/${selectedFood?.id}/portions`),
		enabled: selectedFood !== null,
	});

	const saveMeal = useMutation({
		mutationFn: async () => {
			if (selectedFood === null) {
				throw new Error("尚未選擇食物");
			}
			return apiFetch<MealResponse>("/api/meals", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					// 一個時刻，不是一個日期——規格 §5.3：eaten_at 是
					// timestamptz，收發都用 ISO 8601 含時區。跟「不要自己算
					// 日界線」不衝突：送一個精確的時刻沒問題，自己算「今天是
					// 哪一天」才是建立第二個事實來源。
					eaten_at: new Date().toISOString(),
					meal_type: mealType,
					items: [
						{
							food_id: selectedFood.id,
							// 數值一律以字串送出（規格 §5.1），不要 Number()。
							quantity,
							// quantity_g 不在這裡算——伺服器在寫入當下算好並凍結
							// （交接文件 §4.3）。前端算一次就是把「凍結歷史」
							// 這個保證從另一頭破壞掉。
							...(portionId !== null ? { portion_id: portionId } : {}),
						},
					],
				}),
			});
		},
		onSuccess: () => {
			// 這一行是這份計畫的核心。少了它，記完一餐回到總覽會看到舊數字，
			// 使用者會以為沒記進去——然後再記一次。
			queryClient.invalidateQueries({ queryKey: queryKeys.dailyStats });
			// 常吃/最近吃的排序也變了。
			queryClient.invalidateQueries({ queryKey: queryKeys.frequentFoods });
			queryClient.invalidateQueries({ queryKey: queryKeys.recentFoods });
			setSelectedFood(null);
			setPortionId(null);
			setQuantity("1");
			setError(null);
			onSaved();
		},
		onError: () => setError("記錄失敗，請再試一次"),
	});

	const foods = dedupeById([frequentQuery.data ?? [], recentQuery.data ?? []]);

	return (
		<section>
			<h1>記一餐</h1>

			{frequentQuery.isLoading && <p>載入中…</p>}

			<ul>
				{foods.map((food) => (
					<li key={food.id}>
						<button
							type="button"
							onClick={() => {
								setSelectedFood(food);
								setPortionId(null);
							}}
						>
							{food.name}
						</button>
						<NutritionPreview nutrition={food.nutrition} />
					</li>
				))}
			</ul>

			{selectedFood !== null && (
				<form
					onSubmit={(event) => {
						event.preventDefault();
						saveMeal.mutate();
					}}
				>
					<p>已選擇：{selectedFood.name}</p>

					{portionsQuery.data !== undefined &&
						portionsQuery.data !== null &&
						portionsQuery.data.length > 0 && (
							<>
								<label htmlFor="portion">份量選項</label>
								<select
									id="portion"
									value={portionId ?? ""}
									onChange={(event) =>
										setPortionId(
											event.target.value === ""
												? null
												: Number(event.target.value),
										)
									}
								>
									<option value="">直接輸入數量</option>
									{portionsQuery.data.map((portion) => (
										<option key={portion.id} value={portion.id}>
											{portion.label}
										</option>
									))}
								</select>
							</>
						)}

					<label htmlFor="quantity">份量</label>
					<input
						id="quantity"
						type="text"
						inputMode="decimal"
						value={quantity}
						onChange={(event) => setQuantity(event.target.value)}
						required
					/>

					<label htmlFor="meal-type">餐別</label>
					<select
						id="meal-type"
						value={mealType}
						onChange={(event) => setMealType(event.target.value as MealType)}
					>
						{MEAL_TYPES.map((option) => (
							<option key={option.value} value={option.value}>
								{option.label}
							</option>
						))}
					</select>

					{error !== null && <p role="alert">{error}</p>}
					<button type="submit" disabled={saveMeal.isPending}>
						記錄
					</button>
				</form>
			)}
		</section>
	);
}
