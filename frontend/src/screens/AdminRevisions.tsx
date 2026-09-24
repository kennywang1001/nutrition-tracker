import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { apiFetch } from "../api/client";
import { ApiError } from "../api/errors";
import { queryKeys } from "../api/queries";
import type { components } from "../api/schema";
import { formatMacro } from "../lib/decimal";

type PendingRevision = components["schemas"]["PendingRevisionResponse"];
type Revision = components["schemas"]["RevisionResponse"];

/** `current_*` 為 `null` 時的顯示。`null` 代表「這個食物目前沒有生效版本」
 *  （後端明寫的合法狀態，規格 §5.5、§7.1）——空白一片或直接把 `null` 丟進
 *  `formatMacro` 炸出 `NaN`，都會讓人以為畫面壞了，所以明講。 */
function displayCurrent(value: string | null): string {
	return value === null ? "—" : formatMacro(value);
}

/** 三個具名錯誤碼統一顯示後端回的訊息，不在前端重寫一份——理由跟
 *  `FoodDetail.tsx` 處理 `REVISION_PENDING` 一樣：兩份文字有各自飄走的
 *  風險，而且後端已經是要求的文字。
 *
 *  **這裡的訊息文字跟計畫原文字面不完全一樣，是刻意的。** 計畫的「必須
 *  成立」清單寫「顯示『已經被審過了』」「顯示『找不到這筆提案』」，但
 *  實際讀 `app/api/routes/admin_foods.py` `_load_pending`：
 *
 *    REVISION_NOT_PENDING → "這筆提案已經審核過了"（不是「已經被審過了」）
 *    REVISION_NOT_FOUND   → "找不到該編輯提案"     （不是「找不到這筆提案」）
 *
 *  兩處都只差幾個字，語意一致。跟著計畫的字面另外刻一份翻譯，會製造出
 *  「畫面上的字」與「後端真正會送什麼」永遠對不上的兩份文字——那正是
 *  這個專案從 Task 4 開始就一直在避免的事。所以這裡跟 `FORBIDDEN`
 *  （字面本來就對得上）一樣，一律顯示 `caught.message`。 */
function describeMutationError(caught: unknown): string {
	if (
		caught instanceof ApiError &&
		(caught.code === "FORBIDDEN" ||
			caught.code === "REVISION_NOT_FOUND" ||
			caught.code === "REVISION_NOT_PENDING")
	) {
		return caught.message;
	}
	return "操作失敗，請再試一次";
}

type RevisionRowProps = {
	revision: PendingRevision;
};

function RevisionRow({ revision }: RevisionRowProps) {
	const queryClient = useQueryClient();
	const [reason, setReason] = useState("");
	const [reasonError, setReasonError] = useState<string | null>(null);
	const [mutationError, setMutationError] = useState<string | null>(null);

	// 通過與駁回成功後都只失效兩個 key：pendingRevisions（佇列本身）與
	// food(food_id)。**刻意不另外列 foodRevisions(food_id)**——
	// `queryKeys.food` 在 `api/queries.ts` 的註解裡明寫「刻意是 portions
	// 與 foodRevisions 的前綴」，TanStack Query 的 invalidateQueries 是
	// 前綴比對，invalidate `["foods", foodId]` 本來就會連帶打到
	// `["foods", foodId, "revisions"]`。另外列 foodRevisions 不會多做
	// 任何事，只會讓兩個呼叫端未來要記得同時改，讀那段註解之後判斷不需要。
	function invalidateAfterReview() {
		queryClient.invalidateQueries({ queryKey: queryKeys.pendingRevisions });
		queryClient.invalidateQueries({
			queryKey: queryKeys.food(revision.food_id),
		});
	}

	const approve = useMutation({
		mutationFn: () =>
			apiFetch<Revision>(`/api/admin/food-revisions/${revision.id}/approve`, {
				method: "POST",
			}),
		onSuccess: () => {
			setMutationError(null);
			invalidateAfterReview();
		},
		onError: (caught: unknown) => {
			setMutationError(describeMutationError(caught));
			// 409 REVISION_NOT_PENDING：這筆提案已經被別人（另一個分頁、
			// 另一個管理員）審過了。佇列上顯示的仍是舊狀態，重新載入才會
			// 把這一筆拿掉，不然使用者會對著一筆審不動的提案反覆點。
			if (
				caught instanceof ApiError &&
				caught.code === "REVISION_NOT_PENDING"
			) {
				queryClient.invalidateQueries({ queryKey: queryKeys.pendingRevisions });
			}
		},
	});

	const reject = useMutation({
		mutationFn: (trimmedReason: string) =>
			apiFetch<Revision>(`/api/admin/food-revisions/${revision.id}/reject`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ reason: trimmedReason }),
			}),
		onSuccess: () => {
			setMutationError(null);
			setReason("");
			invalidateAfterReview();
		},
		onError: (caught: unknown) => {
			setMutationError(describeMutationError(caught));
			if (
				caught instanceof ApiError &&
				caught.code === "REVISION_NOT_PENDING"
			) {
				queryClient.invalidateQueries({ queryKey: queryKeys.pendingRevisions });
			}
		},
	});

	function handleReject(event: FormEvent) {
		event.preventDefault();
		// 後端 RevisionRejectRequest.reason 是 min_length=1（app/schemas/food.py）
		// ——空理由本來就會被 422 擋下來，但等一趟網路往返才知道，不如在這裡
		// 直接擋住，連請求都不送。
		const trimmed = reason.trim();
		if (trimmed === "") {
			setReasonError("請輸入駁回理由");
			return;
		}
		setReasonError(null);
		setMutationError(null);
		reject.mutate(trimmed);
	}

	const isBusy = approve.isPending || reject.isPending;

	return (
		<li data-testid={`revision-${revision.id}`}>
			<h2>
				{revision.food_name}
				{revision.food_brand !== null && `（${revision.food_brand}）`}
			</h2>
			<p>
				提案人：{revision.created_by_name}・{revision.created_at}
			</p>
			{revision.change_note !== null && <p>備註：{revision.change_note}</p>}

			<table>
				<thead>
					<tr>
						<th scope="col">項目</th>
						<th scope="col">目前生效</th>
						<th scope="col">提案</th>
					</tr>
				</thead>
				<tbody>
					<tr>
						<th scope="row">熱量（每 100 單位 {revision.base_unit}）</th>
						<td>{displayCurrent(revision.current_kcal)}</td>
						<td>{formatMacro(revision.kcal)}</td>
					</tr>
					<tr>
						<th scope="row">蛋白質</th>
						<td>{displayCurrent(revision.current_protein_g)}</td>
						<td>{formatMacro(revision.protein_g)}</td>
					</tr>
					<tr>
						<th scope="row">脂肪</th>
						<td>{displayCurrent(revision.current_fat_g)}</td>
						<td>{formatMacro(revision.fat_g)}</td>
					</tr>
					<tr>
						<th scope="row">碳水化合物</th>
						<td>{displayCurrent(revision.current_carb_g)}</td>
						<td>{formatMacro(revision.carb_g)}</td>
					</tr>
				</tbody>
			</table>

			<button type="button" onClick={() => approve.mutate()} disabled={isBusy}>
				通過
			</button>

			{/* 駁回理由是獨立的一個小表單，onSubmit 攔下來自己驗證——
				不做樂觀更新（規格 §7.1）：按下去不會先讓這一筆從畫面上消失，
				要等 mutation 真的成功，409 時才不會讓管理員以為自己審過了。 */}
			<form onSubmit={handleReject}>
				<label htmlFor={`reject-reason-${revision.id}`}>駁回理由</label>
				<textarea
					id={`reject-reason-${revision.id}`}
					value={reason}
					maxLength={500}
					onChange={(event) => setReason(event.target.value)}
				/>
				{reasonError !== null && <p role="alert">{reasonError}</p>}
				<button type="submit" disabled={isBusy}>
					駁回
				</button>
			</form>

			{mutationError !== null && <p role="alert">{mutationError}</p>}
		</li>
	);
}

/** 管理員審核佇列（規格 §7.1、Task 7）。
 *
 *  `GET /api/admin/food-revisions` 回的 `PendingRevisionResponse` 已經把
 *  新舊並排算好了——每一筆同時帶提案的四個數值與目前生效的四個數值，
 *  **不需要在這裡再去查一次那個食物。**
 *
 *  **不做前端導向。** 非管理員直接輸入 `/admin/revisions` 時，讓它照常
 *  render、讓這支 query 打出去、讓後端的 `require_admin` 回 403，畫面上
 *  顯示後端的訊息（規格 §3.3）。加一個「不是管理員就 redirect」的話，
 *  一條「非管理員看不到審核佇列」的測試會綠，但它只證明 redirect 有效，
 *  完全沒有碰到後端授權——把 `require_admin` 整個拿掉，那條測試依然綠，
 *  而且 redirect 之後 403 那條路徑再也走不到、也就測不到。前端藏起連結
 *  （`TabBar` 的第五格）是可用性，這裡的 403 才是授權。
 *
 *  **403 不觸發登出。** `client.ts` 的 `fetchWithAuthRetry` 只在
 *  `status === 401` 才換票，403 直接落到 `!response.ok` 拋 `ApiError`——
 *  這裡只是把那個 `ApiError` 顯示出來，不呼叫 `logout()`、不清 token。 */
export function AdminRevisions() {
	const revisionsQuery = useQuery({
		queryKey: queryKeys.pendingRevisions,
		queryFn: () => apiFetch<PendingRevision[]>("/api/admin/food-revisions"),
	});

	if (revisionsQuery.isError) {
		const message =
			revisionsQuery.error instanceof ApiError
				? revisionsQuery.error.message
				: "載入失敗，請再試一次";
		return (
			<section>
				<h1>審核佇列</h1>
				<p role="alert">{message}</p>
			</section>
		);
	}

	if (revisionsQuery.isLoading) {
		return (
			<section>
				<h1>審核佇列</h1>
				<p>載入中…</p>
			</section>
		);
	}

	const revisions = revisionsQuery.data ?? [];

	return (
		<section>
			<h1>審核佇列</h1>
			{revisions.length === 0 ? (
				<p>目前沒有待審的提案</p>
			) : (
				<ul>
					{revisions.map((revision) => (
						<RevisionRow key={revision.id} revision={revision} />
					))}
				</ul>
			)}
		</section>
	);
}
