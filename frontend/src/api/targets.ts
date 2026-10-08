import { apiFetch } from "./client";
import type { components } from "./schema";

export type TargetToday = components["schemas"]["TargetTodayRequest"];
export type Target = components["schemas"]["TargetResponse"];

/** 從今天起，目標是這四個值（帳號設定規格 §3.1）。「今天」由後端用使用者的時區算——
 *  前端不帶日期（handover §10：前端不自己算日界線）。四個鍵都要送，`null`＝不設定；
 *  少一個鍵後端回 422，不是「沿用」。 */
export async function setTargetFromToday(body: TargetToday): Promise<Target> {
	const saved = await apiFetch<Target>("/api/targets/today", {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	if (saved === null) throw new Error("儲存目標的回應沒有 body");
	return saved;
}
