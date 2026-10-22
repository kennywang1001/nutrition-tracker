import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
	type FormEvent,
	type RefObject,
	useEffect,
	useId,
	useRef,
	useState,
} from "react";
import {
	deleteWeight,
	invalidateBody,
	saveWeight,
	useBodyProfile,
	useWeights,
	type WeightEntry,
} from "../api/body";
import { ApiError, describeFieldErrors } from "../api/errors";
import segmented from "../components/Segmented.module.css";
import ui from "../components/ui.module.css";
import { WeightChart } from "../components/WeightChart";
import {
	WEIGHT_PROBLEM,
	WEIGHT_RULE,
	WeightForm,
} from "../components/WeightForm";
import { checkRangeInput, formatMacro } from "../lib/decimal";
import { useConfirmFocus } from "../lib/use-confirm-focus";
import {
	dateLabel,
	entriesInSpan,
	movingAverage,
	recentAverage,
	type WeightSpan,
} from "../lib/weights";
import styles from "./Weight.module.css";

const SPANS = [
	{ value: 30, label: "30 天" },
	{ value: 90, label: "90 天" },
	{ value: "all", label: "全部" },
] as const satisfies readonly { value: WeightSpan; label: string }[];

/** `/weight`（身體資料規格 §6.4）：期間切換、圖表、記一筆、由新到舊的清單（修改、刪除）。
 *
 *  **一個 query（最近 800 天）**，30／90／全部在前端篩（D22）：一人一天最多一筆，切換不用等網路。
 *  圖的右端與表單的預設日期都是回應裡的 `today`——前端不算今天。 */
export function Weight() {
	const weights = useWeights();
	// 目標體重只是圖上的一條線；讀不到就當沒有，不擋整頁。
	const targetKg = useBodyProfile().data?.target_weight_kg ?? null;
	const [span, setSpan] = useState<WeightSpan>(30);
	const data = weights.data;

	return (
		<section className={ui.screen}>
			<h1>體重</h1>
			{weights.isPending ? (
				<p>載入中…</p>
			) : data == null ? (
				<p role="alert">無法載入體重</p>
			) : (
				<WeightBody
					today={data.today}
					all={data.entries}
					span={span}
					onSpan={setSpan}
					targetKg={targetKg}
				/>
			)}
		</section>
	);
}

function WeightBody({
	today,
	all,
	span,
	onSpan,
	targetKg,
}: {
	today: string;
	all: readonly WeightEntry[];
	span: WeightSpan;
	onSpan: (span: WeightSpan) => void;
	targetKg: string | null;
}) {
	const formTitleId = useId();
	const listTitleId = useId();
	// 平均用**全部**的紀錄算，再只畫範圍內的：範圍開頭那幾天的平均要用到範圍外的紀錄。
	const average = movingAverage(all);
	const shown = entriesInSpan(all, today, span);
	const recent = recentAverage(all, today);

	return (
		<>
			{all.length > 0 && (
				<>
					<fieldset className={segmented.group}>
						<legend className={segmented.legend}>期間</legend>
						{SPANS.map((option) => (
							<label key={option.value} className={segmented.option}>
								<input
									type="radio"
									name="weight-span"
									value={option.value}
									checked={span === option.value}
									onChange={() => onSpan(option.value)}
									className={segmented.input}
								/>
								{option.label}
							</label>
						))}
					</fieldset>

					<div data-testid="weight-chart-card">
						{shown.entries.length === 0 ? (
							<p>這段期間沒有體重紀錄</p>
						) : (
							<WeightChart
								entries={shown.entries}
								average={average}
								start={shown.start}
								end={today}
								today={today}
								targetKg={targetKg}
							/>
						)}
						{/* 圖的文字版：每個點的名稱在圖上，這兩句是「趨勢」本身。 */}
						{recent !== null && (
							<p className={styles.summary}>
								最近 7 天平均 {formatMacro(recent)} 公斤
							</p>
						)}
						{targetKg !== null && (
							<p className={styles.summary}>
								目標 {formatMacro(targetKg)} 公斤
							</p>
						)}
						{/* 每一項是「色塊＋字」包成一段：換行時色塊不會跟它的字分開。 */}
						<p className={styles.legend}>
							<span className={styles.legendItem}>
								<span className={styles.swatchDaily} aria-hidden="true" />
								每天的紀錄
							</span>
							<span className={styles.legendItem}>
								<span className={styles.swatchAverage} aria-hidden="true" />7
								天平均
							</span>
						</p>
					</div>
				</>
			)}

			<section aria-labelledby={formTitleId}>
				<h2 id={formTitleId}>記錄體重</h2>
				{all.length === 0 && <p className={styles.empty}>還沒有體重紀錄</p>}
				<WeightForm today={today} />
			</section>

			{all.length > 0 && (
				<section aria-labelledby={listTitleId}>
					<h2 id={listTitleId}>紀錄</h2>
					<ul className={styles.list} aria-label="體重紀錄">
						{[...all].reverse().map((entry) => (
							<WeightRow key={entry.date} entry={entry} today={today} />
						))}
					</ul>
				</section>
			)}
		</>
	);
}

/** 清單的一列：顯示 ↔ 修改 ↔ 確認刪除（同報表的花費列，`Expenses.tsx` 的 `ExpenseRow`）。 */
function WeightRow({ entry, today }: { entry: WeightEntry; today: string }) {
	const queryClient = useQueryClient();
	const label = dateLabel(entry.date, today);
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState("");
	const [confirming, setConfirming] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const confirmFocus = useConfirmFocus(confirming);
	const inputRef = useRef<HTMLInputElement>(null);
	const editRef = useRef<HTMLButtonElement>(null);
	// 修改框收起來（存好或取消）時焦點回到「修改」：按鈕是重新掛上的，要在 effect 裡移。
	const returnToEdit = useRef(false);
	const busy = useRef(false);
	const removing = useRef(false);

	useEffect(() => {
		if (editing) {
			inputRef.current?.focus();
		} else if (returnToEdit.current) {
			returnToEdit.current = false;
			editRef.current?.focus();
		}
	}, [editing]);

	const save = useMutation({
		mutationFn: (weight: string) => saveWeight(entry.date, weight),
		onSuccess: () => invalidateBody(queryClient),
		onSettled: () => {
			busy.current = false;
		},
	});
	const remove = useMutation({
		mutationFn: () => deleteWeight(entry.date),
		onSuccess: () => invalidateBody(queryClient),
	});

	function closeEditor() {
		returnToEdit.current = true;
		setEditing(false);
		setError(null);
	}

	function handleSave(event: FormEvent) {
		event.preventDefault();
		if (busy.current) return;
		if (checkRangeInput(draft, WEIGHT_RULE) !== null) {
			setError(WEIGHT_PROBLEM);
			return;
		}
		setError(null);
		busy.current = true;
		save.mutate(draft.trim(), {
			onSuccess: closeEditor,
			onError: (caught: unknown) =>
				setError(
					caught instanceof ApiError && caught.status === 422
						? describeFieldErrors(caught).join("；")
						: "儲存失敗，請再試一次",
				),
		});
	}

	return (
		<li className={styles.row}>
			<div className={styles.line}>
				<span className={styles.date}>{label}</span>
				<span className={styles.value}>
					{formatMacro(entry.weight_kg)} 公斤
				</span>
				{!editing && !confirming && (
					<span className={styles.actions}>
						<button
							ref={editRef}
							type="button"
							className={ui.secondary}
							aria-label={`修改 ${label}`}
							onClick={() => {
								// 草稿在打開的當下重新載入：清單可能在背景重抓過。
								setDraft(formatMacro(entry.weight_kg));
								setError(null);
								setEditing(true);
							}}
						>
							修改
						</button>
						<button
							ref={confirmFocus.triggerRef}
							type="button"
							className={`${ui.secondary} ${ui.danger}`}
							aria-label={`刪除 ${label}`}
							onClick={() => {
								setError(null);
								setConfirming(true);
							}}
						>
							刪除
						</button>
					</span>
				)}
			</div>

			{editing && (
				<form className={styles.editor} onSubmit={handleSave} noValidate>
					<input
						ref={inputRef}
						aria-label={`${label} 的體重（公斤）`}
						inputMode="decimal"
						autoComplete="off"
						value={draft}
						onChange={(event) => setDraft(event.target.value)}
					/>
					<button
						type="submit"
						className={`${ui.secondary} ${ui.primary}`}
						aria-disabled={save.isPending}
					>
						儲存
					</button>
					<button type="button" className={ui.secondary} onClick={closeEditor}>
						取消
					</button>
				</form>
			)}

			{confirming && (
				<ConfirmDelete
					label={label}
					pending={remove.isPending}
					cancelRef={confirmFocus.cancelRef}
					onConfirm={() => {
						if (removing.current) return;
						removing.current = true;
						setError(null);
						remove.mutate(undefined, {
							onError: () => setError("刪除失敗，請再試一次"),
							onSettled: () => {
								removing.current = false;
							},
						});
					}}
					onCancel={() => {
						confirmFocus.cancelled();
						setConfirming(false);
					}}
				/>
			)}

			{error !== null && (
				<p role="alert" className={styles.error}>
					{error}
				</p>
			)}
		</li>
	);
}

/** 畫面上的確認框（不用 `window.confirm`）：焦點先到「取消」——安全的那一顆。 */
function ConfirmDelete({
	label,
	pending,
	cancelRef,
	onConfirm,
	onCancel,
}: {
	label: string;
	pending: boolean;
	cancelRef: RefObject<HTMLButtonElement | null>;
	onConfirm: () => void;
	onCancel: () => void;
}) {
	const titleId = useId();
	return (
		<div
			role="alertdialog"
			aria-labelledby={titleId}
			className={styles.confirm}
		>
			<p id={titleId}>刪除 {label} 的體重？</p>
			<div className={styles.actions}>
				{/* 送出中不能再按（刪兩次第二次是 404）。剛按下去焦點就在這顆上：用 aria-disabled，
				    原生 disabled 會把焦點弄丟；擋重複送出的是呼叫端的 ref。 */}
				<button
					type="button"
					className={`${ui.secondary} ${ui.danger}`}
					aria-disabled={pending}
					onClick={onConfirm}
				>
					刪除
				</button>
				<button
					ref={cancelRef}
					type="button"
					className={ui.secondary}
					onClick={onCancel}
				>
					取消
				</button>
			</div>
		</div>
	);
}
