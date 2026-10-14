import { useMutation } from "@tanstack/react-query";
import { type FormEvent, useId, useRef, useState } from "react";
import { Link } from "react-router";
import { ApiError } from "../api/errors";
import {
	type ExerciseInput,
	useActivities,
	useExerciseEstimate,
} from "../api/exercises";
import { fromLocalDateTime, localDateTime } from "../lib/dates";
import { formatMacro, toWholeNumber } from "../lib/decimal";
import {
	type ExerciseFormValues,
	estimateParams,
	exerciseProblems,
} from "../lib/exercise";
import { useDebounced } from "../lib/use-debounced";
import { dateLabel } from "../lib/weights";
import styles from "./ExerciseForm.module.css";
import ui from "./ui.module.css";

const NEEDS_WEIGHT = "先記一次體重，就能自動估算";

type Props = {
	initial: ExerciseFormValues;
	/** 送出：新增是 POST，編輯是 PATCH（`kcal: null`＝改回估算）。失效也放在這裡——
	 *  它跟著請求走，元件卸載之後照樣要做。 */
	save: (body: ExerciseInput) => Promise<unknown>;
	/** 存好之後（導頁）。走 `mutate` 的 callback：元件卸載之後不會跑（handover §7）。 */
	onSaved: () => void;
	/** 編輯畫面要送 `kcal: null` 表示「改回估算」；新增畫面省略這個鍵（D10）。 */
	sendNullKcalWhenEstimated: boolean;
};

/** 記運動與編輯運動共用的表單（運動規格 §7.2）。熱量是預覽，存的時候後端再算一次（§10 第 4 點）。 */
export function ExerciseForm({
	initial,
	save,
	onSaved,
	sendNullKcalWhenEstimated,
}: Props) {
	const [values, setValues] = useState(initial);
	const [problems, setProblems] = useState<string[]>([]);
	const [serverNeedsWeight, setServerNeedsWeight] = useState(false);
	// 「儲存」送出中是 aria-disabled（焦點還在它身上）；擋重複送出的是這個 ref——
	// `isPending` 要等下一次 render 才更新，連按兩下兩次都看到 false。
	const sending = useRef(false);
	const activities = useActivities();
	const id = useId();
	const ids = {
		activity: `${id}-activity`,
		name: `${id}-name`,
		minutes: `${id}-minutes`,
		kcal: `${id}-kcal`,
		date: `${id}-date`,
		time: `${id}-time`,
		note: `${id}-note`,
	};

	function set<K extends keyof ExerciseFormValues>(
		key: K,
		value: ExerciseFormValues[K],
	) {
		setValues((current) => ({ ...current, [key]: value }));
	}

	// 預覽：手動與否先只看使用者自己勾的——「沒有體重」要等預覽回來才知道（下面的 forcedManual）。
	const params = estimateParams(values, values.manual, Date.now());
	// debounce 的是字串，不是物件：物件每次 render 都是新的，`useDebounced` 的 effect 會每次
	// 重設計時器、設回來又觸發 render，停不下來。字串一樣就是同一組參數。
	const typed = params === null ? "" : JSON.stringify(params);
	const settled = useDebounced(typed, 400);
	// 停下來的那一組跟現在打的一樣才問：400 ms 之內的舊值不送出去。
	const estimate = useExerciseEstimate(settled === typed ? params : null);

	// 「沒有體重」記住到下一個「有」的答案為止：分鐘改到一半、查詢還在等 debounce 時沒有答案，
	// 不記住的話手動欄會消失又出現。
	const [lastReady, setLastReady] = useState<boolean | null>(null);
	const answer = estimate.data;
	if (answer !== undefined && answer.ready !== lastReady) {
		setLastReady(answer.ready);
	}

	const isOther = values.activity === "other";
	const noWeight = serverNeedsWeight || lastReady === false;
	const forcedManual = isOther || noWeight;
	const manual = values.manual || forcedManual;

	const mutation = useMutation({ mutationFn: save });

	function submit(event: FormEvent) {
		event.preventDefault();
		if (sending.current) return;
		const found = exerciseProblems(values, manual, Date.now());
		setProblems(found);
		const moment = fromLocalDateTime(values.date, values.time);
		if (found.length > 0 || moment === null || values.activity === "") return;
		const note = values.note.trim();
		const body: ExerciseInput = {
			activity: values.activity,
			name: isOther ? values.name.trim() : null,
			minutes: toWholeNumber(values.minutes),
			performed_at: moment.toISOString(),
			note: note === "" ? null : note,
			...(manual
				? { kcal: values.kcal.trim() }
				: sendNullKcalWhenEstimated
					? { kcal: null }
					: {}),
		};
		sending.current = true;
		mutation.mutate(body, {
			onSuccess: onSaved,
			onError: (error) => {
				if (
					error instanceof ApiError &&
					error.code === "EXERCISE_NEEDS_WEIGHT"
				) {
					// 另一個分頁剛刪了體重：換成手動，跟預覽說沒有體重時同一句話。
					setServerNeedsWeight(true);
					setProblems([NEEDS_WEIGHT]);
				} else if (error instanceof ApiError) {
					setProblems([error.message]);
				} else {
					setProblems(["沒有存到，請再試一次"]);
				}
			},
			onSettled: () => {
				sending.current = false;
			},
		});
	}

	let preview: string | null = null;
	if (!manual && params !== null) {
		if (answer?.ready === true) {
			preview = `約 ${formatMacro(answer.kcal)} kcal（依 ${dateLabel(answer.weight_date, values.date)} 的體重 ${formatMacro(answer.weight_kg)} 公斤）`;
		} else if (estimate.error instanceof ApiError) {
			preview = estimate.error.message;
		} else if (estimate.isError) {
			preview = "無法估算，請再試一次";
		} else if (answer === undefined) {
			preview = "估算中…";
		}
	}

	return (
		<form onSubmit={submit} noValidate>
			<label htmlFor={ids.activity}>活動</label>
			<select
				id={ids.activity}
				value={values.activity}
				disabled={activities.data === undefined}
				onChange={(event) =>
					set("activity", event.target.value as ExerciseFormValues["activity"])
				}
			>
				<option value="">請選擇</option>
				{activities.data?.map((activity) => (
					<option key={activity.code} value={activity.code}>
						{activity.label}
					</option>
				))}
			</select>
			{activities.isPending && <p className={styles.hint}>載入中…</p>}
			{activities.isError && activities.data === undefined && (
				<p className={styles.error}>無法載入活動清單</p>
			)}

			{isOther && (
				<>
					<label htmlFor={ids.name}>名稱</label>
					<input
						id={ids.name}
						autoComplete="off"
						value={values.name}
						onChange={(event) => set("name", event.target.value)}
					/>
				</>
			)}

			<label htmlFor={ids.minutes}>分鐘</label>
			<input
				id={ids.minutes}
				inputMode="numeric"
				autoComplete="off"
				value={values.minutes}
				onChange={(event) => set("minutes", event.target.value)}
			/>

			{!isOther && (
				<label className={styles.manual}>
					{/* 「沒有體重」是預覽回來才知道的：它可能在這個勾選框正有焦點時鎖住（剛取消勾選、
					    預覽說沒有體重）。原生 disabled 會把焦點弄丟，所以用 aria-disabled＋onChange 擋。 */}
					<input
						type="checkbox"
						checked={manual}
						aria-disabled={forcedManual}
						onChange={(event) => {
							if (forcedManual) return;
							set("manual", event.target.checked);
						}}
					/>
					手動輸入熱量
				</label>
			)}

			{noWeight && !isOther && (
				<p className={styles.hint}>
					{NEEDS_WEIGHT}
					<Link to="/weight" className={styles.link}>
						記錄體重
					</Link>
				</p>
			)}

			{manual ? (
				<>
					<label htmlFor={ids.kcal}>熱量（kcal）</label>
					<input
						id={ids.kcal}
						inputMode="decimal"
						autoComplete="off"
						value={values.kcal}
						onChange={(event) => set("kcal", event.target.value)}
					/>
				</>
			) : (
				<p className={styles.preview} aria-live="polite">
					{preview}
				</p>
			)}

			<div className={styles.when}>
				<div className={styles.field}>
					<label htmlFor={ids.date}>日期</label>
					<input
						id={ids.date}
						type="date"
						max={localDateTime(new Date().toISOString()).date}
						value={values.date}
						onChange={(event) => set("date", event.target.value)}
					/>
				</div>
				<div className={styles.field}>
					<label htmlFor={ids.time}>時間</label>
					<input
						id={ids.time}
						type="time"
						value={values.time}
						onChange={(event) => set("time", event.target.value)}
					/>
				</div>
			</div>

			<label htmlFor={ids.note}>備註（選填）</label>
			<input
				id={ids.note}
				autoComplete="off"
				value={values.note}
				onChange={(event) => set("note", event.target.value)}
			/>

			{problems.length > 0 && (
				<ul role="alert" className={styles.problems}>
					{problems.map((problem) => (
						<li key={problem}>{problem}</li>
					))}
				</ul>
			)}

			<button
				type="submit"
				className={`${ui.secondary} ${ui.primary}`}
				aria-disabled={mutation.isPending}
			>
				儲存
			</button>
		</form>
	);
}
