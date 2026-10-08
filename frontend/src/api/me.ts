import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "./client";
import { queryKeys } from "./queries";
import type { components } from "./schema";

export type Me = components["schemas"]["UserResponse"];

/** 目前登入者。`TabBar`（Task 7）用它的 `role` 決定管理員那一格出不出現——
 *  前端藏起連結只是可用性，真正的授權在後端 `require_admin`（規格 §11.2、
 *  `app/api/deps.py`）。
 *
 *  **跟 `Me.tsx` 裡「重新整理」按鈕的 `apiFetch("/api/me")` 是兩條獨立的
 *  路。** 那個按鈕是 `e2e/auth.spec.ts` 在強制 access token 過期後，用來觸發
 *  一次需要認證的請求的路徑，它直接呼叫 `apiFetch`、不碰這支 `useMe` 的快取，
 *  兩者刻意不合併。（`useMe().refetch()` 其實也會發請求——refetch 不看
 *  `staleTime`——所以不是「做不到」，只是 E2E 是照直接呼叫寫的。） */
export function useMe() {
	return useQuery({
		queryKey: queryKeys.me,
		queryFn: () => apiFetch<Me>("/api/me"),
	});
}

/** 改顯示名稱（帳號設定規格 §5.1）。**只送 `display_name`**——`PATCH /api/me` 省略的欄位不動；
 *  順手把快取裡的時區一起送回去，會在另一台裝置剛改過時區時把它蓋回舊值。 */
export async function updateDisplayName(displayName: string): Promise<Me> {
	const updated = await apiFetch<Me>("/api/me", {
		method: "PATCH",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ display_name: displayName }),
	});
	if (updated === null) throw new Error("修改名稱的回應沒有 body");
	return updated;
}
