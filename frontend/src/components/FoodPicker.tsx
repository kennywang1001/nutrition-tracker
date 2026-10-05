import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { apiFetch } from "../api/client";
import { type Food, useFoodSearch } from "../api/foods";
import { queryKeys } from "../api/queries";
import { formatMacro } from "../lib/decimal";
import { useDebounced } from "../lib/use-debounced";
import styles from "./FoodPicker.module.css";
import { FoodResultList } from "./FoodResultList";

/** `FoodResponse.nutrition` 為 `null` 時要顯示的說明。跟 `FoodDetail.tsx`
 *  「目前生效的營養素」區塊的空狀態用同一句文字——不重寫一份是為了不讓
 *  兩處的說法飄走。 */
const NO_REVISION_MESSAGE = "這個食物還沒有生效的營養素資料";

/** 一個食物項目的營養素預覽，同時決定這個食物能不能被選。
 *
 *  **`nutrition` 可以是 `null`**（`FoodResponse.nutrition` 的註解：「沒有生效
 *  版本時為 None——全域食物的初版被駁回就會是這個狀態」）。這不是理論上的
 *  邊界情況，是後端明寫的合法狀態。
 *
 *  **這種食物不能被選。** 舊版這裡的註解寫「仍然要能被選、只是不顯示
 *  預覽」——那句話是錯的，而且是實測確認過的錯：`search_foods` /
 *  `list_frequent_foods` / `list_recent_foods` 三個列表端點都用
 *  `outerjoin`，沒有一個把它過濾掉，所以這種食物「查得到」；但
 *  `POST /api/meals` 對它一律回 `409 FOOD_HAS_NO_REVISION`
 *  （`app/api/routes/meals.py`），所以「記不了」。照舊版寫法做的話，
 *  使用者會選了食物、填好份量、按下「記錄」，然後看到 `onError` 的通用
 *  訊息「記錄失敗，請再試一次」——而再試一次永遠不會成功。
 *
 *  所以本檔的兩個選擇按鈕要 `disabled`，這裡旁邊要講清楚原因。
 *  `409 FOOD_HAS_NO_REVISION` 仍然要由呼叫端具名處理（`LogMeal.tsx` 的
 *  `saveMeal` `onError`；編輯餐點的畫面也一樣）——disabled 擋的是送出
 *  當下已知的狀態，搜尋到送出之間，食物有可能剛好失去生效版本，具名
 *  409 是後備，兩者都要。 */
function NutritionPreview({ nutrition }: { nutrition: Food["nutrition"] }) {
	if (nutrition === null) {
		return <span className="food-no-nutrition">{NO_REVISION_MESSAGE}</span>;
	}
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

type Props = {
	/** 選了一個食物。`nutrition === null` 的食物按鈕是 disabled，不會走到這裡。 */
	onSelect: (food: Food) => void;
	/** 選填：放在搜尋框正下方的東西，拿到目前的搜尋字（trim 過）。記一餐用它
	 *  放 AI 估算面板（AI 估算前端規格 §5.1）；編輯這一餐的「加一項」不給。 */
	renderBelowSearch?: (query: string) => ReactNode;
};

/** 搜尋框＋常吃／最近吃清單（記一餐與編輯餐點的「加一項」共用）。
 *
 *  **回 fragment**：搜尋框、結果、清單直接落在呼叫端的版面裡，記一餐的
 *  畫面結構跟抽出來之前一樣。
 *
 *  食物庫不用這個元件——那邊選完是進詳情頁，而且有 scope 選擇器
 *  （見 `useFoodSearch` 的註解）。 */
export function FoodPicker({ onSelect, renderBelowSearch }: Props) {
	const [searchInput, setSearchInput] = useState("");

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

	// 規格 §5.4：跟食物庫共用同一支 useFoodSearch query hook，不共用元件——
	// 兩邊選完之後的去向不一樣。這裡不給 scope 選擇器：要的是「這個字能不能
	// 找到食物」，不是瀏覽「我建立的」跟「公開的」的差異。
	const debouncedSearch = useDebounced(searchInput, 300);
	const hasSearchQuery = debouncedSearch.trim() !== "";
	const searchQuery = useFoodSearch(debouncedSearch, "all");

	const foods = dedupeById([frequentQuery.data ?? [], recentQuery.data ?? []]);

	return (
		<>
			<div className={styles.search}>
				<label htmlFor="food-search-input">搜尋食物</label>
				<input
					id="food-search-input"
					type="text"
					value={searchInput}
					onChange={(event) => setSearchInput(event.target.value)}
				/>
			</div>
			{renderBelowSearch?.(searchInput.trim())}

			{hasSearchQuery && (
				<>
					{searchQuery.isLoading && <p>搜尋中…</p>}
					<FoodResultList
						foods={searchQuery.data ?? []}
						noNutritionMessage={NO_REVISION_MESSAGE}
						renderAction={(food) => (
							<button
								type="button"
								disabled={food.nutrition === null}
								onClick={() => onSelect(food)}
							>
								{food.name}
							</button>
						)}
					/>
				</>
			)}

			{frequentQuery.isLoading && <p>載入中…</p>}

			<ul className={styles.foods}>
				{foods.map((food) => (
					<li key={food.id}>
						<button
							type="button"
							disabled={food.nutrition === null}
							onClick={() => onSelect(food)}
						>
							{food.name}
						</button>
						<NutritionPreview nutrition={food.nutrition} />
					</li>
				))}
			</ul>
		</>
	);
}
