import { useState } from "react";
import { Link } from "react-router";
import { apiFetch } from "../api/client";
import { useMe } from "../api/me";
import { logout } from "../auth/session";
import { AccountCard } from "../components/AccountCard";
import { AccountsAdmin } from "../components/AccountsAdmin";
import { Card } from "../components/Card";
import { FriendsCard } from "../components/FriendsCard";
import { InviteFriends } from "../components/InviteFriends";
import { TargetsCard } from "../components/TargetsCard";
import styles from "./Me.module.css";

type Props = { onLoggedOut: () => void };

/** 我的：帳號、每日目標、好友、管理員的審核、邀請與所有帳號、登出（介面改版規格 §5.7、帳號設定規格 §5.1）。 */
export function Me({ onLoggedOut }: Props) {
	// 帳號卡片自己讀 useMe；這裡只剩「是不是管理員」要用它（同一個 query，不會多打一次）。
	const me = useMe().data;
	// `me?.role` 而不是先判斷 isPending：useMe() 還在載入時 data 是
	// undefined，`undefined?.role === "admin"` 自然是 false——「審核」一開始
	// 就不畫，不會先閃一下再消失。
	const isAdmin = me?.role === "admin";

	// 從原本 App.tsx 的 <Nav> 搬過來，行為一個字都沒改（介面改版 Task 5）。
	//
	// 這顆按鈕是 e2e/auth.spec.ts 在強制 access token 過期後，用來觸發一次
	// 需要認證的請求的路徑（驗證「自動換票並重送」，P3-A 規格 §8.1）。它直接
	// 呼叫 apiFetch("/api/me") 並顯示 display_name，不碰 useMe() 的快取。
	// （useMe().refetch() 也會發請求——refetch 不看 staleTime——所以保留直接
	// 呼叫只是因為 E2E 是照它寫的，不是因為 refetch 不行。）
	const [displayName, setDisplayName] = useState<string | null>(null);
	const [refreshFailed, setRefreshFailed] = useState(false);

	return (
		<section>
			<h1>我的</h1>

			<AccountCard />

			<TargetsCard />

			<FriendsCard />

			{isAdmin && (
				<Card>
					<Link to="/admin/revisions" className={styles.adminLink}>
						審核
					</Link>
				</Card>
			)}

			{isAdmin && <InviteFriends />}

			{isAdmin && <AccountsAdmin />}

			<Card>
				<button
					type="button"
					className={styles.secondary}
					onClick={async () => {
						try {
							const fresh = await apiFetch<{ display_name: string }>("/api/me");
							setRefreshFailed(false);
							setDisplayName(fresh?.display_name ?? null);
						} catch {
							setRefreshFailed(true);
						}
					}}
				>
					重新整理
				</button>
				{displayName !== null && <p>{displayName}</p>}
				{refreshFailed && <p role="alert">無法重新整理</p>}
			</Card>

			<button
				type="button"
				className={styles.logout}
				onClick={async () => {
					await logout();
					onLoggedOut();
				}}
			>
				登出
			</button>
		</section>
	);
}
