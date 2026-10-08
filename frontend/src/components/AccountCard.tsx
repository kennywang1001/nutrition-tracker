import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { ApiError, describeFieldErrors } from "../api/errors";
import { updateDisplayName, useMe } from "../api/me";
import { queryKeys } from "../api/queries";
import styles from "./AccountCard.module.css";
import { Card } from "./Card";
import ui from "./ui.module.css";

/** 「我的」最上面的帳號卡片（帳號設定規格 §5.1）：名字、email、行內改名稱、「修改密碼」。
 *  只有一個欄位，所以是行內表單、不開新頁（規格 決定 7）。 */
export function AccountCard() {
	const queryClient = useQueryClient();
	const meQuery = useMe();
	const me = meQuery.data;
	const [editing, setEditing] = useState(false);
	const [name, setName] = useState("");
	const [error, setError] = useState<string | null>(null);
	const editButtonRef = useRef<HTMLButtonElement>(null);
	const inputRef = useRef<HTMLInputElement>(null);
	// 「修改名稱」與表單是二選一的條件 render：收起來時按鈕是重新掛上的，焦點要在 effect 裡
	// （ref 接上之後）才移得過去。只有「取消」與「存好」才搶焦點（同 useConfirmFocus 的旗標）。
	const returnFocus = useRef(false);

	useEffect(() => {
		if (editing) {
			inputRef.current?.focus();
		} else if (returnFocus.current) {
			returnFocus.current = false;
			editButtonRef.current?.focus();
		}
	}, [editing]);

	const save = useMutation({
		mutationFn: (displayName: string) => updateDisplayName(displayName),
		onSuccess: (updated) => {
			// 先放回應進快取，畫面立刻換成新名字；再失效，讓其他掛著 useMe 的地方跟後端對齊。
			queryClient.setQueryData(queryKeys.me, updated);
			void queryClient.invalidateQueries({ queryKey: queryKeys.me });
		},
	});

	function close() {
		returnFocus.current = true;
		setEditing(false);
		setError(null);
	}

	function handleSubmit(event: FormEvent) {
		event.preventDefault();
		// 去掉前後空白再送：後端的 DisplayName 也會 strip，但前端要先擋「只有空白」，
		// 不然送出去只會拿回一句看不懂的 422。
		const trimmed = name.trim();
		if (trimmed === "") {
			setError("名稱不能是空白");
			return;
		}
		setError(null);
		// 收起表單放在 mutate 的 callback：元件卸載之後不會跑（handover §7）。
		save.mutate(trimmed, {
			onSuccess: close,
			onError: (caught: unknown) => {
				setError(
					caught instanceof ApiError && caught.status === 422
						? describeFieldErrors(caught).join("；")
						: "儲存失敗，請再試一次",
				);
			},
		});
	}

	if (meQuery.isPending) {
		return (
			<Card>
				<p className={styles.text}>載入中…</p>
			</Card>
		);
	}
	if (meQuery.isError || me == null) {
		return (
			<Card>
				<p className={styles.text}>無法載入帳號資料</p>
			</Card>
		);
	}

	return (
		<Card>
			<p className={styles.name}>{me.display_name}</p>
			<p className={styles.email}>{me.email}</p>
			{editing ? (
				<form className={styles.form} onSubmit={handleSubmit} noValidate>
					<label htmlFor="display-name">顯示名稱</label>
					<input
						id="display-name"
						ref={inputRef}
						maxLength={50}
						autoComplete="nickname"
						value={name}
						onChange={(event) => setName(event.target.value)}
					/>
					{error !== null && (
						<p role="alert" className={styles.error}>
							{error}
						</p>
					)}
					<div className={styles.actions}>
						<button
							type="submit"
							className={`${ui.secondary} ${ui.primary}`}
							disabled={save.isPending}
						>
							儲存
						</button>
						<button type="button" className={ui.secondary} onClick={close}>
							取消
						</button>
					</div>
				</form>
			) : (
				<div className={styles.actions}>
					<button
						ref={editButtonRef}
						type="button"
						className={ui.secondary}
						onClick={() => {
							setName(me.display_name);
							setEditing(true);
						}}
					>
						修改名稱
					</button>
					<Link to="/me/password" className={styles.link}>
						修改密碼
					</Link>
				</div>
			)}
		</Card>
	);
}
