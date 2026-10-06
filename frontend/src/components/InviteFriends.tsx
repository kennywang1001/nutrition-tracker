import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { ApiError, describeFieldErrors } from "../api/errors";
import {
	createInvite,
	type InviteCreated,
	type InviteListItem,
	inviteLink,
	revokeInvite,
	useInvites,
} from "../api/invites";
import { queryKeys } from "../api/queries";
import { formatDateTime } from "../lib/dates";
import { Card } from "./Card";
import styles from "./InviteFriends.module.css";

function inviteLabel(invite: InviteListItem): string {
	return invite.note ?? "沒有備註的邀請";
}

/** 「我的」裡的「邀請朋友」（邀請規格 §4.2，管理員限定——藏起來只是可用性，
 *  授權在後端 `require_admin`）。 */
export function InviteFriends() {
	const queryClient = useQueryClient();
	const invites = useInvites();
	const [note, setNote] = useState("");
	const [created, setCreated] = useState<InviteCreated | null>(null);
	const [createError, setCreateError] = useState<string | null>(null);
	const [copyStatus, setCopyStatus] = useState<string | null>(null);

	const create = useMutation({
		mutationFn: (trimmed: string | null) => createInvite(trimmed),
		onSuccess: (result) => {
			setCreated(result);
			setNote("");
			setCopyStatus(null);
			queryClient.invalidateQueries({ queryKey: queryKeys.invites });
		},
		onError: (caught: unknown) => {
			setCreateError(
				caught instanceof ApiError && caught.status === 422
					? describeFieldErrors(caught).join("；")
					: "產生失敗，請再試一次",
			);
		},
	});

	function handleCreate(event: FormEvent) {
		event.preventDefault();
		setCreateError(null);
		const trimmed = note.trim();
		create.mutate(trimmed === "" ? null : trimmed);
	}

	const link = created === null ? null : inviteLink(created.token);
	const pending =
		invites.data?.filter((item) => item.status === "pending") ?? [];
	const used = invites.data?.filter((item) => item.status === "used") ?? [];

	return (
		<Card>
			<h2 className={styles.title}>邀請朋友</h2>
			<form className={styles.form} onSubmit={handleCreate}>
				<label htmlFor="invite-note">給誰？（選填）</label>
				<input
					id="invite-note"
					value={note}
					maxLength={50}
					placeholder="例如：小明"
					onChange={(event) => setNote(event.target.value)}
				/>
				<button
					type="submit"
					className={styles.primary}
					disabled={create.isPending}
				>
					產生邀請連結
				</button>
				{createError !== null && (
					<p role="alert" className={styles.error}>
						{createError}
					</p>
				)}
			</form>

			{link !== null && (
				<div className={styles.created}>
					<label htmlFor="invite-link">邀請連結</label>
					<input
						id="invite-link"
						readOnly
						value={link}
						onFocus={(event) => event.currentTarget.select()}
					/>
					<p>這個連結只會顯示這一次，7 天內有效、只能用一次。</p>
					<div className={styles.actions}>
						{typeof navigator.share === "function" && (
							<button
								type="button"
								className={styles.secondary}
								onClick={() => {
									// 使用者自己關掉分享面板也是 reject——不算錯誤。
									navigator.share({ url: link }).catch(() => {});
								}}
							>
								分享
							</button>
						)}
						<button
							type="button"
							className={styles.secondary}
							onClick={async () => {
								try {
									await navigator.clipboard.writeText(link);
									setCopyStatus("已複製");
								} catch {
									setCopyStatus("複製失敗，請長按連結自己複製");
								}
							}}
						>
							複製
						</button>
					</div>
					{copyStatus !== null && <p role="status">{copyStatus}</p>}
				</div>
			)}

			<h3 className={styles.subtitle}>還沒用的</h3>
			{invites.isPending ? (
				<p>載入中…</p>
			) : invites.isError ? (
				<p role="alert" className={styles.error}>
					無法載入邀請
				</p>
			) : pending.length === 0 ? (
				<p className={styles.muted}>沒有還沒用的邀請</p>
			) : (
				<ul className={styles.list}>
					{pending.map((invite) => (
						<PendingInviteRow key={invite.id} invite={invite} />
					))}
				</ul>
			)}

			{used.length > 0 && (
				<>
					<h3 className={styles.subtitle}>已經用掉的</h3>
					<ul className={styles.list}>
						{used.map((invite) => (
							<li key={invite.id} className={styles.row}>
								<span>{inviteLabel(invite)}</span>
								<span className={styles.muted}>
									{invite.used_by === null
										? "帳號已刪除"
										: `${invite.used_by.display_name}（${invite.used_by.email}）`}
								</span>
								{invite.used_at !== null && (
									<span className={styles.muted}>
										{formatDateTime(invite.used_at)}
									</span>
								)}
							</li>
						))}
					</ul>
				</>
			)}
		</Card>
	);
}

function PendingInviteRow({ invite }: { invite: InviteListItem }) {
	const queryClient = useQueryClient();
	const [confirming, setConfirming] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const label = inviteLabel(invite);

	const revoke = useMutation({
		mutationFn: () => revokeInvite(invite.id),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.invites });
		},
		onError: (caught: unknown) => {
			// 已經被用掉、或已經不在了（另一個分頁撤銷過）：清單是舊的，重新載入。
			if (
				caught instanceof ApiError &&
				(caught.code === "INVITE_USED" || caught.code === "INVITE_NOT_FOUND")
			) {
				setError(caught.message);
				queryClient.invalidateQueries({ queryKey: queryKeys.invites });
			} else {
				setError("撤銷失敗，請再試一次");
			}
		},
	});

	return (
		<li className={styles.row}>
			<span>{label}</span>
			<span className={styles.muted}>
				{formatDateTime(invite.expires_at)} 到期
			</span>
			{confirming ? (
				<div
					role="alertdialog"
					aria-label={`確認撤銷${label}`}
					className={styles.confirm}
				>
					<p>撤銷之後這個連結就不能用了。</p>
					<button
						type="button"
						className={styles.danger}
						disabled={revoke.isPending}
						onClick={() => {
							setError(null);
							revoke.mutate();
						}}
					>
						確定撤銷
					</button>
					<button
						type="button"
						className={styles.secondary}
						onClick={() => {
							setConfirming(false);
							setError(null);
						}}
					>
						取消
					</button>
				</div>
			) : (
				<button
					type="button"
					className={styles.danger}
					aria-label={`撤銷${label}`}
					onClick={() => setConfirming(true)}
				>
					撤銷
				</button>
			)}
			{error !== null && (
				<p role="alert" className={styles.error}>
					{error}
				</p>
			)}
		</li>
	);
}
