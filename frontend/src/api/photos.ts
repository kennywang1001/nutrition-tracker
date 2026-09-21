import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { fetchPhotoBlob } from "./client";
import { queryKeys } from "./queries";

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
