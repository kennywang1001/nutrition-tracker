import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "./client";
import { queryKeys } from "./queries";
import type { components } from "./schema";

export type AdminUser = components["schemas"]["AdminUserItem"];
export type PasswordResetCreated =
	components["schemas"]["PasswordResetCreatedResponse"];

/** 管理員的「所有帳號」（帳號設定規格 §3.3、§5.4）。回應包含管理員自己，由畫面濾掉。 */
export function useAdminUsers() {
	return useQuery({
		queryKey: queryKeys.adminUsers,
		queryFn: () => apiFetch<AdminUser[]>("/api/admin/users"),
		// 同 useInvites：app 的預設 staleTime 60 秒＋離線快取，會讓剛註冊的朋友
		// 在清單上晚一分鐘才出現（handover §6「開帳號的路」）。
		staleTime: 0,
	});
}

/** 替一般使用者產生一次性的重設密碼連結（規格 §3.4）。`token` 只在這個回應出現一次。 */
export async function createPasswordReset(
	userId: number,
): Promise<PasswordResetCreated> {
	const created = await apiFetch<PasswordResetCreated>(
		`/api/admin/users/${userId}/password-reset`,
		{ method: "POST" },
	);
	if (created === null) throw new Error("產生重設連結的回應沒有 body");
	return created;
}

/** 碼放在 `#` 後面（規格 §6）：不送到伺服器，不進 Caddy 或 Tailscale 的存取紀錄、不進 Referer。 */
export function resetLink(token: string): string {
	return `${window.location.origin}/reset-password#${token}`;
}
