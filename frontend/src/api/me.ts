import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "./client";
import { queryKeys } from "./queries";
import type { components } from "./schema";

export type Me = components["schemas"]["UserResponse"];

/** 目前登入者。`TabBar`（Task 7）用它的 `role` 決定管理員那一格出不出現——
 *  前端藏起連結只是可用性，真正的授權在後端 `require_admin`（規格 §11.2、
 *  `app/api/deps.py`）。
 *
 *  **不要跟 `App.tsx` 裡「重新整理」按鈕的 `apiFetch("/api/me")` 搞混。**
 *  那個按鈕是 `e2e/auth.spec.ts` 用來驗證「access token 過期時會自動換票
 *  並重送」的路徑，兩者刻意不合併——這支 `useMe` 帶 `staleTime: 60_000`
 *  的快取，換成它會讓那條 E2E 的按鈕按下去什麼都不會發生（見
 *  `api/queries.ts` 的 `queryClient` 註解）。 */
export function useMe() {
	return useQuery({
		queryKey: queryKeys.me,
		queryFn: () => apiFetch<Me>("/api/me"),
	});
}
