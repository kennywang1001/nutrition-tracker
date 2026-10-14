import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { useWeights } from "../api/body";
import { formatCivilDate } from "../lib/civil-date";
import { formatMacro, isPositiveAmount } from "../lib/decimal";
import { weekChange } from "../lib/weights";
import { Card } from "./Card";
import ui from "./ui.module.css";
import styles from "./WeightCard.module.css";
import { WeightForm } from "./WeightForm";

/** 「+0.5」「-1」「0」：變重了加 +（跟負號對稱，一眼看出方向）。負號照 `formatMacro` 的 "-"，
 *  跟每日目標卡片的重算提示一致。 */
export function signedKg(change: string): string {
	return isPositiveAmount(change)
		? `+${formatMacro(change)}`
		: formatMacro(change);
}

/** 「我的」的體重（身體資料規格 §6.2）：最新一筆、跟 7 天前比、行內記錄、看全部。
 *  「今天」用 `GET /api/weights` 回的 `today`——前端不算今天，讀不到就不給記錄的按鈕。 */
export function WeightCard() {
	const weights = useWeights();
	const [open, setOpen] = useState(false);
	const triggerRef = useRef<HTMLButtonElement>(null);
	// 收起來時焦點回到「記錄體重」（按鈕與表單二選一，收起來時是一顆新掛上的按鈕，要在 effect 裡移）。
	const returnFocus = useRef(false);

	useEffect(() => {
		if (!open && returnFocus.current) {
			returnFocus.current = false;
			triggerRef.current?.focus();
		}
	}, [open]);

	function close() {
		returnFocus.current = true;
		setOpen(false);
	}

	const data = weights.data;
	const latest = data?.entries.at(-1);
	const change = data === undefined ? null : weekChange(data.entries);

	return (
		<Card testId="weight-card">
			<h2 className={`${ui.sectionTitle} ${styles.title}`}>體重</h2>
			{weights.isPending ? (
				<p className={styles.text}>載入中…</p>
			) : data == null ? (
				<p className={styles.text}>無法載入體重</p>
			) : latest === undefined ? (
				<p className={styles.text}>還沒有體重紀錄</p>
			) : (
				<>
					<p className={styles.latest}>
						{formatMacro(latest.weight_kg)} 公斤・{formatCivilDate(latest.date)}
					</p>
					{change !== null && (
						<p className={styles.change}>
							比 7 天前 {signedKg(change.change)} 公斤
						</p>
					)}
				</>
			)}
			{data != null &&
				(open ? (
					<div className={styles.form}>
						<WeightForm
							today={data.today}
							onSaved={close}
							onCancel={close}
							focusOnMount
						/>
					</div>
				) : (
					<div className={styles.actions}>
						<button
							ref={triggerRef}
							type="button"
							className={ui.secondary}
							onClick={() => setOpen(true)}
						>
							記錄體重
						</button>
						<Link to="/weight" className={styles.link}>
							看全部
						</Link>
					</div>
				))}
		</Card>
	);
}
