import type { Page } from "@playwright/test";

/** 用瀏覽器自己的 canvas 產生一張最小的合法 JPEG。
 *
 *  Chromium 的 `canvas.toBlob(..., "image/jpeg")` 輸出標準 baseline
 *  JPEG，後端用 Pillow 解碼一定吃得下（跟 `tests/test_meals_photo.py`
 *  的 `_jpeg_bytes` 做的是同一件事，只是編碼器換成瀏覽器內建的，不必在
 *  Node 端手刻位元組或另外存一份 base64 常數）。8x8 是刻意選的最小值：
 *  遠低於後端 `MAX_PHOTO_BYTES`（10MB），不會被前端或後端的大小檢查攔下，
 *  後端的圖片模組也沒有最小尺寸限制（`app/storage/photos.py`）。 */
export async function generateJpegBuffer(page: Page): Promise<Buffer> {
	const base64 = await page.evaluate(async () => {
		const canvas = document.createElement("canvas");
		canvas.width = 8;
		canvas.height = 8;
		const ctx = canvas.getContext("2d");
		if (ctx === null) throw new Error("canvas 2d context 不存在");
		ctx.fillStyle = "#ff8800";
		ctx.fillRect(0, 0, canvas.width, canvas.height);

		const blob = await new Promise<Blob>((resolve, reject) => {
			canvas.toBlob((result) => {
				if (result === null) reject(new Error("toBlob 回傳 null"));
				else resolve(result);
			}, "image/jpeg");
		});

		const bytes = new Uint8Array(await blob.arrayBuffer());
		let binary = "";
		for (const byte of bytes) binary += String.fromCharCode(byte);
		return btoa(binary);
	});

	return Buffer.from(base64, "base64");
}
