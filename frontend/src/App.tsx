import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import { useState } from "react";
import {
	BrowserRouter,
	Navigate,
	Route,
	Routes,
	useNavigate,
} from "react-router";
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
import { getRefreshToken } from "./auth/store";
import { TabBar } from "./components/TabBar";
import { AdminRevisions } from "./screens/AdminRevisions";
import { Expenses } from "./screens/Expenses";
import { FoodDetail } from "./screens/FoodDetail";
import { FoodLibrary } from "./screens/FoodLibrary";
import { Login } from "./screens/Login";
import { LogMeal } from "./screens/LogMeal";
import { Me } from "./screens/Me";
import { NewFood } from "./screens/NewFood";
import { Overview } from "./screens/Overview";
import { Supplements } from "./screens/Supplements";
import { Today } from "./screens/Today";
import { Trend } from "./screens/Trend";

/** `/meals/new`（介面改版）：記完一餐之後導回總覽。
 *
 *  **導回 `/`，不是留在記一餐**：使用者記完要的是立刻看到「數字變了」——
 *  總覽的今天熱量與時間線。留在原地等於畫面上什麼都沒發生，使用者會以為
 *  沒記進去、再記一次。 */
function LogMealRoute() {
	const navigate = useNavigate();
	return <LogMeal onSaved={() => navigate("/")} />;
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
					<main className="app-main">
						<Routes>
							{/* 介面改版（規格 §3.2）：總覽｜報表｜＋｜飲食｜我的。
									「＋」不是路由，是 TabBar 裡打開 AddSheet 的按鈕。 */}
							<Route path="/" element={<Overview />} />
							<Route path="/reports" element={<Expenses />} />
							<Route path="/diet" element={<Today />} />
							<Route
								path="/me"
								element={<Me onLoggedOut={() => setLoggedIn(false)} />}
							/>
							<Route path="/meals/new" element={<LogMealRoute />} />
							{/* 舊網址轉址（規格 §3.3）：手機上可能有書籤或 PWA 的舊
									狀態。`replace`：上一頁不會回到一個只會再轉走的網址。 */}
							<Route path="/today" element={<Navigate to="/diet" replace />} />
							<Route
								path="/expenses"
								element={<Navigate to="/reports" replace />}
							/>
							<Route path="/trend" element={<Trend />} />
							<Route path="/foods" element={<FoodLibrary />} />
							{/* 順序在這裡不像後端 foods.py 的 /frequent /recent 那樣要緊
								（那是 FastAPI 依宣告順序比對）——react-router 依「靜態片段
								比動態片段更具體」排名，不是宣告順序，實測過
								（matchRoutes([{path:"/foods/:id"},{path:"/foods/new"}],
								"/foods/new") 即使 :id 排在前面，命中的仍然是 "/foods/new"）。
								兩個路由誰先誰後寫在這裡純粹是可讀性。 */}
							<Route path="/foods/new" element={<NewFood />} />
							<Route path="/foods/:id" element={<FoodDetail />} />
							{/* 補劑（P3-C Task 2）：新增「我有在使用的」＋「當天有吃就點
								一份進去」。刻意不加第六個 tab，入口在 Today.tsx 的
								「今日補劑」區塊（計畫的說明：320px 寬度下 tab bar 每格
								只剩 53px，加不下去）。 */}
							<Route path="/supplements" element={<Supplements />} />
							{/* 不做前端導向：非管理員直接輸入這個網址時，讓它照常渲染、
								讓 GET /api/admin/food-revisions 打出去、讓後端的
								require_admin 回 403（見 AdminRevisions.tsx 的說明、
								規格 §3.3）。 */}
							<Route path="/admin/revisions" element={<AdminRevisions />} />
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
