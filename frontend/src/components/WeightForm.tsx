import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { invalidateBody, saveWeight } from "../api/body";
import { ApiError, describeFieldErrors } from "../api/errors";
import { shiftDays } from "../lib/civil-date";
import { checkRangeInput } from "../lib/decimal";
import ui from "./ui.module.css";
import styles from "./WeightForm.module.css";

/** 體重的範圍與小數位（身體資料規格 D4）：跟後端 `WeightRequest` 同一套。 */
export const WEIGHT_RULE = { min: "25", max: "350", places: 2 } as const;
export const WEIGHT_PROBLEM = "體重要在 25 到 350 公斤之間，最多兩位小數";
/** 可以補記的最早日期：今天 − 730 天（D13；真正的檢查在後端）。 */
export const OLDEST_DAYS = 730;

type Props = {
	/** 後端給的今天（`GET /api/weights` 的 `today`）：日期的預設值與上限。前端不算今天。 */
	today: string;
	/** 存好之後（卡片：收起來；`/weight`：留著、清空體重）。 */
	onSaved?: () => void;
	/** 有給才畫「取消」（卡片的行內表單）。 */
	onCancel?: () => void;
	/** 打開就把焦點放到體重（卡片按「記錄體重」展開時）。 */
	focusOnMount?: boolean;
};

/** 記一筆體重（身體資料規格 §6.2、§6.4）：體重＋日期。同一天再記就是更正（後端 upsert）。 */
export function WeightForm({ today, onSaved, onCancel, focusOnMount }: Props) {
	const queryClient = useQueryClient();
	const ids = useId();
	const weightRef = useRef<HTMLInputElement>(null);
	const [weight, setWeight] = useState("");
	const [date, setDate] = useState(today);
	const [error, setError] = useState<string | null>(null);
	// 「儲存」送出中是 aria-disabled（焦點還在它身上，原生 disabled 會把焦點弄丟——同匯出的按鈕）。
	// 瀏覽器不再替我們擋 click／Enter：用 ref 擋，`isPending` 要等下一次 render 才更新。
	const busy = useRef(false);

	useEffect(() => {
		if (focusOnMount) weightRef.current?.focus();
	}, [focusOnMount]);

	const save = useMutation({
		mutationFn: (vars: { date: string; weight: string }) =>
			saveWeight(vars.date, vars.weight),
		// 放在 hook 層：表單收起來（卸載）之後照樣失效——體重變了，清單、卡片、建議都要重抓。
		onSuccess: () => invalidateBody(queryClient),
		onSettled: () => {
			busy.current = false;
		},
	});

	function handleSubmit(event: FormEvent) {
		event.preventDefault();
		if (busy.current) return;
		if (checkRangeInput(weight, WEIGHT_RULE) !== null) {
			setError(WEIGHT_PROBLEM);
			return;
		}
		if (date === "") {
			setError("請選日期");
			return;
		}
		setError(null);
		busy.current = true;
		// 收起來、清空放在 mutate 的 callback：元件卸載之後不會跑（handover §7）。
		save.mutate(
			{ date, weight: weight.trim() },
			{
				onSuccess: () => {
					setWeight("");
					onSaved?.();
				},
				onError: (caught: unknown) => {
					// 日期在未來、太久以前（手打繞過 min／max）：後端的訊息就是人話。
					if (caught instanceof ApiError && caught.status === 422) {
						setError(describeFieldErrors(caught).join("；"));
					} else {
						setError("儲存失敗，請再試一次");
					}
				},
			},
		);
	}

	return (
		<form
			className={styles.form}
			onSubmit={handleSubmit}
			noValidate
			data-testid="weight-form"
		>
			<div className={styles.fields}>
				<div className={styles.field}>
					<label htmlFor={`${ids}-weight`}>體重（公斤）</label>
					<input
						ref={weightRef}
						id={`${ids}-weight`}
						inputMode="decimal"
						autoComplete="off"
						value={weight}
						onChange={(event) => setWeight(event.target.value)}
					/>
				</div>
				<div className={styles.field}>
					<label htmlFor={`${ids}-date`}>日期</label>
					<input
						id={`${ids}-date`}
						type="date"
						min={shiftDays(today, -OLDEST_DAYS)}
						max={today}
						value={date}
						onChange={(event) => setDate(event.target.value)}
					/>
				</div>
			</div>
			{error !== null && (
				<p role="alert" className={styles.error}>
					{error}
				</p>
			)}
			<div className={styles.actions}>
				<button
					type="submit"
					className={`${ui.secondary} ${ui.primary}`}
					aria-disabled={save.isPending}
				>
					儲存
				</button>
				{onCancel !== undefined && (
					<button type="button" className={ui.secondary} onClick={onCancel}>
						取消
					</button>
				)}
			</div>
		</form>
	);
}
