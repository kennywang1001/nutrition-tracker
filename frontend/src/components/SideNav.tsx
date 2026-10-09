import { Plus } from "lucide-react";
import { useId } from "react";
import { NavLink } from "react-router";
import { AddSheet } from "./AddSheet";
import { NAV_TABS, type NavTab, UNREAD_TAB, unreadBadgeText } from "./nav-tabs";
import styles from "./SideNav.module.css";
import ui from "./ui.module.css";
import { useAddSheet } from "./use-add-sheet";

/** 電腦版的左側導覽（電腦版版面規格 §3、§5）。
 *
 *  **名稱跟手機的分頁列一模一樣**（導覽「主要導覽」、按鈕「新增紀錄」、
 *  四個連結）：既有的單元測試與 e2e 用 getByRole 找，兩種版面都找得到。
 *  看得到的字是「新增」，可及名稱「新增紀錄」包含它（WCAG 2.5.3）。
 *
 *  「新增」在最上面——DOM 順序就是 Tab 順序，所以這裡不能跟 TabBar 共用
 *  一份 JSX 再用 CSS 換位置。
 *
 *  `unread`：未讀通知數，由外框（`App.tsx` 的 `LoggedInShell`）查好傳進來。
 *  **這個元件自己不碰 query**——它的測試沒有 `QueryClientProvider`。 */
export function SideNav({ unread = 0 }: { unread?: number }) {
	const sheet = useAddSheet();
	return (
		<>
			<nav className={styles.side} aria-label="主要導覽">
				<button
					ref={sheet.buttonRef}
					type="button"
					className={styles.add}
					aria-label="新增紀錄"
					aria-haspopup="dialog"
					aria-expanded={sheet.open}
					onClick={sheet.show}
				>
					<Plus aria-hidden="true" size={20} />
					<span aria-hidden="true">新增</span>
				</button>
				<ul className={styles.links}>
					{NAV_TABS.map((tab) => (
						<SideLink
							key={tab.to}
							tab={tab}
							unread={tab.to === UNREAD_TAB ? unread : 0}
						/>
					))}
				</ul>
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

/** 一個目的地。`unread`：未讀數字，0＝不畫。名稱、描述、隱藏文字的安排跟手機分頁列的
 *  `TabLink` 一樣（理由寫在那裡）：連結的可及名稱永遠是 `tab.label`。 */
function SideLink({ tab, unread }: { tab: NavTab; unread: number }) {
	const badgeId = useId();
	const Icon = tab.icon;
	return (
		<li>
			<NavLink
				to={tab.to}
				end={tab.end}
				aria-describedby={unread > 0 ? badgeId : undefined}
				className={({ isActive }) =>
					isActive ? `${styles.link} ${styles.active}` : styles.link
				}
			>
				<Icon aria-hidden="true" size={20} />
				<span>{tab.label}</span>
				{unread > 0 && (
					<span aria-hidden="true" className={styles.badge}>
						{unreadBadgeText(unread)}
					</span>
				)}
			</NavLink>
			{unread > 0 && (
				<span id={badgeId} className={ui.srOnly}>
					{unread} 則新通知
				</span>
			)}
		</li>
	);
}
