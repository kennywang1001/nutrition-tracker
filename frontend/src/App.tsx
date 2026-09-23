import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import { useState } from "react";
import { BrowserRouter, Route, Routes, useNavigate } from "react-router";
import { apiFetch } from "./api/client";
// 離線 L2（計畫三 Task 4）：跟下面的 queryClient 一樣是模組層單例，不是
// 這裡的元件 render 裡——建在 render 裡每次重繪都會建一個新的 persister，
// 節流狀態跟著重置。
import { offlinePersistOptions } from "./api/persist";
// 建在 api/queries.ts 的模組層，不是這裡的元件 render 裡——直接寫在 render
// 裡每次重繪都會建一個新的 QueryClient，快取等於沒有。放在 queries.ts
// 而不是這個檔案，是為了讓 auth/session.ts 的 logout() 與 auth/refresh.ts
// 的 refresh 失敗路徑也能拿到同一個 instance 去清快取（規格 §6.5），
// 又不必回頭 import 這個檔案（那會兜出循環依賴）。
import { queryClient } from "./api/queries";
import { logout } from "./auth/session";
import { getRefreshToken } from "./auth/store";
import { TabBar } from "./components/TabBar";
import { Login } from "./screens/Login";
import { LogMeal } from "./screens/LogMeal";
import { Today } from "./screens/Today";
import { Trend } from "./screens/Trend";

/** `/log` 路由：記完一餐之後導回今日總覽。
 *
 *  `onSaved` 不直接放「導回今日總覽」以外的邏輯——快取的失效已經在
 *  `LogMeal` 內部的 mutation `onSuccess` 做掉了，這裡只管畫面切換。 */
function LogMealRoute() {
	const navigate = useNavigate();
	return <LogMeal onSaved={() => navigate("/")} />;
}

function Nav({ onLoggedOut }: { onLoggedOut: () => void }) {
	// 「重新整理」按鈕從 main.tsx 搬過來，不是刪掉——計畫一的
	// 「access token 過期時會自動換票並重送」E2E 依賴它打 /api/me。
	//
	// **不要改成 useMe() 的 refetch。** staleTime 是 60 秒，改了之後按下去
	// 什麼都不會發生，而 e2e/auth.spec.ts 那條測試不會紅——它只是不再
	// 測到任何東西（規格 §8.1）。
	//
	// 導覽連結搬到 <TabBar>（P3-B 計畫一 Task 3），這裡只剩下兩個動作。
	const [displayName, setDisplayName] = useState<string | null>(null);

	return (
		<nav>
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

	return (
		<PersistQueryClientProvider
			client={queryClient}
			persistOptions={offlinePersistOptions}
		>
			{loggedIn ? (
				<BrowserRouter>
					<Nav onLoggedOut={() => setLoggedIn(false)} />
					<main className="app-main">
						<Routes>
							<Route path="/" element={<Today />} />
							<Route path="/log" element={<LogMealRoute />} />
							<Route path="/trend" element={<Trend />} />
						</Routes>
					</main>
					<TabBar />
				</BrowserRouter>
			) : (
				<Login onSuccess={() => setLoggedIn(true)} />
			)}
		</PersistQueryClientProvider>
	);
}
