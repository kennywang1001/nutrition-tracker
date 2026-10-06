import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "./client";
import { queryKeys } from "./queries";
import type { components } from "./schema";

export type InviteCreated = components["schemas"]["InviteCreatedResponse"];
export type InviteListItem = components["schemas"]["InviteListItem"];
export type RegisterBody = components["schemas"]["RegisterRequest"];

const JSON_HEADERS = { "content-type": "application/json" };

export function useInvites() {
	return useQuery({
		queryKey: queryKeys.invites,
		queryFn: () => apiFetch<InviteListItem[]>("/api/admin/invites"),
	});
}

/** `note` 是 null 時不送這個欄位（後端 `note` 省略＝沒有備註）。 */
export async function createInvite(
	note: string | null,
): Promise<InviteCreated> {
	const created = await apiFetch<InviteCreated>("/api/admin/invites", {
		method: "POST",
		headers: JSON_HEADERS,
		body: JSON.stringify(note === null ? {} : { note }),
	});
	if (created === null) throw new Error("產生邀請的回應沒有 body");
	return created;
}

export async function revokeInvite(id: number): Promise<void> {
	await apiFetch(`/api/admin/invites/${id}`, { method: "DELETE" });
}

/** 邀請碼放在 `#` 後面（規格 §4.1）：瀏覽器不會把 `#` 之後送到伺服器，
 *  不進 Caddy 或 Tailscale 的存取紀錄。 */
export function inviteLink(token: string): string {
	return `${window.location.origin}/join#${token}`;
}

export async function checkInvite(token: string): Promise<boolean> {
	const result = await apiFetch<{ valid: boolean }>("/api/auth/invite-status", {
		method: "POST",
		headers: JSON_HEADERS,
		body: JSON.stringify({ token }),
	});
	return result?.valid === true;
}

export async function registerWithInvite(body: RegisterBody): Promise<void> {
	await apiFetch("/api/auth/register", {
		method: "POST",
		headers: JSON_HEADERS,
		body: JSON.stringify(body),
	});
}
