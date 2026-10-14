import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import {
	exerciseAddsToBudgetOf,
	updateExerciseAddsToBudget,
	useMe,
} from "../api/me";
import { queryKeys } from "../api/queries";
import styles from "./ExerciseBudgetSwitch.module.css";

/** 「運動消耗加回今天的熱量額度」（運動規格 §7.6、D25）：每日目標卡片底部的開關——它改的就是
 *  每日目標的熱量分母。值來自 `/api/me`（舊快取沒有這個欄位 → 開）。 */
export function ExerciseBudgetSwitch() {
	const client = useQueryClient();
	const me = useMe().data;
	// 送出中是 aria-disabled（焦點就在它身上，原生 disabled 會把焦點弄丟）；擋重複送出的是 ref——
	// `isPending` 要等下一次 render 才更新。
	const sending = useRef(false);
	const [failed, setFailed] = useState(false);
	const toggle = useMutation({
		mutationFn: updateExerciseAddsToBudget,
		onSuccess: async (updated) => {
			// 回應就是新的「我」：直接寫回快取，不用再抓一次。分母變了，今天的統計要重抓
			// （總覽、飲食頁、這張卡片都讀它）。放在 hook 層：離開「我的」之後照樣要做。
			client.setQueryData(queryKeys.me, updated);
			await client.invalidateQueries({ queryKey: queryKeys.dailyStats });
		},
	});

	// 帳號卡片已經處理「我」的載入與錯誤；沒有「我」就不畫開關（不知道現在是開是關）。
	if (me == null) return null;
	const saved = exerciseAddsToBudgetOf(me);
	// 送出中顯示「要變成的值」：點下去就看得到它動了。失敗之後回到快取裡的原值。
	const on = toggle.isPending ? !saved : saved;

	return (
		<div className={styles.wrap}>
			<label className={styles.row}>
				<span>運動消耗加回今天的熱量額度</span>
				<input
					type="checkbox"
					role="switch"
					className={styles.switch}
					checked={on}
					// 原生的 checked 已經表達了開關的狀態；Biome 的規則要 role="switch" 帶
					// aria-checked，給同一個值，兩邊不會不一致。
					aria-checked={on}
					aria-disabled={toggle.isPending}
					onChange={() => {
						if (sending.current) return;
						sending.current = true;
						setFailed(false);
						toggle.mutate(!saved, {
							onError: () => setFailed(true),
							onSettled: () => {
								sending.current = false;
							},
						});
					}}
				/>
			</label>
			{failed && (
				<p role="alert" className={styles.error}>
					沒有存到，請再試一次
				</p>
			)}
		</div>
	);
}
