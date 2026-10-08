import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
	type AdminUser,
	createPasswordReset,
	resetLink,
	useAdminUsers,
} from "../api/admin-users";
import { ApiError } from "../api/errors";
import { useMe } from "../api/me";
import { queryKeys } from "../api/queries";
import styles from "./AccountsAdmin.module.css";
import { Card } from "./Card";
import ui from "./ui.module.css";

// 寫成一個字串：「24 小時」中間的空白不能靠 JSX 換行時的空白規則湊出來。
const ONCE_TEXT =
	"這個連結只會顯示這一次，24 小時內有效、只能用一次。再產生一次，舊的就不能用了。";

/** 剛產生的那條連結：碼只在產生的回應裡出現一次（規格 §3.4），重新整理就沒了。 */
type Created = { name: string; token: string };

/** 「我的」裡的「所有帳號」（帳號設定規格 §5.4，管理員限定——藏起來只是可用性，授權在後端
 *  `require_admin`）。替一般使用者產生一次性的重設密碼連結，取代 SSH 跑 `create-user`。
 *  連結的顯示、分享、複製照抄 `InviteFriends`。 */
export function AccountsAdmin() {
	const queryClient = useQueryClient();
	const users = useAdminUsers();
	const me = useMe().data;
	const [created, setCreated] = useState<Created | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [copyStatus, setCopyStatus] = useState<string | null>(null);

	const create = useMutation({
		mutationFn: (user: AdminUser) => createPasswordReset(user.id),
		onSuccess: (result, user) => {
			// 再產生別人的就換掉：一次只顯示一條，不會把 A 的連結誤傳給 B。
			setCreated({ name: user.display_name, token: result.token });
			setNotice(null);
			setCopyStatus(null);
		},
		onError: (caught: unknown) => {
			if (
				caught instanceof ApiError &&
				(caught.status === 404 || caught.status === 422)
			) {
				// 清單是舊的（帳號被刪了、剛被升成管理員）：重新載入之後那一列會變，訊息掛在列上
				// 就跟著消失，所以放在卡片這一層。
				setNotice(caught.message);
				void queryClient.invalidateQueries({ queryKey: queryKeys.adminUsers });
			} else {
				setNotice("產生失敗，請再試一次");
			}
		},
	});

	// 不列自己：自己的帳號在最上面的帳號卡片；同一個 email 出現兩次，e2e/auth.spec.ts 的
	// getByText(ADMIN.email) 會撞嚴格模式（規格 §5.4）。
	const others = (users.data ?? []).filter((user) => user.id !== me?.id);
	const link = created === null ? null : resetLink(created.token);

	return (
		<Card>
			<h2 className={styles.title}>所有帳號</h2>

			{created !== null && link !== null && (
				<div className={styles.created}>
					<p className={styles.createdFor}>給 {created.name} 的重設密碼連結</p>
					<label htmlFor="reset-link">重設密碼連結</label>
					<input
						id="reset-link"
						readOnly
						value={link}
						onFocus={(event) => event.currentTarget.select()}
					/>
					<p>{ONCE_TEXT}</p>
					<div className={styles.actions}>
						{typeof navigator.share === "function" && (
							<button
								type="button"
								className={ui.secondary}
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
							className={ui.secondary}
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

			{notice !== null && (
				<p role="alert" className={styles.error}>
					{notice}
				</p>
			)}

			{/* 等 useMe 也回來才畫清單：不然自己會先出現一下、再被濾掉。 */}
			{users.isPending || (me === undefined && !users.isError) ? (
				<p>載入中…</p>
			) : users.isError ? (
				<p role="alert" className={styles.error}>
					無法載入帳號清單
				</p>
			) : others.length === 0 ? (
				<p className={styles.muted}>還沒有其他帳號</p>
			) : (
				<ul className={styles.list}>
					{others.map((user) => (
						<li key={user.id} className={styles.row}>
							{/* 名字與 email 各自一個元素，不拼成「名字（email）」：e2e/invites.spec.ts 找的
							    `E2E 朋友（{email}）` 會同時對到這裡（規格 §5.4）。 */}
							<div className={styles.who}>
								<span>
									<span>{user.display_name}</span>
									{user.role === "admin" && (
										<span className={ui.tag}>管理員</span>
									)}
								</span>
								<span className={styles.email}>{user.email}</span>
							</div>
							{user.role === "admin" ? (
								// 管理員帳號不能用重設連結（規格 決定 12）：偷到管理員 token 的人不能拿它接管管理員。
								<span className={styles.muted}>用命令列重設</span>
							) : (
								<button
									type="button"
									className={ui.secondary}
									aria-label={`產生重設密碼連結：${user.display_name}（${user.email}）`}
									disabled={create.isPending}
									onClick={() => {
										setNotice(null);
										create.mutate(user);
									}}
								>
									產生重設密碼連結
								</button>
							)}
						</li>
					))}
				</ul>
			)}
		</Card>
	);
}
