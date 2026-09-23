import { NavLink } from "react-router";

type Tab = { to: string; label: string; end?: boolean };

/** 底部導覽（規格 §3.1）。
 *
 *  **用 `NavLink` 而不是 `Link`**：NavLink 自己依目前路由加上
 *  `aria-current="page"`。自己拿 `useLocation()` 比字串的話，「哪一格是
 *  亮的」會退化成一個只有 class 名稱看得出來的狀態 —— 而 class 名稱
 *  螢幕閱讀器讀不到，測試驗它也只是在驗我們自己寫的字串。
 *
 *  **`/` 那一格的 `end` 在 react-router 8.3.1 其實是無作用的保險。**
 *  原本的理由是「根路由是每一個路徑的前綴，沒有 `end` 的話今日總覽在
 *  每一頁都會亮」—— 那個理由在這個版本不成立：NavLink 對 `to="/"` 有內建
 *  特例（非精確分支要求 `locationPathname.charAt(1) === "/"`，對 `/log`
 *  是 `"l"`，恆為 false）。實測過：拿掉 `end: true`，
 *  `tests/tab-bar.test.tsx` 3 則照樣全綠。
 *
 *  留著它是因為它精確表達意圖，而且不排除將來 react-router 改掉那個
 *  內建行為。**但不要以為它是那條測試在守的東西** ——
 *  那條測試真正守的是上面「用 NavLink 而不是 Link」這個選擇，
 *  詳見 `tests/tab-bar.test.tsx` 裡的說明。
 */
const TABS: readonly Tab[] = [
	{ to: "/", label: "今日總覽", end: true },
	{ to: "/log", label: "記一餐" },
	{ to: "/trend", label: "趨勢" },
	{ to: "/foods", label: "食物庫" },
];

export function TabBar() {
	return (
		<nav className="tab-bar" aria-label="主要導覽">
			{TABS.map((tab) => (
				<NavLink key={tab.to} to={tab.to} end={tab.end} className="tab">
					{tab.label}
				</NavLink>
			))}
		</nav>
	);
}
