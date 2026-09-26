import { useEffect, useState } from "react";

/** 把一個會頻繁改變的值延後 `delayMs` 再回傳。
 *
 *  給搜尋輸入用：每敲一個字就打一次全庫查詢是不必要的，而且每一次都會在
 *  TanStack Query 的快取裡留下一組新的 key（`["food-search", q, scope]`）。
 *
 *  **回傳的是值，不是 callback。** 呼叫端把回傳值放進 query key 與
 *  `enabled`，query 自然就只在值安定下來之後才發 —— 不需要在呼叫端寫任何
 *  取消邏輯。 */
export function useDebounced<T>(value: T, delayMs: number): T {
	const [settled, setSettled] = useState(value);

	useEffect(() => {
		const timer = setTimeout(() => setSettled(value), delayMs);
		return () => clearTimeout(timer);
	}, [value, delayMs]);

	return settled;
}
