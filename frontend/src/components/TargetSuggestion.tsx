import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useId, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import {
	applySuggestion,
	type BodyProfile,
	invalidateBody,
	type SuggestionReady,
	useBodyProfile,
	useTargetSuggestion,
} from "../api/body";
import { ApiError } from "../api/errors";
import { queryKeys } from "../api/queries";
import {
	GOAL_OPTIONS,
	MISSING_LABELS,
	type MissingField,
	SUGGESTION_DISCLAIMER,
} from "../lib/body";
import { formatCivilDate } from "../lib/civil-date";
import { formatMacro, isPositiveAmount } from "../lib/decimal";
import { TARGET_FIELDS } from "../lib/targets";
import styles from "./TargetSuggestion.module.css";
import ui from "./ui.module.css";

/** `/me/targets` 上半的「建議目標」（身體資料規格 §6.5）。
 *
 *  讀的是一般的快取（不用「掛載後才算」）：套用時後端重算、跟畫面上的四個數字比，不一樣就
 *  409——舊的快取最多換來一次 409 與重抓，存下去的永遠是後端算的（D15）。 */
export function TargetSuggestion() {
	const suggestion = useTargetSuggestion();
	const titleId = useId();
	const data = suggestion.data;

	return (
		<section
			aria-labelledby={titleId}
			data-testid="suggestion"
			className={styles.section}
		>
			<h2 id={titleId}>建議目標</h2>
			{suggestion.isPending ? (
				<p>載入中…</p>
			) : data == null ? (
				<p>無法載入建議目標</p>
			) : data.ready ? (
				<Ready suggestion={data} />
			) : (
				<Missing missing={data.missing ?? []} />
			)}
			<p className={styles.disclaimer}>{SUGGESTION_DISCLAIMER}</p>
		</section>
	);
}

/** 「減重每週 0.5 公斤 -550 kcal」「增重每週 0.25 公斤 +275 kcal」「維持體重，不加不減」。
 *  建議的回應只有調整量；速度來自身體資料，讀不到就省略那一段（「減重 -550 kcal」）。 */
function adjustmentText(
	suggestion: SuggestionReady,
	profile: BodyProfile | undefined,
): string {
	const adjustment = formatMacro(suggestion.adjustment_kcal);
	if (adjustment === "0") return "維持體重，不加不減";
	const gaining = isPositiveAmount(suggestion.adjustment_kcal);
	const goal = GOAL_OPTIONS.find(
		(option) => option.value === (gaining ? "gain" : "lose"),
	)?.label;
	const rate = profile?.rate_kg_per_week ?? null;
	const pace = rate === null ? "" : `每週 ${formatMacro(rate)} 公斤`;
	return `${goal}${pace} ${gaining ? "+" : ""}${adjustment} kcal`;
}

function Ready({ suggestion }: { suggestion: SuggestionReady }) {
	const queryClient = useQueryClient();
	const navigate = useNavigate();
	const profile = useBodyProfile().data;
	const [error, setError] = useState<string | null>(null);
	// 「套用」送出中是 aria-disabled（剛按下去焦點就在它身上，原生 disabled 會把焦點弄丟）。
	// 瀏覽器不再替我們擋 click：用 ref 擋，`isPending` 要等下一次 render 才更新。
	const busy = useRef(false);
	const apply = useMutation({
		mutationFn: applySuggestion,
		// 放在 hook 層：導頁之後照樣跑（同 /me/targets 的手動儲存）。總覽與飲食頁的分母、
		// 趨勢、建議（套用時的體重變了，重算提示也跟著變）都要重抓。
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: queryKeys.dailyStats });
			void queryClient.invalidateQueries({
				queryKey: queryKeys.rangeStatsAll,
			});
			void invalidateBody(queryClient);
		},
		onSettled: () => {
			busy.current = false;
		},
	});

	function handleApply() {
		if (busy.current) return;
		busy.current = true;
		setError(null);
		const { kcal, protein_g, fat_g, carb_g } = suggestion;
		// 導頁放在 mutate 的 callback：元件卸載之後不會跑（handover §7）。
		apply.mutate(
			{ kcal, protein_g, fat_g, carb_g },
			{
				// 導回身體與目標（首頁改版規格 D2）：剛套用的目標在那一頁的卡片上。
				onSuccess: () => navigate("/me/health"),
				onError: (caught: unknown) => {
					if (
						caught instanceof ApiError &&
						caught.code === "SUGGESTION_CHANGED"
					) {
						// 另一個分頁剛記了體重、或快取裡是舊的建議：重抓，讓使用者看過新的數字再按。
						void queryClient.invalidateQueries({
							queryKey: queryKeys.targetSuggestion,
						});
						setError("建議目標剛剛變了，請看過新的數字再套用");
					} else if (
						caught instanceof ApiError &&
						caught.code === "PROFILE_INCOMPLETE"
					) {
						// 另一個分頁剛刪了體重或清了身體資料：畫面上的「可以套用」是舊的（審查 M4）。
						// 身體資料、體重、建議一起重抓——重抓回來缺東西，這一塊就換成「還差：…」。
						void invalidateBody(queryClient);
						setError("身體資料或體重剛剛變了，已經重新整理建議");
					} else if (caught instanceof ApiError && caught.status === 409) {
						setError(caught.message);
					} else {
						setError("套用失敗，請再試一次");
					}
				},
			},
		);
	}

	return (
		<>
			<dl className={styles.list}>
				{TARGET_FIELDS.map((field) => (
					<div key={field.key} className={styles.row}>
						<dt>{field.label}</dt>
						<dd data-testid={`suggestion-${field.key}`}>
							{formatMacro(suggestion[field.key])} {field.unit}
						</dd>
					</div>
				))}
			</dl>
			<p className={styles.how}>
				基礎代謝 {formatMacro(suggestion.bmr)} kcal，乘上活動量是每日消耗{" "}
				{formatMacro(suggestion.tdee)} kcal；
				{adjustmentText(suggestion, profile)}
			</p>
			{suggestion.floor_applied && (
				<p className={styles.how}>
					已調到最低建議熱量 {formatMacro(suggestion.floor_kcal)} kcal
				</p>
			)}
			<p className={styles.how}>
				依 {formatCivilDate(suggestion.based_on_date)} 的體重{" "}
				{formatMacro(suggestion.weight_kg)} 公斤
			</p>
			<button
				type="button"
				className={`${ui.secondary} ${ui.primary}`}
				aria-disabled={apply.isPending}
				onClick={handleApply}
			>
				套用建議目標
			</button>
			{error !== null && (
				<p role="alert" className={styles.error}>
					{error}
				</p>
			)}
		</>
	);
}

function Missing({ missing }: { missing: readonly MissingField[] }) {
	const needsProfile = missing.some((field) => field !== "weight");
	const needsWeight = missing.includes("weight");
	return (
		<>
			<p>還差：{missing.map((field) => MISSING_LABELS[field]).join("、")}</p>
			<div className={styles.links}>
				{needsProfile && (
					<Link to="/me/body" className={styles.link}>
						填寫身體資料
					</Link>
				)}
				{needsWeight && (
					<Link to="/weight" className={styles.link}>
						記錄體重
					</Link>
				)}
			</div>
		</>
	);
}
