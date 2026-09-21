/** 把一張圖片的長邊降到 `maxEdge` 以內，回傳一個新的 `File`（JPEG 編碼）。
 *
 *  **這個函式故意抽成獨立模組，不是內嵌在上傳流程裡：**
 *  上傳流程的單元測試跑在 jsdom，而 jsdom 沒有實作 canvas 的 2D 繪圖
 *  context —— `canvas.getContext("2d")` 在 jsdom 底下是 `null`（或部分
 *  版本直接丟「not implemented」）。只要上傳流程直接呼叫 canvas，
 *  測試會在降尺寸這一步就炸掉，跟測試真正要驗的東西（欄位名、大小擋
 *  下、失效、錯誤訊息）無關。
 *
 *  上傳流程改成只呼叫這個函式；測試裡用 `vi.mock` 把整個模組換掉，
 *  讓它原樣回傳傳進去的 `File`，上傳流程本身才測得到。
 *
 *  **代價：這個函式本身沒有單元測試。** 這是刻意接受的 —— 它需要真的
 *  canvas，只有瀏覽器（Playwright 或手動）驗得到。跟前兩份計畫「service
 *  worker 在 jsdom 不註冊」「`navigator.locks` 在 jsdom 不存在」是同一個
 *  家族：測試環境裡沒有那個東西。**不要為了讓它「有測試」而去 mock
 *  canvas 的 API** —— 那只會測到「我對 canvas API 的假設」，不是
 *  「降尺寸真的有效」。
 *
 *  **這不是安全邊界，也不是為了取代伺服器的處理。** EXIF 仍然由伺服器
 *  負責去除（`app/storage/photos.py` 的 `save_photo` 會重新編碼整張圖）
 *  —— 那是安全邊界，不能交給 client：這是飲食紀錄 app，照片在家裡和
 *  餐廳拍，原樣存下來等於附贈位置歷史。這裡降尺寸純粹是為了不要在
 *  慢速連線（這個 app 走 Tailscale）上傳一張手機拍出來、動輒十幾 MB
 *  的原圖傳了 30 秒才被伺服器拒絕。
 *
 *  長邊已經 <= maxEdge 時直接回傳原檔，不做沒有意義的重新編碼。 */
export async function shrinkToLongestEdge(
	file: File,
	maxEdge: number,
): Promise<File> {
	const bitmap = await createImageBitmap(file);
	try {
		const longestEdge = Math.max(bitmap.width, bitmap.height);
		if (longestEdge <= maxEdge) {
			return file;
		}

		const scale = maxEdge / longestEdge;
		const width = Math.max(1, Math.round(bitmap.width * scale));
		const height = Math.max(1, Math.round(bitmap.height * scale));

		const canvas = document.createElement("canvas");
		canvas.width = width;
		canvas.height = height;
		const ctx = canvas.getContext("2d");
		if (ctx === null) {
			// 沒有 2d context 可用。理論上只會發生在沒有實作 canvas 的測試
			// 環境（見上面的說明）；真的瀏覽器不支援的話，回傳原圖讓伺服器
			// 自己處理，好過讓整個上傳失敗。
			return file;
		}
		ctx.drawImage(bitmap, 0, 0, width, height);

		const blob = await new Promise<Blob | null>((resolve) => {
			canvas.toBlob(resolve, "image/jpeg", 0.85);
		});
		if (blob === null) {
			return file;
		}

		return new File([blob], file.name, {
			type: "image/jpeg",
			lastModified: file.lastModified,
		});
	} finally {
		bitmap.close();
	}
}
