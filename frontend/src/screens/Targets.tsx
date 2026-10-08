import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { useNavigate } from "react-router";
import { ApiError, describeFieldErrors } from "../api/errors";
import { queryKeys } from "../api/queries";
import { type DailyStats, useDailyStats } from "../api/stats";
import { setTargetFromToday, type TargetToday } from "../api/targets";
import ui from "../components/ui.module.css";
import {
	checkTargetInput,
	formatMacro,
	type TargetInputProblem,
} from "../lib/decimal";
import { TARGET_FIELDS, type TargetKey } from "../lib/targets";

type Values = Record<TargetKey, string>;

function problemText(
	problem: TargetInputProblem,
	label: string,
	max: string,
): string {
	switch (problem) {
		case "not-positive-decimal":
			return `${label}要是大於 0 的數字`;
		case "too-precise":
			return `${label}最多兩位小數`;
		case "too-large":
			return `${label}不能超過 ${max}`;
	}
}

/** `/me/targets`（帳號設定規格 §5.2）：從今天起的每日目標。目前的值讀 `stats/daily` 的
 *  `target`（後端用使用者的今天算的），不另外加讀取端點。 */
export function Targets() {
	const stats = useDailyStats();
	return (
		<section className={ui.screen}>
			<h1>每日目標</h1>
			{stats.isPending ? (
				<p>載入中…</p>
			) : stats.data == null ? (
				// 不顯示空白表單：四格空白存下去＝今天起沒有目標，等於把目標清掉。
				<p role="alert">無法載入目前的目標</p>
			) : (
				<TargetsForm current={stats.data.target} />
			)}
		</section>
	);
}

function initialValues(current: DailyStats["target"]): Values {
	const values = {} as Values;
	for (const field of TARGET_FIELDS) {
		const value = current?.[field.key] ?? null;
		// formatMacro 去掉尾數的 0：「1800.00」預填成「1800」，跟「我的」卡片上看到的一樣。
		values[field.key] = value === null ? "" : formatMacro(value);
	}
	return values;
}

function TargetsForm({ current }: { current: DailyStats["target"] }) {
	const queryClient = useQueryClient();
	const navigate = useNavigate();
	const [values, setValues] = useState<Values>(() => initialValues(current));
	const [errors, setErrors] = useState<string[]>([]);

	const save = useMutation({
		mutationFn: (body: TargetToday) => setTargetFromToday(body),
		onSuccess: () => {
			// 總覽、飲食頁的分母（今天）與趨勢（每一天生效的目標）都要重抓。放在 hook 層：
			// 導頁之後元件卸載，這裡照樣會跑（失效是快取的事，不是畫面的事）。
			void queryClient.invalidateQueries({ queryKey: queryKeys.dailyStats });
			void queryClient.invalidateQueries({ queryKey: queryKeys.rangeStatsAll });
		},
	});

	function handleSubmit(event: FormEvent) {
		event.preventDefault();
		const problems: string[] = [];
		const body = {} as Record<TargetKey, string | null>;
		for (const field of TARGET_FIELDS) {
			const raw = values[field.key];
			const problem = checkTargetInput(raw, field.max);
			if (problem !== null) {
				problems.push(problemText(problem, field.label, field.max));
			}
			// 空白送 null（＝不設定），不是空字串：PUT 是整組取代，四個鍵都要在（規格 決定 4）。
			body[field.key] = raw.trim() === "" ? null : raw.trim();
		}
		setErrors(problems);
		if (problems.length > 0) return;
		// 導頁放在 mutate 的 callback：元件卸載之後不會跑（handover §7）。
		save.mutate(body, {
			onSuccess: () => navigate("/me"),
			onError: (caught: unknown) => {
				if (caught instanceof ApiError && caught.status === 409) {
					setErrors([caught.message]);
				} else if (caught instanceof ApiError && caught.status === 422) {
					setErrors(describeFieldErrors(caught));
				} else {
					setErrors(["儲存失敗，請再試一次"]);
				}
			},
		});
	}

	return (
		<form onSubmit={handleSubmit} noValidate>
			<p>留空＝不設定。從今天開始生效，之前的日子維持原本的目標。</p>
			{TARGET_FIELDS.map((field) => (
				<div key={field.key}>
					<label htmlFor={`target-${field.key}`}>
						{field.label}（{field.unit}）
					</label>
					<input
						id={`target-${field.key}`}
						inputMode="decimal"
						autoComplete="off"
						value={values[field.key]}
						onChange={(event) =>
							setValues((prev) => ({
								...prev,
								[field.key]: event.target.value,
							}))
						}
					/>
				</div>
			))}
			{errors.length > 0 && (
				<ul role="alert">
					{errors.map((message) => (
						<li key={message}>{message}</li>
					))}
				</ul>
			)}
			<button type="submit" disabled={save.isPending}>
				儲存
			</button>
		</form>
	);
}
