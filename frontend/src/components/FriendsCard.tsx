import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { ApiError } from "../api/errors";
import {
	acceptFriendRequest,
	deleteFriendRequest,
	type Friend,
	forgetFriend,
	removeFriend,
	resetFriendCode,
	sendFriendRequest,
	useFriendCode,
	useFriendRequests,
	useFriends,
} from "../api/friends";
import { queryKeys } from "../api/queries";
import { Card } from "./Card";
import styles from "./FriendsCard.module.css";

type Notice = { kind: "ok" | "error"; text: string };

/** 「我的」的好友卡片（好友規格 §5.3）：好友碼、加好友、邀請、名單。 */
export function FriendsCard() {
	const queryClient = useQueryClient();
	const code = useFriendCode();
	const requests = useFriendRequests();
	const friends = useFriends();
	const [input, setInput] = useState("");
	const [notice, setNotice] = useState<Notice | null>(null);
	const [copyStatus, setCopyStatus] = useState<string | null>(null);
	const [confirmingReset, setConfirmingReset] = useState(false);

	function refreshRequests() {
		void queryClient.invalidateQueries({ queryKey: queryKeys.friendRequests });
		void queryClient.invalidateQueries({ queryKey: queryKeys.friends });
		void queryClient.invalidateQueries({ queryKey: queryKeys.friendFeed });
	}

	const reset = useMutation({
		mutationFn: resetFriendCode,
		onSuccess: (result) => {
			queryClient.setQueryData(queryKeys.friendCode, result);
			setConfirmingReset(false);
			setCopyStatus(null);
		},
	});

	const send = useMutation({
		mutationFn: (value: string) => sendFriendRequest(value),
		onSuccess: (result) => {
			setInput("");
			setNotice({
				kind: "ok",
				text:
					result.status === "accepted"
						? `你和${result.person.display_name}已經是好友了`
						: `已送出邀請給${result.person.display_name}，等對方接受`,
			});
			refreshRequests();
		},
		onError: (caught: unknown) => {
			setNotice({
				kind: "error",
				text:
					caught instanceof ApiError ? caught.message : "送出失敗，請再試一次",
			});
		},
	});

	function handleSend(event: FormEvent) {
		event.preventDefault();
		setNotice(null);
		const trimmed = input.trim();
		if (trimmed !== "") send.mutate(trimmed);
	}

	const myCode = code.data?.code ?? null;
	const incoming = requests.data?.incoming ?? [];
	const outgoing = requests.data?.outgoing ?? [];
	const friendList = friends.data ?? [];

	return (
		<Card>
			<h2 className={styles.title}>
				{incoming.length > 0 ? `好友（${incoming.length} 個新邀請）` : "好友"}
			</h2>

			<h3 className={styles.subtitle}>我的好友碼</h3>
			{myCode === null ? (
				<p>{code.isError ? "無法載入好友碼" : "載入中…"}</p>
			) : (
				<>
					<p className={styles.code} data-testid="friend-code">
						{myCode}
					</p>
					<div className={styles.actions}>
						{typeof navigator.share === "function" && (
							<button
								type="button"
								className={styles.secondary}
								onClick={() => {
									// 使用者自己關掉分享面板也是 reject——不算錯誤。
									navigator
										.share({ text: `加我好友：${myCode}` })
										.catch(() => {});
								}}
							>
								分享
							</button>
						)}
						<button
							type="button"
							className={styles.secondary}
							aria-label="複製好友碼"
							onClick={async () => {
								try {
									await navigator.clipboard.writeText(myCode);
									setCopyStatus("已複製");
								} catch {
									setCopyStatus("複製失敗，請長按好友碼自己複製");
								}
							}}
						>
							複製
						</button>
						{confirmingReset ? (
							<div
								role="alertdialog"
								aria-label="確認重設好友碼"
								className={styles.confirm}
							>
								<p>重設之後舊的好友碼就不能用了，已經是好友的不受影響。</p>
								<button
									type="button"
									className={styles.danger}
									disabled={reset.isPending}
									onClick={() => reset.mutate()}
								>
									確定重設
								</button>
								<button
									type="button"
									className={styles.secondary}
									onClick={() => setConfirmingReset(false)}
								>
									取消
								</button>
							</div>
						) : (
							<button
								type="button"
								className={styles.secondary}
								aria-label="重設好友碼"
								onClick={() => setConfirmingReset(true)}
							>
								重設
							</button>
						)}
					</div>
					{copyStatus !== null && <p role="status">{copyStatus}</p>}
					{reset.isError && (
						<p role="alert" className={styles.error}>
							重設失敗，請再試一次
						</p>
					)}
				</>
			)}

			<h3 className={styles.subtitle}>加好友</h3>
			<form className={styles.form} onSubmit={handleSend}>
				<label htmlFor="friend-code-input">朋友的好友碼</label>
				<input
					id="friend-code-input"
					value={input}
					autoComplete="off"
					maxLength={32}
					placeholder="例如：K7MX-Q2PD"
					onChange={(event) => setInput(event.target.value)}
				/>
				<button
					type="submit"
					className={styles.primary}
					disabled={send.isPending || input.trim() === ""}
				>
					送出邀請
				</button>
				{notice !== null && (
					<p
						role={notice.kind === "error" ? "alert" : "status"}
						className={notice.kind === "error" ? styles.error : styles.notice}
					>
						{notice.text}
					</p>
				)}
			</form>

			{incoming.length > 0 && (
				<>
					<h3 className={styles.subtitle}>收到的邀請</h3>
					<ul className={styles.list}>
						{incoming.map((request) => (
							<IncomingRow
								key={request.id}
								id={request.id}
								name={request.person.display_name}
								onDone={refreshRequests}
							/>
						))}
					</ul>
				</>
			)}

			{outgoing.length > 0 && (
				<>
					<h3 className={styles.subtitle}>送出的邀請</h3>
					<ul className={styles.list}>
						{outgoing.map((request) => (
							<OutgoingRow
								key={request.id}
								id={request.id}
								name={request.person.display_name}
								onDone={refreshRequests}
							/>
						))}
					</ul>
				</>
			)}

			<h3 className={styles.subtitle}>好友名單</h3>
			{friends.isPending ? (
				<p>載入中…</p>
			) : friendList.length === 0 ? (
				<p className={styles.notice}>還沒有好友</p>
			) : (
				<ul className={styles.list}>
					{friendList.map((friend) => (
						<FriendRow key={friend.id} friend={friend} />
					))}
				</ul>
			)}
		</Card>
	);
}

/** `onDone` 在成功**與失敗**之後都跑（`onSettled`）：失敗多半是對方剛好
 *  收回／接受了（404），重新載入才會讓過時的那一列消失。 */
type RowProps = { id: number; name: string; onDone: () => void };

function IncomingRow({ id, name, onDone }: RowProps) {
	const accept = useMutation({
		mutationFn: () => acceptFriendRequest(id),
		onSettled: onDone,
	});
	const decline = useMutation({
		mutationFn: () => deleteFriendRequest(id),
		onSettled: onDone,
	});
	const busy = accept.isPending || decline.isPending;
	return (
		<li className={styles.row}>
			<span className={styles.name}>{name}</span>
			<button
				type="button"
				className={styles.primary}
				aria-label={`接受${name}的邀請`}
				disabled={busy}
				onClick={() => accept.mutate()}
			>
				接受
			</button>
			<button
				type="button"
				className={styles.secondary}
				aria-label={`拒絕${name}的邀請`}
				disabled={busy}
				onClick={() => decline.mutate()}
			>
				拒絕
			</button>
			{(accept.isError || decline.isError) && (
				<p role="alert" className={styles.error}>
					失敗了，請再試一次
				</p>
			)}
		</li>
	);
}

function OutgoingRow({ id, name, onDone }: RowProps) {
	const withdraw = useMutation({
		mutationFn: () => deleteFriendRequest(id),
		onSettled: onDone,
	});
	return (
		<li className={styles.row}>
			<span className={styles.name}>{name}（等對方接受）</span>
			<button
				type="button"
				className={styles.secondary}
				aria-label={`收回給${name}的邀請`}
				disabled={withdraw.isPending}
				onClick={() => withdraw.mutate()}
			>
				收回
			</button>
			{withdraw.isError && (
				<p role="alert" className={styles.error}>
					收回失敗，請再試一次
				</p>
			)}
		</li>
	);
}

function FriendRow({ friend }: { friend: Friend }) {
	const queryClient = useQueryClient();
	const [confirming, setConfirming] = useState(false);
	const name = friend.display_name;
	const remove = useMutation({
		mutationFn: () => removeFriend(friend.id),
		onSuccess: () => forgetFriend(queryClient, friend.id),
	});
	return (
		<li className={styles.row}>
			<span className={styles.name}>{name}</span>
			{confirming ? (
				<div
					role="alertdialog"
					aria-label={`確認解除和${name}的好友`}
					className={styles.confirm}
				>
					<p>
						解除之後雙方都看不到對方的餐點。已經看過的照片可能還留在對方手機的快取裡。
					</p>
					<button
						type="button"
						className={styles.danger}
						disabled={remove.isPending}
						onClick={() => remove.mutate()}
					>
						確定解除
					</button>
					<button
						type="button"
						className={styles.secondary}
						onClick={() => setConfirming(false)}
					>
						取消
					</button>
				</div>
			) : (
				<button
					type="button"
					className={styles.danger}
					aria-label={`解除和${name}的好友`}
					onClick={() => setConfirming(true)}
				>
					解除
				</button>
			)}
			{remove.isError && (
				<p role="alert" className={styles.error}>
					解除失敗，請再試一次
				</p>
			)}
		</li>
	);
}
