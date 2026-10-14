import {
	useIsRestoring,
	useMutation,
	useQueryClient,
} from "@tanstack/react-query";
import { useId, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { ApiError } from "../api/errors";
import {
	deleteExercise,
	type Exercise,
	invalidateExercises,
	updateExercise,
	useExercise,
} from "../api/exercises";
import { queryKeys } from "../api/queries";
import { ExerciseForm } from "../components/ExerciseForm";
import ui from "../components/ui.module.css";
import { localDateTime } from "../lib/dates";
import { formatMacro } from "../lib/decimal";
import type { ExerciseFormValues } from "../lib/exercise";
import { parseResourceId } from "../lib/resource-id";
import { useConfirmFocus } from "../lib/use-confirm-focus";
import styles from "./EditExercise.module.css";

function initialValues(exercise: Exercise): ExerciseFormValues {
	const when = localDateTime(exercise.performed_at);
	const manual = exercise.kcal_source === "manual";
	return {
		activity: exercise.activity,
		name: exercise.name ?? "",
		minutes: String(exercise.minutes),
		manual,
		// 估算的熱量不放進欄位：勾「手動」時從空的開始打，不會不小心把估算的數字存成手動。
		kcal: manual ? formatMacro(exercise.kcal) : "",
		date: when.date,
		time: when.time,
		note: exercise.note ?? "",
	};
}

/** `/exercises/:id/edit`（運動規格 §7.3）。
 *
 *  **離線快取還在還原時不掛表單**（同 `Targets`）：還原期間建立的 observer 會把還原回來的那份
 *  當成「掛載之後抓回來的」。儲存送的是完整的一組，拿舊值預填的話，沒動的欄位會被改回去。 */
export function EditExercise() {
	const restoring = useIsRestoring();
	const { id } = useParams<{ id: string }>();
	return (
		<section className={ui.screen}>
			<h1>編輯運動</h1>
			{/* `key`：從一筆的編輯換到另一筆時，react-router 不會重掛元素——預填要跟著換。 */}
			{restoring ? <p>載入中…</p> : <ExerciseLoader key={id} />}
		</section>
	);
}

function ExerciseLoader() {
	const exerciseId = parseResourceId(useParams<{ id: string }>().id);
	const query = useExercise(exerciseId);
	const navigate = useNavigate();
	// 第一份掛載之後抓回來的**記下來就不再換**：存好之後失效會重抓，帶回來的值不該把表單重設
	//（同 `TargetsLoader`）。render 期間設 state 是 React 允許的寫法，只多 render 一次。
	const [prefill, setPrefill] = useState<Exercise | null>(null);
	const fresh =
		query.isFetchedAfterMount && query.isSuccess ? query.data : null;
	if (prefill === null && fresh != null) {
		setPrefill(fresh);
	}

	const notFound =
		!Number.isSafeInteger(exerciseId) ||
		(query.error instanceof ApiError && query.error.status === 404);
	if (notFound) {
		return (
			<div>
				<p>找不到這筆運動</p>
				<Link to="/" className={styles.back}>
					回總覽
				</Link>
			</div>
		);
	}
	if (prefill !== null) {
		return (
			<>
				<EditForm exercise={prefill} onDone={() => navigate("/")} />
				<DeleteExercise
					exerciseId={prefill.id}
					onDeleted={() => navigate("/")}
				/>
			</>
		);
	}
	// 還在抓（離線時是 paused，不會自己結束——那算讀不到）。
	if (!query.isFetchedAfterMount && query.fetchStatus !== "paused") {
		return <p>載入中…</p>;
	}
	return <p role="alert">無法載入這筆運動</p>;
}

function EditForm({
	exercise,
	onDone,
}: {
	exercise: Exercise;
	onDone: () => void;
}) {
	const client = useQueryClient();
	const [initial] = useState(() => initialValues(exercise));
	return (
		<ExerciseForm
			initial={initial}
			save={async (body) => {
				await updateExercise(exercise.id, body);
				await invalidateExercises(client);
			}}
			onSaved={onDone}
			sendNullKcalWhenEstimated
		/>
	);
}

/** 刪除（運動規格 §7.3）：畫面上的確認框，同 `/weight` 的清單。 */
function DeleteExercise({
	exerciseId,
	onDeleted,
}: {
	exerciseId: number;
	onDeleted: () => void;
}) {
	const client = useQueryClient();
	const [confirming, setConfirming] = useState(false);
	const [failed, setFailed] = useState(false);
	const confirmFocus = useConfirmFocus(confirming);
	const removing = useRef(false);
	const titleId = useId();

	const remove = useMutation({
		mutationFn: () => deleteExercise(exerciseId),
		onSuccess: async () => {
			// **先移除這一筆自己的快取，再失效其他。** 反過來的話失效 `exercises` 會前綴比對到
			// `exercise(id)`，讓還掛著的 `useExercise` 去重抓一筆已經刪掉的（404）。
			client.removeQueries({ queryKey: queryKeys.exercise(exerciseId) });
			await invalidateExercises(client);
		},
	});

	return (
		<section aria-label="刪除">
			{confirming ? (
				<div
					role="alertdialog"
					aria-labelledby={titleId}
					className={styles.confirm}
				>
					<p id={titleId}>刪除這筆運動？</p>
					<div className={styles.actions}>
						{/* 剛按下去焦點就在這顆上：用 aria-disabled，原生 disabled 會把焦點弄丟；
						    擋重複送出（刪兩次第二次是 404）的是 ref。 */}
						<button
							type="button"
							className={`${ui.secondary} ${ui.danger}`}
							aria-disabled={remove.isPending}
							onClick={() => {
								if (removing.current) return;
								removing.current = true;
								setFailed(false);
								remove.mutate(undefined, {
									onSuccess: onDeleted,
									onError: () => setFailed(true),
									onSettled: () => {
										removing.current = false;
									},
								});
							}}
						>
							刪除
						</button>
						<button
							ref={confirmFocus.cancelRef}
							type="button"
							className={ui.secondary}
							onClick={() => {
								confirmFocus.cancelled();
								setConfirming(false);
							}}
						>
							取消
						</button>
					</div>
				</div>
			) : (
				<button
					ref={confirmFocus.triggerRef}
					type="button"
					className={`${ui.secondary} ${ui.danger}`}
					onClick={() => setConfirming(true)}
				>
					刪除這筆運動
				</button>
			)}
			{failed && <p role="alert">刪除失敗，請再試一次</p>}
		</section>
	);
}
