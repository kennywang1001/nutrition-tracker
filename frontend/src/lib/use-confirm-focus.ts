import { useEffect, useRef } from "react";

/** 確認框（刪這一餐、刪照片、刪一項）的焦點（AI 與編輯畫面的收尾規格 §2
 *  第 8 項）：
 *
 *  - 打開時焦點到「取消」——安全的那一顆，誤按 Enter 不會刪東西；
 *  - 按「取消」收起來之後，焦點回到打開它的按鈕。
 *
 *  三個確認框都是「按鈕 ↔ 確認框」二選一的條件 render：打開時按鈕卸載，
 *  收起來時重新掛上一顆新的，所以兩邊都要在 effect 裡（ref 已經接上之後）
 *  移。**只有按「取消」才回到按鈕**（`cancelled` 旗標）：刪成功、或因為別的
 *  理由收起（開了另一個編輯器、照片在別台刪了）時不搶焦點。 */
export function useConfirmFocus(open: boolean) {
	const cancelRef = useRef<HTMLButtonElement>(null);
	const triggerRef = useRef<HTMLButtonElement>(null);
	const returnFocus = useRef(false);

	useEffect(() => {
		if (open) {
			cancelRef.current?.focus();
		} else if (returnFocus.current) {
			returnFocus.current = false;
			triggerRef.current?.focus();
		}
	}, [open]);

	return {
		cancelRef,
		triggerRef,
		/** 「取消」的 onClick 先呼叫它，再收起確認框。 */
		cancelled: () => {
			returnFocus.current = true;
		},
	};
}
