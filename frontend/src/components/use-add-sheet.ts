import { useCallback, useRef, useState } from "react";
import { useLocation } from "react-router";

/** 「新增」選單的開關（TabBar 與 SideNav 共用，兩邊行為因此一致）。
 *
 *  開關狀態由「在哪個 location 打開的」推導，不是單純的 boolean：導覽在
 *  <Routes> 外面，換頁不會 remount。用 boolean 的話，選單開著時按返回手勢
 *  （Android 返回鍵、瀏覽器上一頁）或用 Tab 鍵走到背後的連結，頁面換了
 *  選單卻還蓋在上面。location.key 一變，openedAt 就不等於它，選單自然關上，
 *  不需要 effect。
 *
 *  換頁後把舊的 key 清掉（React 文件的「render 時調整 state」寫法）：
 *  location.key 是每個歷史紀錄各一個，不清的話回到選單當初開著的那一頁，
 *  key 又對上了，選單會自己跳回來。 */
export function useAddSheet() {
	const location = useLocation();
	const [openedAt, setOpenedAt] = useState<string | null>(null);
	if (openedAt !== null && openedAt !== location.key) setOpenedAt(null);
	const open = openedAt === location.key;
	const buttonRef = useRef<HTMLButtonElement>(null);

	const show = useCallback(() => setOpenedAt(location.key), [location.key]);
	// Esc／取消／點背景：留在原頁，焦點回到按鈕。點入口連結是換頁，不走這條。
	const dismiss = useCallback(() => {
		setOpenedAt(null);
		buttonRef.current?.focus();
	}, []);
	const closeForNavigation = useCallback(() => setOpenedAt(null), []);

	return { open, buttonRef, show, dismiss, closeForNavigation };
}
