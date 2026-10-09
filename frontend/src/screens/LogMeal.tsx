import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type ChangeEvent, useEffect, useRef, useState } from "react";
import { apiFetch } from "../api/client";
import { ApiError, hasFieldError } from "../api/errors";
import { AMOUNT_FORMAT_ERROR } from "../api/expenses";
import { MEAL_TYPE_LABELS, MEAL_TYPE_ORDER } from "../api/meals";
import {
	MAX_PHOTO_BYTES,
	PhotoTooLargeError,
	uploadMealPhoto,
} from "../api/photos";
import { queryKeys } from "../api/queries";
import type { components } from "../api/schema";
import { AiMealPanel } from "../components/AiMealPanel";
import { FoodPicker } from "../components/FoodPicker";
import { PhotoPickerButton } from "../components/PhotoPickerButton";
import {
	PortionQuantityFields,
	usePortionQuantity,
} from "../components/PortionQuantityFields";
import ui from "../components/ui.module.css";
import { isPlainPositiveDecimal } from "../lib/decimal";
import styles from "./LogMeal.module.css";

type Food = components["schemas"]["FoodResponse"];
type MealResponse = components["schemas"]["MealResponse"];
type MealType = components["schemas"]["MealType"];

/** AI 多樣估算加進來的一樣（AI 多樣估算規格 D19）。`quantity` 是直接輸入的量
 *  （g 或 ml），預設 AI 估的；`key` 只給 React 與欄位的 id 用——同一個食物可以出現兩次。 */
type AiItem = { key: number; food: Food; quantity: string };

/** 一個欄位現在的值，加上「AI 填進來的那個值」（沒有填過是 null）。
 *
 *  為什麼要記來歷（審查 M5）：AI 的項目全部移除、表單收起來之後，AI 填的那句描述與
 *  那張照片還留在 state 裡——之後手選一個食物，它們會跟著表單一起回來，一按「記錄」
 *  就記在不相干的一餐上（描述好友看得到）。所以那個時候要清掉，但**只清 AI 填的**：
 *  `value` 仍然等於 `fromAi`（描述比字串、照片比是不是同一個 `File`）才算。使用者
 *  自己打的字、自己選的照片，值跟 `fromAi` 不一樣，永遠不清。
 *
 *  兩個放在同一個 state 裡：要不要採用 AI 的值是在 updater 裡看「現在」的值決定的
 *  （規格 D20），來歷得在同一步一起寫，不然兩邊會對不上。 */
type WithOrigin<T> = { value: T; fromAi: T | null };

const NO_DESCRIPTION: WithOrigin<string> = { value: "", fromAi: null };
const NO_PHOTO: WithOrigin<File | null> = { value: null, fromAi: null };

type Props = {
	/** `photoFailed`：這一餐存好了，但選的照片沒傳上去（規格 §5.4）。 */
	onSaved: (result: { photoFailed: boolean }) => void;
};

/** 餐存好、照片沒傳上去時給總覽顯示的話。補傳走飲食頁 `MealList` 既有的上傳。 */
export const PHOTO_UPLOAD_FAILED_NOTICE =
	"這一餐已記錄，照片沒有傳上去，可以到飲食頁的那一餐補傳";

export function LogMeal({ onSaved }: Props) {
	const queryClient = useQueryClient();
	const [selectedFood, setSelectedFood] = useState<Food | null>(null);
	const portion = usePortionQuantity(selectedFood?.id ?? null);
	// 選填的餐費（P5 規格 §4.1）。有值時 POST /api/meals 會在同一個交易裡
	// 建一筆 category=food、meal_id 指過來的支出。
	const [cost, setCost] = useState("");
	const [isPrivate, setIsPrivate] = useState(false);
	// 這一餐吃了什麼的一句話（AI 多樣估算規格 D13）。好友看得到；跟「備註」是兩回事。
	const [descriptionState, setDescriptionState] = useState(NO_DESCRIPTION);
	const description = descriptionState.value;
	// AI 估的項目。跟上面手選的那一樣（selectedFood）並存：存的時候兩邊都送。
	const [aiItems, setAiItems] = useState<AiItem[]>([]);
	const nextAiKeyRef = useRef(0);
	// 選填的照片（介面改版 §5.4）。選的當下就檢查大小，不要等到存檔才發現。
	const [photoState, setPhotoState] = useState(NO_PHOTO);
	const photo = photoState.value;
	/** 使用者自己選的（或移除）：只換現在的值，AI 填過哪一張照舊記著。 */
	function setPhoto(file: File | null) {
		setPhotoState((current) => ({ ...current, value: file }));
	}
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
	// 面板交回食物後，確認鈕消失、焦點掉到 body：把焦點移到「已選擇」那一行。
	// 只在交回那一次移（旗標），不是每次 render。
	const focusSelectedRef = useRef(false);
	const selectedRef = useRef<HTMLParagraphElement>(null);
	useEffect(() => {
		if (focusSelectedRef.current && selectedRef.current !== null) {
			focusSelectedRef.current = false;
			selectedRef.current.focus();
		}
	});
	// AI 的項目加進來之後，面板收起、「加入」那顆按鈕消失：把焦點移到「AI 估的項目」
	// 的標題（同上面「已選擇」的作法，旗標只在加入那一次移）。
	const focusAiItemsRef = useRef(false);
	const aiItemsHeadingRef = useRef<HTMLHeadingElement>(null);
	useEffect(() => {
		if (focusAiItemsRef.current && aiItemsHeadingRef.current !== null) {
			focusAiItemsRef.current = false;
			aiItemsHeadingRef.current.focus();
		}
	});
	const [mealType, setMealType] = useState<MealType>("snack");
	const [error, setError] = useState<string | null>(null);
	const saveMeal = useMutation({
		mutationFn: async () => {
			// AI 的幾樣在前（估算的順序），手選的那一樣在後。
			const items = [
				...aiItems.map((item) => ({
					food_id: item.food.id,
					// 直接輸入的量（g／ml）：不帶 portion_id。
					quantity: item.quantity.trim(),
				})),
				...(selectedFood === null
					? []
					: [
							{
								food_id: selectedFood.id,
								// 數值一律以字串送出（規格 §5.1），不要 Number()。
								quantity: portion.quantity,
								// quantity_g 不在這裡算——伺服器在寫入當下算好並凍結
								// （交接文件 §4.3）。前端算一次就是把「凍結歷史」
								// 這個保證從另一頭破壞掉。
								...(portion.portionId !== null
									? { portion_id: portion.portionId }
									: {}),
							},
						]),
			];
			if (items.length === 0) {
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
					items,
					// **留空時整個不帶這個欄位**，不是送 "" 也不是送 null。
					// 後端是 `cost: Decimal | None = Field(default=None, gt=0, ...)`：
					// 送 "" 會被 Pydantic 擋成 422；送 null 雖然合法但語意繞了
					// 一圈；不帶讓後端的 default=None 生效，最乾淨。
					...(cost.trim() === "" ? {} : { cost: cost.trim() }),
					// 同 cost：留空（或只有空白）整個不帶。後端會再清一次（控制字元、長度）。
					...(description.trim() === ""
						? {}
						: { description: description.trim() }),
					// 不勾就不帶，後端預設 false＝給好友看（同 cost 的「留空不帶」）。
					...(isPrivate ? { is_private: true } : {}),
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
			portion.reset();
			setCost("");
			// 來歷也歸零：它是跟著這一餐的。
			setDescriptionState(NO_DESCRIPTION);
			setAiItems([]);
			setPhotoState(NO_PHOTO);
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
				(caught.code === "FOOD_HAS_NO_REVISION" ||
					caught.code === "QUANTITY_OUT_OF_RANGE")
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
				hasFieldError(caught, "cost")
			) {
				setError(AMOUNT_FORMAT_ERROR);
				return;
			}
			setError("記錄失敗，請再試一次");
		},
	});

	function removeAiItem(key: number) {
		setAiItems((current) => current.filter((other) => other.key !== key));
		// 這是最後一樣 AI 的項目，而且沒有手選的食物：表單整個收起來。AI 填的描述與
		// 照片跟著清掉（見 `WithOrigin`）。還有手選的食物時表單還在、它們看得到，
		// 留給使用者自己決定。
		const isLast = aiItems.every((item) => item.key === key);
		if (!isLast || selectedFood !== null) return;
		setDescriptionState((current) =>
			current.value === current.fromAi ? NO_DESCRIPTION : current,
		);
		setPhotoState((current) =>
			current.value === current.fromAi ? NO_PHOTO : current,
		);
	}

	return (
		<section className={styles.screen}>
			<h1>記一餐</h1>

			<FoodPicker
				onSelect={setSelectedFood}
				renderBelowSearch={(query) => (
					<AiMealPanel
						text={query}
						onFoodPicked={(food) => {
							// 整段文字就是食物庫裡的食物：跟從清單選一個一樣（份量歸位，
							// 不然上一個食物打的 200 會留下來）。
							portion.reset();
							setSelectedFood(food);
							focusSelectedRef.current = true;
						}}
						onItemsReady={(ready, source) => {
							// key 在 updater 外面先取：updater 可能被 React 呼叫兩次。
							const added = ready.map((item) => ({
								key: nextAiKeyRef.current++,
								food: item.food,
								quantity: item.quantity,
							}));
							setAiItems((current) => [...current, ...added]);
							focusAiItemsRef.current = true;
							// 估算用的照片當這一餐的照片、AI 的那句話當描述——**已經有就不
							// 覆蓋**（規格 D20）。用 updater 看「現在」的值：面板建食物的期間
							// 使用者還能選照片、打字。放進去的是原始檔案（上傳時自己會縮）。
							// 採用的那一刻一起記下來歷（`fromAi`）：之後 AI 的項目全部移除時，
							// 靠它分得出哪些是 AI 填的。
							const { image } = source;
							if (image !== null) {
								setPhotoState((current) =>
									current.value === null
										? { value: image, fromAi: image }
										: current,
								);
								setPhotoError(null);
							}
							setDescriptionState((current) =>
								current.value.trim() === ""
									? { value: source.description, fromAi: source.description }
									: current,
							);
						}}
					/>
				)}
			/>

			{(selectedFood !== null || aiItems.length > 0) && (
				<form
					className={styles.form}
					onSubmit={(event) => {
						event.preventDefault();
						const bad = aiItems.find(
							(item) => !isPlainPositiveDecimal(item.quantity),
						);
						if (bad !== undefined) {
							setError(`「${bad.food.name}」的份量要是大於 0 的數字`);
							return;
						}
						saveMeal.mutate();
					}}
				>
					{aiItems.length > 0 && (
						<section aria-labelledby="meal-ai-items" className={styles.aiItems}>
							<h2 id="meal-ai-items" ref={aiItemsHeadingRef} tabIndex={-1}>
								AI 估的項目
							</h2>
							<ul>
								{aiItems.map((item) => {
									const inputId = `meal-ai-item-${item.key}`;
									const unit = item.food.nutrition?.base_unit ?? "g";
									return (
										<li key={item.key}>
											<label htmlFor={inputId}>
												{`${item.food.name}（${unit}）`}
											</label>
											<input
												id={inputId}
												type="text"
												inputMode="decimal"
												value={item.quantity}
												onChange={(event) => {
													const quantity = event.target.value;
													setAiItems((current) =>
														current.map((other) =>
															other.key === item.key
																? { ...other, quantity }
																: other,
														),
													);
												}}
											/>
											<button
												type="button"
												className={ui.secondary}
												aria-label={`移除 ${item.food.name}`}
												disabled={saveMeal.isPending}
												onClick={() => removeAiItem(item.key)}
											>
												移除
											</button>
										</li>
									);
								})}
							</ul>
						</section>
					)}

					{selectedFood !== null && (
						<>
							{/* 名稱與「不記這一樣」同一列（窄的時候按鈕換行）。沒有按鈕時這一層只是
							    包著那一行字，畫面跟以前一樣。 */}
							<div className={styles.selectedRow}>
								<p ref={selectedRef} tabIndex={-1} className={styles.selected}>
									已選擇：{selectedFood.name}
								</p>
								{/* 只有同時有 AI 的項目時才需要：不然不記這一樣＝整張表單收起來，
								    而且沒有 AI 項目時畫面要跟以前一模一樣。 */}
								{aiItems.length > 0 && (
									<button
										type="button"
										className={ui.secondary}
										disabled={saveMeal.isPending}
										onClick={() => setSelectedFood(null)}
									>
										不記這一樣
									</button>
								)}
							</div>
							<PortionQuantityFields
								state={portion}
								unit={selectedFood.nutrition?.base_unit ?? "g"}
							/>
						</>
					)}

					<label htmlFor="meal-type">餐別</label>
					<select
						id="meal-type"
						value={mealType}
						onChange={(event) => setMealType(event.target.value as MealType)}
					>
						{MEAL_TYPE_ORDER.map((value) => (
							<option key={value} value={value}>
								{MEAL_TYPE_LABELS[value]}
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

					<label htmlFor="meal-description">描述（選填）</label>
					{/* 單行：後端把換行清成空白（`single_line`），這裡用 input 就不會讓人
					    以為可以分段。maxLength 跟後端的 500 一致。 */}
					<input
						id="meal-description"
						type="text"
						maxLength={500}
						value={description}
						aria-describedby="meal-description-hint"
						onChange={(event) => {
							// 只換現在的值：改過的字跟 `fromAi` 不一樣，就不再算 AI 填的。
							const value = event.target.value;
							setDescriptionState((current) => ({ ...current, value }));
						}}
					/>
					<p id="meal-description-hint" className={styles.hint}>
						好友看得到這段描述
					</p>

					<label className={styles.privateToggle}>
						<input
							type="checkbox"
							checked={isPrivate}
							onChange={(event) => setIsPrivate(event.target.checked)}
						/>
						只有我看得到（好友看不到這一餐）
					</label>

					{/* 不加 capture：iPhone 會同時給「拍照」與「從相簿選」
					    （MealList 的補傳有 capture="environment"，那裡的情境是
					    「現在正在吃」，直接開相機比較快）。 */}
					<PhotoPickerButton
						id="meal-photo"
						label="照片（選填）"
						accept="image/*"
						disabled={saveMeal.isPending}
						onChange={handlePhotoChange}
					/>
					{photoPreview !== null && (
						<div className={styles.preview}>
							<img src={photoPreview} alt="選好的照片" />
							{/* 記一餐不在 ui.module.css 的 .screen 裡，通用的按鈕樣式套不到：
							    不指定的話這顆是瀏覽器預設的樣子（同這張表單的「移除 X」）。 */}
							<button
								type="button"
								className={ui.secondary}
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
