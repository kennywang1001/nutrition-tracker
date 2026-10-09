import { Plus } from "lucide-react";
import { useId } from "react";
import { NavLink } from "react-router";
import { AddSheet } from "./AddSheet";
import { NAV_TABS, type NavTab, UNREAD_TAB, unreadBadgeText } from "./nav-tabs";
import styles from "./TabBar.module.css";
import ui from "./ui.module.css";
import { useAddSheet } from "./use-add-sheet";

/** 底部導覽：總覽｜報表｜＋｜飲食｜我的（介面改版規格 §3.1）。
 *
 *  **用 `NavLink` 而不是 `Link`**：NavLink 自己依目前路由加上
 *  `aria-current="page"`。自己拿 `useLocation()` 比字串的話，「哪一格是
 *  亮的」會退化成只有 class 名稱看得出來的狀態，而 `"/diet".startsWith("/")`
 *  為真——總覽會跟著亮（`tests/tab-bar.test.tsx` 守這件事）。
 *
 *  **`/` 那一格的 `end` 在 react-router 8.3.1 是無作用的保險**：NavLink 對
 *  `to="/"` 有內建特例。留著是因為它精確表達意圖。
 *
 *  **「＋」不是一個路由**，是一顆打開 `AddSheet` 的按鈕；開關狀態見
 *  `use-add-sheet.ts`。管理員的「審核」搬到「我的」——tab bar 因此對所有人
 *  都是固定的 4＋1 格，320px 寬時每格 64px，圖示加兩個字的標籤放得下。 */
const LEFT_TABS = NAV_TABS.slice(0, 2);
const RIGHT_TABS = NAV_TABS.slice(2);

/** `unread`：這一格上的未讀數字，0＝不畫（只有「我的」會拿到非 0，見下面）。
 *
 *  **連結的可及名稱永遠是 `tab.label`**（社群規格 D17）——單元測試與 e2e 有 20 多處用
 *  `getByRole("link", { name: "我的" })` 找它。所以：
 *
 *  - 看得到的數字是 `aria-hidden`：不進名稱；
 *  - 唸出來的「N 則新通知」是連結的**描述**（`aria-describedby`），而且那段字放在連結
 *    **外面**——放裡面會併進名稱。螢幕閱讀器唸「我的，連結，3 則新通知」。 */
function TabLink({ tab, unread }: { tab: NavTab; unread: number }) {
	const badgeId = useId();
	const Icon = tab.icon;
	return (
		<>
			<NavLink
				to={tab.to}
				end={tab.end}
				aria-describedby={unread > 0 ? badgeId : undefined}
				className={({ isActive }) =>
					isActive ? `${styles.tab} ${styles.active}` : styles.tab
				}
			>
				<Icon aria-hidden="true" size={22} />
				<span>{tab.label}</span>
				{unread > 0 && (
					<span aria-hidden="true" className={styles.badge}>
						{unreadBadgeText(unread)}
					</span>
				)}
			</NavLink>
			{/* srOnly 是 position: absolute：不佔分頁列的一格。 */}
			{unread > 0 && (
				<span id={badgeId} className={ui.srOnly}>
					{unread} 則新通知
				</span>
			)}
		</>
	);
}

/** `unread`：未讀通知數，由外框（`App.tsx` 的 `LoggedInShell`）查好傳進來。
 *  **這個元件自己不碰 query**——它的測試沒有 `QueryClientProvider`。 */
export function TabBar({ unread = 0 }: { unread?: number }) {
	const sheet = useAddSheet();
	return (
		<>
			<nav className={styles.bar} aria-label="主要導覽">
				{LEFT_TABS.map((tab) => (
					<TabLink
						key={tab.to}
						tab={tab}
						unread={tab.to === UNREAD_TAB ? unread : 0}
					/>
				))}
				<div className={styles.addSlot}>
					<button
						ref={sheet.buttonRef}
						type="button"
						className={styles.add}
						aria-label="新增紀錄"
						aria-haspopup="dialog"
						aria-expanded={sheet.open}
						onClick={sheet.show}
					>
						<Plus aria-hidden="true" size={28} />
					</button>
				</div>
				{RIGHT_TABS.map((tab) => (
					<TabLink
						key={tab.to}
						tab={tab}
						unread={tab.to === UNREAD_TAB ? unread : 0}
					/>
				))}
			</nav>
			{sheet.open && (
				<AddSheet
					onDismiss={sheet.dismiss}
					onNavigate={sheet.closeForNavigation}
				/>
			)}
		</>
	);
}
