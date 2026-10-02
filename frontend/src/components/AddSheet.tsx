import { Utensils, Wallet } from "lucide-react";
import { useEffect, useRef } from "react";
import { Link } from "react-router";
import { CATEGORY_COLORS } from "../api/expenses";
import styles from "./AddSheet.module.css";
import { IconBadge } from "./IconBadge";

type Props = {
	/** Esc、取消、點背景：留在原頁，呼叫端負責把焦點還給「＋」。 */
	onDismiss: () => void;
	/** 點了入口連結：換頁，不需要還焦點。 */
	onNavigate: () => void;
};

/** 「＋」滑出的面板：記帳或記一餐（規格 §3.1、§5.1）。
 *
 *  三種關法：「取消」、點背景、按 Esc。開著時是 `role="dialog"`＋
 *  `aria-modal`，焦點一打開就移到第一個入口——不然鍵盤使用者的焦點會
 *  留在被遮住的「＋」上。
 *
 *  背景是一顆 `tabIndex={-1}` 的按鈕而不是 `<div onClick>`：Biome 的
 *  a11y 規則不接受沒有鍵盤對應的可點擊 div；鍵盤使用者用 Esc 或「取消」。 */
export function AddSheet({ onDismiss, onNavigate }: Props) {
	const firstChoice = useRef<HTMLAnchorElement>(null);

	useEffect(() => {
		firstChoice.current?.focus();
	}, []);

	useEffect(() => {
		function closeOnEscape(event: KeyboardEvent) {
			if (event.key === "Escape") onDismiss();
		}
		window.addEventListener("keydown", closeOnEscape);
		return () => window.removeEventListener("keydown", closeOnEscape);
	}, [onDismiss]);

	return (
		<div className={styles.layer}>
			<button
				type="button"
				className={styles.backdrop}
				aria-label="關閉"
				tabIndex={-1}
				onClick={onDismiss}
			/>
			<div
				role="dialog"
				aria-modal="true"
				aria-label="新增紀錄"
				className={styles.sheet}
			>
				<div className={styles.choices}>
					<Link
						ref={firstChoice}
						to="/expenses/new"
						className={styles.choice}
						onClick={onNavigate}
					>
						<IconBadge icon={Wallet} color="var(--color-action)" size="large" />
						記帳
					</Link>
					<Link to="/meals/new" className={styles.choice} onClick={onNavigate}>
						<IconBadge
							icon={Utensils}
							color={CATEGORY_COLORS.food}
							size="large"
						/>
						記一餐
					</Link>
				</div>
				<button type="button" className={styles.cancel} onClick={onDismiss}>
					取消
				</button>
			</div>
		</div>
	);
}
