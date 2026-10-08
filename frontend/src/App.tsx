import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import { type ReactNode, useEffect, useState } from "react";
import {
	BrowserRouter,
	Navigate,
	Route,
	Routes,
	useLocation,
	useMatch,
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
import { followLogoutFromOtherTabs } from "./auth/session";
import { getRefreshToken, onLoggedOut } from "./auth/store";
import { SideNav } from "./components/SideNav";
import { TabBar } from "./components/TabBar";
import { contentWidthFor } from "./lib/layout";
import { readLinkToken } from "./lib/link-token";
import { useIsDesktop } from "./lib/use-is-desktop";
import { AddExpense } from "./screens/AddExpense";
import { AdminRevisions } from "./screens/AdminRevisions";
import { ChangePassword } from "./screens/ChangePassword";
import { EditMeal } from "./screens/EditMeal";
import { Expenses } from "./screens/Expenses";
import { FoodDetail } from "./screens/FoodDetail";
import { FoodLibrary } from "./screens/FoodLibrary";
import { FriendDay } from "./screens/FriendDay";
import { Join, JoinWhileLoggedIn } from "./screens/Join";
import { Login } from "./screens/Login";
import { LogMeal, PHOTO_UPLOAD_FAILED_NOTICE } from "./screens/LogMeal";
import { Me } from "./screens/Me";
import { NewFood } from "./screens/NewFood";
import { Overview } from "./screens/Overview";
import {
	ResetPassword,
	ResetPasswordWhileLoggedIn,
} from "./screens/ResetPassword";
import { Supplements } from "./screens/Supplements";
import { Targets } from "./screens/Targets";
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

/** 登入後的外框（電腦版版面規格 §3）。
 *
 *  **電腦版（≥ 1024px）**：最外層 `app-desktop`，左側 `SideNav`，每一頁都有
 *  （包括記帳——寬螢幕上沒有「導覽蓋住鍵盤」的問題）。內容區的最寬寬度依路由
 *  決定（`contentWidthFor`）。頁面的兩欄 CSS 看 `app-desktop` 這個 class，
 *  不自己寫 media query——斷點只在 `lib/layout.ts`。
 *
 *  **手機版**：跟以前一樣。記帳（`/expenses/new`）不顯示分頁列（記帳與離線
 *  規格 §2 (b)）：矮螢幕（iPhone SE）上分頁列會蓋住數字鍵盤的最下面幾列。
 *  那一頁是全螢幕的記帳流程，有自己的「關閉」。記一餐不隱藏——它沒有關閉鈕，
 *  在 iOS 主畫面模式下隱藏就出不去了，而且沒有數字鍵盤。`.app-main` 的底部
 *  留白是為分頁列留的，隱藏時一起拿掉（`index.css`）。`useMatch` 而不是比
 *  `pathname` 字串：`/expenses/new/` 也命中同一個路由。
 *
 *  **兩個分支的 `children` 掛在不同的父元素底下**：視窗拉寬拉窄跨過斷點時，
 *  React 會把整頁卸載再重新掛載，表單裡打到一半的字會不見。這是刻意接受的
 *  取捨（規格 §5 已接受「新增」選單會關）——平常不會有人一邊記帳一邊拉視窗，
 *  為了保住它把兩種外框硬湊成同一棵樹不划算。 */
function LoggedInShell({ children }: { children: ReactNode }) {
	const isDesktop = useIsDesktop();
	const { pathname } = useLocation();
	const onAddExpense = useMatch("/expenses/new") !== null;

	if (isDesktop) {
		return (
			<div className="app-desktop">
				<SideNav />
				<main className="app-main">
					<div
						className={`app-content app-content-${contentWidthFor(pathname)}`}
					>
						{children}
					</div>
				</main>
			</div>
		);
	}

	return (
		<>
			<main
				className={onAddExpense ? "app-main app-main-no-tab-bar" : "app-main"}
			>
				{children}
			</main>
			{!onAddExpense && <TabBar />}
		</>
	);
}

/** 未登入時顯示建立帳號的網址。`/join/`：有人手打或轉貼時多一個斜線；登入後的
 *  react-router 本來就把它當 `/join`。 */
const JOIN_PATHS = new Set(["/join", "/join/"]);

/** 未登入時顯示重設密碼的網址（帳號設定規格 §5.5），斜線的理由同 JOIN_PATHS。 */
const RESET_PATHS = new Set(["/reset-password", "/reset-password/"]);

/** 登入畫面上的一行說明：不是使用者在這個分頁按的登出（帳號設定審查 I2）。 */
const FORCED_LOGOUT_NOTICE = "已被登出，請重新登入";

/** 網址是不是一條**還帶著碼**的邀請或重設連結（`/join#碼`、`/reset-password#碼`）。
 *
 *  登入中打開這種連結，碼要等確認登入還有效才從網址列拿掉（`useSessionConfirmed`）。所以
 *  「被登出的當下碼還在」只有一種意思：這台的登入從來沒被確認過——票早就過期或被撤銷了，
 *  或還來不及確認就在別的分頁登出了。這個人就是來用這條連結的。 */
function isOnLinkWithToken(): boolean {
	const { pathname, hash } = window.location;
	return (
		(JOIN_PATHS.has(pathname) || RESET_PATHS.has(pathname)) &&
		readLinkToken(hash) !== ""
	);
}

/** `in`：登入中。`out`：沒登入（開頁時沒有票、自己按了登出，或被登出時正開著一條還帶著碼的
 *  連結——見 `isOnLinkWithToken`）。`forced-out`：被登出——換票被拒（別的裝置改了密碼、重設了
 *  密碼、票過期）或另一個分頁登出了。 */
type AuthView = "in" | "out" | "forced-out";

export function App() {
	// 未登入 → `/join` 是建立帳號、`/reset-password` 是重設密碼，其他一律 <Login>
	// （不掛 BrowserRouter，沒有路由可以比對）。
	const [view, setView] = useState<AuthView>(() =>
		getRefreshToken() !== null ? "in" : "out",
	);

	// **登出由 store 通知，登入由畫面的 onSuccess 通知**（理由在 `auth/store.ts` 的
	// `onLoggedOut`）。本來就沒登入的分頁不變（另一個分頁登出時，這裡不該冒出「已被登出」）。
	//
	// **被登出時正開著一條還帶著碼的連結 → 當成沒登入的人打開它**（`out`，不是 `forced-out`）：
	// 下面照路徑顯示真的 `Join`／`ResetPassword`，連結直接能用，也不顯示「已被登出」——那句話
	// 跟眼前的表單無關。在通知的當下就決定、記進 state，不在 render 時看網址：那兩個畫面成功
	// 之後會自己把網址換成 `/`。
	useEffect(
		() =>
			onLoggedOut(({ forced }) => {
				const next: AuthView =
					forced && !isOnLinkWithToken() ? "forced-out" : "out";
				setView((current) => (current !== "in" ? current : next));
			}),
		[],
	);
	useEffect(() => followLogoutFromOtherTabs(), []);

	return (
		<PersistQueryClientProvider
			client={queryClient}
			persistOptions={offlinePersistOptions}
		>
			{view === "in" ? (
				<BrowserRouter>
					<LoggedInShell>
						<Routes>
							{/* 介面改版（規格 §3.2）：總覽｜報表｜＋｜飲食｜我的。
									「＋」不是路由，是 TabBar 裡打開 AddSheet 的按鈕。 */}
							<Route path="/" element={<Overview />} />
							<Route path="/reports" element={<Expenses />} />
							<Route path="/diet" element={<Today />} />
							<Route path="/me" element={<Me />} />
							{/* 每日目標（帳號設定規格 §5.2），入口是「我的」的每日目標卡片。 */}
							<Route path="/me/targets" element={<Targets />} />
							{/* 修改密碼（帳號設定規格 §5.3），入口是「我的」帳號卡片的「修改密碼」。 */}
							<Route path="/me/password" element={<ChangePassword />} />
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
							<Route path="/friends/:id" element={<FriendDay />} />
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
							<Route
								path="/reset-password"
								element={<ResetPasswordWhileLoggedIn />}
							/>
						</Routes>
					</LoggedInShell>
				</BrowserRouter>
			) : view === "out" && JOIN_PATHS.has(window.location.pathname) ? (
				// 邀請連結（邀請規格 §4.1）。其他網址照舊一律登入畫面。
				// app-auth（index.css）：左右留白、置中、最寬 400px（電腦版版面
				// 規格 §3）。不用 .app-main：那個的底部留白是為分頁列留的，未登入
				// 沒有分頁列；電腦版的寬度規則也只看 .app-desktop 底下的 .app-main。
				<main className="app-auth">
					<Join onSuccess={() => setView("in")} />
				</main>
			) : view === "out" && RESET_PATHS.has(window.location.pathname) ? (
				// 重設密碼連結（帳號設定規格 §5.5）。不收 onSuccess：成功後不自動登入（決定 16），
				// 「去登入」是整頁的 <a href="/">，重新載入後沒有票，落在下面的登入畫面。
				<main className="app-auth">
					<ResetPassword />
				</main>
			) : (
				// 被登出（forced-out）一律是登入畫面，不看路徑：走到這裡的 `/join`、`/reset-password`
				// 網址上已經沒有碼了（確認登入之後拿掉的；還有碼的在通知登出時就歸到 `out`），
				// 照路徑走會顯示「連結失效」——那不是發生的事。
				<main className="app-auth">
					<Login
						onSuccess={() => setView("in")}
						notice={view === "forced-out" ? FORCED_LOGOUT_NOTICE : null}
					/>
				</main>
			)}
		</PersistQueryClientProvider>
	);
}
