import { NavLink } from "react-router";

type Tab = { to: string; label: string; end?: boolean };

/** 底部導覽（規格 §3.1）。
 *
 *  **用 `NavLink` 而不是 `Link`**：NavLink 自己依目前路由加上
 *  `aria-current="page"`。自己拿 `useLocation()` 比字串的話，「哪一格是
 *  亮的」會退化成一個只有 class 名稱看得出來的狀態 —— 而 class 名稱
 *  螢幕閱讀器讀不到，測試驗它也只是在驗我們自己寫的字串。
 *
 *  **`/` 那一格一定要 `end`。** 根路由是每一個路徑的前綴，沒有 `end`
 *  的話「今日總覽」在每一頁都會是 `aria-current`。
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
