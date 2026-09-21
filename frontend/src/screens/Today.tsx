import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "../api/client";
import { queryKeys } from "../api/queries";
import type { components } from "../api/schema";
import { MacroBar } from "../components/MacroBar";
import { formatTime } from "../lib/dates";
import { formatMacro } from "../lib/decimal";
import { MealList } from "./MealList";

type DailyStats = components["schemas"]["DailyStatsResponse"];
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

	// 規格 §5.3：不傳 date，讓後端用 today_in_timezone(user.timezone) 決定
	// 今天是哪一天——跟 /api/supplements/today 用同一個函式（app/days.py）。
	// 前端自己算的話，使用者時區跟瀏覽器時區不同時會在午夜前後靜默算錯。
	const statsQuery = useQuery({
		queryKey: queryKeys.dailyStats,
		queryFn: () => apiFetch<DailyStats>("/api/stats/daily"),
	});

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
			<h1>今日總覽</h1>

			{statsQuery.isLoading && <p>載入中…</p>}
			{statsQuery.isError && stats === undefined && <p>無法載入今日總覽</p>}
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
					<div>
						<p>尚未設定目標</p>
						<dl>
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
					</div>
				) : (
					// 規格 §5.7 第二層 null：目標存在，但個別欄位可能是 null
					// （「有目標，但這一項沒設」）。MacroBar 自己處理那一列的
					// 「未設定」，其他列照常顯示比例——不在這裡把兩層混在一起判斷。
					<div>
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
					</div>
				))}

			<MealList />

			<h2>今日補劑</h2>
			<ul>
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
									if (item.intake_id !== null) cancel.mutate(item.intake_id);
								}}
							>
								取消
							</button>
						)}
					</li>
				))}
			</ul>
		</section>
	);
}
