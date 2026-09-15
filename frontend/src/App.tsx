import { useState } from "react";
import { BrowserRouter, Link, Route, Routes } from "react-router";
import { apiFetch } from "./api/client";
import { logout } from "./auth/session";
import { getRefreshToken } from "./auth/store";
import { Login } from "./screens/Login";

/** 佔位元件——Task 4、5 才會換成真正的畫面。 */
function TodayPlaceholder() {
	return <h1>今日總覽</h1>;
}

function LogMealPlaceholder() {
	return <h1>記一餐</h1>;
}

function Nav({ onLoggedOut }: { onLoggedOut: () => void }) {
	// 「重新整理」按鈕從 main.tsx 搬過來，不是刪掉——計畫一的
	// 「access token 過期時會自動換票並重送」E2E 依賴它打 /api/me。
	const [displayName, setDisplayName] = useState<string | null>(null);

	return (
		<nav>
			<Link to="/">今日總覽</Link>
			<Link to="/log">記一餐</Link>
			<button
				type="button"
				onClick={async () => {
					const me = await apiFetch<{ display_name: string }>("/api/me");
					setDisplayName(me?.display_name ?? null);
				}}
			>
				重新整理
			</button>
			<button
				type="button"
				onClick={async () => {
					await logout();
					onLoggedOut();
				}}
			>
				登出
			</button>
			{displayName !== null && <p>{displayName}</p>}
		</nav>
	);
}

export function App() {
	// 未登入 → 一律顯示 <Login>，不管網址是什麼（不掛 BrowserRouter，
	// 沒有路由可以比對）。
	const [loggedIn, setLoggedIn] = useState(getRefreshToken() !== null);

	if (!loggedIn) return <Login onSuccess={() => setLoggedIn(true)} />;

	return (
		<BrowserRouter>
			<Nav onLoggedOut={() => setLoggedIn(false)} />
			<Routes>
				<Route path="/" element={<TodayPlaceholder />} />
				<Route path="/log" element={<LogMealPlaceholder />} />
			</Routes>
		</BrowserRouter>
	);
}
