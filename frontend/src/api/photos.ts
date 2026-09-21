import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { shrinkToLongestEdge } from "../lib/resize-image";
import { apiFetch, fetchPhotoBlob } from "./client";
import { queryKeys } from "./queries";
import type { components } from "./schema";

type MealResponse = components["schemas"]["MealResponse"];

/** 取一餐的照片，回一個可以塞進 `<img src>` 的 object URL。
 *
 *  **為什麼不能直接用 `/api/meals/{id}/photo` 當 `<img src>`：**
 *  那個端點需要 `Authorization` 標頭（規格 §5.2），而 `<img>` 發的請求
 *  帶不了自訂標頭。後端刻意不掛 `StaticFiles` —— 掛上去的那一刻所有
 *  照片就對所有人公開了，而且既有測試不會變紅（有一個路由表內省的
 *  測試專門守這件事）。
 *
 *  **卸載時一定要 `revokeObjectURL`。** 每一個 `createObjectURL` 都在
 *  文件的生命週期裡佔著那個 blob，直到 revoke 或整頁關掉。清單頁滑過
 *  幾十張照片之後，手機上的分頁會被系統殺掉 —— 而那看起來像「app 很爛」，
 *  不像「有一行沒寫」。
 *
 *  **404（`MEAL_PHOTO_NOT_FOUND`）是正常可達的狀態，不是例外**：DB 有
 *  `photo_path` 但檔案不在磁碟上，是後端 `delete_photo()` best-effort 設計
 *  下可能出現的情況（後端註解原話）。這裡把它反映成 `isError: true`、
 *  `objectUrl: null`，讓畫面優雅地不顯示圖，而不是塞一個壞掉的 URL。
 *
 *  **不用預設的 retry：** 404 在這裡是一個穩定狀態，不是暫時性錯誤，
 *  重試三次只會浪費行動網路的流量（這個 app 走 Tailscale，連線本來就
 *  不一定快）。 */
export function useMealPhoto(mealId: number): {
	objectUrl: string | null;
	isError: boolean;
} {
	const photoQuery = useQuery({
		queryKey: queryKeys.mealPhoto(mealId),
		queryFn: () => fetchPhotoBlob(`/api/meals/${mealId}/photo`),
		retry: false,
	});

	const blob = photoQuery.data ?? null;
	const [objectUrl, setObjectUrl] = useState<string | null>(null);

	useEffect(() => {
		if (blob === null) {
			setObjectUrl(null);
			return;
		}

		const url = URL.createObjectURL(blob);
		setObjectUrl(url);

		return () => {
			URL.revokeObjectURL(url);
		};
	}, [blob]);

	return { objectUrl, isError: photoQuery.isError };
}

/** 跟後端 `MAX_PHOTO_BYTES`（`app/api/routes/meals.py`）同一個數字。
 *
 *  **兩邊各存一份、不是共用一個常數**：前後端是兩個獨立的執行環境，
 *  沒有共用模組的路徑。這裡刻意跟後端保持一致，是為了讓前端的擋檔
 *  真的對應後端會拒絕的門檻，不是隨便選一個數字。 */
export const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

/** 前端在送出前就擋下超過大小上限的檔案時丟的錯誤。
 *
 *  跟後端真的回應的 `ApiError(code: "PHOTO_TOO_LARGE")` 分開：這個
 *  從來沒有打過網路 —— 後端有 413 PHOTO_TOO_LARGE，所以這不是不信任
 *  後端，是不要讓手機在慢速連線上傳了 30 秒才被拒。 */
export class PhotoTooLargeError extends Error {
	constructor() {
		super(
			`照片超過 ${MAX_PHOTO_BYTES / (1024 * 1024)}MB 上限，請換一張較小的照片`,
		);
		this.name = "PhotoTooLargeError";
	}
}

/** 上傳一餐的照片；後端已經有照片的話會取代舊的（`app/api/routes/meals.py`
 *  的 `upload_meal_photo`）。
 *
 *  **順序：先擋大小、再降尺寸、才送出。**
 *
 *  1. 大小檢查用的是**原始檔案**的位元組數，在呼叫 `shrinkToLongestEdge`
 *     之前就做——不必為一個註定要被拒絕的檔案花 CPU 去降尺寸。
 *  2. `shrinkToLongestEdge`（`../lib/resize-image`）把長邊降到 1280，
 *     跟後端一致。**這一步不是安全邊界**：EXIF 去除仍然由伺服器負責
 *     （`save_photo` 會重新編碼整張圖）——前端降尺寸只是不要在慢速連線
 *     上白傳一張手機拍出來動輒十幾 MB 的原圖。降尺寸這個函式本身沒有
 *     單元測試（jsdom 沒有 canvas，見該檔案開頭的說明），這裡的測試
 *     用 `vi.mock` 把它換成直接回傳原檔。
 *  3. `FormData` 的欄位名必須是 `"file"` ——後端的簽章是
 *     `file: UploadFile = File(...)`，欄位名寫錯的話 FastAPI 回
 *     422 VALIDATION_ERROR，訊息不會直接說「你的欄位名叫錯了」。 */
async function uploadMealPhoto(
	mealId: number,
	file: File,
): Promise<MealResponse> {
	if (file.size > MAX_PHOTO_BYTES) {
		throw new PhotoTooLargeError();
	}

	const resized = await shrinkToLongestEdge(file, 1280);

	const formData = new FormData();
	formData.append("file", resized);

	const response = await apiFetch<MealResponse>(`/api/meals/${mealId}/photo`, {
		method: "POST",
		body: formData,
	});
	if (response === null) {
		// 後端這個端點成功時一律回 200 + MealResponse，不會是 204——
		// 走到這裡代表 apiFetch 的假設被破壞了，不是一個預期路徑。
		throw new Error("上傳照片失敗：伺服器沒有回傳結果");
	}
	return response;
}

/** 上傳一餐照片的 mutation。
 *
 *  **成功後 invalidate 兩個 key**：`queryKeys.meals`（清單裡
 *  `MealResponse.photo_path` 變了，要重取才看得到有照片）與
 *  `queryKeys.mealPhoto(mealId)`（`useMealPhoto` 快取的可能是舊照片的
 *  blob，或者這一餐本來沒有照片、快取裡是一個 404 的錯誤狀態——兩種
 *  情況都要重取）。**不 invalidate `queryKeys.dailyStats`**：照片不影響
 *  營養素，`MealResponse` 的巨集不會因為換照片而改變。
 *
 *  **`queryKeys.meals` 那一行一定要帶 `exact: true`。** `queryKeys.meals`
 *  是 `["meals"]`，而 `queryKeys.mealPhoto` 是 `["meals", mealId, "photo"]`
 *  ——TanStack Query 預設的 `invalidateQueries` 是前綴比對，不是精確比對，
 *  `["meals"]` 本身就是 `["meals", mealId, "photo"]` 的前綴。少了
 *  `exact: true` 的話，這一行會連帶把**畫面上目前掛載的每一餐**的照片
 *  快取都標成失效並重取——不只是剛上傳的這一餐，而是清單上所有正在顯示
 *  照片的其他餐點也會跟著多打一次沒必要的 GET。實測抓到的：拿掉
 *  `exact: true` 之後，`tests/meal-photo-upload.test.tsx`「讓餐點清單與
 *  該餐的照片 key 失效」那條測試裡，`GET /api/meals/11/photo` 從預期的
 *  2 次（掛載時 1 次、上傳成功後重取 1 次）變成 3 次——多出來的那一次
 *  正是被這條前綴比對重複觸發的。 */
export function useUploadMealPhoto(mealId: number) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (file: File) => uploadMealPhoto(mealId, file),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.meals, exact: true });
			queryClient.invalidateQueries({
				queryKey: queryKeys.mealPhoto(mealId),
			});
		},
	});
}
