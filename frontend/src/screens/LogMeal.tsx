import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Camera } from "lucide-react";
import { type ChangeEvent, useEffect, useState } from "react";
import { apiFetch } from "../api/client";
import { ApiError } from "../api/errors";
import { AMOUNT_FORMAT_ERROR } from "../api/expenses";
import { useFoodSearch } from "../api/foods";
import {
	MAX_PHOTO_BYTES,
	PhotoTooLargeError,
	uploadMealPhoto,
} from "../api/photos";
import { queryKeys } from "../api/queries";
import type { components } from "../api/schema";
import { FoodResultList } from "../components/FoodResultList";
import { formatMacro } from "../lib/decimal";
import { pickDefaultPortion } from "../lib/portions";
import { useDebounced } from "../lib/use-debounced";
import styles from "./LogMeal.module.css";

type Food = components["schemas"]["FoodResponse"];
type Portion = components["schemas"]["PortionResponse"];
type MealResponse = components["schemas"]["MealResponse"];
type MealType = components["schemas"]["MealType"];

type Props = {
	/** `photoFailed`：這一餐存好了，但選的照片沒傳上去（規格 §5.4）。 */
	onSaved: (result: { photoFailed: boolean }) => void;
};

/** 餐存好、照片沒傳上去時給總覽顯示的話。補傳走飲食頁 `MealList` 既有的上傳。 */
export const PHOTO_UPLOAD_FAILED_NOTICE =
	"這一餐已記錄，照片沒有傳上去，可以到飲食頁的那一餐補傳";

const MEAL_TYPES: Array<{ value: MealType; label: string }> = [
	{ value: "breakfast", label: "早餐" },
	{ value: "lunch", label: "午餐" },
	{ value: "dinner", label: "晚餐" },
	{ value: "snack", label: "點心" },
];

/** `FoodResponse.nutrition` 為 `null` 時要顯示的說明。跟 `FoodDetail.tsx`
 *  「目前生效的營養素」區塊的空狀態用同一句文字——不重寫一份是為了不讓
 *  兩處的說法飄走。 */
const NO_REVISION_MESSAGE = "這個食物還沒有生效的營養素資料";

/** `VALIDATION_ERROR` 可能來自 `cost`，也可能來自 `items[0].quantity`——
 *  兩者是同一次 POST 的不同欄位。看 `details.errors` 的 `loc` 確認錯誤
 *  真的是 `cost` 才顯示金額專屬訊息，不然份量填錯會被誤報成「金額格式
 *  不對」。 */
function isCostValidationError(error: ApiError): boolean {
	const raw = error.details.errors;
	if (!Array.isArray(raw)) return false;
	return raw.some((item) => {
		if (typeof item !== "object" || item === null) return false;
		const loc = (item as { loc?: unknown }).loc;
		return Array.isArray(loc) && loc.includes("cost");
	});
}

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
 *  所以按鈕（見 `selectFood` 的呼叫端）要 `disabled`，這裡旁邊要講清楚
 *  原因。`409 FOOD_HAS_NO_REVISION` 仍然要具名處理（見 `saveMeal` 的
 *  `onError`）——disabled 擋的是送出當下已知的狀態，搜尋到送出之間，
 *  食物有可能剛好失去生效版本，具名 409 是後備，兩者都要。 */
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

export function LogMeal({ onSaved }: Props) {
	const queryClient = useQueryClient();
	const [selectedFood, setSelectedFood] = useState<Food | null>(null);
	// 份量的選擇（食物份量規格 §6）：
	//   null     → 使用者還沒動過，用推導出來的預設份量（有的話）
	//   "manual" → 使用者選了「直接輸入數量」
	//   number   → 使用者選了某個份量
	// **不用 effect 在份量清單到的時候寫 state**：預設份量是從清單推導的，
	// 使用者一旦手動選過就以使用者為準，不會被重新抓到的清單蓋回去。
	const [portionChoice, setPortionChoice] = useState<number | "manual" | null>(
		null,
	);
	const [quantity, setQuantity] = useState("1");
	// 選填的餐費（P5 規格 §4.1）。有值時 POST /api/meals 會在同一個交易裡
	// 建一筆 category=food、meal_id 指過來的支出。
	const [cost, setCost] = useState("");
	// 選填的照片（介面改版 §5.4）。選的當下就檢查大小，不要等到存檔才發現。
	const [photo, setPhoto] = useState<File | null>(null);
	const [photoError, setPhotoError] = useState<string | null>(null);
	const [photoPreview, setPhotoPreview] = useState<string | null>(null);

	useEffect(() => {
		if (photo === null) {
			setPhotoPreview(null);
			return;
		}
		const url = URL.createObjectURL(photo);
		setPhotoPreview(url);
		// 換照片或離開畫面時釋放，不然每選一次就漏一份 blob。
		return () => URL.revokeObjectURL(url);
	}, [photo]);

	function handlePhotoChange(event: ChangeEvent<HTMLInputElement>) {
		const file = event.target.files?.[0] ?? null;
		// 清掉 input 自己的值：「移除」之後再選同一張，change 才會再觸發。
		event.target.value = "";
		if (file !== null && file.size > MAX_PHOTO_BYTES) {
			setPhoto(null);
			setPhotoError(new PhotoTooLargeError().message);
			return;
		}
		setPhotoError(null);
		setPhoto(file);
	}
	const [mealType, setMealType] = useState<MealType>("snack");
	const [error, setError] = useState<string | null>(null);
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
	// 兩邊選完之後的去向不一樣（這裡進份量輸入，食物庫進詳情頁）。
	// 這裡不給 scope 選擇器：記一餐要的是「這個字能不能找到食物」，
	// 不是像食物庫那樣要瀏覽「我建立的」跟「公開的」的差異。
	const debouncedSearch = useDebounced(searchInput, 300);
	const hasSearchQuery = debouncedSearch.trim() !== "";
	const searchQuery = useFoodSearch(debouncedSearch, "all");

	const portionsQuery = useQuery({
		queryKey: queryKeys.portions(selectedFood?.id ?? 0),
		queryFn: () =>
			apiFetch<Portion[]>(`/api/foods/${selectedFood?.id}/portions`),
		enabled: selectedFood !== null,
	});

	const defaultPortion = pickDefaultPortion(portionsQuery.data ?? []);
	const portionId =
		portionChoice === "manual"
			? null
			: (portionChoice ?? defaultPortion?.id ?? null);

	const saveMeal = useMutation({
		mutationFn: async () => {
			if (selectedFood === null) {
				throw new Error("尚未選擇食物");
			}
			const meal = await apiFetch<MealResponse>("/api/meals", {
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
					// **留空時整個不帶這個欄位**，不是送 "" 也不是送 null。
					// 後端是 `cost: Decimal | None = Field(default=None, gt=0, ...)`：
					// 送 "" 會被 Pydantic 擋成 422；送 null 雖然合法但語意繞了
					// 一圈；不帶讓後端的 default=None 生效，最乾淨。
					...(cost.trim() === "" ? {} : { cost: cost.trim() }),
				}),
			});
			if (photo === null) return { photoFailed: false };
			// 後端成功時一定回 MealResponse；null 代表 apiFetch 的假設被破壞了，
			// 照片沒地方傳——當成照片失敗，不是整筆失敗。
			if (meal === null) return { photoFailed: true };
			// **第二步失敗不算整筆失敗**（規格 §5.4）：這一餐（含餐費）已經在
			// 後端了。讓 mutation 失敗，使用者會以為沒記到、再記一次——那就是
			// 重複記錢。
			try {
				await uploadMealPhoto(meal.id, photo);
				return { photoFailed: false };
			} catch {
				return { photoFailed: true };
			}
		},
		onSuccess: (result) => {
			// 這一行是這份計畫的核心。少了它，記完一餐回到總覽會看到舊數字，
			// 使用者會以為沒記進去——然後再記一次。
			queryClient.invalidateQueries({ queryKey: queryKeys.dailyStats });
			// 記完一餐，趨勢圖上「今天」那根柱子也變了。不加這一行的話，
			// 記完切到趨勢看到的是舊的數字。
			//
			// **用前綴 `["stats", "range"]` 是刻意的**：rangeStats 的 key 帶
			// from / to 兩個參數，要失效的是「所有期間」。這個前綴不會碰到
			// `["stats", "daily"]`（規格 §7.2）。
			//
			// **而這一行是那條路徑唯一的守衛。** staleTime 是 60 秒，切換路由
			// 的 unmount／remount 不會自動重取（計畫二 Task 6 為此補上的），
			// 所以刪掉它，e2e/trend.spec.ts 會紅。
			queryClient.invalidateQueries({ queryKey: queryKeys.rangeStatsAll });
			// 常吃/最近吃的排序也變了。
			queryClient.invalidateQueries({ queryKey: queryKeys.frequentFoods });
			queryClient.invalidateQueries({ queryKey: queryKeys.recentFoods });
			// 新記的這一餐要出現在今日餐點清單裡——跟上面 dailyStats 那行
			// 同一類，而且同樣沒有單元測試守得到（計畫三 Task 1 實測確認
			// 過：拿掉這一行，本檔案的既有測試依然全線通過）。Task 5 的
			// E2E 會一起守這一行與 dailyStats 那一行。
			queryClient.invalidateQueries({ queryKey: queryKeys.meals });
			// 餐費會建出一筆支出——記帳的清單與報表都要重取。
			queryClient.invalidateQueries({ queryKey: queryKeys.expensesAll });
			setSelectedFood(null);
			setPortionChoice(null);
			setQuantity("1");
			setCost("");
			setPhoto(null);
			setPhotoError(null);
			setError(null);
			onSaved(result);
		},
		onError: (caught: unknown) => {
			// disabled 按鈕擋的是送出當下已知的狀態；搜尋到送出之間，
			// 食物有可能剛好失去生效版本（例如它的提案在這段時間被駁回），
			// 所以這個 409 仍然要具名處理，不能只靠前端擋（規格 §5.5）。
			if (
				caught instanceof ApiError &&
				caught.code === "FOOD_HAS_NO_REVISION"
			) {
				// 訊息直接用後端回的——跟 FoodDetail.tsx 處理
				// REVISION_PENDING 同一個理由：前端重寫一份只會有兩份文字
				// 互相飄走的風險。
				setError(caught.message);
				return;
			}
			// cost 對齊 expenses.amount 的同一條後端限制（gt=0、最多兩位
			// 小數）。VALIDATION_ERROR 也可能來自 quantity，所以要看
			// details.errors 的 loc 確認是 cost 欄位才顯示這句，不然會
			// 誤導成「金額填錯」但其實是份量填錯。
			if (
				caught instanceof ApiError &&
				caught.code === "VALIDATION_ERROR" &&
				isCostValidationError(caught)
			) {
				setError(AMOUNT_FORMAT_ERROR);
				return;
			}
			setError("記錄失敗，請再試一次");
		},
	});

	function selectFood(food: Food) {
		setSelectedFood(food);
		setPortionChoice(null);
	}

	const foods = dedupeById([frequentQuery.data ?? [], recentQuery.data ?? []]);

	return (
		<section className={styles.screen}>
			<h1>記一餐</h1>

			<div className={styles.search}>
				<label htmlFor="food-search-input">搜尋食物</label>
				<input
					id="food-search-input"
					type="text"
					value={searchInput}
					onChange={(event) => setSearchInput(event.target.value)}
				/>
			</div>

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
								onClick={() => selectFood(food)}
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
							onClick={() => selectFood(food)}
						>
							{food.name}
						</button>
						<NutritionPreview nutrition={food.nutrition} />
					</li>
				))}
			</ul>

			{selectedFood !== null && (
				<form
					className={styles.form}
					onSubmit={(event) => {
						event.preventDefault();
						saveMeal.mutate();
					}}
				>
					<p className={styles.selected}>已選擇：{selectedFood.name}</p>

					{portionsQuery.data !== undefined &&
						portionsQuery.data !== null &&
						portionsQuery.data.length > 0 && (
							<>
								<label htmlFor="portion">份量選項</label>
								<select
									id="portion"
									value={portionId ?? ""}
									onChange={(event) =>
										setPortionChoice(
											event.target.value === ""
												? "manual"
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
					{/* 選了份量時數量是「幾份」；直接輸入時是公克（或毫升）——
					    預設的「1」在直接輸入模式下是 1 g，這個提示讓它看得出來。 */}
					<span className={styles.unit} data-testid="quantity-unit">
						{portionId !== null
							? "份"
							: (selectedFood.nutrition?.base_unit ?? "g")}
					</span>

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

					<label htmlFor="meal-cost">金額（選填）</label>
					{/* 填了就會在同一個交易裡記一筆餐費（規格 §4.1）。
					    inputMode="decimal" 讓手機跳數字鍵盤；字級由 index.css
					    的全域規則保證 ≥16px（iOS Safari 的自動放大，P3-C 踩過）。 */}
					<input
						id="meal-cost"
						type="text"
						inputMode="decimal"
						value={cost}
						onChange={(event) => setCost(event.target.value)}
					/>

					<label htmlFor="meal-photo" className={styles.photoButton}>
						<Camera aria-hidden="true" size={18} />
						照片（選填）
					</label>
					{/* 不加 capture：iPhone 會同時給「拍照」與「從相簿選」
					    （MealList 的補傳有 capture="environment"，那裡的情境是
					    「現在正在吃」，直接開相機比較快）。 */}
					<input
						id="meal-photo"
						type="file"
						accept="image/*"
						className={styles.fileInput}
						disabled={saveMeal.isPending}
						onChange={handlePhotoChange}
					/>
					{photoPreview !== null && (
						<div className={styles.preview}>
							<img src={photoPreview} alt="選好的照片" />
							<button
								type="button"
								disabled={saveMeal.isPending}
								onClick={() => setPhoto(null)}
							>
								移除照片
							</button>
						</div>
					)}
					{photoError !== null && <p role="alert">{photoError}</p>}

					{error !== null && <p role="alert">{error}</p>}
					<button
						type="submit"
						className={styles.save}
						disabled={saveMeal.isPending}
					>
						{saveMeal.isPending ? "儲存中…" : "記錄"}
					</button>
				</form>
			)}
		</section>
	);
}
