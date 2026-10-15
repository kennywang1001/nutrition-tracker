import { Link, useNavigate } from "react-router";
import {
	type LibrarySuggestions,
	type PlannedCombo,
	type PlannedItem,
	useLibrarySuggestions,
} from "../api/planner";
import ui from "../components/ui.module.css";
import { formatMacro, percentOf, roundForDisplay } from "../lib/decimal";
import { itemsState, SUGGEST_STATE } from "../lib/planner";
import styles from "./Planner.module.css";

/** 熱量顯示到整數、克到小數一位（half-up，只是顯示；後端給兩位，「236.25 kcal」太瑣碎）。 */
const kcalText = (value: string) => `${roundForDisplay(value, 0)} kcal`;
const gramsText = (value: string) => `${roundForDisplay(value, 1)} g`;

/** 一樣的那一行（規格 §7.3）。數字都是後端給的，這裡不做任何運算：有份量的寫「幾份（份量名）」，
 *  沒有的寫 g／ml（看食物的單位）。量原樣（`formatMacro`）——它就是記一餐輸入框裡會出現的值。 */
function itemLine(item: PlannedItem): string {
	const amount =
		item.portion === null
			? `${formatMacro(item.quantity)} ${item.food.nutrition?.base_unit ?? "g"}`
			: `${formatMacro(item.quantity)} 份（${item.portion.label}）`;
	return `${item.food.name} ${amount}・${kcalText(item.nutrition.kcal)}`;
}

/** 合計的四段。每一段各自不換行（手機上「碳水 112.5」與「g」被拆到兩行很難讀）；分隔的「・」
 *  接在前一段的尾巴——它不能當一行的開頭（換行規則），放在下一段的開頭就沒有地方可以換行了。 */
function totalSegments(combo: PlannedCombo): string[] {
	const t = combo.total;
	const segments = [
		`合計 ${kcalText(t.kcal)}`,
		`蛋白質 ${gramsText(t.protein_g)}`,
		`脂肪 ${gramsText(t.fat_g)}`,
		`碳水 ${gramsText(t.carb_g)}`,
	];
	return segments.map((segment, index) =>
		index < segments.length - 1 ? `${segment}・` : segment,
	);
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
					<dd>{kcalText(remaining.kcal)}</dd>
				</div>
				{MACRO_ROWS.map(({ field, label }) => {
					const value = remaining[field];
					if (value === null) return null;
					return (
						<div key={field} className={ui.stat}>
							<dt>{label}</dt>
							<dd>{gramsText(value)}</dd>
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
														<p className={styles.total}>
															{totalSegments(combo).map((segment) => (
																<span key={segment} className={styles.segment}>
																	{segment}
																</span>
															))}
														</p>
														{combo.fill.kcal !== null && (
															<p className={styles.total}>
																佔剩下的熱量 {percentOf(combo.fill.kcal)}
															</p>
														)}
														{/* 次要按鈕（.screen 的通用樣式）：一頁三顆實心的大按鈕太重，
														    而且這只是「帶過去」，真的記下來是記一餐的「記錄」。 */}
														<button
															type="button"
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
