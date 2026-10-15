import { Link, useNavigate } from "react-router";
import {
	type LibrarySuggestions,
	type PlannedCombo,
	type PlannedItem,
	useLibrarySuggestions,
} from "../api/planner";
import ui from "../components/ui.module.css";
import { formatMacro, percentOf } from "../lib/decimal";
import { itemsState, SUGGEST_STATE } from "../lib/planner";
import styles from "./Planner.module.css";

/** 一樣的那一行（規格 §7.3）。數字都是後端給的，這裡不做任何運算：有份量的寫「幾份（份量名）」，
 *  沒有的寫 g／ml（看食物的單位）。 */
function itemLine(item: PlannedItem): string {
	const amount =
		item.portion === null
			? `${formatMacro(item.quantity)} ${item.food.nutrition?.base_unit ?? "g"}`
			: `${formatMacro(item.quantity)} 份（${item.portion.label}）`;
	return `${item.food.name} ${amount}・${formatMacro(item.nutrition.kcal)} kcal`;
}

function totalLine(combo: PlannedCombo): string {
	const t = combo.total;
	return `合計 ${formatMacro(t.kcal)} kcal・蛋白質 ${formatMacro(t.protein_g)} g・脂肪 ${formatMacro(t.fat_g)} g・碳水 ${formatMacro(t.carb_g)} g`;
}

const MACRO_ROWS = [
	{ field: "protein_g", label: "蛋白質" },
	{ field: "fat_g", label: "脂肪" },
	{ field: "carb_g", label: "碳水" },
] as const;

/** 「還能吃」：熱量一定有；三大營養素只列有目標的（null＝不考慮，規格 D2）。 */
function Remaining({
	remaining,
}: {
	remaining: NonNullable<LibrarySuggestions["remaining"]>;
}) {
	return (
		<section aria-labelledby="planner-remaining">
			<h2 id="planner-remaining">還能吃</h2>
			<dl className={ui.stats}>
				<div className={ui.stat}>
					<dt>熱量</dt>
					<dd>{formatMacro(remaining.kcal)} kcal</dd>
				</div>
				{MACRO_ROWS.map(({ field, label }) => {
					const value = remaining[field];
					if (value === null) return null;
					return (
						<div key={field} className={ui.stat}>
							<dt>{label}</dt>
							<dd>{formatMacro(value)} g</dd>
						</div>
					);
				})}
			</dl>
		</section>
	);
}

/** 今天還能吃什麼（營養素配餐規格 §7.3）：剩下的額度、從食物庫配的最多 3 組、讓 AI 配一餐。
 *  「記成一餐」與「讓 AI 配一餐」都只是帶著 router state 到記一餐（D22）；這一頁不寫任何東西。 */
export function Planner() {
	const query = useLibrarySuggestions();
	const navigate = useNavigate();
	const data = query.data;

	return (
		<section className={ui.screen}>
			<h1>今天還能吃什麼</h1>
			{query.isLoading && <p>載入中…</p>}
			{query.isError && data === undefined && (
				<div className={styles.status}>
					<p role="alert">無法載入建議</p>
					<button type="button" onClick={() => query.refetch()}>
						再試一次
					</button>
				</div>
			)}
			{data !== undefined &&
				(data.status === "no_target" || data.remaining === null ? (
					// 沒有熱量額度就沒有東西可以配（D3）：只請使用者先去設定。
					<div className={styles.status}>
						<p>先設定每日目標，才知道今天還能吃多少</p>
						<Link to="/me/targets" className={styles.link}>
							設定每日目標
						</Link>
					</div>
				) : (
					<>
						<Remaining remaining={data.remaining} />
						{data.status === "full" ? (
							<div className={styles.status}>
								<p>今天的熱量差不多用完了</p>
							</div>
						) : (
							<>
								<section aria-labelledby="planner-library">
									<h2 id="planner-library">從食物庫配</h2>
									{data.status === "no_candidates" && (
										<p className={styles.empty}>
											先記幾餐，常吃的食物會出現在這裡
										</p>
									)}
									{data.status === "no_fit" && (
										<p className={styles.empty}>
											常吃的食物裡，沒有份量夠小的組合
										</p>
									)}
									{data.status === "ok" && (
										<ol aria-label="從食物庫配的組合" className={styles.combos}>
											{data.combos.map((combo, index) => {
												const n = index + 1;
												return (
													// 組合沒有自己的 id；最多 3 組、整份一起換，用位置當 key 不會錯位。
													// biome-ignore lint/suspicious/noArrayIndexKey: 見上一行
													<li key={index} className={styles.combo}>
														<h3>組合 {n}</h3>
														<ul className={styles.items}>
															{combo.items.map((item) => (
																<li key={item.food.id}>{itemLine(item)}</li>
															))}
														</ul>
														<p className={styles.total}>{totalLine(combo)}</p>
														{combo.fill.kcal !== null && (
															<p className={styles.total}>
																佔剩下的熱量 {percentOf(combo.fill.kcal)}
															</p>
														)}
														<button
															type="button"
															className={ui.primary}
															aria-label={`把組合 ${n} 記成一餐`}
															onClick={() =>
																navigate("/meals/new", {
																	state: itemsState(combo),
																})
															}
														>
															記成一餐
														</button>
													</li>
												);
											})}
										</ol>
									)}
								</section>
								{/* 模式 B 在記一餐裡（D15）：這裡只帶 router state 過去，記一餐一打開就展開那個表單。 */}
								<section aria-labelledby="planner-ai">
									<h2 id="planner-ai">讓 AI 配一餐</h2>
									<p className={styles.empty}>
										依今天剩下的額度請 AI 建議一餐（用掉一次 AI 次數）
									</p>
									<button
										type="button"
										className={styles.aiButton}
										onClick={() =>
											navigate("/meals/new", { state: SUGGEST_STATE })
										}
									>
										讓 AI 配一餐
									</button>
								</section>
							</>
						)}
					</>
				))}
		</section>
	);
}
