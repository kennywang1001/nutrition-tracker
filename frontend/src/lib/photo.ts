import { shrinkToLongestEdge } from "./resize-image";

/** 跟後端 `MAX_PHOTO_BYTES`（`app/api/routes/meals.py`）同一個數字。
 *
 *  **兩邊各存一份、不是共用一個常數**：前後端是兩個獨立的執行環境，
 *  沒有共用模組的路徑。這裡刻意跟後端保持一致，是為了讓前端的擋檔
 *  真的對應後端會拒絕的門檻，不是隨便選一個數字。
 *
 *  `api/photos.ts` 原樣轉出：既有的呼叫端照舊從那裡拿。 */
export const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

/** 照片送出前的長邊上限，跟後端一致。 */
const MAX_EDGE = 1280;

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

/** 照片送出前的前處理——上傳餐點照片（`uploadMealPhoto`）與照片估算
 *  （`analyzeImage`）共用同一套（AI 與編輯畫面的收尾規格 §2 第 5 項）。
 *
 *  **順序：先擋大小、再降尺寸。** 大小檢查用的是**原始檔案**的位元組數，
 *  在呼叫 `shrinkToLongestEdge` 之前就做——不必為一個註定要被拒絕的檔案
 *  花 CPU 去降尺寸。降尺寸**不是安全邊界**：EXIF 去除仍然由伺服器負責
 *  （見 `resize-image.ts` 開頭的說明）。 */
export async function preparePhoto(file: File): Promise<File> {
	if (file.size > MAX_PHOTO_BYTES) {
		throw new PhotoTooLargeError();
	}
	return shrinkToLongestEdge(file, MAX_EDGE);
}
