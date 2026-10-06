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
import { AddExpense } from "./screens/AddExpense";
import { AdminRevisions } from "./screens/AdminRevisions";
import { EditMeal } from "./screens/EditMeal";
import { Expenses } from "./screens/Expenses";
import { FoodDetail } from "./screens/FoodDetail";
import { FoodLibrary } from "./screens/FoodLibrary";
import { Join, JoinWhileLoggedIn } from "./screens/Join";
import { Login } from "./screens/Login";
import { LogMeal, PHOTO_UPLOAD_FAILED_NOTICE } from "./screens/LogMeal";
import { Me } from "./screens/Me";
import { NewFood } from "./screens/NewFood";
import { Overview } from "./screens/Overview";
import { Supplements } from "./screens/Supplements";
import { Today } from "./screens/Today";
import { Trend } from "./screens/Trend";

/** `/meals/new`（介面改版）：記完一餐之後導回總覽；照片沒傳上去時帶著通知回總覽。
 *
 *  **導回 `/`，不是留在記一餐**：使用者記完要的是立刻看到「數字變了」——
 *  總覽的今天熱量與時間線。留在原地等於畫面上什麼都沒發生，使用者會以為
 *  沒記進去、再記一次。 */
function LogMealRoute() {
	const navigate = useNavigate();
	return (
		<LogMeal
			onSaved={({ photoFailed }) =>
				navigate(
					"/",
					photoFailed
						? { state: { notice: PHOTO_UPLOAD_FAILED_NOTICE } }
						: undefined,
				)
			}
		/>
	);
}

/** `/expenses/new`：記完或關閉都回總覽。 */
function AddExpenseRoute() {
	const navigate = useNavigate();
	return <AddExpense onDone={() => navigate("/")} />;
}

/** 未登入時顯示建立帳號的網址。`/join/`：有人手打或轉貼時多一個斜線；登入後的
 *  react-router 本來就把它當 `/join`。 */
const JOIN_PATHS = new Set(["/join", "/join/"]);

export function App() {
	// 未登入 → `/join` 是建立帳號，其他一律 <Login>（不掛 BrowserRouter，
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
							<Route path="/expenses/new" element={<AddExpenseRoute />} />
							<Route path="/meals/new" element={<LogMealRoute />} />
							{/* 修改或刪除一筆已經記下的餐（編輯餐點規格 §4.2）。入口：飲食頁
									餐點卡片的「編輯」、總覽時間線的餐點列。 */}
							<Route path="/meals/:id/edit" element={<EditMeal />} />
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
								一份進去」。tab bar 固定是 總覽／報表／＋／飲食／我的，
								沒有補劑的位置，入口放在飲食畫面（Today.tsx 的
								「今日補劑」區塊）。 */}
							<Route path="/supplements" element={<Supplements />} />
							{/* 不做前端導向：非管理員直接輸入這個網址時，讓它照常渲染、
								讓 GET /api/admin/food-revisions 打出去、讓後端的
								require_admin 回 403（見 AdminRevisions.tsx 的說明、
								規格 §3.3）。 */}
							<Route path="/admin/revisions" element={<AdminRevisions />} />
							<Route path="/join" element={<JoinWhileLoggedIn />} />
						</Routes>
					</main>
					<TabBar />
				</BrowserRouter>
			) : JOIN_PATHS.has(window.location.pathname) ? (
				// 邀請連結（邀請規格 §4.1）。其他網址照舊一律登入畫面。
				// 包在 .app-main 裡：頁面的左右留白來自它，少了它卡片會貼著螢幕邊緣。
				<main className="app-main">
					<Join onSuccess={() => setLoggedIn(true)} />
				</main>
			) : (
				<Login onSuccess={() => setLoggedIn(true)} />
			)}
		</PersistQueryClientProvider>
	);
}
