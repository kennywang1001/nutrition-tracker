import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router";
import { apiFetch } from "../api/client";
import { queryKeys } from "../api/queries";
import type { components } from "../api/schema";
import { useDailyStats } from "../api/stats";
import { Card } from "../components/Card";
import { MacroBar } from "../components/MacroBar";
import ui from "../components/ui.module.css";
import { formatTime } from "../lib/dates";
import { formatMacro } from "../lib/decimal";
import { FriendFeed } from "./FriendFeed";
import { MealList } from "./MealList";
import styles from "./Today.module.css";

type TodaySupplementItem = components["schemas"]["TodaySupplementItem"];

/** 打卡：`POST /api/supplement-intakes`。`taken_at` 是「現在這一刻」，不是
 *  「今天」—— 記錄一個明確的 instant，跟 `lib/dates.ts` 頂端那條「不算日界線」
 *  的規矩無關：後端會用 `taken_at` 落在哪個 `day_bounds()` 半開區間來判斷
 *  它屬於哪一天，前端不用、也不該替它做這個判斷。 */
async function checkInSupplement(item: TodaySupplementItem): Promise<void> {
	await apiFetch("/api/supplement-intakes", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			supplement_id: item.supplement_id,
			plan_id: item.plan_id,
			dose: item.dose,
			taken_at: new Date().toISOString(),
		}),
	});
}

async function cancelIntake(intakeId: number): Promise<void> {
	await apiFetch(`/api/supplement-intakes/${intakeId}`, { method: "DELETE" });
}

function supplementKey(item: TodaySupplementItem): string {
	return `${item.plan_id ?? "adhoc"}-${item.supplement_id}-${item.intake_id ?? "none"}`;
}

export function Today() {
	const queryClient = useQueryClient();
	// 看誰的放在網址（`?view=friends`），不是元件狀態：從好友的一天按返回
	// 要回到好友動態，不是回到「我的」。沒有參數＝我的。換的時候 replace，
	// 不在瀏覽紀錄裡多一格。
	const [searchParams, setSearchParams] = useSearchParams();
	const view: "mine" | "friends" =
		searchParams.get("view") === "friends" ? "friends" : "mine";
	const setView = (next: "mine" | "friends") =>
		setSearchParams(next === "friends" ? { view: "friends" } : {}, {
			replace: true,
		});

	// 規格 §5.3：不傳 date，讓後端用 today_in_timezone(user.timezone) 決定
	// 今天是哪一天——跟 /api/supplements/today 用同一個函式（app/days.py）。
	// 前端自己算的話，使用者時區跟瀏覽器時區不同時會在午夜前後靜默算錯。
	const statsQuery = useDailyStats();

	const supplementsQuery = useQuery({
		queryKey: queryKeys.supplementsToday,
		queryFn: () => apiFetch<TodaySupplementItem[]>("/api/supplements/today"),
	});

	// 打卡/取消都會改變今天吃了多少（補劑也有熱量），兩個 key 都要失效——
	// 只失效 supplementsToday 的話，總覽的巨量營養素數字不會跟著更新。
	const invalidateAfterChange = () => {
		void queryClient.invalidateQueries({
			queryKey: queryKeys.supplementsToday,
		});
		void queryClient.invalidateQueries({ queryKey: queryKeys.dailyStats });
	};

	const checkIn = useMutation({
		mutationFn: checkInSupplement,
		onSuccess: invalidateAfterChange,
	});

	const cancel = useMutation({
		mutationFn: cancelIntake,
		onSuccess: invalidateAfterChange,
	});

	const stats = statsQuery.data;
	const supplements = supplementsQuery.data ?? [];

	// 離線 L2（規格 §8、計畫三 Task 4）：**不用 navigator.onLine**——它只
	// 知道「有沒有連上網路介面」，不知道「連得到這個後端嗎」。這個 app 走
	// Tailscale，navigator.onLine 為 true 但 tailnet 不通是完全正常的情況。
	// 用「這次的請求實際失敗了嗎」判斷：statsQuery.isError 為 true 代表
	// 最近一次嘗試取得 /api/stats/daily 失敗了；`stats !== undefined`
	// 代表儘管如此，畫面上顯示的仍然是（hydrate 回來的）舊資料，不是空白。
	// isStale 這裡是冗餘的（任何一次 fetch 失敗都會讓 TanStack Query 把
	// query 標成 invalidated，isStale 因此必為 true）——留著寫是為了讓
	// 條件讀起來直接對應規格的措辭「陳舊資料」，不是省略後才成立。
	const isOfflineStats =
		statsQuery.isStale && statsQuery.isError && stats !== undefined;

	return (
		<section>
			<h1>飲食</h1>

			<fieldset className={styles.views}>
				<legend className={styles.legend}>看誰的</legend>
				{(["mine", "friends"] as const).map((option) => (
					<label key={option} className={styles.view}>
						<input
							type="radio"
							name="diet-view"
							value={option}
							checked={view === option}
							onChange={() => setView(option)}
							className={styles.viewInput}
						/>
						{option === "mine" ? "我的" : "好友"}
					</label>
				))}
			</fieldset>
			{view === "friends" ? (
				<div className={styles.friendFeed}>
					<FriendFeed />
				</div>
			) : (
				<>
					{/* 介面改版：「食物庫」不再是 tab，入口在這裡（今天吃了什麼的
				    旁邊，就是會想查、想加食物的地方）。補劑管理的入口原本就在下面
				    「今日補劑」區塊，維持不動。 */}
					<nav className={styles.links} aria-label="飲食相關">
						<Link to="/foods">食物庫</Link>
					</nav>

					{/* 電腦版：營養素與補劑在左欄、餐點在右欄（電腦版版面規格 §4）。
					    DOM 順序維持 營養素 → 餐點 → 補劑（手機版就是照這個順序往下排），
					    左右靠 Today.module.css 的 grid-template-areas 擺，不是靠換 DOM
					    順序——換了的話手機版與螢幕閱讀器的順序會跟著變。 */}
					<div className={styles.columns}>
						<div className={styles.macros}>
							{statsQuery.isLoading && <p>載入中…</p>}
							{statsQuery.isError && stats === undefined && (
								<p>無法載入今天的營養素</p>
							)}
							{isOfflineStats && (
								<p data-testid="offline-banner">
									離線資料，最後更新於 {formatTime(statsQuery.dataUpdatedAt)}
								</p>
							)}

							{stats &&
								(stats.target === null ? (
									// 規格 §5.7 第一層 null：這一天完全沒有生效的目標。**不要**
									// 逐項顯示「未設定」（那是第二層 null 的畫面，見 else 分支的
									// MacroBar）——兩者混為一談會讓使用者以為自己是「設了目標但
									// 剛好每一項都沒填」，而不是「根本沒設目標」。
									<Card>
										<p className={styles.noTarget}>尚未設定目標</p>
										{/* 一列一項：名稱在左、數字在右（跟有目標時的 MacroBar 同一個節奏）。 */}
										<dl className={styles.macroList}>
											<div data-testid="macro-kcal">
												<dt>熱量</dt>
												<dd>{formatMacro(stats.actual.kcal)}</dd>
											</div>
											<div data-testid="macro-protein_g">
												<dt>蛋白質</dt>
												<dd>{formatMacro(stats.actual.protein_g)}</dd>
											</div>
											<div data-testid="macro-fat_g">
												<dt>脂肪</dt>
												<dd>{formatMacro(stats.actual.fat_g)}</dd>
											</div>
											<div data-testid="macro-carb_g">
												<dt>碳水</dt>
												<dd>{formatMacro(stats.actual.carb_g)}</dd>
											</div>
										</dl>
									</Card>
								) : (
									// 規格 §5.7 第二層 null：目標存在，但個別欄位可能是 null
									// （「有目標，但這一項沒設」）。MacroBar 自己處理那一列的
									// 「未設定」，其他列照常顯示比例——不在這裡把兩層混在一起判斷。
									<Card>
										<MacroBar
											field="kcal"
											label="熱量"
											actual={stats.actual.kcal}
											target={stats.target.kcal}
										/>
										<MacroBar
											field="protein_g"
											label="蛋白質"
											actual={stats.actual.protein_g}
											target={stats.target.protein_g}
										/>
										<MacroBar
											field="fat_g"
											label="脂肪"
											actual={stats.actual.fat_g}
											target={stats.target.fat_g}
										/>
										<MacroBar
											field="carb_g"
											label="碳水"
											actual={stats.actual.carb_g}
											target={stats.target.carb_g}
										/>
									</Card>
								))}
						</div>
						<div className={styles.meals}>
							<MealList />
						</div>
						<div className={styles.supplements}>
							<Card>
								<h2 className={`${ui.sectionTitle} ${styles.cardTitle}`}>
									今日補劑
								</h2>
								{/* 補劑的新增與「當天吃了就點一份進去」（P3-C Task 2）的入口。
						    補劑不是 tab（tab bar 固定是 總覽／報表／＋／飲食／我的），
						    入口放在飲食畫面——這裡是使用者會看到補劑的地方，也是他們
						    想「加一個」的當下。 */}
								<Link to="/supplements" className={styles.cardLink}>
									新增補劑
								</Link>
								<ul className={styles.supplementList}>
									{supplements.map((item) => (
										<li key={supplementKey(item)}>
											<span>{item.supplement_name}</span>
											{/* 規格 §5.8：plan_id 為 null 是臨時記錄，一定 done=true，
									    不該有打卡按鈕——只有「計畫存在但今天還沒打卡」才給打卡。 */}
											{item.plan_id !== null && !item.done && (
												<button
													type="button"
													disabled={checkIn.isPending}
													onClick={() => checkIn.mutate(item)}
												>
													打卡
												</button>
											)}
											{item.done && (
												<button
													type="button"
													disabled={cancel.isPending}
													onClick={() => {
														if (item.intake_id !== null)
															cancel.mutate(item.intake_id);
													}}
												>
													取消
												</button>
											)}
										</li>
									))}
								</ul>
							</Card>
						</div>
					</div>
				</>
			)}
		</section>
	);
}
