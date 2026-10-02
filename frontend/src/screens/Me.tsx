import { useState } from "react";
import { Link } from "react-router";
import { apiFetch } from "../api/client";
import { useMe } from "../api/me";
import { logout } from "../auth/session";
import { Card } from "../components/Card";
import styles from "./Me.module.css";

type Props = { onLoggedOut: () => void };

/** 我的：帳號、登出、管理員的審核入口（介面改版規格 §5.7）。 */
export function Me({ onLoggedOut }: Props) {
	const meQuery = useMe();
	const me = meQuery.data;
	// `me?.role` 而不是先判斷 isPending：useMe() 還在載入時 data 是
	// undefined，`undefined?.role === "admin"` 自然是 false——「審核」一開始
	// 就不畫，不會先閃一下再消失。
	const isAdmin = me?.role === "admin";

	// 從原本 App.tsx 的 <Nav> 搬過來，行為一個字都沒改（介面改版 Task 5）。
	//
	// **不要改成 useMe() 的 refetch。** staleTime 是 60 秒，改了之後按下去
	// 什麼都不會發生，而 e2e/auth.spec.ts 那條「access token 過期時會自動
	// 換票並重送」不會紅——它只是不再測到任何東西（P3-A 規格 §8.1）。
	const [displayName, setDisplayName] = useState<string | null>(null);

	return (
		<section>
			<h1>我的</h1>

			<Card>
				{meQuery.isPending ? (
					<p>載入中…</p>
				) : meQuery.isError || me == null ? (
					<p>無法載入帳號資料</p>
				) : (
					<p className={styles.email}>{me.email}</p>
				)}
			</Card>

			{isAdmin && (
				<Card>
					<Link to="/admin/revisions">審核</Link>
				</Card>
			)}

			<Card>
				<button
					type="button"
					className={styles.secondary}
					onClick={async () => {
						const fresh = await apiFetch<{ display_name: string }>("/api/me");
						setDisplayName(fresh?.display_name ?? null);
					}}
				>
					重新整理
				</button>
				{displayName !== null && <p>{displayName}</p>}
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
